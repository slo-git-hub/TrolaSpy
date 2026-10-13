import page from './page.html';
import logo from './logo.svg';
import banner from './banner.jpg';
import icon192 from './icon-192.png';
import icon512 from './icon-512.png';
import iconMaskable from './icon-maskable-512.png';
import { manifest, serviceWorker } from './pwa.js';
import { listSessions } from '../../shared/charges.js';
import { rangeStats, ensureDays, listDays, dayKey } from '../../shared/stats.js';
import { getSettings } from '../../shared/alerts.js';
import { CO2_SAVED_G_PER_KM } from '../../shared/co2.js';
import { leisureCharge, HELD, CHARGING_A } from '../../shared/lifepo4.js';
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

async function latest(env) {
  const row = await env.DB.prepare('SELECT * FROM readings ORDER BY ts DESC LIMIT 1').first();
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
  // Last known position, in case the newest upload had no GPS fix.
  const pos = row && row.lat === null
    ? await env.DB.prepare('SELECT ts, lat, lon FROM readings WHERE lat IS NOT NULL ORDER BY ts DESC LIMIT 1').first()
    : null;
  return { reading: row, lastPosition: pos, co2_g_per_km: CO2_SAVED_G_PER_KM };
}

async function track(env, hours) {
  const since = Date.now() - hours * 3600 * 1000;
  // Downsample so long ranges stay light: one point per bucket.
  const bucketMs = Math.max(10_000, Math.ceil((hours * 3600 * 1000) / MAX_POINTS));
  // No power for charging readings that came without the battery current, so the chart skips them.
  const { results } = await env.DB.prepare(
    `SELECT MIN(ts) AS ts, lat, lon, NULLIF(soc, 0) AS soc, speed, chrg_pwr, pwr_sw, bat_temp, amb_temp,
            CASE WHEN chrg_mode > 0 AND COALESCE(bat_volts * bat_amps, 0) = 0 THEN NULL
                 ELSE ROUND(bat_volts * bat_amps / 1000.0, 2) END AS kw
       FROM readings WHERE ts >= ?
      GROUP BY ts / ?
      ORDER BY ts`
  ).bind(since, bucketMs).all();
  return { since, bucketMs, points: results };
}

// Victron solar charger and DC-DC charger: newest values, a time series for each chart, the
// solar yield per day (the charger's own "today" total, taken while the sun is on the panels,
// since it only resets when they wake up the next morning) and how long the DC-DC charger ran
// per day. A row is stored on every change and at least every 15 minutes, so each "on" row
// counts until the next one, but for at most RUN_GAP_MS (the bridge app may have stopped).
const RUN_GAP_MS = 20 * 60 * 1000;
async function solar(env, hours) {
  const now = Date.now(), since = now - hours * 3600e3, month = now - 30 * 864e5;
  const bucketMs = Math.max(60_000, Math.ceil((hours * 3600e3) / 600));
  const one = (kind) => env.DB.prepare('SELECT * FROM victron WHERE kind = ? ORDER BY ts DESC LIMIT 1').bind(kind).first();
  const [sol, dcdc, pts, days, dpts, runs, rest] = await Promise.all([
    one('solar'), one('dcdc'),
    env.DB.prepare(`SELECT MIN(ts) AS ts, ROUND(AVG(pv_w)) AS pv_w, ROUND(AVG(batt_v), 2) AS batt_v
                      FROM victron WHERE kind = 'solar' AND ts >= ? GROUP BY ts / ? ORDER BY ts`).bind(since, bucketMs).all(),
    env.DB.prepare(`SELECT ts / 86400000 AS d, MAX(yield_wh) AS wh FROM victron
                     WHERE kind = 'solar' AND pv_w > 0 AND ts >= ? GROUP BY d ORDER BY d`).bind(month).all(),
    env.DB.prepare(`SELECT MIN(ts) AS ts, ROUND(AVG(in_v), 2) AS in_v FROM victron
                     WHERE kind = 'dcdc' AND ts >= ? GROUP BY ts / ? ORDER BY ts`).bind(since, bucketMs).all(),
    env.DB.prepare(`WITH r AS (SELECT ts, state, LEAD(ts) OVER (ORDER BY ts) AS nx FROM victron WHERE kind = 'dcdc' AND ts >= ?1)
                    SELECT ts / 86400000 AS d, SUM(MIN(COALESCE(nx, ?2), ts + ?3) - ts) AS on_ms FROM r
                     WHERE state > 0 GROUP BY d ORDER BY d`).bind(month, now, RUN_GAP_MS).all(),
    // The leisure battery's newest voltage while neither charger was charging it (last 24 h).
    env.DB.prepare(`SELECT ts, batt_v FROM victron s
                     WHERE kind = 'solar' AND ts >= ?1 AND batt_v > 0 AND COALESCE(batt_a, 0) < ${CHARGING_A} AND COALESCE(state, 0) NOT IN (${HELD.join(', ')})
                       AND COALESCE((SELECT state FROM victron d WHERE d.kind = 'dcdc' AND d.ts <= s.ts AND d.ts > s.ts - ?2
                                       ORDER BY d.ts DESC LIMIT 1), 0) = 0
                     ORDER BY ts DESC LIMIT 1`).bind(now - 864e5, RUN_GAP_MS).first(),
  ]);
  return {
    solar: sol, dcdc, points: pts.results, dcdc_points: dpts.results, leisure: leisureCharge(sol, dcdc, rest),
    days: days.results.map((r) => ({ day: dayKey(r.d * 864e5), wh: r.wh })),
    dcdc_days: runs.results.map((r) => ({ day: dayKey(r.d * 864e5), on_ms: r.on_ms })),
  };
}

async function stats(env, hours) {
  const since = Date.now() - hours * 3600 * 1000;
  return { since, ...(await rangeStats(env.DB, since)) };
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
      if (!/^[0-9a-f-]{36}(_t)?\.jpg$/.test(key)) return new Response('Not found', { status: 404 });
      return servePhoto(env, key);
    }
    if (url.pathname.startsWith('/api/admin/')) {
      if (!admin) return json({ error: 'Only the admin can do that.' }, 403);
      const origin = request.headers.get('Origin');
      if (method !== 'GET' && origin && origin !== url.origin) return json({ error: 'Bad origin.' }, 403);
      return handleAdmin(request, env, url);
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
    if (url.pathname === '/api/charges') return json({ sessions: await listSessions(env.DB) });
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
