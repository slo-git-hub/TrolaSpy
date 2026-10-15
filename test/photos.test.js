import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './d1.js';
import { uploadPhoto, replacePhoto, listPhotos, namePhotos } from '../web/src/photos.js';

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

test('pins get the name of their place, older ones too, each spot asked once', async () => {
  const env = { DB: d1(), PHOTOS: r2() };
  const camp = { category: 'tourism', type: 'camp_site', name: 'Camping Lipa', address: { village: 'Lipa', country: 'Slovenia' } };
  const asked = [];
  const fetchFn = async (url) => {
    const u = new URL(url); asked.push(u.searchParams.get('lat'));
    return Response.json(u.searchParams.get('lat') === '46.100' ? camp : { error: 'Unable to geocode' });
  };
  const add = (lat, lon) => env.DB.sqlite.prepare("INSERT INTO photos (id, lat, lon, created_ts) VALUES (?, ?, ?, 1)").run(crypto.randomUUID(), lat, lon);
  add(46.1001, 14.2001); add(46.0999, 14.1999); add(43, 13); add(45, 12); // two at the campsite, one at sea
  await namePhotos(env, { fetchFn, gap: 1, max: 2 });
  const place = () => env.DB.sqlite.prepare('SELECT lat, place FROM photos ORDER BY lat').all().map((r) => [r.lat, r.place]);
  assert.deepEqual(place(), [[43, ''], [45, null], [46.0999, 'Camping Lipa, Lipa, Slovenia'], [46.1001, 'Camping Lipa, Lipa, Slovenia']]);
  await namePhotos(env, { fetchFn, gap: 1, max: 2 }); // the rest next time
  assert.equal(place()[1][1], '');
  assert.equal(asked.length, 3);

  // The list carries it, and asks for more only while some are missing.
  const later = [];
  await listPhotos(env, false, (p) => later.push(p));
  assert.equal(later.length, 0);
  add(46.1, 14.2);
  const list = (await (await listPhotos(env, false, (p) => later.push(p))).json()).photos;
  assert.equal(later.length, 1);
  await Promise.all(later);
  assert.ok(list.some((p) => p.place === 'Camping Lipa, Lipa, Slovenia'));
  assert.equal(place().filter(([, p]) => p === null).length, 0);
  assert.equal(asked.length, 3, 'the campsite was known already');
});
