// Elevation along the route from the terrain tiles (GPX elevation is often missing or noisy).
import { TILE, lonLatToTile } from "./tiles.js";
import { haversine } from "./gpx.js";

const STEP = 30;          // resample every 30 m along the route
const HYSTERESIS = 3;     // metres; ignore wiggles smaller than this when adding up climbing

/**
 * getTile(z, x, y) -> Promise<Float64Array(256*256)> of metres.
 * Returns { max, min, gain, loss } in metres.
 */
export async function routeProfile(segments, getTile, zoom = 12) {
  // only the tiles the route passes through
  const need = new Map();
  for (const s of segments) for (const [la, lo] of s) {
    const [fx, fy] = lonLatToTile(lo, la, zoom);
    need.set(`${Math.floor(fx)}/${Math.floor(fy)}`, null);
  }
  if (need.size > 300) throw new Error("Route too long for an elevation profile");
  await Promise.all([...need.keys()].map(async (k) => {
    const [x, y] = k.split("/").map(Number);
    need.set(k, await getTile(zoom, x, y));
  }));
  const sample = (la, lo) => {
    const [fx, fy] = lonLatToTile(lo, la, zoom);
    const tx = Math.floor(fx), ty = Math.floor(fy), t = need.get(`${tx}/${ty}`);
    const px = Math.min(TILE - 1, Math.max(0, Math.round((fx - tx) * TILE - 0.5)));
    const py = Math.min(TILE - 1, Math.max(0, Math.round((fy - ty) * TILE - 0.5)));
    return t[py * TILE + px];
  };

  let max = -Infinity, min = Infinity, gain = 0, loss = 0;
  for (const s of segments) {
    // resample at even spacing, then smooth lightly so pixel noise doesn't count as climbing
    const ele = [sample(s[0][0], s[0][1])];
    let carry = 0;
    for (let i = 1; i < s.length; i++) {
      const len = haversine(s[i - 1], s[i]);
      for (let d = STEP - carry; d <= len; d += STEP) {
        const t = d / len;
        ele.push(sample(s[i - 1][0] + (s[i][0] - s[i - 1][0]) * t, s[i - 1][1] + (s[i][1] - s[i - 1][1]) * t));
      }
      carry = (carry + len) % STEP;
    }
    ele.push(sample(s.at(-1)[0], s.at(-1)[1]));
    const sm = ele.map((_, i) => {
      let a = 0, n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(ele.length - 1, i + 2); j++) { a += ele[j]; n++; }
      return a / n;
    });
    let ref = sm[0];
    for (const e of sm) {
      max = Math.max(max, e); min = Math.min(min, e);
      if (e - ref >= HYSTERESIS) { gain += e - ref; ref = e; }
      else if (ref - e >= HYSTERESIS) { loss += ref - e; ref = e; }
    }
  }
  return { max, min, gain, loss };
}

const MAX_SPEED = 80 / 3.6;   // m/s; faster than this on average means the times aren't a real ride

/**
 * First/last timestamps (ms) on the route, or null. Course files often carry made-up times
 * (e.g. one second per point), which would print a nonsense date and duration, so those are
 * rejected by their implied average speed. Pass the route length if it's already known.
 */
export function routeTimes(segments, length = null) {
  let start = null, end = null, dist = length ?? 0;
  for (const s of segments) for (let i = 0; i < s.length; i++) {
    if (i && length == null) dist += haversine(s[i - 1], s[i]);
    if (Number.isFinite(s[i][2])) { start ??= s[i][2]; end = s[i][2]; }
  }
  if (start == null || !(end > start)) return null;
  return dist / ((end - start) / 1000) > MAX_SPEED ? null : { start, end };
}
