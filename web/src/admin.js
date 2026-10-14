// Admin-only API: alert, public-page and Victron settings, battery health, reports, and backup / restore / delete of readings.
import { COLUMNS, checkValues } from '../../ingest/src/parse.js';
import { DEFAULT_ALERTS, getSettings, putSetting, sendAlert } from '../../shared/alerts.js';
import { createVapidKeys } from '../../shared/push.js';
import { DETAIL_KM, DELAYS_H, publicSettings } from '../../shared/public.js';
import { ensureDays, forgetDays, listDays } from '../../shared/stats.js';
import { archiveSessions, listSessions, rewindSessions } from '../../shared/charges.js';
import { victronDays } from '../../shared/victron-days.js';
import { CO2_SAVED_G_PER_KM } from '../../shared/co2.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const EXPORT_PAGE = 2000;
const IMPORT_MAX = 500;
const DAY_MS = 864e5;
const REPORT_MAX_DAYS = 400;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Day summaries, solar days and charging sessions for the days from..to (YYYY-MM-DD, UTC days,
// both included). Days not summed up yet are worked out first, a few per call: until then the
// answer is { pending: true } and the page asks again.
async function report(db, from, to) {
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`), now = Date.now();
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || !(a <= b)) return { error: 'Pick a start and an end day.' };
  if ((b - a) / DAY_MS >= REPORT_MAX_DAYS) return { error: `Pick at most ${REPORT_MAX_DAYS} days.` };
  // A call that worked out days stops there, to stay well inside the free plan's 50 subrequests.
  if (await ensureDays(db, a, b + DAY_MS) > 0) return { pending: true };
  const solar = await victronDays(db, now, a, Math.min(b, Math.floor(now / DAY_MS) * DAY_MS), 20);
  if (solar.more) return { pending: true };
  const [days, sessions, s] = await Promise.all([listDays(db, from, to), listSessions(db), getSettings(db, ['price'])]);
  return { from, to, days, solar: solar.days, price: s.price ?? null, co2_g_per_km: CO2_SAVED_G_PER_KM,
    charges: sessions.filter((c) => c.start_ts >= a && c.start_ts < b + DAY_MS).reverse() };
}

// TrolaSpy's own key pair for signing alerts, made the first time the admin page asks.
async function vapid(db, url) {
  const s = await getSettings(db, ['vapid']);
  if (s.vapid) return s.vapid;
  const keys = await createVapidKeys(url.origin);
  await putSetting(db, 'vapid', keys);
  return keys;
}

// The public page is the "trola" Worker on the same workers.dev subdomain (or PUBLIC_URL).
const publicUrl = (env, url) => env.PUBLIC_URL
  || (url.hostname.endsWith('.workers.dev') ? `https://${url.hostname.replace(/^[^.]+/, 'trola')}/` : null);

// Where LeafSpy and the Bridge app upload: the "trolaspy-ingest" Worker next to this one (or INGEST_URL).
const ingestUrl = (env, url) => env.INGEST_URL
  || (url.hostname.endsWith('.workers.dev') ? `https://${url.hostname.replace(/^[^.]+/, 'trolaspy-ingest')}` : null);

// The ChatGPT connector: the "trolaspy-mcp" Worker (or MCP_URL), at a path with a secret.
const mcpBase = (env, url) => env.MCP_URL
  || (url.hostname.endsWith('.workers.dev') ? `https://${url.hostname.replace(/^[^.]+/, 'trolaspy-mcp')}` : null);
const mcpInfo = (env, url, m) => (m && m.token
  ? { on: true, url: mcpBase(env, url) && `${mcpBase(env, url)}/mcp/${m.token}`, made_ts: m.made_ts || null, used_ts: m.used_ts || null }
  : { on: false });
const newSecret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_');

// Cloudflare's free plan per UTC day: D1 rows read and written, Worker requests (whole account),
// from Cloudflare's GraphQL analytics. Needs an API token that may read account analytics, which
// the admin saves in the Data tab (setting "cf_token"); it is never sent back to the page.
const cfApi = (env) => env.CF_API_URL || 'https://api.cloudflare.com/client/v4'; // CF_API_URL: local testing
const CF_FREE = { rows_read: 5e6, rows_written: 1e5, requests: 1e5 };
async function cfAccount(env, token) {
  if (/^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID || '')) return env.CF_ACCOUNT_ID;
  const r = await fetch(`${cfApi(env)}/accounts?per_page=5`, { headers: { authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  return j.result && j.result.length ? j.result[0].id : null;
}
async function cfUsage(env, token, now = Date.now()) {
  const account = await cfAccount(env, token).catch(() => null);
  if (!account) return { error: "Cloudflare didn't accept the token, or didn't say which account it is for." };
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  const today = day(now), yesterday = day(now - DAY_MS);
  const since = Math.floor(now / 3600e3) * 3600e3 - 23 * 3600e3; // the last 24 hours, this one included
  const query = `query ($a: string!, $from: Date!, $to: Date!, $since: Time!) { viewer { accounts(filter: { accountTag: $a }) {
    days: d1AnalyticsAdaptiveGroups(limit: 20, filter: { date_geq: $from, date_leq: $to }) { sum { rowsRead rowsWritten } dimensions { date } }
    hours: d1AnalyticsAdaptiveGroups(limit: 50, filter: { datetimeHour_geq: $since }) { sum { rowsRead rowsWritten } dimensions { datetimeHour } }
    workers: workersInvocationsAdaptive(limit: 200, filter: { date_geq: $from, date_leq: $to }) { sum { requests } dimensions { date } } } } }`;
  let j = null, status = 0;
  try {
    const r = await fetch(`${cfApi(env)}/graphql`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { a: account, from: yesterday, to: today, since: new Date(since).toISOString() } }) });
    status = r.status; j = await r.json();
  } catch { /* below */ }
  const a = j && j.data && j.data.viewer && j.data.viewer.accounts[0];
  if (!a) return { error: `Cloudflare said: ${(j && j.errors && j.errors[0] && j.errors[0].message) || status || 'no answer'}` };
  const sum = (list, d, k) => (list || []).filter((x) => x.dimensions.date === d).reduce((t, x) => t + (x.sum[k] || 0), 0);
  const totals = (d) => ({ date: d, rows_read: sum(a.days, d, 'rowsRead'), rows_written: sum(a.days, d, 'rowsWritten'), requests: sum(a.workers, d, 'requests') });
  const byHour = new Map((a.hours || []).map((x) => [Date.parse(x.dimensions.datetimeHour), x.sum]));
  const hours = Array.from({ length: 24 }, (_, i) => {
    const ts = since + i * 3600e3, h = byHour.get(ts) || {};
    return { ts, rows_read: h.rowsRead || 0, rows_written: h.rowsWritten || 0 };
  });
  return { today: totals(today), yesterday: totals(yesterday), hours, free: CF_FREE,
    last_24h: { rows_read: hours.reduce((t, h) => t + h.rows_read, 0), rows_written: hours.reduce((t, h) => t + h.rows_written, 0) },
    resets_ts: Date.parse(`${today}T00:00:00Z`) + DAY_MS, checked_ts: now };
}

// Total size of the photo files in R2 (photo + thumbnail each). Each list call is a
// subrequest, and a free-plan Worker may make 50, so very large buckets are only counted in part.
async function photoBytes(bucket) {
  if (!bucket) return { bytes: null, partial: false };
  let bytes = 0, cursor;
  for (let page = 0; page < 40; page++) {
    const r = await bucket.list({ prefix: 'photos/', cursor, limit: 1000 });
    for (const o of r.objects) bytes += o.size;
    if (!r.truncated) return { bytes, partial: false };
    cursor = r.cursor;
  }
  return { bytes, partial: true };
}

// Browsers that get alerts, without their keys.
const devices = (subs) => (subs || []).map(({ endpoint, label, added }) => ({ endpoint, label, added }));

export async function handleAdmin(request, env, url) {
  const db = env.DB;
  const path = url.pathname.slice('/api/admin/'.length);
  const method = request.method;

  if (path === 'settings' && method === 'GET') {
    const s = await getSettings(db, ['alerts', 'price', 'push_subs', 'victron', 'bridge', 'mcp']);
    return json({ alerts: { ...DEFAULT_ALERTS, ...(s.alerts || {}) }, price: s.price ?? null,
      push_key: (await vapid(db, url)).publicKey, devices: devices(s.push_subs),
      public: await publicSettings(db), public_url: publicUrl(env, url),
      victron: { solar: '', dcdc: '', ...(s.victron || {}) }, bridge: s.bridge || null, ingest_url: ingestUrl(env, url),
      mcp: mcpInfo(env, url, s.mcp) });
  }
  if (path === 'settings' && method === 'PUT') {
    const body = await request.json();
    const a = body.alerts || {};
    const clamp = (v, d) => Math.min(100, Math.max(1, Math.round(Number(v)) || d));
    const alerts = {
      enabled: !!a.enabled, target_on: !!a.target_on, target_soc: clamp(a.target_soc, 80),
      done_on: !!a.done_on, low_on: !!a.low_on, low_soc: clamp(a.low_soc, 20),
    };
    const price = body.price === null || body.price === '' ? null : Math.max(0, Number(body.price)) || 0;
    await Promise.all([putSetting(db, 'alerts', alerts), putSetting(db, 'price', price)]);
    return json({ ok: true, alerts, price });
  }
  if (path === 'public' && method === 'PUT') {
    const b = await request.json();
    const cfg = {
      enabled: !!b.enabled, photos: !!b.photos,
      detail: DETAIL_KM[b.detail] ? b.detail : 'town',
      delay_h: DELAYS_H.includes(Number(b.delay_h)) ? Number(b.delay_h) : 0,
    };
    await putSetting(db, 'public', cfg);
    return json({ public: cfg });
  }
  // Body { on }: on makes a new secret address (the old one stops working); off removes it.
  if (path === 'mcp' && method === 'POST') {
    const b = await request.json();
    const m = b.on ? { token: newSecret(), made_ts: Date.now() } : null;
    if (m) await putSetting(db, 'mcp', m); else await db.prepare("DELETE FROM settings WHERE key = 'mcp'").run();
    return json({ mcp: mcpInfo(env, url, m) });
  }
  if (path === 'victron' && method === 'PUT') {
    const b = await request.json();
    const key = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
    const keys = { solar: key(b.solar), dcdc: key(b.dcdc) };
    for (const k of Object.values(keys)) {
      if (k && !/^[0-9a-f]{32}$/.test(k)) return json({ error: 'A key is 32 characters: digits 0-9 and letters a-f.' }, 400);
    }
    await putSetting(db, 'victron', keys);
    return json({ victron: keys });
  }
  if (path === 'push-subscribe' && method === 'POST') {
    const { subscription: sub, label } = await request.json();
    if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
      return json({ error: 'This browser gave no usable subscription.' }, 400);
    }
    const s = await getSettings(db, ['push_subs', 'alerts']);
    const subs = (s.push_subs || []).filter((x) => x.endpoint !== sub.endpoint);
    subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      label: String(label || 'Browser').slice(0, 60), added: Date.now() });
    // Turning alerts on for a phone also switches them on.
    const alerts = { ...DEFAULT_ALERTS, ...(s.alerts || {}), enabled: true };
    await Promise.all([putSetting(db, 'push_subs', subs), putSetting(db, 'alerts', alerts)]);
    return json({ devices: devices(subs), alerts });
  }
  if (path === 'push-unsubscribe' && method === 'POST') {
    const { endpoint } = await request.json();
    const s = await getSettings(db, ['push_subs']);
    const subs = (s.push_subs || []).filter((x) => x.endpoint !== endpoint);
    await putSetting(db, 'push_subs', subs);
    return json({ devices: devices(subs) });
  }
  if (path === 'alert-test' && method === 'POST') {
    try {
      const sent = await sendAlert(db, { title: 'TrolaSpy test', body: 'Alerts from Trola will arrive like this.', tags: ['wave'] });
      return json({ ok: true, sent });
    } catch (e) {
      return json({ ok: false, error: `Could not send: ${e.message}` }, 502);
    }
  }

  if (path === 'report' && method === 'GET') {
    const r = await report(db, url.searchParams.get('from') || '', url.searchParams.get('to') || '');
    return json(r, r.error ? 400 : 200);
  }

  if (path === 'health' && method === 'GET') {
    await ensureDays(db);
    const { results } = await db.prepare(
      'SELECT day, soh, hx, ahr FROM daily WHERE soh IS NOT NULL OR hx IS NOT NULL ORDER BY day').all();
    const today = await db.prepare(
      `SELECT AVG(NULLIF(soh, 0)) AS soh, AVG(NULLIF(hx, 0)) AS hx, AVG(NULLIF(ahr, 0)) AS ahr
         FROM readings WHERE ts >= ?`).bind(Math.floor(Date.now() / 864e5) * 864e5).first();
    if (today && today.soh) results.push({ day: new Date().toISOString().slice(0, 10), ...today });
    return json({ days: results });
  }

  if (path === 'usage' && method === 'GET') {
    const { cf_token: token } = await getSettings(db, ['cf_token']);
    if (!token) return json({ token: false });
    const u = await cfUsage(env, token);
    return json({ token: true, ...u });
  }
  if (path === 'usage' && method === 'PUT') {
    const token = String((await request.json()).token || '').trim();
    if (!token) { await db.prepare("DELETE FROM settings WHERE key = 'cf_token'").run(); return json({ token: false }); }
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return json({ error: "That doesn't look like a Cloudflare API token." }, 400);
    const u = await cfUsage(env, token);
    if (u.error) return json({ error: u.error }, 400);
    await putSetting(db, 'cf_token', token);
    return json({ token: true, ...u });
  }
  if (path === 'data' && method === 'GET') {
    // Counted from the day summaries plus today's readings: counting every reading would read
    // every row (D1's free plan allows 5 million rows read a day).
    const today = Math.floor(Date.now() / DAY_MS) * DAY_MS, key = (t) => new Date(t).toISOString().slice(0, 10);
    await ensureDays(db);
    const [days, live, first, last, photos, files] = await Promise.all([
      db.prepare('SELECT SUM(readings) AS n, SUM(CASE WHEN day >= ? THEN readings END) AS n30 FROM daily WHERE day < ?')
        .bind(key(today - 30 * DAY_MS), key(today)).first(),
      db.prepare('SELECT COUNT(*) AS n FROM readings WHERE ts >= ?').bind(today).first(),
      db.prepare('SELECT ts FROM readings ORDER BY ts LIMIT 1').first(),
      db.prepare('SELECT ts FROM readings ORDER BY ts DESC LIMIT 1').all(),
      db.prepare('SELECT COUNT(*) AS n FROM photos').first(),
      photoBytes(env.PHOTOS),
    ]);
    // D1 reports the database file size with every query.
    return json({ n: (days.n || 0) + live.n, first: first ? first.ts : null, last: last.results[0] ? last.results[0].ts : null,
      db_bytes: last.meta.size_after ?? null, readings_30d: (days.n30 || 0) + live.n,
      photos: photos.n, photo_bytes: files.bytes, photo_bytes_partial: files.partial });
  }
  if (path === 'export' && method === 'GET') {
    const after = Number(url.searchParams.get('after')) || 0;
    const { results } = await db.prepare(`SELECT ${COLUMNS.join(', ')} FROM readings WHERE ts > ? ORDER BY ts LIMIT ?`)
      .bind(after, EXPORT_PAGE).all();
    return json({ columns: COLUMNS, rows: results.map((r) => COLUMNS.map((c) => r[c])), more: results.length === EXPORT_PAGE });
  }
  if (path === 'import' && method === 'POST') {
    const { columns, rows } = await request.json();
    if (!Array.isArray(columns) || !Array.isArray(rows) || rows.length > IMPORT_MAX) return json({ error: 'Bad import chunk.' }, 400);
    const idx = COLUMNS.map((c) => columns.indexOf(c));
    if (idx[COLUMNS.indexOf('ts')] < 0) return json({ error: 'The file has no ts column.' }, 400);
    const num = (v) => (v === null || v === '' || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const stmt = db.prepare(`INSERT OR REPLACE INTO readings (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
    const good = rows.filter((r) => Array.isArray(r) && num(r[idx[0]]) > 0);
    const reading = (r) => checkValues(Object.fromEntries(COLUMNS.map((c, k) => [c, idx[k] < 0 ? null : num(r[idx[k]])])));
    if (good.length) await db.batch(good.map((r) => { const o = reading(r); return stmt.bind(...COLUMNS.map((c) => o[c])); }));
    const tss = good.map((r) => num(r[idx[0]]));
    if (tss.length) await Promise.all([forgetDays(db, Math.min(...tss), Math.max(...tss)), rewindSessions(db, Math.min(...tss))]);
    return json({ imported: good.length });
  }
  if (path === 'delete' && method === 'POST') {
    const { from, to } = await request.json();
    if (!(Number(from) > 0) || !(Number(to) > Number(from))) return json({ error: 'Pick a valid date range.' }, 400);
    const res = await db.prepare('DELETE FROM readings WHERE ts >= ? AND ts < ?').bind(from, to).run();
    await db.prepare('DELETE FROM charges WHERE start_ts < ? AND end_ts >= ?').bind(to, from).run();
    await forgetDays(db, from, to - 1);
    return json({ deleted: res.meta.changes });
  }
  if (path === 'reindex' && method === 'POST') {
    // After a restore: store charging sessions found in the restored readings, a stretch per call.
    return json(await archiveSessions(db));
  }
  return json({ error: 'Not found' }, 404);
}
