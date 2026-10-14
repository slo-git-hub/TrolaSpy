import page from './page.html';
import logo from './logo.svg';
import banner from './banner.jpg';
import icon192 from './icon-192.png';
import icon512 from './icon-512.png';
import iconMaskable from './icon-maskable-512.png';
import { manifest, serviceWorker } from './pwa.js';
// Video shrinking in the browser (WebCodecs), served from here and loaded only when a video is added.
import mediabunny from '../../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs';
const MEDIABUNNY_PATH = '/vendor/mediabunny-1.59.1.mjs';
import { listSessions } from '../../shared/charges.js';
import { rangeStats, ensureDays, listDays, dayKey } from '../../shared/stats.js';
import { getSettings } from '../../shared/alerts.js';
import { CO2_SAVED_G_PER_KM } from '../../shared/co2.js';
import { leisureCharge, HELD, CHARGING_A } from '../../shared/lifepo4.js';
import { dashSoc } from '../../shared/soc.js';
import { handleAdmin } from './admin.js';
import { getViewer, isAdmin } from './access.js';
import { listPhotos, servePhoto, positionAt, uploadPhoto, updatePhoto, deletePhoto } from './photos.js';

const MAX_HOURS = 30 * 24;
const MAX_POINTS = 3000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// Values only the car itself can give. When it doesn't answer (just after it is switched off)
// LeafSpy sends nothing or 0 for them, so the last ones it did give are shown instead. Each
// group comes from the newest reading that has its first value.
const CAR_FIELDS = [['soc', 'gids', 'bat_temp', 'amb_temp'], ['soh', 'hx', 'ahr'], ['odo']];
const missing = (k, v) => v === null || v === undefined || (v === 0 && !k.endsWith('_temp'));
// While charging, LeafSpy sometimes gets no battery current from the car and sends 0. The
// newest current measured in the last CHARGE_FILL_MS of the charge is shown instead.
const CHARGE_FILL_MS = 20 * 60 * 1000;

// Battery % is shown as the dashboard shows it (see soc.js); `soc_leafspy` keeps LeafSpy's own.
const socCal = async (env) => (await getSettings(env.DB, ['soc_cal'])).soc_cal;

async function latest(env) {
  const [row, cal] = await Promise.all([env.DB.prepare('SELECT * FROM readings ORDER BY ts DESC LIMIT 1').first(), socCal(env)]);
  for (const group of row ? CAR_FIELDS : []) {
    if (!group.some((k) => missing(k, row[k]))) continue;
    const known = await env.DB.prepare(`SELECT ${group.join(', ')} FROM readings WHERE ${group[0]} > 0 ORDER BY ts DESC LIMIT 1`).first();
    if (known) for (const k of group) if (missing(k, row[k]) && !missing(k, known[k])) row[k] = known[k];
  }
  if (row && row.chrg_mode > 0 && !(row.bat_volts * row.bat_amps)) {
    const known = await env.DB.prepare(
      `SELECT bat_volts, bat_amps FROM readings
        WHERE ts >= ? AND ts < ? AND chrg_mode > 0 AND bat_volts * bat_amps < 0 ORDER BY ts DESC LIMIT 1`
    ).bind(row.ts - CHARGE_FILL_MS, row.ts).first();
    Object.assign(row, known || { bat_amps: null });
  }
  if (row) Object.assign(row, { soc_leafspy: row.soc, soc: dashSoc(row.soc, cal) });
  // Last known position, in case the newest upload had no GPS fix.
  const pos = row && row.lat === null
    ? await env.DB.prepare('SELECT ts, lat, lon FROM readings WHERE lat IS NOT NULL ORDER BY ts DESC LIMIT 1').first()
    : null;
  return { reading: row, lastPosition: pos, co2_g_per_km: CO2_SAVED_G_PER_KM };
}

// Downsampled to one point per bucket (the bucket's first reading). Up to 2 days, grouping reads
// every reading once; longer ranges look up each bucket's first reading by time instead, which
// reads about two rows per bucket rather than every reading (D1's free plan counts rows read).
const POINT_COLS = (r) => `${r}.ts, ${r}.lat, ${r}.lon, NULLIF(${r}.soc, 0) AS soc, ${r}.speed, ${r}.chrg_pwr, ${r}.pwr_sw, ${r}.bat_temp, ${r}.amb_temp,
  CASE WHEN ${r}.chrg_mode > 0 AND COALESCE(${r}.bat_volts * ${r}.bat_amps, 0) = 0 THEN NULL
       ELSE ROUND(${r}.bat_volts * ${r}.bat_amps / 1000.0, 2) END AS kw`; // none for charging readings without the current
