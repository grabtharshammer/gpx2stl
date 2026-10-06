// Start/finish marker shapes: flat-topped solids standing on the terrain.

export const MARKER_SHAPES = ["none", "triangle", "circle", "square", "star", "hexagon"];

const ring = (n, r, a0 = 0) =>
  Array.from({ length: n }, (_, i) => {
    const a = a0 + (2 * Math.PI * i) / n;
    return [r * Math.cos(a), r * Math.sin(a)];
  });

/**
 * Counter-clockwise outline of a marker of the given overall size (mm across), centred on the
 * origin, with its "front" (triangle tip, star point) facing angle `heading` (radians, 0 = east).
 */
export function markerPolygon(shape, size, heading = 0) {
  const r = size / 2;
  let pts;
  switch (shape) {
    case "triangle": pts = ring(3, r); break;
    case "circle": pts = ring(48, r); break;
    case "square": pts = ring(4, r, Math.PI / 4).map(([x, y]) => [x * 0.9, y * 0.9]); break;
    case "hexagon": pts = ring(6, r); break;
    case "star":
      pts = ring(10, r).map(([x, y], i) => (i % 2 ? [x * 0.45, y * 0.45] : [x, y]));
      break;
    default: return null;
  }
  const c = Math.cos(heading), s = Math.sin(heading);
  return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]);
}

/** Even-odd point-in-polygon test (works for the non-convex star). */
export function inPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
