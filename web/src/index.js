import page from './page.html';
import logo from './logo.svg';
import banner from './banner.jpg';
import icon192 from './icon-192.png';
import icon512 from './icon-512.png';
import iconMaskable from './icon-maskable-512.png';
import { manifest, serviceWorker } from './pwa.js';
import { listSessions, computeSessions } from '../../shared/charges.js';
import { getViewer, isAdmin } from './access.js';
import { listPhotos, servePhoto, positionAt, uploadPhoto, deletePhoto } from './photos.js';

const MAX_HOURS = 30 * 24;
const MAX_POINTS = 3000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function latest(env) {
  const row = await env.DB.prepare('SELECT * FROM readings ORDER BY ts DESC LIMIT 1').first();
  // Last known position, in case the newest upload had no GPS fix.
  const pos = row && row.lat === null
    ? await env.DB.prepare('SELECT ts, lat, lon FROM readings WHERE lat IS NOT NULL ORDER BY ts DESC LIMIT 1').first()
    : null;
  return { reading: row, lastPosition: pos };
}

async function track(env, hours) {
  const since = Date.now() - hours * 3600 * 1000;
  // Downsample so long ranges stay light: one point per bucket.
  const bucketMs = Math.max(10_000, Math.ceil((hours * 3600 * 1000) / MAX_POINTS));
  const { results } = await env.DB.prepare(
    `SELECT MIN(ts) AS ts, lat, lon, NULLIF(soc, 0) AS soc, speed, chrg_pwr, pwr_sw, bat_temp, amb_temp,
            ROUND(bat_volts * bat_amps / 1000.0, 2) AS kw
       FROM readings WHERE ts >= ?
      GROUP BY ts / ?
      ORDER BY ts`
  ).bind(since, bucketMs).all();
  return { since, bucketMs, points: results };
}

// Energy and driving totals over a time range, computed in D1 (not in the Worker).
// Power is pack volts x amps: positive = drawing from the battery, negative = going in
// (regen while driving, or charging). Each reading's power is applied to the gap since
// the previous one; gaps over MAX_GAP_MS (LeafSpy off) count as nothing.
const MAX_GAP_MS = 150_000; // LeafSpy uploads every 35-120 s once the tablet dozes
const MS_PER_KWH = 3.6e9; // W x ms per kWh

async function stats(env, hours) {
  const since = Date.now() - hours * 3600 * 1000;
  const row = await env.DB.prepare(
    `WITH r AS (
       SELECT ts, odo, speed, pwr_sw, COALESCE(chrg_mode, 0) AS chrg_mode, bat_temp, amb_temp,
              bat_volts * bat_amps AS w,
              ts - LAG(ts) OVER (ORDER BY ts) AS dt
         FROM readings WHERE ts >= ?3)
     SELECT
       SUM(CASE WHEN dt <= ?1 AND w > 0 AND chrg_mode = 0 THEN w * dt END) / ?2 AS used_kwh,
       SUM(CASE WHEN dt <= ?1 AND w < 0 AND chrg_mode = 0 AND pwr_sw = 1 THEN -w * dt END) / ?2 AS regen_kwh,
       SUM(CASE WHEN dt <= ?1 AND w < 0 AND chrg_mode > 0 THEN -w * dt END) / ?2 AS charged_kwh,
       SUM(CASE WHEN dt <= ?1 AND speed > 1 THEN dt END) / 1000.0 AS drive_s,
       MAX(speed) AS max_speed,
       MAX(NULLIF(odo, 0)) - MIN(NULLIF(odo, 0)) AS distance_km,
       MIN(bat_temp) AS bat_temp_min, MAX(bat_temp) AS bat_temp_max,
       MIN(amb_temp) AS amb_temp_min, MAX(amb_temp) AS amb_temp_max,
       MAX(CASE WHEN chrg_mode = 0 AND pwr_sw = 1 THEN -w END) / 1000.0 AS max_regen_kw, MAX(w) / 1000.0 AS max_power_kw
     FROM r`
  ).bind(MAX_GAP_MS, MS_PER_KWH, since).first();
  // Charged energy comes from the charging sessions (they also count charges LeafSpy missed).
  const sessions = await computeSessions(env.DB, since);
  return { since, ...row, charged_kwh: sessions.reduce((t, s) => t + (s.kwh || 0), 0) };
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
    if (url.pathname.startsWith('/api/photos') || url.pathname === '/api/position') {
      if (!admin) return json({ error: 'Only the admin can do that.' }, 403);
      // Same-origin check: uploads and deletes only from this page.
      const origin = request.headers.get('Origin');
      if (method !== 'GET' && origin && origin !== url.origin) return json({ error: 'Bad origin.' }, 403);
      if (url.pathname === '/api/position') return positionAt(env, Number(url.searchParams.get('ts')) || Date.now());
      if (url.pathname === '/api/photos' && method === 'POST') return uploadPhoto(request, env, viewer);
      const m = url.pathname.match(/^\/api\/photos\/([0-9a-f-]{36})$/);
      if (m && method === 'DELETE') return deletePhoto(env, m[1]);
      return json({ error: 'Not found' }, 404);
    }
    if (url.pathname === '/api/latest') return json(await latest(env));
    if (url.pathname === '/api/charges') return json({ sessions: await listSessions(env.DB) });
    if (url.pathname === '/api/track') {
      const hours = Math.min(MAX_HOURS, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      return json(await track(env, hours));
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
