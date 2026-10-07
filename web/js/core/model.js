// GPX segments -> watertight terrain solid with the route raised (or grooved) on it.
// Grew out of a Python script; the default output must keep matching its reference model (tests/).
import { TILE, lonLatToTile } from "./tiles.js";
import { gaussianBlur, distanceTransform } from "./filters.js";
import { inPolygon } from "./markers.js";
import { INLAY_DEFAULTS, planPieces, bufferPolyline, abovePlane } from "./inlay.js";
import { gridSolid, mergedTris, meshOut, footprintSection, markerOutlines, labelFrame, labelSections } from "./solids.js";
import { buildFlat } from "./flat.js";

const EARTH_R = 6371008.8;
const ORDER = ["terrain", "route", "start", "finish", "lettering"];   // 3MF part order
const MAX_TILES = 400;
const RAD = Math.PI / 180;

export const DEFAULTS = {
  size: 180,          // longest side, mm
  marginKm: 1.8,      // terrain around the route
  zExag: 2,           // vertical exaggeration
  base: 3,            // thickness under the lowest point, mm
  cell: 0.3,          // grid spacing, mm
  trailHeight: 1.0,   // mm; negative cuts a groove
  trailWidth: 1.6,    // mm
  cornerRadius: 10,   // mm; 0 for square
  shape: "rect",      // footprint: "rect" or "hex" (hexagon inscribed in the area)
  smooth: 0.8,        // terrain blur, grid cells
  startMarker: "none", // marker shape at the start / finish (see markers.js)
  endMarker: "none",
  markerSize: 6,      // mm across
  markerHeight: 2,    // mm above the highest terrain under the marker
  // Label plate, or null. { center: {lat, lon}, contours (mm, centred, non-zero fill, from
  // text.js layoutText), width, height (plate, mm), style: "raised"|"engraved", relief (mm),
  // angle (degrees, counter-clockwise) }
  label: null,
  // Separate route inlay (see inlay.js), or null for a ridge/groove moulded into the terrain:
  // { clearance, depth, maxHeight, minFloor, maxTilt }. trailHeight is then how far the inlay
  // stands above the terrain (>= 0) and trailWidth its width.
  inlay: null,
  // "relief" (the terrain itself), or a quick flat print: "contours" (lines on a plate) or
  // "terraced" (stacked steps); settings for those in contours (see flat.js FLAT_DEFAULTS)
  printStyle: "relief",
  contours: null,
  zoom: null,         // tile zoom; null = choose from cell size
  origin: null,       // { lat, lon } projection centre; null = mean of the route points
};

/**
 * Local equirectangular frame centred on the route (or on `origin`): metres east/north of it.
 * x depends only on longitude and y only on latitude, so lat/lon boxes map to rectangles.
 */
export function routeFrame(segments, origin = null) {
  let latc = 0, lonc = 0, n = 0;
  for (const s of segments) for (const [la, lo] of s) { latc += la; lonc += lo; n++; }
  latc /= n; lonc /= n;
  if (origin) ({ lat: latc, lon: lonc } = origin);
  const cosl = Math.cos(latc * RAD);
  const toM = ([la, lo]) => [(lo - lonc) * RAD * EARTH_R * cosl, (la - latc) * RAD * EARTH_R];
  const lonOf = (x) => lonc + x / (EARTH_R * cosl) / RAD;
  const latOf = (y) => latc + y / EARTH_R / RAD;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const s of segments) for (const p of s) {
    const [x, y] = toM(p);
    xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  return { latc, lonc, cosl, toM, lonOf, latOf, toLL: (x, y) => [latOf(y), lonOf(x)],
           bounds: { xmin, xmax, ymin, ymax } };
}

/**
 * Grid geometry and tile plan for a route; cheap, so the UI can use it for estimates.
 * opts.area = { south, west, north, east } prints exactly that box; otherwise the area is the
 * route's bounding box plus opts.marginKm on every side.
 */
