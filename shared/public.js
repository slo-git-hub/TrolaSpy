// The public "Where's Trola" page: what anyone may see without logging in. Only a rough
// area (a grid cell, so repeat visits can't narrow it down), whether Trola is on the road,
// parked or charging, a few totals, and optionally the photo pins. Optionally everything is
// shown some hours late. Off until the admin switches it on.
import { getSettings } from './alerts.js';
import { co2SavedKg } from './co2.js';

export const DEFAULT_PUBLIC = { enabled: false, detail: 'town', delay_h: 0, photos: true };
export const DETAIL_KM = { town: 5, area: 1.5 }; // grid cell size
export const DELAYS_H = [0, 1, 3, 12, 24];
const QUIET_MS = 15 * 60 * 1000; // no upload for this long: LeafSpy is off, so the car is too

export async function publicSettings(db) {
  const s = await getSettings(db, ['public']);
  const cfg = { ...DEFAULT_PUBLIC, ...(s.public || {}) };
  if (!DETAIL_KM[cfg.detail]) cfg.detail = DEFAULT_PUBLIC.detail;
  if (!DELAYS_H.includes(cfg.delay_h)) cfg.delay_h = DEFAULT_PUBLIC.delay_h;
  return cfg;
}

// Centre of the grid cell holding the point; the circle around it covers the whole cell.
export function roughArea(lat, lon, km) {
  const dLat = km / 111.32;
  const cLat = (Math.floor(lat / dLat) + 0.5) * dLat;
  const dLon = km / (111.32 * Math.cos((cLat * Math.PI) / 180));
  const cLon = (Math.floor(lon / dLon) + 0.5) * dLon;
  return { lat: Math.round(cLat * 1e4) / 1e4, lon: Math.round(cLon * 1e4) / 1e4, radius_m: Math.round(km * 750) };
}

const monthStart = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

function status(r, at) {
  if (!r || at - r.ts > QUIET_MS) return 'parked';
  if (r.chrg_mode > 0 || (r.bat_amps < -3 && (r.speed || 0) < 1 && !r.pwr_sw)) return 'charging';
  return r.speed > 1 ? 'driving' : 'parked';
}

export async function publicWhere(db, now = Date.now()) {
  const cfg = await publicSettings(db);
  if (!cfg.enabled) return { enabled: false };
  const at = now - cfg.delay_h * 3600e3;
  const one = (sql, ...args) => db.prepare(sql).bind(...args).first();
  const [r, pos, odo, odoMonth] = await Promise.all([
    one('SELECT ts, speed, pwr_sw, chrg_mode, bat_amps FROM readings WHERE ts <= ? ORDER BY ts DESC LIMIT 1', at),
    one('SELECT ts, lat, lon FROM readings WHERE ts <= ? AND lat IS NOT NULL ORDER BY ts DESC LIMIT 1', at),
    one('SELECT odo FROM readings WHERE ts <= ? AND odo > 0 ORDER BY ts DESC LIMIT 1', at),
    one('SELECT odo FROM readings WHERE ts >= ? AND ts <= ? AND odo > 0 ORDER BY ts LIMIT 1', monthStart(at), at),
  ]);
  const photos = cfg.photos
    ? (await db.prepare(`SELECT id, lat, lon, caption, taken_ts, created_ts, duration FROM photos
                          WHERE COALESCE(taken_ts, created_ts) <= ? ORDER BY COALESCE(taken_ts, created_ts) DESC LIMIT 500`)
      .bind(at).all()).results
    : [];
  return {
    enabled: true,
    delay_h: cfg.delay_h,
    seen_ts: r ? r.ts : null,
    status: status(r, at),
    area: pos ? roughArea(pos.lat, pos.lon, DETAIL_KM[cfg.detail]) : null,
    odo_km: odo ? odo.odo : null,
    month_km: odo && odoMonth ? odo.odo - odoMonth.odo : null,
    co2_kg: odo ? co2SavedKg(odo.odo) : null,
    photos,
  };
}

// A photo may be shown when photos are on and it is older than the delay.
export async function publicPhotoAllowed(db, id, now = Date.now()) {
  const cfg = await publicSettings(db);
  if (!cfg.enabled || !cfg.photos) return false;
  const row = await db.prepare('SELECT 1 AS ok FROM photos WHERE id = ? AND COALESCE(taken_ts, created_ts) <= ?')
    .bind(id, now - cfg.delay_h * 3600e3).first();
  return !!row;
}
