// Footprint outlines, shared by the engine (cut shape) and the map (drawn box).

const SQRT3 = Math.sqrt(3);

/**
 * Outline (counter-clockwise, y up) of a footprint filling a w x h box at the origin.
 * "hex" is a regular hexagon when w/h = 2/√3 (flat top) or √3/2 (pointy top); orientation
 * follows the box. "circle" is a CIRCLE_SIDES-gon inscribed in the box (a circle when w = h).
 */
export const CIRCLE_SIDES = 128;
export function outline(shape, w, h) {
  if (shape === "circle") {
    return Array.from({ length: CIRCLE_SIDES }, (_, k) => {
      const a = (2 * Math.PI * k) / CIRCLE_SIDES;
      return [(w / 2) * (1 + Math.cos(a)), (h / 2) * (1 + Math.sin(a))];
    });
  }
  if (shape === "hex") {
    return w >= h
      ? [[0, h / 2], [w / 4, 0], [(3 * w) / 4, 0], [w, h / 2], [(3 * w) / 4, h], [w / 4, h]]
      : [[w / 2, 0], [w, h / 4], [w, (3 * h) / 4], [w / 2, h], [0, (3 * h) / 4], [0, h / 4]];
  }
  return [[0, 0], [w, 0], [w, h], [0, h]];
}

/** Points along a convex CCW polygon with its corners rounded to radius r (a circle has none). */
export function roundedOutline(pts, r, segments = 8) {
  if (r <= 0 || pts.length === CIRCLE_SIDES) return pts.map((p) => [...p]);
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const [vx, vy] = pts[i], [px, py] = pts[(i + n - 1) % n], [nx, ny] = pts[(i + 1) % n];
    const lp = Math.hypot(px - vx, py - vy), ln = Math.hypot(nx - vx, ny - vy);
    const u1 = [(px - vx) / lp, (py - vy) / lp], u2 = [(nx - vx) / ln, (ny - vy) / ln];
    const theta = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    const rr = Math.min(r, (Math.min(lp, ln) / 2) * Math.tan(theta / 2));   // fit on short edges
    const t = rr / Math.tan(theta / 2), d = rr / Math.sin(theta / 2);
    const bl = Math.hypot(u1[0] + u2[0], u1[1] + u2[1]);
    const cx = vx + ((u1[0] + u2[0]) / bl) * d, cy = vy + ((u1[1] + u2[1]) / bl) * d;
    let a0 = Math.atan2(vy + u1[1] * t - cy, vx + u1[0] * t - cx);
    let a1 = Math.atan2(vy + u2[1] * t - cy, vx + u2[0] * t - cx);
    while (a1 < a0) a1 += 2 * Math.PI;
    for (let k = 0; k <= segments; k++) {
      const a = a0 + ((a1 - a0) * k) / segments;
      out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
  }
  return out;
}

/** Is (x, y) inside the convex CCW polygon? */
export function insidePolygon(pts, x, y) {
  for (let i = 0, n = pts.length; i < n; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < -1e-9) return false;
  }
  return true;
}

/** Smallest circle centred on (cx, cy) holding every point with `margin` to spare: its box. */
export function fitCircle(points, cx, cy, margin) {
  let r = 0;
  for (const [x, y] of points) r = Math.max(r, Math.hypot(x - cx, y - cy));
  r += margin;
  return { x0: cx - r, x1: cx + r, y0: cy - r, y1: cy + r };
}

/**
 * Smallest regular hexagon centred on (cx, cy) holding every point with `margin` to spare, in
 * whichever orientation is tighter. Returns the bounding box { x0, x1, y0, y1 } and `flat`.
 */
export function fitHexagon(points, cx, cy, margin) {
  const flatN = [[0, 1], [SQRT3 / 2, 0.5], [SQRT3 / 2, -0.5]];     // edge normals, flat top
  const pointyN = [[1, 0], [0.5, SQRT3 / 2], [0.5, -SQRT3 / 2]];   // pointy top
  let af = 0, ap = 0;                                               // apothems
  for (const [x, y] of points) {
    const dx = x - cx, dy = y - cy;
    for (const [nx, ny] of flatN) af = Math.max(af, Math.abs(nx * dx + ny * dy));
    for (const [nx, ny] of pointyN) ap = Math.max(ap, Math.abs(nx * dx + ny * dy));
  }
  const flat = af <= ap, a = (flat ? af : ap) + margin;
  const hw = flat ? (2 * a) / SQRT3 : a, hh = flat ? a : (2 * a) / SQRT3;
  return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh, flat };
}
