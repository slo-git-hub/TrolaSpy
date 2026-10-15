// Photo and video pins: list, serve, upload, replace, caption and delete. Files are stored in R2 (binding
// PHOTOS), metadata in D1. The browser shrinks photos and videos and makes the thumbnail (for a
// video also a full-size frame) before uploading.

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 90 * 1024 * 1024; // 3 minutes at 720p is about 40 MB
const MAX_VIDEO_S = 185;
const TRACK_MATCH_MS = 30 * 60 * 1000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// The admin also gets each original file's name and size, so the page can tell what is on the map already.
export async function listPhotos(env, admin = false) {
  const { results } = await env.DB.prepare(
    `SELECT id, taken_ts, lat, lon, source, caption, width, height, duration, created_ts${admin ? ', orig_name, orig_size' : ''}
     FROM photos ORDER BY COALESCE(taken_ts, created_ts) DESC LIMIT 2000`
  ).all();
  return json({ photos: results });
}

// Videos are served in parts (HTTP Range) so they can start playing and skip ahead.
export async function servePhoto(env, key, cacheControl = 'private, max-age=31536000, immutable', request = null) {
  if (!env.PHOTOS) return new Response('Photo storage not configured', { status: 503 });
  const video = key.endsWith('.mp4');
  const ranged = video && request && request.headers.has('range');
  const obj = await env.PHOTOS.get(`photos/${key}`, ranged ? { range: request.headers } : undefined);
  if (!obj) return new Response('Not found', { status: 404 });
  const headers = { 'content-type': video ? 'video/mp4' : 'image/jpeg', 'cache-control': cacheControl, etag: obj.httpEtag };
  if (video) headers['accept-ranges'] = 'bytes';
  if (ranged && obj.range) {
    const r = obj.range; // { offset, length } or { suffix }; absent keys can be present as undefined
    const start = r.suffix !== undefined ? obj.size - r.suffix : r.offset || 0;
    const length = r.suffix !== undefined ? r.suffix : r.length ?? obj.size - start;
    headers['content-range'] = `bytes ${start}-${start + length - 1}/${obj.size}`;
    headers['content-length'] = String(length);
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { headers });
}

// Where was the van at a given time? Nearest GPS reading within 30 minutes.
export async function positionAt(env, ts) {
  const before = await env.DB.prepare('SELECT ts, lat, lon FROM readings WHERE ts <= ? AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1').bind(ts).first();
  const after = await env.DB.prepare('SELECT ts, lat, lon FROM readings WHERE ts >= ? AND lat IS NOT NULL ORDER BY ts ASC LIMIT 1').bind(ts).first();
  const best = [before, after].filter(Boolean).sort((a, b) => Math.abs(a.ts - ts) - Math.abs(b.ts - ts))[0];
  return json(best && Math.abs(best.ts - ts) <= TRACK_MATCH_MS ? { found: true, ...best } : { found: false });
}

// The files of an upload: the shrunk photo, its thumbnail and, for a video, the MP4 and its length.
function readFiles(form) {
  const image = form.get('image');
  const thumb = form.get('thumb');
  if (!(image instanceof File) || !(thumb instanceof File)) return { error: 'Missing image.', status: 400 };
  if (image.type !== 'image/jpeg' || thumb.type !== 'image/jpeg') return { error: 'Images must be JPEG.', status: 400 };
  if (image.size > MAX_BYTES || thumb.size > MAX_BYTES) return { error: 'Image too large.', status: 413 };
  const video = form.get('video');
  const duration = num(form.get('duration'));
  if (video !== null) {
    if (!(video instanceof File) || video.type !== 'video/mp4') return { error: 'Videos must be MP4.', status: 400 };
    if (video.size > MAX_VIDEO_BYTES) return { error: 'Video too large.', status: 413 };
    if (duration === null || duration <= 0 || duration > MAX_VIDEO_S) return { error: 'Videos can be up to 3 minutes.', status: 400 };
  }
  return { image, thumb, video, duration: video ? duration : null, width: num(form.get('width')), height: num(form.get('height')),
    orig_name: String(form.get('orig_name') || '').slice(0, 255) || null, orig_size: num(form.get('orig_size')) };
}

