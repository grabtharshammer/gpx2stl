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

function points(text, tag) {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}\\b([^>]*)>`, "g");
  const pts = [];
  for (const m of text.matchAll(re)) {
    const lat = parseFloat(/\blat\s*=\s*["']([^"']+)["']/.exec(m[1])?.[1]);
    const lon = parseFloat(/\blon\s*=\s*["']([^"']+)["']/.exec(m[1])?.[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon]);
  }
  return pts;
}

/** Returns { name, segments: [[[lat, lon], ...], ...] }. Elevation in the file is ignored. */
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

/** Great-circle length of all segments, in metres. */
export function routeLength(segments) {
  let d = 0;
  for (const s of segments) {
    for (let i = 1; i < s.length; i++) {
      const [la1, lo1] = s[i - 1], [la2, lo2] = s[i];
      const p1 = (la1 * Math.PI) / 180, p2 = (la2 * Math.PI) / 180;
      const dp = p2 - p1, dl = ((lo2 - lo1) * Math.PI) / 180;
      const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
      d += 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
    }
  }
  return d;
}
