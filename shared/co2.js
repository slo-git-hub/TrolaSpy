// CO₂ saved, a rough number for fun: Trola against a comparable diesel van over the same distance.
// The diesel Nissan NV200 uses about 6 l/100 km, about 160 g of CO₂ per km. Trola takes about
// 22 kWh per 100 km from the plug, and making that electricity puts out about 250 g per kWh
// (roughly the European average), so about 55 g per km.
export const DIESEL_G_PER_KM = 160;
export const EV_KWH_PER_KM = 0.22;
export const GRID_G_PER_KWH = 250;
export const CO2_SAVED_G_PER_KM = DIESEL_G_PER_KM - EV_KWH_PER_KM * GRID_G_PER_KWH;

export const co2SavedKg = (km) => (km === null || km === undefined ? null : Math.round((km * CO2_SAVED_G_PER_KM) / 1000));
