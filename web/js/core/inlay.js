// Separate route inlay: the route prints as its own pieces that drop into a slot in the terrain,
// so it can be a different colour on any printer. Each piece has a flat but *sloped* bottom (a
// best-fit plane under it), so it prints without supports lying on that face, and the terrain
// slot is cut down to the same plane. Sloped floors keep the pieces short: a mostly-downhill
// route is often a single piece.

export const INLAY_DEFAULTS = {
  clearance: 0.15,   // mm per side between inlay and slot
  depth: 3,          // mm the slot goes below the terrain, at least
  maxHeight: 10,     // mm; split the route into pieces so no piece is taller
  minFloor: 1.2,     // mm of terrain left under the slot
  maxTilt: 30,       // degrees; steepest piece bottom
};

const STEP = 0.5;      // mm between samples along the route
const MIN_PIECE = 24;  // samples (12 mm); shorter pieces are fiddly to handle

/** Douglas-Peucker simplification of a polyline. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i], [bx, by] = pts[j], l = Math.hypot(bx - ax, by - ay) || 1e-12;
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - pts[k][1]) - (ax - pts[k][0]) * (by - ay)) / l;
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

const ccw = (poly) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a < 0 ? poly.reverse() : poly;
};

/**
 * Polygons whose non-zero union is the polyline thickened to radius r with round ends and
 * joins: a circle at every vertex plus a rectangle along every leg.
 */
export function bufferPolyline(pts, r, segments = 20) {
  pts = simplify(pts, 0.03);
  const out = [];
  const circle = ([cx, cy]) => Array.from({ length: segments }, (_, i) => {
    const a = (2 * Math.PI * i) / segments;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  out.push(circle(pts[0]));
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], l = Math.hypot(bx - ax, by - ay);
    if (l > 1e-6) {
      const nx = (-(by - ay) / l) * r, ny = ((bx - ax) / l) * r;
      out.push(ccw([[ax + nx, ay + ny], [ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny]]));
    }
    out.push(circle(pts[i]));
  }
  return out;
}

/**
 * Floor plane z = a x + b y + c under samples i..j: it sits at least `depth` below the lowest
 * ground (lo) everywhere, and its tilt is chosen to make the piece as short as possible, i.e. to
 * minimise max(top - plane). That "spread" is convex in (a, b), so a pattern search from the
 * least-squares tilt finds it.
 */
function fitFloor(S, i, j, o) {
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (let k = i; k <= j; k++) {
    const { x, y, lo } = S[k];
    n++; sx += x; sy += y; sz += lo; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * lo; syz += y * lo;
  }
  const mx = sx / n, my = sy / n, mz = sz / n;
  const cxx = sxx / n - mx * mx + 1, cyy = syy / n - my * my + 1, cxy = sxy / n - mx * my;   // +1: ridge for straight pieces
  const cxz = sxz / n - mx * mz, cyz = syz / n - my * mz, det = cxx * cyy - cxy * cxy;
  const gmax = Math.tan((o.maxTilt * Math.PI) / 180);
  const spread = (a, b) => {
    if (Math.hypot(a, b) > gmax) return Infinity;
    let hi = -Infinity, lo = Infinity;
    for (let k = i; k <= j; k++) {
      const p = a * S[k].x + b * S[k].y;
      hi = Math.max(hi, S[k].top - p); lo = Math.min(lo, S[k].lo - p);
    }
    return hi - lo;
  };
  let a = (cxz * cyy - cyz * cxy) / det, b = (cyz * cxx - cxz * cxy) / det;
  const g0 = Math.hypot(a, b);
  if (g0 > gmax) { a *= gmax / g0; b *= gmax / g0; }
  let best = spread(a, b);
  for (let step = 0.05; step > 2e-4; ) {
    let moved = false;
    for (const [da, db] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const v = spread(a + da, b + db);
      if (v < best) { best = v; a += da; b += db; moved = true; break; }
    }
    if (!moved) step /= 2;
  }
  let c = Infinity;
  for (let k = i; k <= j; k++) c = Math.min(c, S[k].lo - o.depth - a * S[k].x - b * S[k].y);
  let height = 0, floor = Infinity;
  for (let k = i; k <= j; k++) {
    const z = a * S[k].x + b * S[k].y + c;
    height = Math.max(height, S[k].top - z);
    floor = Math.min(floor, z);
  }
  return { a, b, c, height, floor, tilt: (Math.atan(Math.hypot(a, b)) * 180) / Math.PI };
}

/**
 * Split route polylines (model mm) into inlay pieces, each with a sloped floor.
 *   heightAt(x, y) -> { lo, top }: lowest terrain within the slot's reach, and the inlay's top
 *   opts: INLAY_DEFAULTS plus proud (mm above terrain)
 * Returns [{ pts (polyline, mm), plane: {a, b, c}, height (tallest point of the piece above its
 * floor, mm), tilt (degrees) }] in route order.
 */
