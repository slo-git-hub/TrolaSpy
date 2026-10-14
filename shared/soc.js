// Battery % as Trola's dashboard shows it. LeafSpy's SOC is the battery computer's own figure,
// which counts a reserve at the bottom that the dashboard hides, so LeafSpy reads higher: about
// 10 points at a quarter full, less and less towards full. Dashboard readings entered in Admin,
// each a pair [LeafSpy %, dashboard %], set the scale: straight lines between them and on to
// 100 = 100, with the lowest line carried on down to 0. Stored readings keep LeafSpy's own value.

export const DEFAULT_SOC_CAL = [[35.3, 25]]; // LeafSpy 35.3 % while the dashboard showed 25 %

export function socPoints(cal) {
  const pts = (Array.isArray(cal) ? cal : DEFAULT_SOC_CAL)
    .filter((p) => Array.isArray(p) && p[0] > 0 && p[0] < 100 && p[1] >= 0 && p[1] <= 100)
    .map(([l, d]) => [Number(l), Number(d)])
    .sort((a, b) => a[0] - b[0]);
  return [...pts, [100, 100]];
}

export function dashSoc(soc, cal) {
  if (soc === null || soc === undefined || !(soc > 0)) return soc ?? null;
  const pts = socPoints(cal);
  if (pts.length === 1) return soc; // no readings entered: LeafSpy's own value
  let i = pts.findIndex(([l]) => soc <= l);
  if (i === -1) return 100;
  if (i === 0) i = 1; // below the lowest reading: carry its line on down
  const [[l0, d0], [l1, d1]] = [pts[i - 1], pts[i]];
  const v = d0 + ((soc - l0) / (l1 - l0)) * (d1 - d0);
  return Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
}

// Adds a dashboard reading, replacing any taken within 3 LeafSpy points of it.
export function addSocPoint(cal, leafspy, dash) {
  const l = Math.round(leafspy * 10) / 10;
  return [...socPoints(cal).slice(0, -1).filter(([x]) => Math.abs(x - l) >= 3), [l, Math.round(dash)]].sort((a, b) => a[0] - b[0]);
}
