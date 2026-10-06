// Build the example route with the browser engine under Node and compare against the
// reference numbers from the Python implementation (see CLAUDE.md).
//   cd tests && npm install && node regression.mjs [tile_cache_dir] [out.stl]
// Tiles are read from tile_cache_dir if present there, otherwise downloaded (and saved).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Module from "manifold-3d";
import { parseGpx, routeLength, trimSegments, routeIndex } from "../web/js/core/gpx.js";
import { tileUrl, decodeTerrarium } from "../web/js/core/tiles.js";
import { buildModel, routeFrame } from "../web/js/core/model.js";
import { outline, fitHexagon } from "../web/js/core/footprint.js";
import { writeStl } from "../web/js/core/stl.js";
import { layoutText } from "../web/js/core/text.js";
import { routeProfile, routeTimes } from "../web/js/core/profile.js";
import * as opentype from "opentype.js/dist/opentype.mjs";
import { layFlat } from "../web/js/core/inlay.js";   // same build the browser loads

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

// The multi-colour 3MF parts must not overlap the terrain and must add up to the whole model.
const toManifold = (q) => new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: q.positions, triVerts: q.indices }));
function checkParts(what, m, extra = 0) {
  if (!m.parts3mf) { console.log(`  MISMATCH ${what}: no 3MF parts`); return 1; }
  const P = m.parts3mf.map((q) => ({ ...q, man: toManifold(q) }));
  const total = P.reduce((v, q) => v + q.man.volume(), 0), whole = toManifold(m).volume() + extra;
  let overlap = 0;
  for (const q of P.slice(1)) overlap += P[0].man.intersect(q.man).volume();
  console.log(`  3MF parts (${what}): ${P.map((q) => q.name).join(", ")}; total ${(total / 1000).toFixed(3)} cm3 ` +
              `vs model ${(whole / 1000).toFixed(3)} cm3; overlap with terrain ${overlap.toFixed(3)} mm3`);
  if (overlap > 0.5 || Math.abs(total - whole) > 1) { console.log(`  MISMATCH ${what}: parts overlap or don't add up`); return 1; }
  return 0;
}
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
// Markers: both present (coloured vertices), valid solid, standing above the terrain.
{
  const mm = await buildModel(gpx.segments, { startMarker: "triangle", endMarker: "star" }, { getTile, manifold: wasm });
  const count = [0, 0, 0, 0];
  for (const t of mm.trail) count[t]++;
  console.log(`markers: start ${count[2]} / finish ${count[3]} vertices, height ${mm.stats.height.toFixed(1)} mm, ` +
              `${mm.stats.triangles.toLocaleString("en")} triangles, ${mm.stats.volume.toFixed(1)} cm3`);
  if (!count[2] || !count[3]) { bad++; console.log("MISMATCH a marker is missing"); }
  if (!(mm.stats.volume > s.volume)) { bad++; console.log("MISMATCH markers added no volume"); }
  bad += checkParts("markers", mm);
  if (mm.parts3mf?.filter((q) => q.role === "start" || q.role === "finish").length !== 2) { bad++; console.log("MISMATCH marker parts missing"); }
  if (out) await writeFile(out.replace(/\.stl$/, "-markers.stl"), Buffer.from(writeStl(mm.positions, mm.indices, "markers")));
  console.log(bad ? "FAILED" : "OK: markers");
}
// Trimming: the whole range is a no-op; a cut gives exactly the requested length and snaps back.
{
  const L = routeLength(gpx.segments);
  const same = JSON.stringify(trimSegments(gpx.segments, 0, L)) === JSON.stringify(gpx.segments);
  const cut = trimSegments(gpx.segments, 5000, 20000), cl = routeLength(cut);
  const f = routeFrame(gpx.segments), idx = routeIndex(gpx.segments, f.toM);
  const back = idx.nearest(...f.toM(cut[0][0])).distance;
  console.log(`trim: full range unchanged ${same}; 5–20 km cut is ${(cl / 1000).toFixed(4)} km; start snaps to ${(back / 1000).toFixed(4)} km`);
  if (!same || Math.abs(cl - 15000) > 1 || Math.abs(back - 5000) > 1 || Math.abs(idx.length - L) > 1e-6) {
    bad++; console.log("MISMATCH trimming");
  }
  console.log(bad ? "FAILED" : "OK: trimming");
}
// Label: raised and engraved builds are valid solids with plate and lettering present.
{
  const fb = await readFile(join(here, "../web/fonts/AtkinsonHyperlegible-Bold.ttf"));
  const font = opentype.parse(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.length));
  const t = layoutText(font, "the WHOLE enchilada\n29.4 mi · +1,520 / -7,780 ft", 4);
  const f = routeFrame(gpx.segments), [lat, lon] = f.toLL(0, -6000);
  for (const [style, angle] of [["raised", 0], ["engraved", 0], ["raised", 30]]) {
    const label = { center: { lat, lon }, contours: t.contours, width: t.width + 6, height: t.height + 6, style, relief: 0.8, angle };
    const lm = await buildModel(gpx.segments, { label }, { getTile, manifold: wasm });
    const count = [0, 0, 0, 0, 0, 0];
    for (const k of lm.trail) count[k]++;
    console.log(`label ${style} ${angle}°: ${t.width.toFixed(1)} x ${t.height.toFixed(1)} mm text, ${t.contours.length} contours; ` +
                `plate ${count[4]} / lettering ${count[5]} vertices; ${lm.stats.triangles.toLocaleString("en")} triangles`);
    if (!count[4] || !count[5]) { bad++; console.log(`MISMATCH label ${style} missing parts`); }
    // engraved letters' fill isn't in the single-colour model (that has the empty pocket)
    const fill = style === "engraved" ? toManifold(lm.parts3mf.find((q) => q.role === "lettering")).volume() : 0;
    bad += checkParts(`label ${style}`, lm, fill);
    if (out) await writeFile(out.replace(/[.]stl$/, `-label-${style}-${angle}.stl`), Buffer.from(writeStl(lm.positions, lm.indices, "label")));
  }
  const prof = await routeProfile(gpx.segments, getTile);
  console.log(`profile: high ${prof.max.toFixed(0)} m, low ${prof.min.toFixed(0)} m, +${prof.gain.toFixed(0)} / -${prof.loss.toFixed(0)} m; times ${JSON.stringify(routeTimes(gpx.segments))}`);
  if (!(prof.max > 3000 && prof.min < 1300 && prof.loss > prof.gain)) { bad++; console.log("MISMATCH profile"); }
  console.log(bad ? "FAILED" : "OK: label + profile");
}
// Inlay: pieces are valid, fit their slot without touching the terrain, and lie flat on their floor.
{
  const toManifold = (pos, idx) => new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: pos, triVerts: idx }));
  const im = await buildModel(gpx.segments, { inlay: {}, startMarker: "triangle", endMarker: "square" }, { getTile, manifold: wasm });
  const terrain = toManifold(im.positions, im.indices);
  const st = im.stats.inlay;
  console.log(`inlay: ${st.pieces} piece(s), tallest ${st.tallest.toFixed(1)} mm, steepest floor ${st.steepest.toFixed(1)}°, ` +
              `base raised to ${im.stats.base} mm, ${im.stats.triangles.toLocaleString("en")} triangles`);
  if (!st.pieces) { bad++; console.log("MISMATCH no inlay pieces"); }
  im.inlays.forEach((q, k) => {
    const piece = toManifold(q.positions, q.indices);
    const overlap = terrain.intersect(piece).volume();
    const flat = layFlat(q.positions, q.plane);
    let onBed = 0;
    for (let i = 2; i < flat.length; i += 3) if (flat[i] < 0.01) onBed++;
    const markers = [...new Set(q.trail)].filter((t) => t > 1);
    console.log(`  piece ${k + 1}: ${(piece.volume() / 1000).toFixed(2)} cm3, tilt ${q.tilt.toFixed(1)}°, height ${q.height.toFixed(1)} mm, ` +
                `overlap with terrain ${overlap.toFixed(3)} mm3, ${onBed} vertices on the bed, markers ${markers.join(",") || "-"}`);
    if (overlap > 0.5) { bad++; console.log("MISMATCH inlay overlaps the terrain"); }
    if (onBed < 10) { bad++; console.log("MISMATCH piece does not lie flat"); }
    if (out) writeFile(out.replace(/[.]stl$/, `-inlay-${k + 1}.stl`), Buffer.from(writeStl(flat, q.indices, `inlay ${k + 1}`)));
  });
  if (out) await writeFile(out.replace(/[.]stl$/, "-inlay-terrain.stl"), Buffer.from(writeStl(im.positions, im.indices, "terrain")));
  bad += checkParts("inlay", im, im.inlays.reduce((v, q) => v + toManifold(q.positions, q.indices).volume(), 0));   // local toManifold(pos, idx)
  console.log(bad ? "FAILED" : "OK: inlay");
}
process.exit(bad ? 1 : 0);
