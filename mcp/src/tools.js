// The connector's tools: read-only questions about Trola, answered in short sentences that
// read well aloud (ChatGPT voice), with the numbers also given as data. Days are Trola's own:
// midnight to midnight in the time zone where it last was. Spots (where it charged, stayed or is
// now) are named from OpenStreetMap (shared/places.js), with their coordinates in the data.
import { ToolError } from './protocol.js';
import { rangeStats, ensureDays, listDays } from '../../shared/stats.js';
import { listSessions, KWH_PER_GID } from '../../shared/charges.js';
import { victronDays } from '../../shared/victron-days.js';
import { latestReading, victronNow, timeZoneAt } from '../../shared/latest.js';
import { track } from '../../shared/track.js';
import { findStays, nightsIn, STOP_MS } from '../../shared/stays.js';
import { placeNames, cellOf, mapsUrl, ATTRIBUTION } from '../../shared/places.js';

const DAY_MS = 864e5;
const FALLBACK_TZ = 'Europe/Ljubljana';
const MAX_DAYS = 400; // like the dashboard's longest range
const MAX_LIST_DAYS = 62;
const MAX_STOP_DAYS = 31, MAX_STOPS = 40, TRACK_POINTS = 3000;
const STALE_MS = 15 * 60 * 1000;

// ---------- Days in a time zone ----------
// The time zone's offset from UTC at a moment, in ms (local minus UTC).
export function zoneOffset(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// When a day (YYYY-MM-DD) begins in a time zone. The second step gets days that change clocks right.
export function dayStart(key, tz) {
  const midnight = Date.parse(`${key}T00:00:00Z`);
  return midnight - zoneOffset(midnight - zoneOffset(midnight, tz), tz);
}
export const dayOf = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(ms); // YYYY-MM-DD
export const addDays = (key, n) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// YYYY-MM-DD, "today", "yesterday" or a weekday (the latest one, today included) → YYYY-MM-DD.
export function parseDay(v, today) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'today') return today;
  if (s === 'yesterday') return addDays(today, -1);
  const w = WEEKDAYS.indexOf(s);
  if (w >= 0) return addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() - w + 7) % 7));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return s;
  throw new ToolError(`Give days as YYYY-MM-DD (or "today", "yesterday", or a weekday), not "${v}".`);
}

// The days asked for, oldest first, none after today and at most `max` of them.
function dayRange(args, today, max, fallbackFrom = today) {
  let from = parseDay(args.from ?? args.date ?? args.day, today) ?? fallbackFrom;
  let to = parseDay(args.to, today) ?? (args.from || args.date || args.day ? from : today);
  if (to < from) [from, to] = [to, from];
  if (from > today) throw new ToolError(`${longDay(from)} hasn't come yet in Trola's time zone (today is ${longDay(today)}).`);
  if (to > today) to = today;
  const n = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  if (n > max) throw new ToolError(`That is ${n} days; ask for at most ${max} at a time.`);
  return { from, to, n };
}

// ---------- Words ----------
const num = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? null
  : Number(v.toFixed(d)).toLocaleString('en-GB', { maximumFractionDigits: d }));
const round = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const longDay = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDay = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const period = (from, to) => (from === to ? longDay(from) : `${longDay(from)} to ${longDay(to)}`);
const hm = (ms, tz) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
function duration(sec) {
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 2) return 'just now';
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

const coords = (p) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
// A spot's name for a sentence ("Camping Bled, Bled, Slovenia"), or its coordinates.
function placeText(names, p) {
  const n = names.get(cellOf(p));
  return n ? n.label || `a spot with no place name (${coords(p)})` : `${coords(p)} (its place name isn't looked up yet; ask again shortly)`;
}
const placeData = (names, p) => ({ place: names.get(cellOf(p))?.label ?? null, lat: p.lat, lon: p.lon, maps_url: mapsUrl(p) });

