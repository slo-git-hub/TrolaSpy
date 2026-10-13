// Driving and energy totals for a time range, and the per-day summaries built from them.
// Worked out here from one plain read of the readings (see charges.js for why not in SQL).
import { SESSION_GAP_MS, scanReadings, sessionsFrom } from './charges.js';

// Power is pack volts x amps: positive = drawing from the battery, negative = going in
// (regen while driving, or charging). Each reading's power is applied to the gap since
// the previous one; gaps over MAX_GAP_MS (LeafSpy off) count as nothing.
const MAX_GAP_MS = 150_000; // LeafSpy uploads every 35-120 s once the tablet dozes
const MS_PER_KWH = 3.6e9; // W x ms per kWh
const DAY_MS = 864e5;
const FOREVER = 8.64e15;
// Longer ranges take whole days from the daily table and read only the part days at each end.
const LIVE_MAX_MS = 2 * DAY_MS;

const add = (a, b) => (b === null || b === undefined ? a : (a ?? 0) + b);
const hi = (a, b) => (b === null || b === undefined ? a : a === null ? b : Math.max(a, b));
const lo = (a, b) => (b === null || b === undefined ? a : a === null ? b : Math.min(a, b));
const nz = (v) => (v ? v : null);

function statsFrom(rows) {
  const t = { readings: rows.length, used_kwh: null, regen_kwh: null, drive_s: null, max_speed: null, distance_km: null,
    bat_temp_min: null, bat_temp_max: null, amb_temp_min: null, amb_temp_max: null, max_regen_kw: null, max_power_kw: null };
  const avg = { soh: [0, 0], hx: [0, 0], ahr: [0, 0] };
  let prev = null, odoMin = null, odoMax = null;
  for (const r of rows) {
    const dt = prev === null ? null : r.ts - prev;
    prev = r.ts;
    const w = r.bat_volts === null || r.bat_amps === null ? null : r.bat_volts * r.bat_amps;
    const parked = (r.chrg_mode ?? 0) === 0, on = r.pwr_sw === 1;
    if (dt !== null && dt <= MAX_GAP_MS) {
      if (w !== null && w > 0 && parked) t.used_kwh = add(t.used_kwh, (w * dt) / MS_PER_KWH);
      if (w !== null && w < 0 && parked && on) t.regen_kwh = add(t.regen_kwh, (-w * dt) / MS_PER_KWH);
      if (r.speed > 1) t.drive_s = add(t.drive_s, dt / 1000);
    }
    t.max_speed = hi(t.max_speed, r.speed);
    odoMin = lo(odoMin, nz(r.odo)); odoMax = hi(odoMax, nz(r.odo));
    t.bat_temp_min = lo(t.bat_temp_min, r.bat_temp); t.bat_temp_max = hi(t.bat_temp_max, r.bat_temp);
    t.amb_temp_min = lo(t.amb_temp_min, r.amb_temp); t.amb_temp_max = hi(t.amb_temp_max, r.amb_temp);
    if (w !== null && parked && on) t.max_regen_kw = hi(t.max_regen_kw, -w / 1000);
    if (w !== null) t.max_power_kw = hi(t.max_power_kw, w / 1000);
    for (const k of ['soh', 'hx', 'ahr']) if (nz(r[k]) !== null) { avg[k][0] += r[k]; avg[k][1]++; }
  }
  if (odoMin !== null) t.distance_km = odoMax - odoMin;
  for (const k of ['soh', 'hx', 'ahr']) t[k] = avg[k][1] ? avg[k][0] / avg[k][1] : null;
  return t;
}

async function liveStats(db, since, until) {
  if (until <= since) return null;
  // Read a little past `until`: a charge ending near it needs the reading after.
  const rows = await scanReadings(db, since, until + SESSION_GAP_MS);
  const sessions = await sessionsFrom(db, rows, until);
  // Charged energy comes from the charging sessions (they also count charges LeafSpy missed).
  return { ...statsFrom(rows.filter((r) => r.ts < until)), charged_kwh: sessions.reduce((t, s) => t + (s.kwh || 0), 0), charges: sessions.length };
}

const fromDaily = (d) => ({ readings: d.readings, used_kwh: d.used_kwh, regen_kwh: d.regen_kwh, drive_s: d.drive_s,
  max_speed: d.max_speed, distance_km: d.distance_km, amb_temp_min: d.amb_min, amb_temp_max: d.amb_max,
  max_regen_kw: d.max_regen_kw ?? null, soh: d.soh, hx: d.hx, ahr: d.ahr, charged_kwh: d.charged_kwh, charges: d.charges });

