// GPX parsing. Regex-based rather than DOMParser so it also runs in Web Workers and Node.

const EARTH_R = 6371008.8;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, "0x")))
                 : ENTITIES[e] ?? m);

function blocks(text, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, "g");
  return [...text.matchAll(re)].map((m) => m[1]);
}

const EPOCH_MIN = Date.UTC(1990, 0, 1);   // older timestamps are placeholders (Trailforks writes 1970)

function points(text, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>)`, "g");
  const pts = [];
  for (const m of text.matchAll(re)) {
    const lat = parseFloat(/\blat\s*=\s*["']([^"']+)["']/.exec(m[1])?.[1]);
    const lon = parseFloat(/\blon\s*=\s*["']([^"']+)["']/.exec(m[1])?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const body = m[2] ?? "";
    let time = Date.parse(/<(?:[\w-]+:)?time>([^<]+)</.exec(body)?.[1]);
    if (!(time > EPOCH_MIN)) time = NaN;
    const ele = parseFloat(/<(?:[\w-]+:)?ele>([^<]+)</.exec(body)?.[1]);
    pts.push([lat, lon, time, ele]);
  }
  return pts;
}

/**
 * Returns { name, segments: [[[lat, lon, time, ele], ...], ...] }; time (ms) and ele (m) are NaN
 * when missing. The model never uses GPX elevation (often absent or zero); it's informational only.
 */
export function parseGpx(text) {
  let segments = blocks(text, "trkseg").map((s) => points(s, "trkpt"));
  if (!segments.some((s) => s.length > 1)) segments = blocks(text, "rte").map((s) => points(s, "rtept"));
  segments = segments.filter((s) => s.length > 1);
  if (!segments.length) throw new Error("No track or route points found in this GPX file.");

  const named = (src) => /<(?:[\w-]+:)?name>([^<]*)</.exec(src ?? "")?.[1].trim();
  const name = unescape(named(blocks(text, "trk")[0]) || named(blocks(text, "rte")[0]) ||
                        named(blocks(text, "metadata")[0]) || "");
  return { name, segments };
}

/** Great-circle distance between two [lat, lon] points, in metres. */
export function haversine([la1, lo1], [la2, lo2]) {
  const p1 = (la1 * Math.PI) / 180, p2 = (la2 * Math.PI) / 180;
  const dp = p2 - p1, dl = ((lo2 - lo1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Great-circle length of all segments, in metres (gaps between segments don't count). */
export function routeLength(segments) {
  let d = 0;
  for (const s of segments) for (let i = 1; i < s.length; i++) d += haversine(s[i - 1], s[i]);
  return d;
}

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);   // lat, lon, and time/ele too

/** The part of the route between `from` and `to` metres along it, cut exactly at those points. */
export function trimSegments(segments, from, to) {
  const out = [];
  let d = 0;
  for (const s of segments) {
    const cur = [];
    if (d >= from && d <= to) cur.push(s[0]);
    for (let i = 1; i < s.length; i++) {
      const len = haversine(s[i - 1], s[i]), d0 = d, d1 = d + len;
      if (d0 < from && d1 > from) cur.push(lerp(s[i - 1], s[i], (from - d0) / len));
      if (d1 > from && d0 < to) cur.push(d1 <= to ? s[i] : lerp(s[i - 1], s[i], (to - d0) / len));
      d = d1;
    }
    if (cur.length > 1) out.push(cur);
  }
  return out;
}

/**
 * Lookup for snapping to the route. toM projects [lat, lon] to planar metres.
 * nearest(x, y) -> { distance (metres along the route), point: [lat, lon] } of the closest spot.
 */
export function routeIndex(segments, toM) {
  const parts = [];
  let d = 0;
  for (const s of segments) {
    const cum = [d];
    for (let i = 1; i < s.length; i++) cum.push((d += haversine(s[i - 1], s[i])));
    parts.push({ ll: s, m: s.map(toM), cum });
  }
  return {
    length: d,
    nearest(x, y) {
      let best = { d2: Infinity };
      for (const { ll, m, cum } of parts) {
        for (let i = 1; i < m.length; i++) {
          const [ax, ay] = m[i - 1], [bx, by] = m[i], dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
          const d2 = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
          if (d2 < best.d2) best = { d2, distance: cum[i - 1] + (cum[i] - cum[i - 1]) * t, point: lerp(ll[i - 1], ll[i], t) };
        }
      }
      return best;
    },
  };
}
