import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionsFrom } from '../shared/charges.js';

const noDb = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
const row = (ts, o) => ({ ts, lat: 46, lon: 14, odo: 1000, speed: 0, pwr_sw: 0, chrg_mode: 0, soc: 50, gids: 200,
  bat_volts: 360, bat_amps: 0, bat_temp: 20, amb_temp: 15, soh: 81, hx: 49, ahr: 93, ...o });
const min = 60000;

test('a seen charge, then a silent gap, form one session', async () => {
  const rows = [
    row(0, { chrg_mode: 2, bat_amps: -40, gids: 200, soc: 50 }),
    row(10 * min, { chrg_mode: 2, bat_amps: -40, gids: 210, soc: 52 }),
    // LeafSpy off for 2 h while the pack went on charging
    row(130 * min, { gids: 300, soc: 70 }),
  ];
  const [s, ...rest] = await sessionsFrom(noDb, rows, 200 * min);
  assert.equal(rest.length, 0);
  assert.equal(s.start_ts, 0);
  assert.equal(s.end_ts, 130 * min);
  assert.equal(s.soc_start, 50);
  assert.equal(s.soc_end, 70);
  assert.equal(s.mode, 2);
  // Seen part: volts x amps (14.4 kW for 10 min) beats its Gids; the gap: its Gids.
  assert.ok(Math.abs(s.kwh - (2.4 + (300 - 210) * 0.0775)) < 1e-9);
});

test('a drive is no charge, and readings past the end only finish one', async () => {
  const rows = [row(0, { pwr_sw: 1, speed: 50, bat_amps: 50 }), row(min, { pwr_sw: 1, speed: 50, bat_amps: -20 })];
  assert.deepEqual(await sessionsFrom(noDb, rows, 10 * min), []);
  const charge = [row(0, { chrg_mode: 2, bat_amps: -40, gids: 200 }), row(5 * min, { chrg_mode: 2, bat_amps: -40, gids: 205 }),
    row(15 * min, { gids: 220, soc: 60 })]; // after `until`: only for where the charge ended
  const [s] = await sessionsFrom(noDb, charge, 10 * min);
  assert.equal(s.end_ts, 5 * min);
  assert.equal(s.soc_end, 60);
  assert.ok(Math.abs(s.kwh - 20 * 0.0775) < 1e-9);
});
