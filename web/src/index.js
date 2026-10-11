import page from './page.html';
import logo from './logo.svg';
import banner from './banner.jpg';
import { isAuthorized } from './access.js';

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
    `SELECT MIN(ts) AS ts, lat, lon, soc, speed, chrg_pwr, pwr_sw
       FROM readings WHERE ts >= ?
      GROUP BY ts / ?
      ORDER BY ts`
  ).bind(since, bucketMs).all();
  return { since, bucketMs, points: results };
}

export default {
  async fetch(request, env, ctx) {
    if (!env.DEV_NO_AUTH && !(await isAuthorized(request, env, ctx))) {
      return new Response('Forbidden: open this page through Cloudflare Access.', { status: 403 });
    }

    const url = new URL(request.url);
    if (url.pathname === '/api/latest') return json(await latest(env));
    if (url.pathname === '/api/track') {
      const hours = Math.min(MAX_HOURS, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      return json(await track(env, hours));
    }
    if (url.pathname === '/logo') {
      return new Response(logo, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'private, max-age=3600' } });
    }
    if (url.pathname === '/banner.jpg') {
      return new Response(banner, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' } });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  },
};
