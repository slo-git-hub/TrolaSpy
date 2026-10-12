import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBroadcast, parseSolar, parseDcdc, offReasonText, STATES } from '../shared/victron.js';

// Broadcasts and keys from the victron-ble project's tests.
test('reads a solar charger broadcast', async () => {
  const r = await readBroadcast('100242a0016207adceb37b605d7e0ee21b24df5c', { solar: 'adeccb947395801a4dd45a2eaa44bf17' });
  assert.equal(r.kind, 'solar');
  assert.equal(STATES[r.state], 'Absorption');
  assert.equal(r.batt_v, 13.88);
  assert.equal(r.batt_a, 1.4);
  assert.equal(r.yield_wh, 30);
  assert.equal(r.pv_w, 19);
  assert.equal(r.load_a, 0);
});

test('reads a DC-DC charger broadcast', async () => {
  const r = await readBroadcast('1000c0a304121d64ca8d442b90bbdf6a8cba', { dcdc: '64ba49f1a8562e45197a8e1fe50d7658' });
  assert.equal(r.kind, 'dcdc');
  assert.equal(r.model, 0xa3c0);
  assert.equal(STATES[r.state], 'Off');
  assert.equal(r.error, 0);
  assert.equal(r.in_v, 13.15);
  assert.equal(r.out_v, null);
  assert.equal(offReasonText(r.off_reason), 'Engine off');
});

test('ignores broadcasts without a fitting key', async () => {
  assert.equal(await readBroadcast('100242a0016207adceb37b605d7e0ee21b24df5c', { solar: 'bdeccb947395801a4dd45a2eaa44bf17' }), null);
  assert.equal(await readBroadcast('100242a0016207adceb37b605d7e0ee21b24df5c', { dcdc: 'adeccb947395801a4dd45a2eaa44bf17' }), null);
  assert.equal(await readBroadcast('zz', { solar: 'adeccb947395801a4dd45a2eaa44bf17' }), null);
  assert.equal(await readBroadcast('', {}), null);
});

test('reads decrypted records like victron-ble does', () => {
  const big = parseSolar(Uint8Array.from(Buffer.from('0300fb09650032000901ffff31bc45ad', 'hex')));
  assert.deepEqual([big.batt_a, big.batt_v, STATES[big.state], big.pv_w, big.yield_wh, big.load_a], [10.1, 25.55, 'Bulk', 265, 500, null]);
  const d = parseDcdc(Uint8Array.from(Buffer.from('00002305ff7f80000000cbdd494cc5d1', 'hex')));
  assert.deepEqual([d.in_v, d.out_v, d.off_reason], [13.15, null, 0x80]);
});
