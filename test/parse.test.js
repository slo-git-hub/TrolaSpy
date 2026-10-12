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

test('stores speed in km/h and drops a zero odometer', () => {
  const r = parseReading(new URLSearchParams('Speed=25&Odo=0&SOC=0&Gids=0'));
  assert.equal(r.speed, 90);
  assert.equal(r.odo, null);
  assert.equal(r.soc, null);
  assert.equal(r.gids, null);
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

test('drops temperatures LeafSpy sends when the car does not answer', () => {
  const r = parseReading(new URLSearchParams('Tunits=C&Amb=87&BatTemp=-128&PwrSw=0'));
  assert.equal(r.amb_temp, null);
  assert.equal(r.bat_temp, null);
  const ok = parseReading(new URLSearchParams('Tunits=C&Amb=-12.5&BatTemp=41'));
  assert.equal(ok.amb_temp, -12.5);
  assert.equal(ok.bat_temp, 41);
});