async function track(env, hours) {
  const now = Date.now(), since = now - hours * 3600 * 1000;
  const bucketMs = Math.max(10_000, Math.ceil((hours * 3600 * 1000) / MAX_POINTS));
  const sql = hours <= 48
    ? `SELECT ${POINT_COLS('readings').replace('readings.ts,', 'MIN(readings.ts) AS ts,')} FROM readings WHERE ts >= ?1
        GROUP BY ts / CAST(?2 AS INTEGER) ORDER BY ts`
    : `WITH RECURSIVE b(t) AS (SELECT ?1 UNION ALL SELECT t + ?2 FROM b WHERE t + ?2 < ?3)
       SELECT ${POINT_COLS('r')} FROM b JOIN readings r
           ON r.ts = (SELECT ts FROM readings WHERE ts >= b.t AND ts < b.t + ?2 ORDER BY ts LIMIT 1)
        ORDER BY r.ts`;
  const args = hours <= 48 ? [since, bucketMs] : [since, bucketMs, now];
  const [{ results }, cal] = await Promise.all([env.DB.prepare(sql).bind(...args).all(), socCal(env)]);
  for (const p of results) p.soc = dashSoc(p.soc, cal);
  return { since, bucketMs, points: results };
}

// Victron solar charger and DC-DC charger: newest values, a time series for each chart, the
// solar yield per day (the charger's own "today" total, taken while the sun is on the panels,
// since it only resets when they wake up the next morning) and how long the DC-DC charger ran
// per day. A row is stored on every change and at least every 15 minutes, so each "on" row
// counts until the next one, but for at most RUN_GAP_MS (the bridge app may have stopped).
// Finished days are kept in victron_days, so only today's rows are read for the day bars.
const RUN_GAP_MS = 20 * 60 * 1000;
const DAY_MS = 864e5;
const victronDay = (db, from, to, now) => [
  db.prepare(`SELECT MAX(yield_wh) AS wh FROM victron WHERE kind = 'solar' AND pv_w > 0 AND ts >= ? AND ts < ?`).bind(from, to),
  db.prepare(`WITH r AS (SELECT ts, state, LEAD(ts) OVER (ORDER BY ts) AS nx FROM victron WHERE kind = 'dcdc' AND ts >= ?1 AND ts < ?2 + ?3)
              SELECT SUM(MIN(COALESCE(nx, ?4), ts + ?3) - ts) AS on_ms FROM r WHERE state > 0 AND ts < ?2`).bind(from, to, RUN_GAP_MS, now),
];
async function victronDays(db, now) {
  const today = Math.floor(now / DAY_MS) * DAY_MS, first = today - 30 * DAY_MS;
  const { results: stored } = await db.prepare('SELECT * FROM victron_days WHERE day >= ?').bind(dayKey(first)).all();
  const have = new Set(stored.map((d) => d.day));
  // A day is stored once over (and the DC-DC charger's last run in it counted); a few per call.
  const store = [], live = [];
  for (let t = first; t <= today; t += DAY_MS) {
    if (have.has(dayKey(t))) continue;
    if (t + DAY_MS + RUN_GAP_MS > now) live.push(t); else if (store.length < 10) store.push(t);
  }
  const want = [...store, ...live];
  const res = await db.batch(want.flatMap((t) => victronDay(db, t, t + DAY_MS, now)));
  const got = want.map((t, i) => ({ day: dayKey(t), solar_wh: res[2 * i].results[0].wh, dcdc_on_ms: res[2 * i + 1].results[0].on_ms }));
  if (store.length) {
    const ins = db.prepare('INSERT OR REPLACE INTO victron_days (day, solar_wh, dcdc_on_ms) VALUES (?, ?, ?)');
    await db.batch(got.slice(0, store.length).map((d) => ins.bind(d.day, d.solar_wh, d.dcdc_on_ms)));
  }
  return [...stored, ...got].sort((a, b) => (a.day < b.day ? -1 : 1));
}

