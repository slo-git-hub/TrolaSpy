import { archiveSessions } from '../../shared/charges.js';
import { ensureDays } from '../../shared/stats.js';
import { checkAlerts, checkQuietCharge } from '../../shared/alerts.js';
import { parseReading, COLUMNS } from './parse.js';
import { handleBridge } from './bridge.js';

const LEAFSPY_OK = '"status":"0"';
const DAILY_CRON = '17 3 * * *'; // as in wrangler.toml

const INSERT_SQL = `INSERT OR REPLACE INTO readings (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`;

// Constant-time string comparison so the password can't be guessed by timing.
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a || '');
  const y = enc.encode(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// The TrolaSpy Bridge app logs in with LeafSpy's user name and password (HTTP Basic).
async function bridge(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!env.LEAFSPY_USER || !env.LEAFSPY_PASS) return json({ error: 'Server not configured' }, 500);
  const [user, pass] = (() => {
    try { return atob((request.headers.get('Authorization') || '').replace(/^Basic\s+/i, '')).split(/:(.*)/s); } catch { return []; }
  })();
  if (!safeEqual(user, env.LEAFSPY_USER) || !safeEqual(pass, env.LEAFSPY_PASS)) return json({ error: 'Wrong user name or password' }, 403);
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Bad body' }, 400);
  return json(await handleBridge(env.DB, body));
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    const url = new URL(request.url);
    if (url.pathname === '/bridge') return bridge(request, env);
    const params = url.searchParams;
    if (!params.has('user')) {
      return new Response('TrolaSpy ingest is running.\n', { headers: { 'content-type': 'text/plain' } });
    }
    if (!env.LEAFSPY_USER || !env.LEAFSPY_PASS) {
      return new Response('Server not configured', { status: 500 });
    }
    if (!safeEqual(params.get('user'), env.LEAFSPY_USER) || !safeEqual(params.get('pass'), env.LEAFSPY_PASS)) {
      return new Response('Forbidden', { status: 403 });
    }

    const row = parseReading(params);
    await env.DB.prepare(INSERT_SQL).bind(...COLUMNS.map((c) => row[c])).run();
    // Phone alerts run after the reply, so LeafSpy is never kept waiting.
    ctx.waitUntil(checkAlerts(env.DB, row).catch((e) => console.log('alerts:', e.message)));

    return new Response(LEAFSPY_OK, { headers: { 'content-type': 'application/json' } });
  },

  async scheduled(event, env) {
    await checkQuietCharge(env.DB); // every 10 min: a charge LeafSpy stopped seeing has ended
    if (event.cron !== DAILY_CRON) return;
    await archiveSessions(env.DB); // keep charging sessions before any readings go
    await ensureDays(env.DB); // day summaries for the monthly view and battery health
    // RETENTION_DAYS = "0" (the default) keeps readings forever.
    const days = Number(env.RETENTION_DAYS) || 0;
    if (days <= 0) return;
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    await env.DB.prepare('DELETE FROM readings WHERE ts < ?').bind(cutoff).run();
  },
};