// ---------- Tools ----------
// later: ctx.waitUntil, for place names looked up after answering. nominatim: another address
// for the place-name service (local testing).
export function trolaServer(db, { now = () => Date.now(), later = null, nominatim = null } = {}) {
  // Trola's time zone and today's date there, read once per request.
  let place = null;
  const where = async () => (place ||= latestReading(db).then((l) => ({ ...l, tz: l.tz || FALLBACK_TZ, today: dayOf(now(), l.tz || FALLBACK_TZ) })));
  const names = (spots, max) => placeNames(db, spots, { max, later, ...(nominatim ? { base: nominatim } : {}) });

  async function status() {
    const t = now();
    const [{ reading: r, lastPosition, tz, today }, vic, avg] = await Promise.all([
      where(), victronNow(db, t),
      db.prepare('SELECT SUM(used_kwh) AS used, SUM(regen_kwh) AS regen, SUM(distance_km) AS km FROM daily WHERE day >= ?')
        .bind(new Date(t - 30 * DAY_MS).toISOString().slice(0, 10)).first(),
    ]);
    const clock = `${longDay(today)}, ${hm(t, tz)}`;
    if (!r) return { text: `It is ${clock} where Trola is (${tz}). LeafSpy hasn't sent any readings yet.`, data: { timezone: tz, today, local_time: hm(t, tz) } };
    const age = t - r.ts, stale = age > STALE_MS;
    const w = r.bat_volts !== null && r.bat_amps !== null ? r.bat_volts * r.bat_amps : null;
    const charging = r.chrg_mode > 0 || (r.bat_amps !== null && r.bat_amps < -3 && (r.speed ?? 0) < 1 && (r.pwr_sw ?? 0) === 0);
    const driving = !charging && r.speed > 1;
    const kwhLeft = r.gids > 0 ? r.gids * KWH_PER_GID : null;
    const per100 = avg && avg.km >= 20 && avg.used ? ((avg.used - (avg.regen || 0)) / avg.km) * 100 : null;
    const rangeKm = kwhLeft !== null && per100 > 5 ? (kwhLeft / per100) * 100 : null;
    const L = vic.leisure;
    const pos = lastPosition || (r.lat !== null ? r : null);
    const named = pos ? await names([pos], 1) : new Map();
    const at = pos ? ` ${driving ? 'near' : 'at'} ${placeText(named, pos)}` : '';
    const temps = [r.bat_temp !== null ? `Battery ${num(r.bat_temp)} °C` : null, r.amb_temp !== null ? `outside ${num(r.amb_temp)} °C` : null].filter(Boolean);
    const parts = [
      `It is ${clock} where Trola is (${tz}).`,
      `${stale ? `LeafSpy last reported ${ago(age)}, so this is how things were then` : `Last report ${ago(age)}`}: Trola was ${driving ? `driving at ${num(r.speed)} km/h` : charging ? 'charging' : 'parked'}${at}.`,
      r.soc !== null ? `Battery ${num(Math.max(0, r.soc))}%${kwhLeft !== null ? ` (about ${num(kwhLeft, 1)} kWh usable)` : ''}${charging && w !== null && w < 0 ? `, charging at ${num(-w / 1000, 1)} kW` : ''}.` : null,
      rangeKm !== null ? `That is about ${num(Math.round(rangeKm / 5) * 5)} km of range at the last 30 days' average of ${num(per100, 1)} kWh per 100 km.` : null,
      r.odo ? `Odometer ${num(r.odo)} km.` : null,
      r.soh ? `Battery health ${num(r.soh, 1)}%.` : null,
      temps.length ? `${temps.join(', ')}.` : null,
      L && L.percent !== null ? `Leisure battery about ${L.percent}%${vic.solar && vic.solar.pv_w > 0 && t - vic.solar.ts < STALE_MS ? `, solar giving ${num(vic.solar.pv_w)} W` : ''}.` : null,
    ];
    return {
      text: parts.filter(Boolean).join(' '),
      data: { timezone: tz, today, local_time: hm(t, tz), last_report_minutes_ago: Math.round(age / 60000),
        state: driving ? 'driving' : charging ? 'charging' : 'parked', speed_kmh: round(r.speed, 0), battery_percent: round(r.soc, 1),
        battery_kwh_usable: round(kwhLeft, 1), charging_kw: charging && w < 0 ? round(-w / 1000, 1) : null,
        range_km: round(rangeKm, 0), consumption_30d_kwh_per_100km: round(per100, 1), odometer_km: r.odo || null,
        battery_health_percent: round(r.soh, 1), battery_temp_c: r.bat_temp, outside_temp_c: r.amb_temp,
        leisure_battery_percent: L ? L.percent : null, solar_w: vic.solar ? vic.solar.pv_w : null,
        position: pos ? { ...placeData(named, pos), at: new Date(pos.ts).toISOString() } : null, place_names: ATTRIBUTION },
    };
  }

  async function stats(args) {
    const t = now(), { tz, today } = await where();
    const { from, to } = dayRange(args, today, MAX_DAYS);
    const since = dayStart(from, tz), until = Math.min(t, dayStart(addDays(to, 1), tz));
    const [s, vd] = await Promise.all([
      rangeStats(db, since, until, 4),
      victronDays(db, t, Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`)),
    ]);
    const solarWh = vd.days.reduce((a, d) => (d.solar_wh === null ? a : (a ?? 0) + d.solar_wh), null);
    const km = s.distance_km, used = s.used_kwh, regen = s.regen_kwh, net = used === null ? null : used - (regen || 0);
    const per100 = km >= 1 && net !== null ? (net / km) * 100 : null;
    const when = `${period(from, to)} (Trola's time, ${tz})`;
    const parts = !s.readings
      ? [`${when}: no readings from LeafSpy, so no driving or charging was recorded.`]
      : [
        km ? `${when}: Trola drove ${num(km)} km in ${duration(s.drive_s || 0)}${s.drive_s > 60 ? `, averaging ${num(km / (s.drive_s / 3600))} km/h` : ''}, top speed ${num(s.max_speed)} km/h.`
          : `${when}: Trola didn't drive.`,
        used ? `It used ${num(used, 1)} kWh from the battery; regen gave back ${num(regen || 0, 1)} kWh, so ${num(net, 1)} kWh net${per100 !== null ? `, or ${num(per100, 1)} kWh per 100 km` : ''}.` : null,
        s.charges ? `It charged ${num(s.charged_kwh, 1)} kWh in ${s.charges} charging session${s.charges > 1 ? 's' : ''}.` : 'No charging.',
        s.amb_temp_min !== null ? `Outside it was ${s.amb_temp_min === s.amb_temp_max ? `${num(s.amb_temp_min)}` : `${num(s.amb_temp_min)} to ${num(s.amb_temp_max)}`} °C.` : null,
      ];
    if (solarWh) parts.push(`The solar panels made ${num(solarWh / 1000, 2)} kWh.`);
    if (to === today) parts.push(`Today is not over yet (it is ${hm(t, tz)} there).`);
    if (s.partial) parts.push('Some days are still being added up, so these totals may be low; ask again in a minute.');
    return {
      text: parts.filter(Boolean).join(' '),
      data: { from, to, timezone: tz, distance_km: km, driving_minutes: s.drive_s === null ? null : Math.round(s.drive_s / 60),
        top_speed_kmh: s.max_speed, energy_used_kwh: round(used, 2), regen_kwh: round(regen, 2), net_energy_kwh: round(net, 2),
        consumption_kwh_per_100km: round(per100, 1), charged_kwh: round(s.charged_kwh, 2), charging_sessions: s.charges,
        solar_kwh: solarWh === null ? null : round(solarWh / 1000, 2), outside_min_c: s.amb_temp_min, outside_max_c: s.amb_temp_max,
        partial: !!s.partial },
    };
  }

  async function days(args) {
    const t = now(), today = dayOf(t, 'UTC');
    const { from, to } = dayRange(args, today, MAX_LIST_DAYS, addDays(today, -6));
    await ensureDays(db, Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`) + DAY_MS);
    const [rows, vd] = await Promise.all([listDays(db, from, to),
      victronDays(db, t, Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`))]);
    const solar = new Map(vd.days.map((d) => [d.day, d.solar_wh]));
    const list = rows.map((d) => ({ day: d.day, distance_km: d.distance_km || 0, driving_minutes: Math.round((d.drive_s || 0) / 60),
      energy_used_kwh: round(d.used_kwh || 0, 1), regen_kwh: round(d.regen_kwh || 0, 1), charged_kwh: round(d.charged_kwh || 0, 1),
      solar_kwh: solar.get(d.day) ? round(solar.get(d.day) / 1000, 2) : null }));
    const lines = list.map((d) => `${shortDay(d.day)}: ${d.distance_km ? `${num(d.distance_km)} km, ${num(d.energy_used_kwh, 1)} kWh used, ${num(d.regen_kwh, 1)} regen` : 'no driving'}`
      + `${d.charged_kwh ? `, charged ${num(d.charged_kwh, 1)} kWh` : ''}${d.solar_kwh ? `, solar ${num(d.solar_kwh, 2)} kWh` : ''}.`);
    return {
      text: `${period(from, to)}, day by day (days run midnight to midnight UTC):\n${lines.length ? lines.join('\n') : 'No readings on any of these days.'}`
        + `${lines.length ? '\nDays without any readings are left out.' : ''}`,
      data: { from, to, days: list },
    };
  }

  async function charges(args) {
    const { tz, today } = await where();
    const { from, to } = dayRange(args, today, MAX_DAYS, addDays(today, -6));
    const since = dayStart(from, tz), until = dayStart(addDays(to, 1), tz);
    const all = (await listSessions(db)).filter((s) => s.start_ts >= since && s.start_ts < until);
    const shown = all.slice(0, 20);
    const here = shown.filter((s) => s.lat !== null && s.lat !== undefined);
    const named = await names(here, 3);
    const kind = (m) => (m === 3 ? 'DC fast charge' : m ? 'AC charge' : 'charge (LeafSpy was off)');
    const lines = shown.map((s) => `${shortDay(dayOf(s.start_ts, tz))} ${hm(s.start_ts, tz)}–${hm(s.end_ts, tz)}: ${kind(s.mode)}, ${num(s.kwh, 1)} kWh`
      + `${s.soc_start !== null && s.soc_end !== null ? `, ${num(s.soc_start)}% to ${num(s.soc_end)}%` : ''}${s.max_kw ? `, up to ${num(s.max_kw, 1)} kW` : ''}`
      + `${s.lat !== null && s.lat !== undefined ? `, at ${placeText(named, s)}` : ''}.`);
    const total = all.reduce((a, s) => a + (s.kwh || 0), 0);
    return {
      text: all.length
        ? `${period(from, to)} (Trola's time, ${tz}): ${all.length} charging session${all.length > 1 ? 's' : ''}, ${num(total, 1)} kWh in all, newest first:\n${lines.join('\n')}`
          + `${all.length > shown.length ? `\nAnd ${all.length - shown.length} earlier ones.` : ''}`
        : `${period(from, to)} (Trola's time, ${tz}): no charging.`,
      data: { from, to, timezone: tz, total_kwh: round(total, 2), sessions: shown.map((s) => ({
        start: new Date(s.start_ts).toISOString(), end: new Date(s.end_ts).toISOString(), kwh: round(s.kwh, 2),
        kind: s.mode === 3 ? 'dc' : s.mode ? 'ac' : 'unknown', battery_start_percent: s.soc_start, battery_end_percent: s.soc_end,
        peak_kw: round(s.max_kw, 1), ...(s.lat !== null && s.lat !== undefined ? placeData(named, s) : {}) })), place_names: ATTRIBUTION },
    };
  }

  // Nights and stops: where Trola stood still for 20 min or more (shared/stays.js), oldest first.
  async function stops(args) {
    const t = now(), { tz, today } = await where();
    const { from, to } = dayRange(args, today, MAX_STOP_DAYS, addDays(today, -1));
    const since = dayStart(from, tz), until = Math.min(t, dayStart(addDays(to, 1), tz));
    const [tr, sessions] = await Promise.all([track(db, since, until, 'r.ts, r.lat, r.lon', TRACK_POINTS), listSessions(db)]);
    // Nothing after the range: Trola has stood at its last spot since then (LeafSpy is quiet while it's off).
    const found = findStays([tr.before, ...(tr.points || []), tr.after].filter(Boolean), tr.after ? null : t)
      .filter((g) => g.end > since && g.start < until).slice(-MAX_STOPS);
    const list = found.map((g) => {
      const charged = sessions.filter((c) => c.start_ts < g.end && c.end_ts > g.start).reduce((a, c) => a + (c.kwh || 0), 0);
      return { ...g, nights: nightsIn(g.start, g.end, timeZoneAt(g) || tz), charged };
    });
    // Names for the nights first, then the longest stops.
    const named = await names([...list].sort((a, b) => (b.nights - a.nights) || (b.end - b.start) - (a.end - a.start)), 3);
    const when = (g) => {
      const a = `${shortDay(dayOf(g.start, tz))} ${hm(g.start, tz)}`;
      if (g.ongoing) return `Since ${a}, still there (${duration((g.end - g.start) / 1000)} so far)`;
      return `${a} to ${dayOf(g.start, tz) === dayOf(g.end, tz) ? '' : `${shortDay(dayOf(g.end, tz))} `}${hm(g.end, tz)} (${duration((g.end - g.start) / 1000)})`;
    };
    const lines = list.map((g) => `${when(g)}: ${g.nights > 1 ? `${g.nights} nights` : g.nights ? 'night' : g.ongoing ? 'parked' : 'stop'} at ${placeText(named, g)}`
      + `${g.charged >= 0.1 ? `, charged ${num(g.charged, 1)} kWh` : ''}.`);
    const n = list.filter((g) => g.nights).length;
    return {
      text: list.length
        ? `${period(from, to)} (Trola's time, ${tz}): ${n} overnight stay${n === 1 ? '' : 's'} and ${list.length - n} stop${list.length - n === 1 ? '' : 's'} `
          + `of ${STOP_MS / 60000} minutes or more, oldest first (a stay is listed on each day it touches):\n${lines.join('\n')}`
        : `${period(from, to)} (Trola's time, ${tz}): ${tr.points && tr.points.length ? `no stops of ${STOP_MS / 60000} minutes or more.` : 'no readings from LeafSpy.'}`,
      data: { from, to, timezone: tz, stays: list.map((g) => ({ kind: g.nights ? 'night' : 'stop', nights: g.nights,
        start: new Date(g.start).toISOString(), end: g.ongoing ? null : new Date(g.end).toISOString(), minutes: Math.round((g.end - g.start) / 60000),
        still_there: !!g.ongoing, charged_kwh: g.charged >= 0.1 ? round(g.charged, 1) : 0, ...placeData(named, g) })), place_names: ATTRIBUTION },
    };
  }

  const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const DAY_ARG = (what) => ({ type: 'string', description: `${what}: YYYY-MM-DD in Trola's local time, or "today", "yesterday", or a weekday name for the latest one.` });
  return {
    info: { name: 'trolaspy', title: 'TrolaSpy', version: '1.0.0' },
    instructions: 'TrolaSpy knows Trola, a Nissan e-NV200 electric camper van: how far it drove, energy used, regen, charging, '
      + 'solar, battery, where it charged, stopped and spent the night (place names from OpenStreetMap), and where it is now. Days are midnight to midnight in Trola\'s local time zone. Work out '
      + 'words like "yesterday", "Sunday" or "last week" as dates; get_trola_status gives today\'s date there. Energy is in '
      + 'kWh ("kilowatts" usually means kWh). Answer briefly, in the user\'s language, rounding numbers for speech.',
    tools: [
      { name: 'get_trola_status', title: 'Trola right now', annotations: { title: 'Trola right now', ...READ_ONLY },
        description: 'Trola right now: where it is (place name), battery %, energy and range left, whether it is driving, parked or charging, '
          + 'odometer, battery health, temperatures, the leisure battery and solar, and today\'s date and local time where Trola is.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: status },
      { name: 'get_trola_stats', title: 'Trola totals', annotations: { title: 'Trola totals for days', ...READ_ONLY },
        description: 'Totals for one day or a range of days: km driven, driving time, average and top speed, energy used from the battery (kWh), '
          + 'regen, net energy, consumption per 100 km, energy charged and charging sessions, solar, outside temperatures. '
          + 'For a range ("this week", "October") give the first and last day.',
        inputSchema: { type: 'object', properties: { from: DAY_ARG('The day, or the first day'), to: DAY_ARG('The last day, included; leave out for one day') },
          required: ['from'], additionalProperties: false }, run: stats },
      { name: 'get_trola_days', title: 'Trola day by day', annotations: { title: 'Trola day by day', ...READ_ONLY },
        description: `One line per day: km, energy used, regen, charged and solar, to compare days ("which day did I drive most"). At most ${MAX_LIST_DAYS} days; `
          + 'leave both out for the last 7. These days run midnight to midnight UTC, so for one day\'s exact totals use get_trola_stats.',
        inputSchema: { type: 'object', properties: { from: DAY_ARG('First day'), to: DAY_ARG('Last day, included') }, additionalProperties: false }, run: days },
      { name: 'get_trola_charges', title: 'Trola charging', annotations: { title: 'Trola charging sessions', ...READ_ONLY },
        description: 'Charging sessions, newest first: when (Trola\'s local time), where (place name), AC or DC fast, kWh added, '
          + 'battery % before and after, peak power. Leave both days out for the last 7 days.',
        inputSchema: { type: 'object', properties: { from: DAY_ARG('First day'), to: DAY_ARG('Last day, included') }, additionalProperties: false }, run: charges },
      { name: 'get_trola_stops', title: 'Trola nights and stops', annotations: { title: 'Where Trola slept and stopped', ...READ_ONLY },
        description: `Where Trola spent the night and stopped (20 min or more), oldest first: when, how long, the place name, and any charging there. `
          + `For "where did we sleep last night" ask for yesterday to today. At most ${MAX_STOP_DAYS} days; leave both out for yesterday and today.`,
        inputSchema: { type: 'object', properties: { from: DAY_ARG('First day'), to: DAY_ARG('Last day, included') }, additionalProperties: false }, run: stops },
    ],
  };
}
