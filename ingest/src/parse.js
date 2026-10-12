// Turns a LeafSpy server upload (query string) into a readings row.
// Field names follow LeafSpy's "Server" upload: user, pass, Lat, Long, SOC, Gids, ...

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const int = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

// LeafSpy's Speed is GPS speed in metres per second; store km/h.
const msToKmh = (v) => (v === null ? null : Math.round(v * 3.6 * 10) / 10);

const fToC = (f) => (f === null ? null : Math.round(((f - 32) * 5 / 9) * 10) / 10);

export function parseReading(params, ts = Date.now()) {
  let lat = num(params.get('Lat'));
  let lon = num(params.get('Long'));
  // LeafSpy sends 0/0 (or nothing) until the tablet has a GPS fix.
  if (lat === null || lon === null || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    lat = null;
    lon = null;
  }

  const fahrenheit = (params.get('Tunits') || '').toUpperCase() === 'F';
  let batTemp = num(params.get('BatTemp'));
  let ambTemp = num(params.get('Amb'));
  if (fahrenheit) {
    batTemp = fToC(batTemp);
    ambTemp = fToC(ambTemp);
  }

  return {
    ts,
    lat,
    lon,
    elv: num(params.get('Elv')),
    speed: msToKmh(num(params.get('Speed'))),
    soc: num(params.get('SOC')) || null, // LeafSpy sometimes sends 0 before the car answers
    gids: int(params.get('Gids')) || null,
    soh: num(params.get('SOH')),
    ahr: num(params.get('AHr')),
    hx: num(params.get('Hx')),
    bat_volts: num(params.get('BatVolts')),
    bat_amps: num(params.get('BatAmps')),
    bat_temp: batTemp,
    amb_temp: ambTemp,
    plug_state: int(params.get('PlugState')),
    chrg_mode: int(params.get('ChrgMode')),
    chrg_pwr: num(params.get('ChrgPwr')),
    pwr_sw: int(params.get('PwrSw')),
    odo: int(params.get('Odo')) || null, // 0 until the car answers
    trip: int(params.get('Trip')),
    seq: int(params.get('Seq')),
    dev_bat: int(params.get('DevBat')),
    rpm: int(params.get('RPM')),
  };
}

export const COLUMNS = Object.keys(parseReading(new URLSearchParams()));
