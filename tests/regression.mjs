// Build the example route with the browser engine under Node and compare against the
// reference numbers from the Python implementation (see CLAUDE.md).
//   cd tests && npm install && node regression.mjs [tile_cache_dir] [out.stl]
// Tiles are read from tile_cache_dir if present there, otherwise downloaded (and saved).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Module from "manifold-3d";
import { parseGpx } from "../web/js/core/gpx.js";
import { tileUrl, decodeTerrarium } from "../web/js/core/tiles.js";
import { buildModel, routeFrame } from "../web/js/core/model.js";
import { outline, fitHexagon } from "../web/js/core/footprint.js";
import { writeStl } from "../web/js/core/stl.js";

const here = dirname(fileURLToPath(import.meta.url));
const cache = process.argv[2] ?? join(here, "tile_cache");
const out = process.argv[3];

async function getTile(z, x, y) {
  const f = join(cache, `${z}`, `${x}`, `${y}.png`);
  let buf;
  try { buf = await readFile(f); }
  catch {
    const r = await fetch(tileUrl(z, x, y));
    if (!r.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, buf);
  }
  return decodeTerrarium(buf);
}

const wasm = await Module();
wasm.setup();
const gpx = parseGpx(await readFile(join(here, "../web/examples/whole_enchilada.gpx"), "utf8"));
const t0 = performance.now();
const m = await buildModel(gpx.segments, {}, { getTile, manifold: wasm });
const s = m.stats;
console.log(`built in ${((performance.now() - t0) / 1000).toFixed(1)} s  (${gpx.name})`);
console.log(`  size        ${s.width.toFixed(1)} x ${s.depth.toFixed(1)} x ${s.height.toFixed(1)} mm`);
console.log(`  scale       1:${Math.round(s.scale).toLocaleString("en")}  (vertical x${s.zExag})`);
console.log(`  elevation   ${s.elevMin.toFixed(0)} - ${s.elevMax.toFixed(0)} m  (tile zoom ${s.zoom})`);
console.log(`  triangles   ${s.triangles.toLocaleString("en")}   volume ${s.volume.toFixed(1)} cm3`);
if (out) await writeFile(out, Buffer.from(writeStl(m.positions, m.indices, gpx.name)));

// Python reference: 180.0 x 111.9 x 32.2 mm, 1:173,067, 1208-3733 m, z12, 452,004 tris, 255 cm3
const expect = [
  ["width", s.width, 180.0, 0.05], ["depth", s.depth, 111.9, 0.05], ["height", s.height, 32.2, 0.05],
  ["scale", s.scale, 173067, 1], ["elevMin", s.elevMin, 1208, 0.5], ["elevMax", s.elevMax, 3733, 0.5],
  ["zoom", s.zoom, 12, 0], ["triangles", s.triangles, 452004, 200], ["volume", s.volume, 255, 0.5],
];
let bad = 0;
for (const [k, got, want, tol] of expect)
  if (Math.abs(got - want) > tol) { bad++; console.log(`MISMATCH ${k}: got ${got}, want ${want} ±${tol}`); }
console.log(bad ? `${bad} mismatches` : "OK: matches Python reference");

// Hexagon footprint: fitted the way the UI does it; every vertex must lie inside the hexagon
// and the outline must reach the box edges (i.e. it really is the hexagon, not the box).
{
  const f = routeFrame(gpx.segments), b = f.bounds;
  const pts = gpx.segments.flat().map(f.toM);
  const h = fitHexagon(pts, (b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2, 1800);
  const [south, west] = f.toLL(h.x0, h.y0), [north, east] = f.toLL(h.x1, h.y1);
  const hm = await buildModel(gpx.segments, { shape: "hex", area: { south, west, north, east }, cornerRadius: 0 },
                              { getTile, manifold: wasm });
  const hs = hm.stats, poly = outline("hex", hs.width, hs.depth), p = hm.positions;
  // signed distance (mm) inside the polygon's nearest edge; float32 vertices sit ~1e-5 off the edges
  const depthInside = (x, y) => Math.min(...poly.map(([ax, ay], i) => {
    const [bx, by] = poly[(i + 1) % poly.length], l = Math.hypot(bx - ax, by - ay);
    return ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / l;
  }));
  let outside = 0, xmax = 0;
  for (let i = 0; i < p.length; i += 3) {
    if (depthInside(p[i], p[i + 1]) < -0.001) outside++;
    xmax = Math.max(xmax, p[i]);
  }
  const ratio = hs.width / hs.depth;
  console.log(`hexagon (${h.flat ? "flat" : "pointy"} top): ${hs.width.toFixed(1)} x ${hs.depth.toFixed(1)} mm, ` +
              `${hs.triangles.toLocaleString("en")} triangles, ${hs.volume.toFixed(0)} cm3, ${outside} vertices outside`);
  const want = h.flat ? 2 / Math.sqrt(3) : Math.sqrt(3) / 2;
  if (Math.abs(ratio - want) > 0.01) { bad++; console.log(`MISMATCH hexagon aspect ${ratio}, want ${want}`); }
  if (outside) { bad++; console.log("MISMATCH vertices outside the hexagon"); }
  if (Math.abs(xmax - hs.width) > 0.05) { bad++; console.log("MISMATCH hexagon does not reach the box edge"); }
  console.log(bad ? "FAILED" : "OK: hexagon");
}
process.exit(bad ? 1 : 0);
