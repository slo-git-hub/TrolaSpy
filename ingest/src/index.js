import { archiveSessions } from '../../shared/charges.js';
import { parseReading, COLUMNS } from './parse.js';

const LEAFSPY_OK = '"status":"0"';

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

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    const params = new URL(request.url).searchParams;
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

    return new Response(LEAFSPY_OK, { headers: { 'content-type': 'application/json' } });
  },

  async scheduled(event, env) {
    await archiveSessions(env.DB); // keep charging sessions before any readings go
    // RETENTION_DAYS = "0" (the default) keeps readings forever.
    const days = Number(env.RETENTION_DAYS) || 0;
    if (days <= 0) return;
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    await env.DB.prepare('DELETE FROM readings WHERE ts < ?').bind(cutoff).run();
  },
};
