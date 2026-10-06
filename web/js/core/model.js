// GPX segments -> watertight terrain solid with the route raised (or grooved) on it.
// Port of the original Python gpx2stl.build(); keep the two in step (see tests/).
import { TILE, lonLatToTile } from "./tiles.js";
import { gaussianBlur, distanceTransform } from "./filters.js";
import { outline } from "./footprint.js";
import { markerPolygon, inPolygon } from "./markers.js";

const EARTH_R = 6371008.8;
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
  // text.js layoutText), width, height (plate, mm), style: "raised"|"engraved", relief (mm) }
  label: null,
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
 * Returns { positions: Float32Array, indices: Uint32Array, trail: Uint8Array (per vertex), stats }.
 */
export async function buildModel(segments, opts, { getTile, manifold, progress = () => {} }) {
  const plan = planGrid(segments, opts);
  const { o, nx, ny, sc, xmin, xmax, ymin, ymax, z } = plan;
  const { cell } = o;

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

  // route: distance from the rasterised track, turned into a tapered bump
  progress("route", 0);
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
  const Zt = new Float64Array(nx * ny), bump = new Float32Array(nx * ny);
  let zmax = 0;
  for (let i = 0; i < Zt.length; i++) {
    bump[i] = o.trailHeight * clip((r1 - dist[i] * cell) / (r1 - r0), 1);
    Zt[i] = Math.max(o.base + (elev[i] - emin) * sc * o.zExag + bump[i], 0.6);  // floor if grooving
    zmax = Math.max(zmax, Zt[i]);
  }

  // watertight solid: top grid, vertical walls, fan-triangulated flat bottom
  progress("mesh", 0);
  const W = (nx - 1) * cell, D = (ny - 1) * cell;
  const per = [];
  for (let i = 0; i < nx - 1; i++) per.push(i);                         // south edge, west->east
  for (let j = 0; j < ny - 1; j++) per.push(j * nx + nx - 1);           // east edge, south->north
  for (let i = nx - 1; i > 0; i--) per.push((ny - 1) * nx + i);         // north edge, east->west
  for (let j = ny - 1; j > 0; j--) per.push(j * nx);                    // west edge, north->south
  const nb = per.length, nTop = nx * ny, ci = nTop + nb;
  const V = new Float32Array((nTop + nb + 1) * 3);
  for (let j = 0, p = 0; j < ny; j++)
    for (let i = 0; i < nx; i++, p += 3) { V[p] = i * cell; V[p + 1] = j * cell; V[p + 2] = Zt[j * nx + i]; }
  per.forEach((t, k) => { V[(nTop + k) * 3] = V[t * 3]; V[(nTop + k) * 3 + 1] = V[t * 3 + 1]; });
  V[ci * 3] = W / 2; V[ci * 3 + 1] = D / 2;

  const F = new Uint32Array((2 * (nx - 1) * (ny - 1) + 3 * nb) * 3);
  let f = 0;
  const tri = (a, b, c) => { F[f++] = a; F[f++] = b; F[f++] = c; };
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx + 1, e = a + nx;
      tri(a, b, c); tri(a, c, e);
    }
  for (let j = 0; j < nb; j++) {
    const k = (j + 1) % nb, bj = nTop + j, bk = nTop + k;
    tri(per[j], bj, bk); tri(per[j], bk, per[k]); tri(bk, bj, ci);
  }

  // start/finish markers, facing the direction of travel
  const markers = [];
  const markerAt = (kind, shape, pts) => {
    if (!shape || shape === "none") return;
    const [px, py] = pts[0], reach = o.markerSize / sc;          // look one marker-width along
    let [hx, hy] = pts[Math.min(1, pts.length - 1)];
    for (const q of pts) if (Math.hypot(q[0] - px, q[1] - py) >= reach) { [hx, hy] = q; break; }
    const cx = (px - xmin) * sc, cy = (py - ymin) * sc;           // mm in model space
    if (cx < 0 || cx > W || cy < 0 || cy > D) return;              // cropped away
    // pts runs away from the marker: forwards from the start, backwards from the finish
    const heading = kind === 3 ? Math.atan2(py - hy, px - hx) : Math.atan2(hy - py, hx - px);
    const poly = markerPolygon(shape, o.markerSize, heading).map(([x, y]) => [cx + x, cy + y]);
    let top = 0;
    const rad = o.markerSize / 2 / cell;
    for (let j = Math.max(0, Math.floor(cy / cell - rad)); j <= Math.min(ny - 1, Math.ceil(cy / cell + rad)); j++)
      for (let i = Math.max(0, Math.floor(cx / cell - rad)); i <= Math.min(nx - 1, Math.ceil(cx / cell + rad)); i++)
        if (Math.hypot(i - cx / cell, j - cy / cell) <= rad + 1) top = Math.max(top, Zt[j * nx + i]);
    markers.push({ kind, poly, cx, cy, top: top + o.markerHeight });
  };
  const first = segments[0].map(plan.toM), last = segments.at(-1).map(plan.toM).reverse();
  markerAt(2, o.startMarker, first);
  markerAt(3, o.endMarker, last);
  // label plate: flat top level with the highest ground under it
  let label = null;
  if (o.label?.contours?.length) {
    const L = o.label, [lx, ly] = plan.toM([L.center.lat, L.center.lon]);
    const cx = (lx - xmin) * sc, cy = (ly - ymin) * sc, hw = L.width / 2, hh = L.height / 2;
    let top = 0;
    for (let j = Math.max(0, Math.floor((cy - hh) / cell)); j <= Math.min(ny - 1, Math.ceil((cy + hh) / cell)); j++)
      for (let i = Math.max(0, Math.floor((cx - hw) / cell)); i <= Math.min(nx - 1, Math.ceil((cx + hw) / cell)); i++)
        top = Math.max(top, Zt[j * nx + i]);
    if (top > 0) label = { ...L, cx, cy, top: top + 0.2 };   // 0.2 mm proud so the plate edge reads
  }
  const ztop = Math.max(zmax, ...markers.map((m) => m.top),
                        label ? label.top + (label.style === "engraved" ? 0 : label.relief) : 0);

  progress("solid", 0);
  const { Manifold, Mesh, CrossSection } = manifold;
  const trash = [];
  const keep = (x) => (trash.push(x), x);
  try {
    let solid = keep(new Manifold(new Mesh({ numProp: 3, vertProperties: V, triVerts: F })));
    for (const m of markers) {
      const cs = keep(keep(new CrossSection([m.poly])).intersect(keep(CrossSection.square([W, D]))));
      solid = keep(solid.add(keep(Manifold.extrude(cs, m.top))));
    }
    if (label) {
      const { cx, cy, width: w, height: h, top } = label, pr = Math.min(1.5, w / 4, h / 4);
      const plate = keep(keep(keep(keep(CrossSection.square([w - 2 * pr, h - 2 * pr])).translate([cx - w / 2 + pr, cy - h / 2 + pr]))
        .offset(pr, "Round", 2, 32)).intersect(keep(CrossSection.square([W, D]))));
      solid = keep(solid.add(keep(Manifold.extrude(plate, top))));
      const text = keep(keep(keep(new CrossSection(label.contours, "NonZero")).translate([cx, cy]))
        .intersect(keep(CrossSection.square([W, D]))));
      solid = label.style === "engraved"
        ? keep(solid.subtract(keep(keep(Manifold.extrude(text, label.relief + 1)).translate([0, 0, top - label.relief]))))
        : keep(solid.add(keep(keep(Manifold.extrude(text, label.relief)).translate([0, 0, top]))));
    }
    const r = Math.min(o.cornerRadius, W / 2 - 0.1, D / 2 - 0.1);
    if (o.shape === "hex") {
      let cs = keep(new CrossSection([outline("hex", W, D)]));
      if (r > 0) cs = keep(keep(cs.offset(-r, "Miter")).offset(r, "Round", 2, 96));
      solid = keep(solid.intersect(keep(Manifold.extrude(cs, ztop + 10))));
    } else if (r > 0) {
      const sq = keep(keep(CrossSection.square([W - 2 * r, D - 2 * r])).translate([r, r]));
      const cs = keep(sq.offset(r, "Round", 2, 96));
      solid = keep(solid.intersect(keep(Manifold.extrude(cs, ztop + 10))));
    }
    const status = solid.status();
    if (status !== "NoError" || solid.isEmpty()) throw new Error(`Mesh is not a valid solid (${status})`);
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
      if (label && Math.abs(x - label.cx) <= label.width / 2 + 0.01 && Math.abs(y - label.cy) <= label.height / 2 + 0.01) {
        // 4 = label plate, 5 = lettering (top and sides of raised text, or floor and sides of engraving)
        if (Math.abs(zz - label.top) < 0.005) trail[v] = 4;
        else if (zz > label.top - label.relief - 0.005 && zz <= label.top + label.relief + 0.005) trail[v] = 5;
      }
    }
    const indices = new Uint32Array(mesh.triVerts);
    return {
      positions, indices, trail,
      stats: {
        width: W, depth: D, height: ztop,
        scale: 1000 / sc, zExag: o.zExag,
        elevMin: emin, elevMax: emax, zoom: z, tiles: plan.tiles.count,
        triangles: indices.length / 3, volume: solid.volume() / 1000,   // cm3
      },
    };
  } finally {
    for (const x of trash) try { x.delete(); } catch {}
  }
}
