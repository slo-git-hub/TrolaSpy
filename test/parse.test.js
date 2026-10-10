import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReading } from '../ingest/src/parse.js';

// Real-world shaped upload, from the leafspy2mqtt README.
const SAMPLE = 'user=q84fh&pass=x&DevBat=100&Gids=219&Lat=-11.12421&Long=-71.75095&Elv=35&Seq=143&Trip=86&Odo=37774&SOC=46.2757&AHr=107.3014&BatTemp=8.7&Amb=7.0&Wpr=0&PlugState=2&ChrgMode=2&ChrgPwr=1300&VIN=3VWSB81H8WM210368&PwrSw=1&Tunits=C&RPM=0&SOH=92.95&Hx=102.51&Speed=0.0&BatVolts=352.56&BatAmps=-1.006';

test('parses a LeafSpy upload', () => {
  const r = parseReading(new URLSearchParams(SAMPLE), 1000);
  assert.equal(r.ts, 1000);
  assert.equal(r.lat, -11.12421);
  assert.equal(r.lon, -71.75095);
  assert.equal(r.soc, 46.2757);
  assert.equal(r.gids, 219);
  assert.equal(r.plug_state, 2);
  assert.equal(r.chrg_mode, 2);
  assert.equal(r.chrg_pwr, 1300);
  assert.equal(r.bat_temp, 8.7);
  assert.equal(r.odo, 37774);
  assert.equal('vin' in r, false);
});

test('drops a missing GPS fix', () => {
  const r = parseReading(new URLSearchParams('Lat=0&Long=0&SOC=50'));
  assert.equal(r.lat, null);
  assert.equal(r.lon, null);
  assert.equal(r.soc, 50);
});

test('converts Fahrenheit temperatures', () => {
  const r = parseReading(new URLSearchParams('Tunits=F&BatTemp=50&Amb=32'));
  assert.equal(r.bat_temp, 10);
  assert.equal(r.amb_temp, 0);
});