function combine(parts) {
  parts = parts.filter(Boolean);
  const sum = (k) => parts.reduce((t, p) => add(t, p[k]), null);
  const top = (k) => parts.reduce((t, p) => hi(t, p[k]), null);
  const bottom = (k) => parts.reduce((t, p) => lo(t, p[k]), null);
  const mean = (k) => { const v = parts.map((p) => p[k]).filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b) / v.length : null; };
  return {
    readings: sum('readings') ?? 0, used_kwh: sum('used_kwh'), regen_kwh: sum('regen_kwh'), drive_s: sum('drive_s'),
    max_speed: top('max_speed'), distance_km: sum('distance_km'),
    bat_temp_min: bottom('bat_temp_min'), bat_temp_max: top('bat_temp_max'), amb_temp_min: bottom('amb_temp_min'), amb_temp_max: top('amb_temp_max'),
    max_regen_kw: top('max_regen_kw'), max_power_kw: top('max_power_kw'), soh: mean('soh'), hx: mean('hx'), ahr: mean('ahr'),
    charged_kwh: sum('charged_kwh') ?? 0, charges: sum('charges') ?? 0,
  };
}

export async function rangeStats(db, since, until = Date.now()) {
  if (until - since <= LIVE_MAX_MS) return combine([await liveStats(db, since, until)]);
  const a = Math.ceil(since / DAY_MS) * DAY_MS, b = Math.floor(until / DAY_MS) * DAY_MS;
  await ensureDays(db, a, b);
  const { results: days } = await db.prepare('SELECT * FROM daily WHERE day >= ? AND day < ?').bind(dayKey(a), dayKey(b)).all();
  // Days still without a summary (ensureDays does a few per call) are read directly.
  const have = new Set(days.map((d) => d.day)), gaps = [];
  for (let t = a, g = null; t < b; t += DAY_MS) {
    if (have.has(dayKey(t))) g = null;
    else if (g) g[1] = t + DAY_MS;
    else gaps.push(g = [t, t + DAY_MS]);
  }
  const live = await Promise.all([[since, a], ...gaps, [b, until]].map(([x, y]) => liveStats(db, x, y)));
  return combine([...live, ...days.map(fromDaily)]);
}

// ---------- Daily summaries (UTC days) ----------
// One row per finished day, stored so month views and battery health over years stay cheap.

export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const DAILY_COLS = ['day', 'readings', 'distance_km', 'drive_s', 'used_kwh', 'regen_kwh', 'charged_kwh', 'charges',
  'max_speed', 'soh', 'hx', 'ahr', 'amb_min', 'amb_max', 'max_regen_kw'];

async function computeDay(db, start) {
  const s = combine([await liveStats(db, start, start + DAY_MS)]);
  return {
    day: dayKey(start), readings: s.readings, distance_km: s.distance_km, drive_s: s.drive_s,
    used_kwh: s.used_kwh, regen_kwh: s.regen_kwh, charged_kwh: s.charged_kwh, charges: s.charges,
    max_speed: s.max_speed, soh: s.soh, hx: s.hx, ahr: s.ahr, amb_min: s.amb_temp_min, amb_max: s.amb_temp_max,
    max_regen_kw: s.max_regen_kw,
  };
}

// Works out and stores any finished day in [from, to) that has no summary yet
// (at most `limit` per call, oldest first: each day costs a query or two, and a Worker on the
// free plan may make 50). Days before the first reading are skipped.
export async function ensureDays(db, from = 0, to = FOREVER, limit = 10) {
  const first = await db.prepare('SELECT MIN(ts) AS ts FROM readings').first();
  if (!first || first.ts === null) return 0;
  const start = dayStart(Math.max(from, first.ts));
  const end = Math.min(dayStart(to), dayStart(Date.now()));
  if (start >= end) return 0;
  const { results } = await db.prepare('SELECT day FROM daily WHERE day >= ? AND day < ?')
    .bind(dayKey(start), dayKey(end)).all();
  const have = new Set(results.map((r) => r.day));
  const missing = [];
  for (let t = start; t < end && missing.length < limit; t += DAY_MS) if (!have.has(dayKey(t))) missing.push(t);
  if (!missing.length) return 0;
  const rows = await Promise.all(missing.map((t) => computeDay(db, t)));
  const stmt = db.prepare(`INSERT OR REPLACE INTO daily (${DAILY_COLS.join(', ')}, computed_ts)
                           VALUES (${DAILY_COLS.map(() => '?').join(', ')}, ?)`);
  await db.batch(rows.map((r) => stmt.bind(...DAILY_COLS.map((c) => r[c] ?? null), Date.now())));
  return rows.length;
}

// Day summaries for [fromKey, toKey] (inclusive, YYYY-MM-DD); today is worked out live.
export async function listDays(db, fromKey, toKey) {
  const { results } = await db.prepare('SELECT * FROM daily WHERE day >= ? AND day <= ? ORDER BY day')
    .bind(fromKey, toKey).all();
  const today = dayKey(Date.now());
  if (today >= fromKey && today <= toKey) results.push(await computeDay(db, dayStart(Date.now())));
  return results.filter((r) => r.readings > 0);
}

// Summaries are recomputed after readings change (restore or delete).
export async function forgetDays(db, from, to) {
  await db.prepare('DELETE FROM daily WHERE day >= ? AND day <= ?').bind(dayKey(from), dayKey(to)).run();
}