async function solar(env, hours) {
  const now = Date.now(), since = now - hours * 3600e3;
  const bucketMs = Math.max(60_000, Math.ceil((hours * 3600e3) / 600));
  const one = (kind) => env.DB.prepare('SELECT * FROM victron WHERE kind = ? ORDER BY ts DESC LIMIT 1').bind(kind).first();
  const [sol, dcdc, pts, dpts, days, rest] = await Promise.all([
    one('solar'), one('dcdc'),
    env.DB.prepare(`SELECT MIN(ts) AS ts, ROUND(AVG(pv_w)) AS pv_w, ROUND(AVG(batt_v), 2) AS batt_v
                      FROM victron WHERE kind = 'solar' AND ts >= ? GROUP BY ts / CAST(? AS INTEGER) ORDER BY ts`).bind(since, bucketMs).all(),
    env.DB.prepare(`SELECT MIN(ts) AS ts, ROUND(AVG(in_v), 2) AS in_v FROM victron
                     WHERE kind = 'dcdc' AND ts >= ? GROUP BY ts / CAST(? AS INTEGER) ORDER BY ts`).bind(since, bucketMs).all(),
    victronDays(env.DB, now),
    // The leisure battery's newest voltage while neither charger was charging it (last 24 h).
    env.DB.prepare(`SELECT ts, batt_v FROM victron s
                     WHERE kind = 'solar' AND ts >= ?1 AND batt_v > 0 AND COALESCE(batt_a, 0) < ${CHARGING_A} AND COALESCE(state, 0) NOT IN (${HELD.join(', ')})
                       AND COALESCE((SELECT state FROM victron d WHERE d.kind = 'dcdc' AND d.ts <= s.ts AND d.ts > s.ts - ?2
                                       ORDER BY d.ts DESC LIMIT 1), 0) = 0
                     ORDER BY ts DESC LIMIT 1`).bind(now - 864e5, RUN_GAP_MS).first(),
  ]);
  return {
    solar: sol, dcdc, points: pts.results, dcdc_points: dpts.results, leisure: leisureCharge(sol, dcdc, rest),
    days: days.filter((d) => d.solar_wh !== null).map((d) => ({ day: d.day, wh: d.solar_wh })),
    dcdc_days: days.filter((d) => d.dcdc_on_ms !== null).map((d) => ({ day: d.day, on_ms: d.dcdc_on_ms })),
  };
}

async function stats(env, hours) {
  const since = Date.now() - hours * 3600 * 1000;
  return { since, ...(await rangeStats(env.DB, since)) };
}

// Days Trola was driven between two times (ms), for marking them in the photo picker. Days are
// in the viewer's time zone: tz = minutes east of UTC.
const MAX_DROVE_MS = 4 * 366 * 864e5;
async function droveDays(env, from, to, tz) {
  from = Math.max(from, to - MAX_DROVE_MS);
  const { results } = await env.DB.prepare(
    `SELECT (ts + CAST(?3 AS INTEGER)) / 86400000 AS d, ROUND(MAX(odo) - MIN(odo)) AS km FROM readings
      WHERE ts >= ?1 AND ts < ?2 AND odo > 0 GROUP BY d HAVING km > 0 ORDER BY d`
  ).bind(from, to, tz * 60000).all();
  return { days: results.map((r) => ({ day: dayKey(r.d * 864e5), km: r.km })) };
}

// One month of day summaries (finished days are stored, today is live). month = YYYY-MM.
async function monthly(env, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) month = dayKey(Date.now()).slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const from = Date.UTC(y, m - 1, 1), to = Date.UTC(y, m, 1);
  const added = await ensureDays(env.DB, from, to);
  const [days, first, s] = await Promise.all([
    listDays(env.DB, dayKey(from), dayKey(to - 1)),
    env.DB.prepare('SELECT MIN(ts) AS ts FROM readings').first(),
    getSettings(env.DB, ['price']),
  ]);
  return { month, days, first_month: first && first.ts ? dayKey(first.ts).slice(0, 7) : month,
    price: s.price ?? null, pending: added >= 10, co2_g_per_km: CO2_SAVED_G_PER_KM };
}

