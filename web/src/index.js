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
    `SELECT MIN(ts) AS ts, lat, lon, soc, speed, chrg_pwr, pwr_sw, bat_temp, amb_temp,
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
const MAX_GAP_MS = 60_000;
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
       MAX(odo) - MIN(odo) AS distance_km,
       MIN(bat_temp) AS bat_temp_min, MAX(bat_temp) AS bat_temp_max,
       MIN(amb_temp) AS amb_temp_min, MAX(amb_temp) AS amb_temp_max,
       MAX(CASE WHEN chrg_mode = 0 AND pwr_sw = 1 THEN -w END) / 1000.0 AS max_regen_kw, MAX(w) / 1000.0 AS max_power_kw
     FROM r`
  ).bind(MAX_GAP_MS, MS_PER_KWH, since).first();
  return { since, ...row };
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
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  },
};
