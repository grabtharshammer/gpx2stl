// Contour lines and filled level regions from an elevation grid (marching squares).
import { simplify } from "./inlay.js";

const NICE = {
  m: [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000],
  ft: [10, 20, 25, 40, 50, 100, 200, 250, 500, 1000, 2000, 5000],
};
const FT = 0.3048;

/**
 * The finest round contour interval whose lines stay at least `gap` mm apart over all but
 * `tolerance` of the map, so raised lines don't merge when sliced. Z is elevation in metres on a
 * grid of `cell` mm. Returns { interval (m), label, unit }.
 */
export function autoInterval(Z, nx, ny, cell, { unit = "m", gap = 1.2, tolerance = 0.03, minLevels = 4 } = {}) {
  const grads = new Float64Array((nx - 2) * (ny - 2));
  let n = 0, lo = Infinity, hi = -Infinity;
  for (let j = 1; j < ny - 1; j++)
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      grads[n++] = Math.hypot(Z[k + 1] - Z[k - 1], Z[k + nx] - Z[k - nx]) / (2 * cell);   // metres per mm
    }
  for (const z of Z) { lo = Math.min(lo, z); hi = Math.max(hi, z); }
  const scale = unit === "ft" ? FT : 1;
  const choices = NICE[unit] ?? NICE.m;
  let pick = choices.at(-1);
  for (const c of choices) {
    const iv = c * scale, limit = iv / gap;            // crowded where the gradient exceeds this
    let crowded = 0;
    for (let k = 0; k < n; k++) if (grads[k] > limit) crowded++;
    if (crowded / n <= tolerance) { pick = c; break; }
  }
  // very flat areas: don't let the interval swallow the relief
  while ((hi - lo) / (pick * scale) < minLevels && choices.indexOf(pick) > 0) pick = choices[choices.indexOf(pick) - 1];
  return { interval: pick * scale, label: `${pick.toLocaleString("en-US")} ${unit}`, unit };
}

// marching squares segment table: for each case, pairs of cell edges (0 bottom, 1 right, 2 top,
// 3 left) the line crosses; saddles (5, 10) are resolved by the cell's centre value
const CASES = [[], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], null, [[0, 2]], [[3, 2]],
               [[2, 3]], [[0, 2]], null, [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], []];

/**
 * Trace the `level` contour of Z (nx x ny grid). With closed = true the grid is treated as
 * surrounded by -Infinity, so every line closes around the area at or above the level (for
 * filled regions). Returns polylines in grid units [[i, j], ...]; closed ones repeat the start.
 */
export function traceLevel(Z, nx, ny, level, closed = false) {
  const pad = closed ? 1 : 0, W = nx + 2 * pad, H = ny + 2 * pad;
  const val = (i, j) => {
    i -= pad; j -= pad;
    return i < 0 || j < 0 || i >= nx || j >= ny ? -Infinity : Z[j * nx + i];
  };
  const point = (e) => {                                 // where the line crosses edge e
    const k = e >> 1, i = k % W, j = (k - i) / W;
    const a = val(i, j), b = e & 1 ? val(i, j + 1) : val(i + 1, j);
    let t = a === -Infinity ? 1 : b === -Infinity ? 0 : (level - a) / (b - a);
    t = Math.min(1, Math.max(0, t));
    return e & 1 ? [i - pad, j + t - pad] : [i + t - pad, j - pad];
  };
  const adj = new Map();
  const link = (a, b) => {
    (adj.get(a) ?? adj.set(a, []).get(a)).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)).push(a);
  };
  for (let j = 0; j < H - 1; j++)
    for (let i = 0; i < W - 1; i++) {
      const v0 = val(i, j), v1 = val(i + 1, j), v2 = val(i + 1, j + 1), v3 = val(i, j + 1);
      const c = (v0 >= level) | ((v1 >= level) << 1) | ((v2 >= level) << 2) | ((v3 >= level) << 3);
      if (c === 0 || c === 15) continue;
      const edges = [(j * W + i) * 2, (j * W + i + 1) * 2 + 1, ((j + 1) * W + i) * 2, (j * W + i) * 2 + 1];
      let segs = CASES[c];
      if (!segs) {
        const centre = [v0, v1, v2, v3].filter(Number.isFinite);
        const high = centre.length && centre.reduce((s, v) => s + v, 0) / centre.length >= level;
        segs = (c === 5) === Boolean(high) ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
      }
      for (const [a, b] of segs) link(edges[a], edges[b]);
    }
  // join the segments into polylines: open ones from their ends first, then the loops
  const lines = [], seen = new Set();
  const walk = (start) => {
    const line = [start];
    seen.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const nb = adj.get(cur), next = nb[0] !== prev ? nb[0] : nb[1];
      if (next === undefined) break;
      if (seen.has(next)) { if (next === start) line.push(start); break; }
      seen.add(next); line.push(next); prev = cur; cur = next;
    }
    if (line.length > 1) lines.push(line.map(point));
  };
  for (const [e, nb] of adj) if (nb.length === 1 && !seen.has(e)) walk(e);
  for (const e of adj.keys()) if (!seen.has(e)) walk(e);
  return lines;
}

/** Chaikin corner cutting (keeps the ends of open lines), then simplification. */
export function smoothLine(pts, iterations = 2, tol = 0.03) {
  const closed = pts.length > 3 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1];
  for (let it = 0; it < iterations; it++) {
    const out = closed ? [] : [pts[0]];
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    if (closed) out.push(out[0]); else out.push(pts.at(-1));
    pts = out;
  }
  if (!closed) return simplify(pts, tol);
  // Douglas-Peucker needs two distinct ends: split the loop at its farthest point from the start
  let far = 1, fd = -1;
  for (let k = 1; k < pts.length - 1; k++) {
    const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]);
    if (d > fd) { fd = d; far = k; }
  }
  return [...simplify(pts.slice(0, far + 1), tol), ...simplify(pts.slice(far), tol).slice(1)];
}

export const lineLength = (pts) => pts.reduce((s, p, k) => (k ? s + Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : 0), 0);