export default {
  async fetch(request, env, ctx) {
    const viewer = await getViewer(request, env, ctx);
    if (!viewer) {
      return new Response('Forbidden: open this page through Cloudflare Access.', { status: 403 });
    }
    const admin = isAdmin(viewer, env);

    const url = new URL(request.url);
    const method = request.method;
    if (url.pathname === '/api/me') return json({ email: viewer.email, admin, photos: !!env.PHOTOS });
    if (url.pathname === '/api/photos' && method === 'GET') return listPhotos(env);
    if (url.pathname.startsWith('/photos/') && method === 'GET') {
      const key = url.pathname.slice('/photos/'.length);
      if (!/^[0-9a-f-]{36}((_t)?\.jpg|\.mp4)$/.test(key)) return new Response('Not found', { status: 404 });
      return servePhoto(env, key, undefined, request);
    }
    if (url.pathname === MEDIABUNNY_PATH) {
      return new Response(mediabunny, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable' } });
    }
    if (url.pathname.startsWith('/api/admin/')) {
      if (!admin) return json({ error: 'Only the admin can do that.' }, 403);
      const origin = request.headers.get('Origin');
      if (method !== 'GET' && origin && origin !== url.origin) return json({ error: 'Bad origin.' }, 403);
      return handleAdmin(request, env, url);
    }
    if (url.pathname === '/api/drove') {
      const q = (k) => Number(url.searchParams.get(k)) || 0;
      return json(await droveDays(env, q('from'), q('to') || Date.now(), Math.max(-900, Math.min(900, q('tz')))));
    }
    if (url.pathname === '/api/monthly') return json(await monthly(env, url.searchParams.get('month') || ''));
    if (url.pathname.startsWith('/api/photos') || url.pathname === '/api/position') {
      if (!admin) return json({ error: 'Only the admin can do that.' }, 403);
      // Same-origin check: uploads and deletes only from this page.
      const origin = request.headers.get('Origin');
      if (method !== 'GET' && origin && origin !== url.origin) return json({ error: 'Bad origin.' }, 403);
      if (url.pathname === '/api/position') return positionAt(env, Number(url.searchParams.get('ts')) || Date.now());
      if (url.pathname === '/api/photos' && method === 'POST') return uploadPhoto(request, env, viewer);
      const m = url.pathname.match(/^\/api\/photos\/([0-9a-f-]{36})$/);
      if (m && method === 'PATCH') return updatePhoto(request, env, m[1]);
      if (m && method === 'DELETE') return deletePhoto(env, m[1]);
      return json({ error: 'Not found' }, 404);
    }
    if (url.pathname === '/api/latest') return json(await latest(env));
    if (url.pathname === '/api/charges') {
      const [sessions, cal] = await Promise.all([listSessions(env.DB), socCal(env)]);
      for (const c of sessions) Object.assign(c, { soc_start: dashSoc(c.soc_start, cal), soc_end: dashSoc(c.soc_end, cal) });
      return json({ sessions });
    }
    if (url.pathname === '/api/track') {
      const hours = Math.min(MAX_HOURS, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      return json(await track(env, hours));
    }
    if (url.pathname === '/api/solar') {
      const hours = Math.min(MAX_HOURS, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      return json(await solar(env, hours));
    }
    if (url.pathname === '/api/stats') {
      const hours = Math.min(MAX_HOURS, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      return json(await stats(env, hours));
    }
    if (url.pathname === '/logo') {
      return new Response(logo, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'private, max-age=3600' } });
    }
    if (url.pathname === '/banner.jpg') {
      return new Response(banner, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
    }
    if (url.pathname === '/manifest.webmanifest') {
      return new Response(JSON.stringify(manifest), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'private, max-age=3600' } });
    }
    if (url.pathname === '/sw.js') {
      return new Response(serviceWorker, { headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' } });
    }
    const icons = { '/icon-192.png': icon192, '/icon-512.png': icon512, '/icon-maskable-512.png': iconMaskable };
    if (icons[url.pathname]) {
      return new Response(icons[url.pathname], { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' } });
    }
    // A share that arrived before the service worker was running: just open the page.
    if (url.pathname === '/share') return Response.redirect(new URL('/?shared=0', url), 303);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  },
};