async function putFiles(env, id, f) {
  if (f.video) await env.PHOTOS.put(`photos/${id}.mp4`, f.video.stream(), { httpMetadata: { contentType: 'video/mp4' } });
  await env.PHOTOS.put(`photos/${id}.jpg`, f.image.stream(), { httpMetadata: { contentType: 'image/jpeg' } });
  await env.PHOTOS.put(`photos/${id}_t.jpg`, f.thumb.stream(), { httpMetadata: { contentType: 'image/jpeg' } });
}

const insertRow = (env, r) => env.DB.prepare(
  'INSERT INTO photos (id, taken_ts, lat, lon, source, caption, width, height, duration, created_ts, created_by, orig_name, orig_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
).bind(r.id, r.taken_ts, r.lat, r.lon, r.source, r.caption, r.width, r.height, r.duration, r.created_ts, r.created_by, r.orig_name ?? null, r.orig_size ?? null);
const filesOf = (id) => [`photos/${id}.jpg`, `photos/${id}_t.jpg`, `photos/${id}.mp4`];

export async function uploadPhoto(request, env, viewer) {
  if (!env.PHOTOS) return json({ error: 'Photo storage (R2) is not set up yet.' }, 503);
  const form = await request.formData();
  const f = readFiles(form);
  if (f.error) return json({ error: f.error }, f.status);
  const lat = num(form.get('lat'));
  const lon = num(form.get('lon'));
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: 'Missing location.' }, 400);

  const id = crypto.randomUUID();
  const source = ['exif', 'track', 'manual'].includes(form.get('source')) ? form.get('source') : 'manual';
  const caption = String(form.get('caption') || '').slice(0, 500);
  await putFiles(env, id, f);
  const row = {
    id, taken_ts: num(form.get('taken_ts')), lat, lon, source, caption,
    width: f.width, height: f.height, duration: f.duration, created_ts: Date.now(), created_by: viewer.email,
    orig_name: f.orig_name, orig_size: f.orig_size,
  };
  await insertRow(env, row).run();
  delete row.created_by;
  return json({ photo: row }, 201);
}

// A new photo or video for a pin: it keeps its place and caption, and takes the new file's time
// when it has one. The pin gets a new id, since photos are cached for good under theirs.
export async function replacePhoto(request, env, id) {
  if (!env.PHOTOS) return json({ error: 'Photo storage (R2) is not set up yet.' }, 503);
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'Bad id.' }, 400);
  const old = await env.DB.prepare('SELECT * FROM photos WHERE id = ?').bind(id).first();
  if (!old) return json({ error: 'Not found.' }, 404);
  const form = await request.formData();
  const f = readFiles(form);
  if (f.error) return json({ error: f.error }, f.status);

  const row = { ...old, id: crypto.randomUUID(), taken_ts: num(form.get('taken_ts')) ?? old.taken_ts, width: f.width, height: f.height, duration: f.duration,
    orig_name: f.orig_name, orig_size: f.orig_size };
  await putFiles(env, row.id, f);
  await env.DB.batch([insertRow(env, row), env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id)]);
  await env.PHOTOS.delete(filesOf(id));
  delete row.created_by;
  return json({ photo: row, replaced: id }, 201);
}

export async function updatePhoto(request, env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'Bad id.' }, 400);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.caption !== 'string') return json({ error: 'Missing caption.' }, 400);
  const caption = body.caption.trim().slice(0, 500);
  const res = await env.DB.prepare('UPDATE photos SET caption = ? WHERE id = ?').bind(caption, id).run();
  if (!res.meta.changes) return json({ error: 'Not found.' }, 404);
  return json({ id, caption });
}

export async function deletePhoto(env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'Bad id.' }, 400);
  await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
  if (env.PHOTOS) await env.PHOTOS.delete(filesOf(id));
  return json({ deleted: id });
}
