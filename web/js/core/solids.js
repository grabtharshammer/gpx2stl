// Geometry helpers shared by the relief builder (model.js) and the flat builder (flat.js).
import { outline } from "./footprint.js";
import { markerPolygon } from "./markers.js";

/**
 * Watertight heightfield solid over grid cells i0..i1 x j0..j1: top surface at Z (+ dz), vertical
 * walls, and a fan-triangulated flat bottom at z = 0.
 */
export function gridSolid({ Manifold, Mesh }, Z, nx, cell, i0, i1, j0, j1, dz = 0) {
  const gx = i1 - i0 + 1, gy = j1 - j0 + 1;
  const per = [];
  for (let i = 0; i < gx - 1; i++) per.push(i);                         // south edge, west->east
  for (let j = 0; j < gy - 1; j++) per.push(j * gx + gx - 1);           // east edge, south->north
  for (let i = gx - 1; i > 0; i--) per.push((gy - 1) * gx + i);         // north edge, east->west
  for (let j = gy - 1; j > 0; j--) per.push(j * gx);                    // west edge, north->south
  const nb = per.length, nTop = gx * gy, ci = nTop + nb;
  const V = new Float32Array((nTop + nb + 1) * 3);
  for (let j = 0, p = 0; j < gy; j++)
    for (let i = 0; i < gx; i++, p += 3) {
      V[p] = (i0 + i) * cell; V[p + 1] = (j0 + j) * cell; V[p + 2] = Z[(j0 + j) * nx + i0 + i] + dz;
    }
  per.forEach((t, k) => { V[(nTop + k) * 3] = V[t * 3]; V[(nTop + k) * 3 + 1] = V[t * 3 + 1]; });
  V[ci * 3] = i0 * cell + ((gx - 1) * cell) / 2; V[ci * 3 + 1] = j0 * cell + ((gy - 1) * cell) / 2;

  const F = new Uint32Array((2 * (gx - 1) * (gy - 1) + 3 * nb) * 3);
  let f = 0;
  const tri = (a, b, c) => { F[f++] = a; F[f++] = b; F[f++] = c; };
  for (let j = 0; j < gy - 1; j++)
    for (let i = 0; i < gx - 1; i++) {
      const a = j * gx + i, b = a + 1, c = a + gx + 1, e = a + gx;
      tri(a, b, c); tri(a, c, e);
    }
  for (let j = 0; j < nb; j++) {
    const k = (j + 1) % nb, bj = nTop + j, bk = nTop + k;
    tri(per[j], bj, bk); tri(per[j], bk, per[k]); tri(bk, bj, ci);
  }
  return new Manifold(new Mesh({ numProp: 3, vertProperties: V, triVerts: F }));
}

/**
 * Triangle indices with manifold's seam duplicates merged (mergeFromVert -> mergeToVert), so
 * indexed exports like 3MF are closed meshes. STL output is unchanged: positions are identical.
 */
export function mergedTris(mesh) {
  const t = new Uint32Array(mesh.triVerts), from = mesh.mergeFromVert, to = mesh.mergeToVert;
  if (from?.length) {
    const map = new Map();
    for (let i = 0; i < from.length; i++) map.set(from[i], to[i]);
    for (let i = 0; i < t.length; i++) { const m = map.get(t[i]); if (m !== undefined) t[i] = m; }
  }
  return t;
}

/** A manifold as plain arrays: { positions (xyz), indices }. */
export function meshOut(m) {
  const g = m.getMesh(), gp = g.numProp, gv = g.vertProperties, pos = new Float32Array((gv.length / gp) * 3);
  for (let i = 0, k = 0; i < gv.length; i += gp, k += 3) { pos[k] = gv[i]; pos[k + 1] = gv[i + 1]; pos[k + 2] = gv[i + 2]; }
  return { positions: pos, indices: mergedTris(g) };
}

/** The print's outline (W x D mm) as a CrossSection: rectangle or hexagon, corners rounded by r. */
export function footprintSection(CrossSection, shape, W, D, r, keep) {
  if (shape === "hex") {
    let cs = keep(new CrossSection([outline("hex", W, D)]));
    if (r > 0) cs = keep(keep(cs.offset(-r, "Miter")).offset(r, "Round", 2, 96));
    return cs;
  }
  if (r > 0) return keep(keep(keep(CrossSection.square([W - 2 * r, D - 2 * r])).translate([r, r])).offset(r, "Round", 2, 96));
  return keep(CrossSection.square([W, D]));
}

/**
 * Start/finish marker outlines in model mm, each turned to face the direction of travel.
 * toMM(point) -> [x, y] mm. Returns [{ kind: 2 start | 3 finish, poly, cx, cy }].
 */
export function markerOutlines(segments, toMM, o, W, D) {
  const out = [];
  const at = (kind, shape, pts) => {
    if (!shape || shape === "none") return;
    const [px, py] = pts[0];
    let [hx, hy] = pts[Math.min(1, pts.length - 1)];
    for (const q of pts) if (Math.hypot(q[0] - px, q[1] - py) >= o.markerSize) { [hx, hy] = q; break; }   // one marker-width along
    if (px < 0 || px > W || py < 0 || py > D) return;                  // cropped away
    // pts runs away from the marker: forwards from the start, backwards from the finish
    const heading = kind === 3 ? Math.atan2(py - hy, px - hx) : Math.atan2(hy - py, hx - px);
    out.push({ kind, poly: markerPolygon(shape, o.markerSize, heading).map(([x, y]) => [px + x, py + y]), cx: px, cy: py });
  };
  at(2, o.startMarker, segments[0].map(toMM));
  at(3, o.endMarker, segments.at(-1).map(toMM).reverse());
  return out;
}

/** Where a label plate sits: centre (mm), half sizes, and its own rotated frame. */
export function labelFrame(L, toMM) {
  const [cx, cy] = toMM([L.center.lat, L.center.lon]), hw = L.width / 2, hh = L.height / 2;
  const angle = L.angle ?? 0, a = (angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  return {
    ...L, angle, cx, cy, hw, hh,
    local: (x, y) => [(x - cx) * ca + (y - cy) * sa, -(x - cx) * sa + (y - cy) * ca],   // into the plate's frame
    bw: Math.abs(hw * ca) + Math.abs(hh * sa), bh: Math.abs(hw * sa) + Math.abs(hh * ca),   // rotated half extents
  };
}

/** The label's plate outline and lettering as CrossSections, placed and clipped to the W x D box. */
export function labelSections(CrossSection, label, W, D, keep) {
  const { cx, cy, width: w, height: h, angle } = label, pr = Math.min(1.5, w / 4, h / 4);
  const place = (cs) => keep(keep(keep(cs.rotate(angle)).translate([cx, cy])).intersect(keep(CrossSection.square([W, D]))));
  return {
    plate: place(keep(keep(CrossSection.square([w - 2 * pr, h - 2 * pr], true)).offset(pr, "Round", 2, 32))),
    text: place(keep(new CrossSection(label.contours, "NonZero"))),
  };
}
