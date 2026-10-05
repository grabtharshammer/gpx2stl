// GPX segments -> watertight terrain solid with the route raised (or grooved) on it.
// Port of the original Python gpx2stl.build(); keep the two in step (see tests/).
import { TILE, lonLatToTile } from "./tiles.js";
import { gaussianBlur, distanceTransform } from "./filters.js";

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
  smooth: 0.8,        // terrain blur, grid cells
  zoom: null,         // tile zoom; null = choose from cell size
};

/** Grid geometry and tile plan for a route; cheap, so the UI can use it for estimates. */
export function planGrid(segments, opts) {
  const o = { ...DEFAULTS, ...opts };
  let latc = 0, lonc = 0, n = 0;
  for (const s of segments) for (const [la, lo] of s) { latc += la; lonc += lo; n++; }
  latc /= n; lonc /= n;
  const cosl = Math.cos(latc * RAD);
  const toM = ([la, lo]) => [(lo - lonc) * RAD * EARTH_R * cosl, (la - latc) * RAD * EARTH_R];

  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const s of segments) for (const p of s) {
    const [x, y] = toM(p);
    xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
  }
  const marg = o.marginKm * 1000;
  xmin -= marg; xmax += marg; ymin -= marg; ymax += marg;
  const sc = o.size / Math.max(xmax - xmin, ymax - ymin);      // mm per metre
  const nx = Math.round(((xmax - xmin) * sc) / o.cell) + 1;
  const ny = Math.round(((ymax - ymin) * sc) / o.cell) + 1;

  let z = o.zoom;
  if (z == null) {                       // finest level whose pixels are no coarser than a cell
    z = 8;
    while (z < 14 && (156543.03 * cosl) / 2 ** z > o.cell / sc) z++;
  }
  const lonOf = (x) => lonc + x / (EARTH_R * cosl) / RAD;
  const latOf = (y) => latc + y / EARTH_R / RAD;
  const [xa, ya] = lonLatToTile(lonOf(xmin), latOf(ymax), z);   // north-west
  const [xb, yb] = lonLatToTile(lonOf(xmax), latOf(ymin), z);   // south-east
  const tiles = { x0: Math.floor(xa), x1: Math.floor(xb), y0: Math.floor(ya), y1: Math.floor(yb) };
  tiles.count = (tiles.x1 - tiles.x0 + 1) * (tiles.y1 - tiles.y0 + 1);

  return {
    o, latc, lonc, cosl, toM, lonOf, latOf, xmin, xmax, ymin, ymax, sc, nx, ny, z, tiles,
    width: (nx - 1) * o.cell, depth: (ny - 1) * o.cell,
    triangles: 2 * (nx - 1) * (ny - 1) + 3 * 2 * (nx + ny - 2),   // before corner rounding
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
        seed[clip(iy, ny - 1) * nx + clip(ix, nx - 1)] = 1;
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

  progress("solid", 0);
  const { Manifold, Mesh, CrossSection } = manifold;
  const trash = [];
  const keep = (x) => (trash.push(x), x);
  try {
    let solid = keep(new Manifold(new Mesh({ numProp: 3, vertProperties: V, triVerts: F })));
    const r = Math.min(o.cornerRadius, W / 2 - 0.1, D / 2 - 0.1);
    if (r > 0) {
      const sq = keep(keep(CrossSection.square([W - 2 * r, D - 2 * r])).translate([r, r]));
      const cs = keep(sq.offset(r, "Round", 2, 96));
      solid = keep(solid.intersect(keep(Manifold.extrude(cs, zmax + 10))));
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
    }
    const indices = new Uint32Array(mesh.triVerts);
    return {
      positions, indices, trail,
      stats: {
        width: W, depth: D, height: zmax,
        scale: 1000 / sc, zExag: o.zExag,
        elevMin: emin, elevMax: emax, zoom: z, tiles: plan.tiles.count,
        triangles: indices.length / 3, volume: solid.volume() / 1000,   // cm3
      },
    };
  } finally {
    for (const x of trash) try { x.delete(); } catch {}
  }
}
