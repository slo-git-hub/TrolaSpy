import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlerts, checkQuietCharge, sendAlert } from '../shared/alerts.js';
import { createVapidKeys } from '../shared/push.js';
import { fakeBrowser } from './browser.js';

// Just enough of D1 for the settings table.
function fakeDb(settings) {
  const store = new Map(Object.entries(settings).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() { return { results: args.filter((k) => store.has(k)).map((k) => ({ key: k, value: store.get(k) })) }; },
            async run() { if (sql.startsWith('INSERT')) store.set(args[0], args[1]); },
          };
        },
      };
    },
  };
}

// Push service stand-in: decrypts what each browser would receive. Endpoints in `gone` answer 410.
const sent = [];
const browsers = new Map();
const gone = new Set();
globalThis.fetch = async (url, opts) => {
  if (gone.has(url)) return new Response('expired', { status: 410 });
  sent.push({ url, ...JSON.parse(await browsers.get(url).decrypt(opts.body)) });
  return new Response(null, { status: 201 });
};
async function push(endpoint = 'https://push.example.com/a') {
  const b = await fakeBrowser(endpoint);
  browsers.set(endpoint, b);
  return { vapid: await createVapidKeys('https://trola.example'), push_subs: [{ ...b.subscription, label: 'Chrome on Android' }] };
}

const reading = (over) => ({ ts: 0, soc: 50, gids: 200, chrg_mode: 0, bat_amps: 0, bat_volts: 380, speed: 0, pwr_sw: 0, ...over });

test('alerts at the target %, when charging finishes, and once when low', async () => {
  const db = fakeDb({ ...await push(), alerts: { enabled: true, target_on: true, target_soc: 80, done_on: true, low_on: true, low_soc: 20 } });
  sent.length = 0;
  await checkAlerts(db, reading({ ts: 1, soc: 50, gids: 200, chrg_mode: 2, bat_amps: -40 }));
  await checkAlerts(db, reading({ ts: 2, soc: 79, gids: 300, chrg_mode: 2, bat_amps: -40 }));
  await checkAlerts(db, reading({ ts: 3, soc: 81, gids: 320, chrg_mode: 2, bat_amps: -40 }));
  await checkAlerts(db, reading({ ts: 4, soc: 85, gids: 330, chrg_mode: 2, bat_amps: -40 }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /81%/);
  assert.equal(sent[0].url, 'https://push.example.com/a');
  assert.equal(sent[0].tag, 'zap');
  await checkAlerts(db, reading({ ts: 4 + 10 * 60000, soc: 86, gids: 340, pwr_sw: 1 }));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, '✅ Charging finished');
  assert.equal(sent[1].body, '50% → 86%, +10.8 kWh in about 10 min.');
  await checkAlerts(db, reading({ ts: 5e6, soc: 19, pwr_sw: 1 }));
  await checkAlerts(db, reading({ ts: 6e6, soc: 18, pwr_sw: 1 }));
  assert.equal(sent.length, 3);
  assert.match(sent[2].title, /low: 19%/);
});

test('no alerts when switched off or plugged in above the target', async () => {
  const subs = await push();
  const off = fakeDb({ ...subs, alerts: { enabled: false } });
  sent.length = 0;
  await checkAlerts(off, reading({ chrg_mode: 2, soc: 90 }));
  const above = fakeDb({ ...subs, alerts: { enabled: true, done_on: false } });
  await checkAlerts(above, reading({ ts: 1, chrg_mode: 2, soc: 85 }));
  await checkAlerts(above, reading({ ts: 2, chrg_mode: 2, soc: 90 }));
  assert.equal(sent.length, 0);
});

test('a browser that dropped its subscription is forgotten', async () => {
  const a = await push('https://push.example.com/keep');
  const b = await push('https://push.example.com/gone');
  const db = fakeDb({ vapid: a.vapid, push_subs: [...a.push_subs, ...b.push_subs] });
  gone.add('https://push.example.com/gone');
  sent.length = 0;
  assert.equal(await sendAlert(db, { title: 'TrolaSpy test', body: 'Hi', tags: ['wave'] }), 1);
  assert.deepEqual(sent.map((x) => [x.url, x.title]), [['https://push.example.com/keep', '👋 TrolaSpy test']]);
  assert.deepEqual(JSON.parse(db.store.get('push_subs')).map((x) => x.endpoint), ['https://push.example.com/keep']);
  await assert.rejects(sendAlert(fakeDb({ vapid: a.vapid, push_subs: [] }), { title: 'x', body: 'y' }), /No phone has alerts turned on/);
});

test('a charge LeafSpy stopped seeing ends where it was last seen', async () => {
  const min = 60000;
  const cfg = { ...await push(), alerts: { enabled: true, target_on: false, done_on: true } };
  // Next upload hours later, after a drive: the alert uses the last charging reading.
  const db = fakeDb(cfg);
  sent.length = 0;
  for (let t = 0; t <= 70; t += 10) {
    await checkAlerts(db, reading({ ts: t * min, soc: 40 + t * 5 / 7, gids: 150 + t * 18 / 7, chrg_mode: 2, bat_amps: -40 }));
  }
  await checkAlerts(db, reading({ ts: 300 * min, soc: 70, gids: 260, pwr_sw: 1, speed: 50 }));
  assert.deepEqual(sent.map((x) => x.body), ['40% → 90%, +13.9 kWh in about 1 h 10 min (when LeafSpy last saw it).']);
  // The 10-minute check sends it without waiting for the next upload, once.
  const db2 = fakeDb(cfg);
  sent.length = 0;
  await checkAlerts(db2, reading({ ts: 0, soc: 40, gids: 150, chrg_mode: 2, bat_amps: -40 }));
  await checkAlerts(db2, reading({ ts: 20 * min, soc: 60, gids: 220, chrg_mode: 2, bat_amps: -40 }));
  await checkQuietCharge(db2, 50 * min);
  assert.equal(sent.length, 0);
  await checkQuietCharge(db2, 51 * min);
  await checkQuietCharge(db2, 61 * min);
  assert.deepEqual(sent.map((x) => x.body), ['40% → 60%, +5.4 kWh in about 20 min (when LeafSpy last saw it).']);
  await checkAlerts(db2, reading({ ts: 300 * min, soc: 55, pwr_sw: 1 }));
  assert.equal(sent.length, 1);
});
