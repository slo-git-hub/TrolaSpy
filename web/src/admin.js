// Admin-only API: alert, public-page and Victron settings, battery health, and backup / restore / delete of readings.
import { COLUMNS } from '../../ingest/src/parse.js';
import { DEFAULT_ALERTS, getSettings, putSetting, sendAlert } from '../../shared/alerts.js';
import { createVapidKeys } from '../../shared/push.js';
import { DETAIL_KM, DELAYS_H, publicSettings } from '../../shared/public.js';
import { ensureDays, forgetDays } from '../../shared/stats.js';
import { archiveSessions } from '../../shared/charges.js';
import { addSocPoint, dashSoc, socPoints } from '../../shared/soc.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const EXPORT_PAGE = 2000;
// A dashboard reading is paired with LeafSpy's newest SOC, so that must be this fresh.
const SOC_FRESH_MS = 15 * 60 * 1000;

// Dashboard readings (see soc.js) and what LeafSpy reads now.
async function socCalInfo(db, cal) {
  const now = await db.prepare('SELECT ts, soc FROM readings WHERE soc > 0 ORDER BY ts DESC LIMIT 1').first();
  return { points: socPoints(cal).slice(0, -1), now: now && { ...now, dash: dashSoc(now.soc, cal) } };
}
const IMPORT_MAX = 500;

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
    const s = await getSettings(db, ['alerts', 'price', 'push_subs', 'victron', 'bridge', 'soc_cal']);
    return json({ alerts: { ...DEFAULT_ALERTS, ...(s.alerts || {}) }, price: s.price ?? null,
      push_key: (await vapid(db, url)).publicKey, devices: devices(s.push_subs),
      public: await publicSettings(db), public_url: publicUrl(env, url),
      victron: { solar: '', dcdc: '', ...(s.victron || {}) }, bridge: s.bridge || null, ingest_url: ingestUrl(env, url),
      soc_cal: await socCalInfo(db, s.soc_cal) });
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
  // Body { dash }: the dashboard shows this % now. Body { remove }: drop the reading at that LeafSpy %.
  if (path === 'soc-cal' && method === 'PUT') {
    const b = await request.json();
    let cal = socPoints((await getSettings(db, ['soc_cal'])).soc_cal).slice(0, -1);
    if (b.remove !== undefined) cal = cal.filter(([l]) => l !== Number(b.remove));
    else {
      const dash = Number(b.dash);
      if (b.dash === '' || b.dash === null || !(dash >= 0 && dash <= 100)) return json({ error: 'Enter the % the dashboard shows, 0 to 100.' }, 400);
      const now = await db.prepare('SELECT ts, soc FROM readings WHERE soc > 0 ORDER BY ts DESC LIMIT 1').first();
      if (!now || Date.now() - now.ts > SOC_FRESH_MS) return json({ error: 'LeafSpy has not sent the battery % in the last 15 minutes. Try again with the car on and LeafSpy running.' }, 409);
      if (now.soc >= 100) return json({ error: 'LeafSpy reads 100 %, which already matches the dashboard.' }, 400);
      cal = addSocPoint(cal, now.soc, dash);
    }
    await putSetting(db, 'soc_cal', cal);
    return json(await socCalInfo(db, cal));
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

  if (path === 'data' && method === 'GET') {
    const res = await db.prepare('SELECT COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last FROM readings').all();
    const [recent, photos, files] = await Promise.all([
      db.prepare('SELECT COUNT(*) AS n FROM readings WHERE ts >= ?').bind(Date.now() - 30 * 864e5).first(),
      db.prepare('SELECT COUNT(*) AS n FROM photos').first(),
      photoBytes(env.PHOTOS),
    ]);
    // D1 reports the database file size with every query.
    return json({ ...res.results[0], db_bytes: res.meta.size_after ?? null, readings_30d: recent.n,
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
    if (good.length) await db.batch(good.map((r) => stmt.bind(...idx.map((i) => (i < 0 ? null : num(r[i]))))));
    const tss = good.map((r) => num(r[idx[0]]));
    if (tss.length) await forgetDays(db, Math.min(...tss), Math.max(...tss));
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
    // After a restore: store charging sessions found in the restored readings.
    return json({ charges: await archiveSessions(db) });
  }
  return json({ error: 'Not found' }, 404);
}