export function planPieces(lines, heightAt, opts) {
  const o = { ...INLAY_DEFAULTS, ...opts };
  const pieces = [];
  for (const line of lines) {
    // sample the line evenly, remembering distance along it
    const S = [], cum = [0];
    for (let k = 1; k < line.length; k++) cum.push(cum[k - 1] + Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]));
    const total = cum.at(-1);
    if (total < 1) continue;
    for (let d = 0, k = 1; ; d = Math.min(d + STEP, total)) {
      while (k < line.length - 1 && cum[k] < d) k++;
      const t = (d - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
      const x = line[k - 1][0] + (line[k][0] - line[k - 1][0]) * t, y = line[k - 1][1] + (line[k][1] - line[k - 1][1]) * t;
      S.push({ x, y, d, ...heightAt(x, y) });
      if (d >= total) break;
    }
    // greedy: grow each piece as long as it stays short enough and leaves enough floor
    // (galloping then binary search for the end; longer pieces only ever get taller)
    const ok = (f) => f.height <= o.maxHeight && f.floor >= o.minFloor;
    const last = S.length - 1;
    for (let i = 0; i < last; ) {
      let j = Math.min(last, i + MIN_PIECE), f = fitFloor(S, i, j, o);
      if (ok(f) && j < last) {
        let good = j, bad = null;
        for (let span = MIN_PIECE; ; span *= 2) {
          const t = Math.min(last, good + span), g = fitFloor(S, i, t, o);
          if (!ok(g)) { bad = t; break; }
          good = t; f = g;
          if (t === last) break;
        }
        while (bad !== null && bad - good > 1) {
          const mid = (good + bad) >> 1, g = fitFloor(S, i, mid, o);
          if (ok(g)) { good = mid; f = g; } else bad = mid;
        }
        j = good;
      }
      if (S.length - 1 - j < MIN_PIECE && j < S.length - 1) {    // don't leave a stub at the end
        const g = fitFloor(S, i, S.length - 1, o);
        if (ok(g) || !ok(f)) { j = S.length - 1; f = g; }
      }
      pieces.push({ pts: slice(line, cum, S[i].d, S[j].d), plane: { a: f.a, b: f.b, c: f.c }, height: f.height, tilt: f.tilt });
      i = j;
    }
  }
  return pieces;
}

function slice(line, cum, d0, d1) {
  const at = (d) => {
    let k = 1;
    while (k < line.length - 1 && cum[k] < d) k++;
    const t = (d - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
    return { k, p: [line[k - 1][0] + (line[k][0] - line[k - 1][0]) * t, line[k - 1][1] + (line[k][1] - line[k - 1][1]) * t] };
  };
  const a = at(d0), b = at(d1), out = [a.p];
  for (let k = a.k; k < b.k; k++) out.push(line[k]);
  out.push(b.p);
  return out;
}

/** Plane z = a x + b y + c as manifold trimByPlane arguments, keeping what's above it. */
export function abovePlane({ a, b, c }) {
  const l = Math.hypot(a, b, 1);
  return [[-a / l, -b / l, 1 / l], c / l];
}

/**
 * Rotate a piece so its sloped bottom lies on the bed (z = 0), centred on the origin.
 * positions: Float32Array xyz (model mm). Returns a new Float32Array.
 */
export function layFlat(positions, { a, b }) {
  const l = Math.hypot(a, b, 1), n = [-a / l, -b / l, 1 / l];        // floor normal, pointing into the piece
  // Rodrigues rotation taking n to +z: axis k = n x z, angle acos(n . z)
  const kx = n[1], ky = -n[0], s = Math.hypot(kx, ky), cth = n[2];
  const ux = s ? kx / s : 0, uy = s ? ky / s : 0;
  const R = [
    cth + ux * ux * (1 - cth), ux * uy * (1 - cth), uy * s,
    ux * uy * (1 - cth), cth + uy * uy * (1 - cth), -ux * s,
    -uy * s, ux * s, cth,
  ];
  const out = new Float32Array(positions.length);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const rx = R[0] * x + R[1] * y + R[2] * z, ry = R[3] * x + R[4] * y + R[5] * z, rz = R[6] * x + R[7] * y + R[8] * z;
    out[i] = rx; out[i + 1] = ry; out[i + 2] = rz;
    x0 = Math.min(x0, rx); x1 = Math.max(x1, rx); y0 = Math.min(y0, ry); y1 = Math.max(y1, ry); z0 = Math.min(z0, rz);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < out.length; i += 3) { out[i] -= cx; out[i + 1] -= cy; out[i + 2] -= z0; }
  return out;
}

/**
 * A small test-fit pair with the current width and clearance: a block with a 20 mm slot (with a
 * bend) and the matching inlay. Returns { block, piece } as { positions, indices }.
 */
export function buildCoupon(manifold, { width, clearance, depth, proud }) {
  const { Manifold, CrossSection } = manifold;
  const trash = [], keep = (x) => (trash.push(x), x);
  try {
    const r = width / 2, path = [[-10, -3], [0, -3], [8, 3]];
    const blockH = depth + 2;
    const block = keep(Manifold.cube([30, 16, blockH], true)).translate([0, 0, blockH / 2]);
    const slot = keep(keep(Manifold.extrude(keep(new CrossSection(bufferPolyline(path, r + clearance), "NonZero")), depth + 1))
      .translate([0, 0, 2]));
    const b = keep(keep(block).subtract(slot));
    const piece = keep(Manifold.extrude(keep(new CrossSection(bufferPolyline(path, r), "NonZero")), depth + proud));
    const mesh = (m) => {
      const g = m.getMesh(), np = g.numProp, v = g.vertProperties, p = new Float32Array((v.length / np) * 3);
      for (let i = 0, k = 0; i < v.length; i += np, k += 3) { p[k] = v[i]; p[k + 1] = v[i + 1]; p[k + 2] = v[i + 2]; }
      return { positions: p, indices: new Uint32Array(g.triVerts) };
    };
    return { block: mesh(b), piece: mesh(piece) };
  } finally {
    for (const x of trash) try { x.delete(); } catch {}
  }
}
