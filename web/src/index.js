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
import { handleAdmin } from './admin.js';
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
    price: s.price ?? null, pending: added >= 10 };
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