export function planGrid(segments, opts) {
  const o = { ...DEFAULTS, ...opts };
  const frame = routeFrame(segments, o.origin);
  const { latc, lonc, cosl, toM, lonOf, latOf } = frame;
  let { xmin, xmax, ymin, ymax } = frame.bounds;
  if (o.area) {
    [xmin, ymin] = toM([o.area.south, o.area.west]);
    [xmax, ymax] = toM([o.area.north, o.area.east]);
  } else {
    const marg = o.marginKm * 1000;
    xmin -= marg; xmax += marg; ymin -= marg; ymax += marg;
  }
  const sc = o.size / Math.max(xmax - xmin, ymax - ymin);      // mm per metre
  const nx = Math.round(((xmax - xmin) * sc) / o.cell) + 1;
  const ny = Math.round(((ymax - ymin) * sc) / o.cell) + 1;

  let z = o.zoom;
  if (z == null) {                       // finest level whose pixels are no coarser than a cell
    z = 8;
    while (z < 14 && (156543.03 * cosl) / 2 ** z > o.cell / sc) z++;
  }
  const [xa, ya] = lonLatToTile(lonOf(xmin), latOf(ymax), z);   // north-west
  const [xb, yb] = lonLatToTile(lonOf(xmax), latOf(ymin), z);   // south-east
  const tiles = { x0: Math.floor(xa), x1: Math.floor(xb), y0: Math.floor(ya), y1: Math.floor(yb) };
  tiles.count = (tiles.x1 - tiles.x0 + 1) * (tiles.y1 - tiles.y0 + 1);

  return {
    o, frame, latc, lonc, cosl, toM, lonOf, latOf, xmin, xmax, ymin, ymax, sc, nx, ny, z, tiles,
    width: (nx - 1) * o.cell, depth: (ny - 1) * o.cell,
    // before cutting the footprint; a hexagon keeps about 3/4 of its box
    triangles: Math.round((o.shape === "hex" ? 0.75 : 1) * 2 * (nx - 1) * (ny - 1)) + 3 * 2 * (nx + ny - 2),
  };
}

