import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVapidKeys, encryptPayload, sendPush } from '../shared/push.js';
import { fakeBrowser, checkVapid } from './browser.js';

test('a browser can decrypt the payload', async () => {
  const b = await fakeBrowser();
  const text = JSON.stringify({ title: '⚡ Trola is at 80%', body: 'Reached your 80% target.' });
  assert.equal(await b.decrypt(await encryptPayload(b.subscription, text)), text);
});

test('pushes are signed for the push service and say how they are encoded', async () => {
  const b = await fakeBrowser('https://fcm.googleapis.com/fcm/send/xyz');
  const vapid = await createVapidKeys('https://trola.example');
  let req;
  globalThis.fetch = async (url, opts) => { req = { url, ...opts }; return new Response(null, { status: 201 }); };
  assert.deepEqual(await sendPush(b.subscription, { title: 'Hi' }, vapid, { urgency: 'high' }), { ok: true, status: 201 });
  assert.equal(req.url, b.subscription.endpoint);
  assert.equal(req.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(req.headers.Urgency, 'high');
  const claims = await checkVapid(req.headers.Authorization);
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'https://trola.example');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  assert.ok(req.headers.Authorization.endsWith(`k=${vapid.publicKey}`));
  assert.deepEqual(JSON.parse(await b.decrypt(req.body)), { title: 'Hi' });

  globalThis.fetch = async () => new Response('push subscription has unsubscribed or expired.\n', { status: 410 });
  const gone = await sendPush(b.subscription, { title: 'Hi' }, vapid);
  assert.equal(gone.status, 410);
  assert.match(gone.error, /410: push subscription has unsubscribed or expired\.$/);
});
