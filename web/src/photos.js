// Photo pins: list, serve, upload and delete. Images are stored in R2 (binding PHOTOS),
// metadata in D1. The browser resizes photos and makes the thumbnail before uploading.

const MAX_BYTES = 8 * 1024 * 1024;
const TRACK_MATCH_MS = 30 * 60 * 1000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export async function listPhotos(env) {
  const { results } = await env.DB.prepare(
    'SELECT id, taken_ts, lat, lon, source, caption, width, height, created_ts FROM photos ORDER BY COALESCE(taken_ts, created_ts) DESC LIMIT 2000'
  ).all();
  return json({ photos: results });
}

export async function servePhoto(env, key) {
  if (!env.PHOTOS) return new Response('Photo storage not configured', { status: 503 });
  const obj = await env.PHOTOS.get(`photos/${key}`);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', etag: obj.httpEtag },
  });
}

// Where was the van at a given time? Nearest GPS reading within 30 minutes.
export async function positionAt(env, ts) {
  const before = await env.DB.prepare('SELECT ts, lat, lon FROM readings WHERE ts <= ? AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1').bind(ts).first();
  const after = await env.DB.prepare('SELECT ts, lat, lon FROM readings WHERE ts >= ? AND lat IS NOT NULL ORDER BY ts ASC LIMIT 1').bind(ts).first();
  const best = [before, after].filter(Boolean).sort((a, b) => Math.abs(a.ts - ts) - Math.abs(b.ts - ts))[0];
  return json(best && Math.abs(best.ts - ts) <= TRACK_MATCH_MS ? { found: true, ...best } : { found: false });
}

export async function uploadPhoto(request, env, viewer) {
  if (!env.PHOTOS) return json({ error: 'Photo storage (R2) is not set up yet.' }, 503);
  const form = await request.formData();
  const image = form.get('image');
  const thumb = form.get('thumb');
  const lat = num(form.get('lat'));
  const lon = num(form.get('lon'));
  if (!(image instanceof File) || !(thumb instanceof File)) return json({ error: 'Missing image.' }, 400);
  if (image.type !== 'image/jpeg' || thumb.type !== 'image/jpeg') return json({ error: 'Images must be JPEG.' }, 400);
  if (image.size > MAX_BYTES || thumb.size > MAX_BYTES) return json({ error: 'Image too large.' }, 413);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return json({ error: 'Missing location.' }, 400);

  const id = crypto.randomUUID();
  const source = ['exif', 'track', 'manual'].includes(form.get('source')) ? form.get('source') : 'manual';
  const caption = String(form.get('caption') || '').slice(0, 500);

  await env.PHOTOS.put(`photos/${id}.jpg`, image.stream(), { httpMetadata: { contentType: 'image/jpeg' } });
  await env.PHOTOS.put(`photos/${id}_t.jpg`, thumb.stream(), { httpMetadata: { contentType: 'image/jpeg' } });
  const row = {
    id, taken_ts: num(form.get('taken_ts')), lat, lon, source, caption,
    width: num(form.get('width')), height: num(form.get('height')), created_ts: Date.now(),
  };
  await env.DB.prepare(
    'INSERT INTO photos (id, taken_ts, lat, lon, source, caption, width, height, created_ts, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(row.id, row.taken_ts, row.lat, row.lon, row.source, row.caption, row.width, row.height, row.created_ts, viewer.email).run();
  return json({ photo: row }, 201);
}

export async function deletePhoto(env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: 'Bad id.' }, 400);
  await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
  if (env.PHOTOS) await env.PHOTOS.delete([`photos/${id}.jpg`, `photos/${id}_t.jpg`]);
  return json({ deleted: id });
}