async function loadDem(plan, getTile, progress) {
  const { x0, x1, y0, y1, count } = plan.tiles;
  if (count > MAX_TILES)
    throw new Error(`This area needs ${count} elevation tiles (limit ${MAX_TILES}). ` +
                    "Use a coarser detail level or a smaller margin.");
  const w = (x1 - x0 + 1) * TILE, dem = new Float64Array(w * (y1 - y0 + 1) * TILE);
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
  let done = 0;
  const worker = async () => {
    for (let j; (j = jobs.shift()); ) {
      const [tx, ty] = j, t = await getTile(plan.z, tx, ty);
      const ox = (tx - x0) * TILE, oy = (ty - y0) * TILE;
      for (let r = 0; r < TILE; r++) dem.set(t.subarray(r * TILE, (r + 1) * TILE), (oy + r) * w + ox);
      progress("tiles", ++done / count);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  return { dem, w, h: dem.length / w };
}

/**
 * Build the model.
 *   getTile(z, x, y) -> Promise<Float64Array(256*256)> of metres
 *   manifold: initialised manifold-3d wasm module (after .setup())
 * Returns { positions: Float32Array, indices: Uint32Array, trail: Uint8Array (per vertex), stats,
 *           inlays: [{ positions, indices, trail, plane, height, tilt }] (inlay mode only),
 *           parts3mf: [{ name, role, positions, indices }] | null — the model split into one body
 *             per colour for a multi-colour 3MF (role: terrain, route, start, finish, lettering);
 *             the parts don't overlap. null when there's only the terrain. }
 * The main body (positions/indices) is always the single-colour version with everything merged.
 */
export async function buildModel(segments, opts, { getTile, manifold, progress = () => {} }) {
  const plan = planGrid(segments, opts);
  const { o, nx, ny, sc, xmin, xmax, ymin, ymax, z } = plan;
  const { cell } = o;
  const inl = o.inlay && { ...INLAY_DEFAULTS, ...o.inlay };
  // room for the slot under the lowest ground, plus headroom so sloped floors can dip a little there
  if (inl) o.base = Math.max(o.base, inl.depth + inl.minFloor + 1.5);

  // terrain: bilinear sample of the tile mosaic at every grid point
  const { dem, w: dw, h: dh } = await loadDem(plan, getTile, progress);
  progress("terrain", 0);
  const px = new Float64Array(nx), py = new Float64Array(ny);
  const clip = (v, hi) => Math.min(Math.max(v, 0), hi);
  for (let i = 0; i < nx; i++) {
    const x = nx > 1 ? xmin + ((xmax - xmin) * i) / (nx - 1) : xmin;
    px[i] = clip((lonLatToTile(plan.lonOf(x), plan.latc, z)[0] - plan.tiles.x0) * TILE - 0.5, dw - 1);
  }
  for (let j = 0; j < ny; j++) {
    const y = ny > 1 ? ymin + ((ymax - ymin) * j) / (ny - 1) : ymin;
    py[j] = clip((lonLatToTile(plan.lonc, plan.latOf(y), z)[1] - plan.tiles.y0) * TILE - 0.5, dh - 1);
  }
  const elev = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y0 = Math.floor(py[j]), y1 = Math.min(y0 + 1, dh - 1), fy = py[j] - y0;
    for (let i = 0; i < nx; i++) {
      const x0 = Math.floor(px[i]), x1 = Math.min(x0 + 1, dw - 1), fx = px[i] - x0;
      const a = dem[y0 * dw + x0], b = dem[y0 * dw + x1], c = dem[y1 * dw + x0], d = dem[y1 * dw + x1];
      elev[j * nx + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  if (o.smooth > 0) gaussianBlur(elev, nx, ny, o.smooth);
  let emin = Infinity, emax = -Infinity;
  for (const e of elev) { emin = Math.min(emin, e); emax = Math.max(emax, e); }
  if (o.printStyle === "contours" || o.printStyle === "terraced")
    return buildFlat({ segments, plan, elev, emin, emax, manifold, progress });

  // route: distance from the rasterised track, turned into a tapered bump (not with an inlay)
  progress("route", 0);
  const Zt = new Float64Array(nx * ny), bump = new Float32Array(nx * ny);
  let zmax = 0;
  if (!inl) {
    const seed = new Uint8Array(nx * ny);
    const step = cell / 4 / sc;
    for (const s of segments) {
      const pts = s.map(plan.toM);
      let t = 0;
      for (let k = 1; k < pts.length; k++) {
        const [ax, ay] = pts[k - 1], [bx, by] = pts[k], len = Math.hypot(bx - ax, by - ay);
        for (; t < len; t += step) {
          const f = t / len;
          const ix = Math.round(((ax + (bx - ax) * f - xmin) * sc) / cell);
          const iy = Math.round(((ay + (by - ay) * f - ymin) * sc) / cell);
          if (ix >= 0 && ix < nx && iy >= 0 && iy < ny) seed[iy * nx + ix] = 1;   // area may crop the route
        }
        t -= len;
      }
    }
    const dist = distanceTransform(seed, nx, ny);
    const half = o.trailWidth / 2, r0 = Math.max(half - 0.2, 0), r1 = half + 0.25;
    for (let i = 0; i < Zt.length; i++) bump[i] = o.trailHeight * clip((r1 - dist[i] * cell) / (r1 - r0), 1);
  }
  for (let i = 0; i < Zt.length; i++) {
    Zt[i] = Math.max(o.base + (elev[i] - emin) * sc * o.zExag + bump[i], 0.6);  // floor if grooving
    zmax = Math.max(zmax, Zt[i]);
  }

  progress("mesh", 0);
  const W = (nx - 1) * cell, D = (ny - 1) * cell;

  // start/finish markers, facing the direction of travel, standing above the highest ground under them
  const toMM = (p) => { const [x, y] = plan.toM(p); return [(x - xmin) * sc, (y - ymin) * sc]; };
  const markers = markerOutlines(segments, toMM, o, W, D).map((m) => {
    let top = 0;
    const rad = o.markerSize / 2 / cell;
    for (let j = Math.max(0, Math.floor(m.cy / cell - rad)); j <= Math.min(ny - 1, Math.ceil(m.cy / cell + rad)); j++)
      for (let i = Math.max(0, Math.floor(m.cx / cell - rad)); i <= Math.min(nx - 1, Math.ceil(m.cx / cell + rad)); i++)
        if (Math.hypot(i - m.cx / cell, j - m.cy / cell) <= rad + 1) top = Math.max(top, Zt[j * nx + i]);
    return { ...m, top: top + o.markerHeight };
  });
  // label plate: flat top level with the highest ground under it
  let label = null;
  if (o.label?.contours?.length) {
    const f = labelFrame(o.label, toMM);
    let top = 0;
    for (let j = Math.max(0, Math.floor((f.cy - f.bh) / cell)); j <= Math.min(ny - 1, Math.ceil((f.cy + f.bh) / cell)); j++)
      for (let i = Math.max(0, Math.floor((f.cx - f.bw) / cell)); i <= Math.min(nx - 1, Math.ceil((f.cx + f.bw) / cell)); i++) {
        const [u, v] = f.local(i * cell, j * cell);
        if (Math.abs(u) <= f.hw + cell && Math.abs(v) <= f.hh + cell) top = Math.max(top, Zt[j * nx + i]);
      }
    if (top > 0) label = { ...f, top: top + 0.2 };   // 0.2 mm proud so the edge reads
  }
  const proud = inl ? Math.max(0, o.trailHeight) : 0;
  const ztop = Math.max(zmax + proud, ...markers.map((m) => m.top),
                        label ? label.top + (label.style === "engraved" ? 0 : label.relief) : 0);

  progress("solid", 0);
  const { Manifold, Mesh, CrossSection } = manifold;
  const trash = [];
  const keep = (x) => (trash.push(x), x);
  let lettering = null;
  try {
    // Every boolean with the full terrain costs a pass over ~0.5M triangles, so small bodies are
    // collected and applied in batches: what's added to / cut from the terrain, then the footprint,
    // then the small parts that sit on top (markers, raised letters).
    // (manifold evaluates lazily; status() forces each stage so progress reports are honest)
    let solid = keep(gridSolid(manifold, Zt, nx, cell, 0, nx - 1, 0, ny - 1));
    solid.status();
    progress("solid", 0.3);
    const adds = [], cuts = [];
    // start/finish markers stay separate bodies until the end (their own 3MF parts); with an
    // inlay they ride on the first and last pieces instead (see below)
    const markerBodies = [];
    for (const m of inl ? [] : markers) {
      const cs = keep(keep(new CrossSection([m.poly])).intersect(keep(CrossSection.square([W, D]))));
      markerBodies.push({ m, solid: keep(Manifold.extrude(cs, m.top)) });
    }
    if (label) {
      const { top } = label, { plate, text } = labelSections(CrossSection, label, W, D, keep);
      adds.push(keep(Manifold.extrude(plate, top)));
      // the lettering stays a separate body until the end, so a 3MF can give it its own filament:
      // raised letters stand on the plate; engraved ones get a fill that is flush with it
      if (label.style === "engraved") {
        cuts.push(keep(keep(Manifold.extrude(text, label.relief + 1)).translate([0, 0, top - label.relief])));
        lettering = keep(keep(Manifold.extrude(text, label.relief)).translate([0, 0, top - label.relief]));
      } else {
        lettering = keep(keep(Manifold.extrude(text, label.relief)).translate([0, 0, top]));
      }
    }
    // separate inlay: slot cut into the terrain, pieces built to drop into it
    const pieces = [];
    if (inl) {
      const rIn = o.trailWidth / 2, rOut = rIn + inl.clearance, reach = Math.ceil(rOut / cell);
      const heightAt = (x, y) => {             // lowest ground the slot cuts through; the inlay's top
        const ci = Math.round(x / cell), cj = Math.round(y / cell);
        let lo = Infinity, hi = 0;
        for (let j = Math.max(0, cj - reach); j <= Math.min(ny - 1, cj + reach); j++)
          for (let i = Math.max(0, ci - reach); i <= Math.min(nx - 1, ci + reach); i++) {
            lo = Math.min(lo, Zt[j * nx + i]); hi = Math.max(hi, Zt[j * nx + i]);
          }
        return { lo: lo === Infinity ? Zt[0] : lo, top: hi + proud };
      };
      const lines = segments.map((s) => s.map((p) => { const [x, y] = plan.toM(p); return [(x - xmin) * sc, (y - ymin) * sc]; }));
      const plans = planPieces(lines, heightAt, { ...inl, proud });
      const slots = [];
      let taken = null;                        // outlines (with clearance) of earlier pieces
      plans.forEach((pc, k) => {
        const mk = markers.filter((m) => (m.kind === 2 && k === 0) || (m.kind === 3 && k === plans.length - 1));
        const [nrm, off] = abovePlane(pc.plane);
        let outer = keep(new CrossSection(bufferPolyline(pc.pts, rOut), "NonZero"));
        for (const m of mk) outer = keep(outer.add(keep(keep(new CrossSection([m.poly])).offset(inl.clearance, "Round", 2, 16))));
        let inner = keep(new CrossSection(bufferPolyline(pc.pts, rIn), "NonZero"));
        if (taken) inner = keep(inner.subtract(taken));
        slots.push(keep(keep(Manifold.extrude(outer, ztop + 20)).trimByPlane(nrm, off)));
        // the piece: from its floor plane up to the terrain surface (+ proud), over its outline
        const bb = outer.bounds(), pad = 2;
        const i0 = Math.max(0, Math.floor(bb.min[0] / cell) - pad), i1 = Math.min(nx - 1, Math.ceil(bb.max[0] / cell) + pad);
        const j0 = Math.max(0, Math.floor(bb.min[1] / cell) - pad), j1 = Math.min(ny - 1, Math.ceil(bb.max[1] / cell) + pad);
        if (i1 - i0 < 1 || j1 - j0 < 1) return;
        const surface = keep(gridSolid(manifold, Zt, nx, cell, i0, i1, j0, j1, proud));
        const fin = keep(keep(keep(Manifold.extrude(inner, ztop + 20)).trimByPlane(nrm, off)).intersect(surface));
        let piece = fin;
        const own = [];
        for (const m of mk) {
          let ms = keep(new CrossSection([m.poly]));
          if (taken) ms = keep(ms.subtract(taken));
          const body = keep(keep(Manifold.extrude(ms, m.top)).trimByPlane(nrm, off));
          own.push({ m, solid: body });
          piece = keep(piece.add(body));
        }
        taken = taken ? keep(taken.add(outer)) : outer;
        pieces.push({ solid: piece, fin, markerBodies: own, plane: pc.plane, height: pc.height, tilt: pc.tilt, markers: mk });
      });
      if (slots.length) {
        const slot = keep(Manifold.union(slots));
        cuts.push(slot);
        if (lettering) lettering = keep(lettering.subtract(slot));
      }
    }
    if (adds.length) solid = keep(Manifold.union([solid, ...adds]));
    if (cuts.length) solid = keep(solid.subtract(cuts.length > 1 ? keep(Manifold.union(cuts)) : cuts[0]));
    solid.status();
    progress("solid", 0.5);

    const r = Math.min(o.cornerRadius, W / 2 - 0.1, D / 2 - 0.1);
    // (a plain rectangle needs no cut, except to trim inlay pieces that overhang the edge)
    const footprint = o.shape === "hex" || r > 0 || pieces.length
      ? keep(Manifold.extrude(footprintSection(CrossSection, o.shape, W, D, r, keep), ztop + 10)) : null;
    if (footprint) solid = keep(solid.intersect(footprint));
    solid.status();
    progress("solid", 0.75);
    if (lettering && footprint) lettering = keep(lettering.intersect(footprint));
    if (lettering?.isEmpty()) lettering = null;
    // single-colour body: raised letters merged in (engraved ones are just the empty pocket)
    const plain = solid;                       // terrain alone, for the 3MF
    const parts = [];                          // [name, role, manifold] for the 3MF
    const onTop = [];                          // small bodies merged into the single-colour model
    for (const b of markerBodies) {
      const ms = footprint ? keep(b.solid.intersect(footprint)) : b.solid;
      if (ms.isEmpty()) continue;
      onTop.push(ms);
      // the part is only what stands above the ground, so it doesn't overlap the terrain part
      const reach = o.markerSize / 2 + 2 * cell;
      const i0 = Math.max(0, Math.floor((b.m.cx - reach) / cell)), i1 = Math.min(nx - 1, Math.ceil((b.m.cx + reach) / cell));
      const j0 = Math.max(0, Math.floor((b.m.cy - reach) / cell)), j1 = Math.min(ny - 1, Math.ceil((b.m.cy + reach) / cell));
      const above = keep(ms.subtract(keep(gridSolid(manifold, Zt, nx, cell, i0, i1, j0, j1))));
      if (!above.isEmpty()) parts.push([b.m.kind === 2 ? "Start marker" : "Finish marker", b.m.kind === 2 ? "start" : "finish", above]);
    }
    if (lettering && label.style !== "engraved") onTop.push(lettering);
    if (onTop.length) solid = keep(Manifold.union([solid, ...onTop]));
    const status = solid.status();
    if (status !== "NoError" || solid.isEmpty()) throw new Error(`Mesh is not a valid solid (${status})`);
    progress("solid", 0.9);
    const mesh = solid.getMesh();
    const np = mesh.numProp, mv = mesh.vertProperties, nv = mv.length / np;
    const positions = new Float32Array(nv * 3), trail = new Uint8Array(nv);
    let bmax = 0;
    for (const v of bump) bmax = Math.max(bmax, Math.abs(v));
    for (let v = 0; v < nv; v++) {
      const x = mv[v * np], y = mv[v * np + 1], zz = mv[v * np + 2];
      positions[v * 3] = x; positions[v * 3 + 1] = y; positions[v * 3 + 2] = zz;
      if (zz > 0.01 && bmax > 0) {
        const g = clip(Math.round(y / cell), ny - 1) * nx + clip(Math.round(x / cell), nx - 1);
        trail[v] = Math.abs(bump[g]) > 0.5 * bmax ? 1 : 0;
      }
      for (const m of markers) {            // 2 = start marker, 3 = finish marker
        const k = 1.04, mx = m.cx + (x - m.cx) / k, my = m.cy + (y - m.cy) / k;   // slightly generous
        if (zz > 0.01 && inPolygon(m.poly, mx, my)) trail[v] = m.kind;
      }
      const [lu, lv] = label ? label.local(x, y) : [];
      if (label && Math.abs(lu) <= label.width / 2 + 0.01 && Math.abs(lv) <= label.height / 2 + 0.01) {
        // 4 = label plate, 5 = lettering (top and sides of raised text, or floor and sides of engraving)
        if (Math.abs(zz - label.top) < 0.005) trail[v] = 4;
        else if (zz > label.top - label.relief - 0.005 && zz <= label.top + label.relief + 0.005) trail[v] = 5;
      }
    }
    const indices = mergedTris(mesh);

    // inlay pieces: trail colour, start/finish colours on their markers
    const inlays = [];
    let volume = solid.volume(), triangles = indices.length / 3;
    for (const pc of pieces) {
      const ps = footprint ? keep(pc.solid.intersect(footprint)) : pc.solid;
      if (ps.isEmpty()) continue;
      // 3MF: the route piece without its marker, and the marker on its own
      let fin = footprint ? keep(pc.fin.intersect(footprint)) : pc.fin;
      for (const b of pc.markerBodies) {
        const ms = footprint ? keep(b.solid.intersect(footprint)) : b.solid;
        fin = keep(fin.subtract(ms));
        if (!ms.isEmpty()) parts.push([b.m.kind === 2 ? "Start marker" : "Finish marker", b.m.kind === 2 ? "start" : "finish", ms]);
      }
      if (!fin.isEmpty()) parts.push([`Route ${inlays.length + 1}`, "route", fin]);
      if (ps.status() !== "NoError") throw new Error(`Inlay is not a valid solid (${ps.status()})`);
      const g = ps.getMesh(), gp = g.numProp, gv = g.vertProperties, n = gv.length / gp;
      const pos = new Float32Array(n * 3), col = new Uint8Array(n).fill(1);
      for (let v = 0; v < n; v++) {
        const x = gv[v * gp], y = gv[v * gp + 1];
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = gv[v * gp + 2];
        for (const m of pc.markers) {
          const k = 1.04, mx = m.cx + (x - m.cx) / k, my = m.cy + (y - m.cy) / k;
          if (inPolygon(m.poly, mx, my)) col[v] = m.kind;
        }
      }
      const idx = mergedTris(g);
      inlays.push({ positions: pos, indices: idx, trail: col, plane: pc.plane, height: pc.height, tilt: pc.tilt });
      volume += ps.volume();
      triangles += idx.length / 3;
    }

    return {
      positions, indices, trail, inlays,
      parts3mf: parts.length || lettering
        ? [["Terrain", "terrain", plain], ...parts.sort((a, b) => ORDER.indexOf(a[1]) - ORDER.indexOf(b[1])),
           ...(lettering ? [["Label text", "lettering", lettering]] : [])]
            .map(([name, role, m]) => ({ name, role, ...meshOut(m) }))
        : null,
      stats: {
        width: W, depth: D, height: ztop,
        scale: 1000 / sc, zExag: o.zExag, base: o.base,
        elevMin: emin, elevMax: emax, zoom: z, tiles: plan.tiles.count,
        triangles, volume: volume / 1000,   // cm3
        inlay: inl && {
          pieces: inlays.length,
          tallest: Math.max(0, ...inlays.map((q) => q.height)),
          steepest: Math.max(0, ...inlays.map((q) => q.tilt)),
        },
      },
    };
  } finally {
    for (const x of trash) try { x.delete(); } catch {}
  }
}

