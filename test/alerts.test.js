import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAlerts } from '../shared/alerts.js';

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

const sent = [];
globalThis.fetch = async (url, opts) => { sent.push({ url, title: opts.headers.Title, body: opts.body }); return { ok: true }; };

const reading = (over) => ({ ts: 0, soc: 50, gids: 200, chrg_mode: 0, bat_amps: 0, bat_volts: 380, speed: 0, pwr_sw: 0, ...over });

test('alerts at the target %, when charging finishes, and once when low', async () => {
  const db = fakeDb({ ntfy_topic: 'trola-test', alerts: { enabled: true, target_on: true, target_soc: 80, done_on: true, low_on: true, low_soc: 20 } });
  sent.length = 0;
  await checkAlerts(db, reading({ ts: 1, soc: 50, gids: 200, chrg_mode: 2, bat_amps: -40 }));
  await checkAlerts(db, reading({ ts: 2, soc: 79, gids: 300, chrg_mode: 2, bat_amps: -40 }));
  await checkAlerts(db, reading({ ts: 3, soc: 81, gids: 320, chrg_mode: 2, bat_amps: -40 }));
  await checkAlerts(db, reading({ ts: 4, soc: 85, gids: 330, chrg_mode: 2, bat_amps: -40 }));
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /81%/);
  assert.equal(sent[0].url, 'https://ntfy.sh/trola-test');
  await checkAlerts(db, reading({ ts: 4 + 60 * 60000, soc: 86, gids: 340, pwr_sw: 1 }));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, 'Charging finished');
  assert.match(sent[1].body, /50% → 86%, \+10\.8 kWh/);
  await checkAlerts(db, reading({ ts: 5e6, soc: 19, pwr_sw: 1 }));
  await checkAlerts(db, reading({ ts: 6e6, soc: 18, pwr_sw: 1 }));
  assert.equal(sent.length, 3);
  assert.match(sent[2].title, /low: 19%/);
});

test('no alerts when switched off or plugged in above the target', async () => {
  const off = fakeDb({ ntfy_topic: 't', alerts: { enabled: false } });
  sent.length = 0;
  await checkAlerts(off, reading({ chrg_mode: 2, soc: 90 }));
  const above = fakeDb({ ntfy_topic: 't', alerts: { enabled: true, done_on: false } });
  await checkAlerts(above, reading({ ts: 1, chrg_mode: 2, soc: 85 }));
  await checkAlerts(above, reading({ ts: 2, chrg_mode: 2, soc: 90 }));
  assert.equal(sent.length, 0);
});
