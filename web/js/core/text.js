// Label text -> polygons in millimetres, using an opentype.js Font.

/**
 * Lay out `text` (may contain newlines), centred on the origin, y up.
 * letterHeight is the capital height in mm; titleHeight (optional) sets it for the first line.
 * Returns
 *   { contours: [[[x, y], ...], ...], width, height }   (contours use the non-zero fill rule)
 * or null if there's nothing to print.
 */
export function layoutText(font, text, letterHeight, { titleHeight = letterHeight, lineSpacing = 1.5, align = "center" } = {}) {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && !lines.at(-1)) lines.pop();
  if (!lines.some((l) => l.trim())) return null;

  const cap = font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7;
  const heights = lines.map((_, i) => (i ? letterHeight : titleHeight));
  const sizes = heights.map((h) => (h * font.unitsPerEm) / cap);   // font sizes in mm
  const step = Math.max(0.05, Math.min(...heights) / 25);         // curve flattening, mm
  const widths = lines.map((l, i) => font.getAdvanceWidth(l, sizes[i]));
  const maxW = Math.max(...widths);
  const baselines = [];                                           // y down: each line drops by its own height x spacing
  for (let i = 0, y = 0; i < lines.length; i++) { if (i) y += heights[i] * lineSpacing; baselines.push(y); }
  const contours = [];

  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const x0 = align === "left" ? -maxW / 2 : align === "right" ? maxW / 2 - widths[i] : -widths[i] / 2;
    const path = font.getPath(line, x0, baselines[i], sizes[i]);   // y down
    let cur = null, px = 0, py = 0;
    const close = () => { if (cur && cur.length > 2) contours.push(cur); cur = null; };
    for (const c of path.commands) {
      if (c.type === "M") { close(); cur = [[c.x, -c.y]]; }
      else if (c.type === "L") cur.push([c.x, -c.y]);
      else if (c.type === "Q" || c.type === "C") {
        const n = Math.max(2, Math.min(16, Math.ceil(Math.hypot(c.x - px, c.y - py) / step)));
        for (let k = 1; k <= n; k++) {
          const t = k / n, u = 1 - t;
          const [x, y] = c.type === "Q"
            ? [u * u * px + 2 * u * t * c.x1 + t * t * c.x, u * u * py + 2 * u * t * c.y1 + t * t * c.y]
            : [u ** 3 * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t ** 3 * c.x,
               u ** 3 * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t ** 3 * c.y];
          cur.push([x, -y]);
        }
      } else if (c.type === "Z") close();
      if (c.type !== "Z") { px = c.x; py = c.y; }
    }
    close();
  });
  if (!contours.length) return null;

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const c of contours) for (const [x, y] of c) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return {
    contours: contours.map((c) => c.map(([x, y]) => [x - cx, y - cy])),
    width: x1 - x0, height: y1 - y0,
  };
}

/** SVG path data for contours (mm, y up) drawn in a y-down viewBox. */
export function contoursToSvgPath(contours) {
  return contours.map((c) => "M" + c.map(([x, y]) => `${x.toFixed(2)} ${(-y).toFixed(2)}`).join("L") + "Z").join("");
}
