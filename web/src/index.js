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
// The admin report's Excel writer, loaded only when a file is made.
import xlsxModule from './xlsx.mjs';
import { listSessions } from '../../shared/charges.js';
import { rangeStats, ensureDays, listDays, dayKey } from '../../shared/stats.js';
import { getSettings } from '../../shared/alerts.js';
import { CO2_SAVED_G_PER_KM } from '../../shared/co2.js';
import { victronDays } from '../../shared/victron-days.js';
import { latestReading, victronNow } from '../../shared/latest.js';
import { track as trackPoints } from '../../shared/track.js';
import { handleAdmin } from './admin.js';
import { getViewer, isAdmin } from './access.js';
import { listPhotos, servePhoto, positionAt, uploadPhoto, replacePhoto, updatePhoto, deletePhoto } from './photos.js';

const MAX_HOURS = 30 * 24; // solar charts
const MAX_POINTS = 3000;
// The route, chart and totals cover up to a year, or a range of days the viewer picks.
const MAX_RANGE_MS = 400 * 864e5;
// Totals over a long range read days without a summary directly, but only this many per call.
const STATS_LIVE_DAYS = 4;

// ?hours=N is the last N hours; ?from=&to= (ms since epoch) a range of the viewer's choosing.
function rangeOf(url) {
  const now = Date.now(), q = url.searchParams;
  const from = Number(q.get('from')), to = Number(q.get('to'));
  if (from > 0 && to > from) {
    const until = Math.min(to, now);
    return { since: Math.max(from, until - MAX_RANGE_MS), until };
  }
  return { since: now - Math.min(Math.max(1, Number(q.get('hours')) || 24) * 3600e3, MAX_RANGE_MS), until: now };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function latest(env) {
  const { reading, lastPosition, tz } = await latestReading(env.DB);
  return { reading, lastPosition, tz, co2_g_per_km: CO2_SAVED_G_PER_KM };
}

// The route, downsampled (see shared/track.js), with what the chart needs.
const POINT_COLS = (r) => `${r}.ts, ${r}.lat, ${r}.lon, NULLIF(${r}.soc, 0) AS soc, ${r}.speed, ${r}.chrg_pwr, ${r}.pwr_sw, ${r}.bat_temp, ${r}.amb_temp,
  CASE WHEN ${r}.chrg_mode > 0 AND COALESCE(${r}.bat_volts * ${r}.bat_amps, 0) = 0 THEN NULL
       ELSE ROUND(${r}.bat_volts * ${r}.bat_amps / 1000.0, 2) END AS kw`; // none for charging readings without the current
const track = (env, since, until) => trackPoints(env.DB, since, until, POINT_COLS('r'), MAX_POINTS);

// Victron solar charger and DC-DC charger: newest values, a time series for each chart, and the
// day totals of the last 30 days (see victron-days.js).
const DAY_MS = 864e5;
async function solar(env, hours) {
  const now = Date.now(), since = now - hours * 3600e3, today = Math.floor(now / DAY_MS) * DAY_MS;
  const bucketMs = Math.max(60_000, Math.ceil((hours * 3600e3) / 600));
  const [{ solar: sol, dcdc, leisure }, pts, dpts, days] = await Promise.all([
    victronNow(env.DB, now),
    env.DB.prepare(`SELECT MIN(ts) AS ts, ROUND(AVG(pv_w)) AS pv_w, ROUND(AVG(batt_v), 2) AS batt_v
                      FROM victron WHERE kind = 'solar' AND ts >= ? GROUP BY ts / CAST(? AS INTEGER) ORDER BY ts`).bind(since, bucketMs).all(),
    env.DB.prepare(`SELECT MIN(ts) AS ts, ROUND(AVG(in_v), 2) AS in_v FROM victron
                     WHERE kind = 'dcdc' AND ts >= ? GROUP BY ts / CAST(? AS INTEGER) ORDER BY ts`).bind(since, bucketMs).all(),
    victronDays(env.DB, now, today - 30 * DAY_MS, today).then((v) => v.days),
  ]);
  return {
    solar: sol, dcdc, points: pts.results, dcdc_points: dpts.results, leisure,
    days: days.filter((d) => d.solar_wh !== null).map((d) => ({ day: d.day, wh: d.solar_wh })),
    dcdc_days: days.filter((d) => d.dcdc_on_ms !== null).map((d) => ({ day: d.day, on_ms: d.dcdc_on_ms })),
  };
}

async function stats(env, since, until) {
  if (until <= since) return { since, until, readings: 0 };
  return { since, until, ...(await rangeStats(env.DB, since, until, STATS_LIVE_DAYS)) };
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
    if (url.pathname === '/api/photos' && method === 'GET') return listPhotos(env, admin);
    if (url.pathname.startsWith('/photos/') && method === 'GET') {
      const key = url.pathname.slice('/photos/'.length);
      if (!/^[0-9a-f-]{36}((_t)?\.jpg|\.mp4)$/.test(key)) return new Response('Not found', { status: 404 });
      return servePhoto(env, key, undefined, request);
    }
    if (url.pathname === MEDIABUNNY_PATH) {
      return new Response(mediabunny, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable' } });
    }
    if (url.pathname === '/vendor/xlsx.mjs') {
      return new Response(xlsxModule, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, no-cache' } });
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
      const rm = url.pathname.match(/^\/api\/photos\/([0-9a-f-]{36})\/replace$/);
      if (rm && method === 'POST') return replacePhoto(request, env, rm[1]);
      return json({ error: 'Not found' }, 404);
    }
    if (url.pathname === '/api/latest') return json(await latest(env));
    if (url.pathname === '/api/charges') return json({ sessions: await listSessions(env.DB) });
    if (url.pathname === '/api/track') {
      const { since, until } = rangeOf(url);
      return json(await track(env, since, until));
    }
    if (url.pathname === '/api/solar') {
      const hours = Math.min(MAX_HOURS, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      return json(await solar(env, hours));
    }
    if (url.pathname === '/api/stats') {
      const { since, until } = rangeOf(url);
      return json(await stats(env, since, until));
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
