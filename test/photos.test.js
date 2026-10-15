import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './d1.js';
import { uploadPhoto, replacePhoto, listPhotos } from '../web/src/photos.js';

const r2 = () => { const files = new Map(); return { files, put: async (k) => { files.set(k, true); }, delete: async (ks) => ks.forEach((k) => files.delete(k)) }; };
const jpeg = (n) => new File([new Uint8Array(n)], 'photo.jpg', { type: 'image/jpeg' });
const form = (fields) => {
  const fd = new FormData();
  fd.append('image', jpeg(100)); fd.append('thumb', jpeg(10));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request('https://x/api/photos', { method: 'POST', body: fd });
};

test('a pin keeps its original file name and size, shown to the admin only', async () => {
  const env = { DB: d1(), PHOTOS: r2() };
  const r = await uploadPhoto(form({ lat: 46, lon: 14, source: 'exif', taken_ts: 1760000000000, orig_name: 'IMG_1036.jpg', orig_size: 3145728 }), env, { email: 'a@b' });
  assert.equal(r.status, 201);
  const { photo } = await r.json();
  assert.equal(photo.orig_name, 'IMG_1036.jpg');
  assert.equal(photo.orig_size, 3145728);

  const admin = (await (await listPhotos(env, true)).json()).photos[0];
  assert.deepEqual([admin.orig_name, admin.orig_size], ['IMG_1036.jpg', 3145728]);
  const viewer = (await (await listPhotos(env)).json()).photos[0];
  assert.equal('orig_name' in viewer, false);

  // Replaced: the pin now holds the new file.
  const rr = await replacePhoto(form({ orig_name: 'IMG_1037.jpg', orig_size: 2000000 }), env, photo.id);
  assert.equal(rr.status, 201);
  const now = (await (await listPhotos(env, true)).json()).photos;
  assert.deepEqual(now.map((p) => [p.orig_name, p.orig_size, p.lat]), [['IMG_1037.jpg', 2000000, 46]]);

  // Older pages send neither: kept empty.
  await uploadPhoto(form({ lat: 45, lon: 13 }), env, { email: 'a@b' });
  const old = (await (await listPhotos(env, true)).json()).photos.find((p) => p.lat === 45);
  assert.deepEqual([old.orig_name, old.orig_size], [null, null]);
});
