// Flat print styles: a thin plate with the terrain shown as raised (or engraved) contour lines,
// or as stacked terrace steps, plus the route, markers and label. Much quicker to print than the
// full relief. Every part is built as its own body so the parts never overlap; the 3MF, the
// preview colours and the single-colour STL all come from them.
import { gaussianBlur } from "./filters.js";
import { bufferPolyline } from "./inlay.js";
import { autoInterval, traceLevel, smoothLine, lineLength } from "./contours.js";
import { meshOut, footprintSection, markerOutlines, labelFrame, labelSections } from "./solids.js";

export const FLAT_DEFAULTS = {
  interval: null,     // metres between contours; null = automatic
  unit: "m",          // units for the automatic interval's round numbers: "m" or "ft"
  plate: 2.4,         // mm, base plate thickness
  lineHeight: 0.6,    // mm, raised (or engraved) contour lines
  engraved: false,
  minorWidth: 0.8,    // mm
  indexWidth: 1.2,    // mm, every 5th contour
  stepHeight: 0.4,    // mm per terrace step
};
const GAP = 1.2;      // mm; minor contours closer than this are dropped (they'd merge when sliced)

export async function buildFlat({ segments, plan, elev, emin, emax, manifold, progress }) {
  const { o, nx, ny, sc, xmin, ymin } = plan, { cell } = o;
  const c = { ...FLAT_DEFAULTS, ...o.contours };
  const terraced = o.printStyle === "terraced";
  const W = (nx - 1) * cell, D = (ny - 1) * cell;
  const toMM = (p) => { const [x, y] = plan.toM(p); return [(x - xmin) * sc, (y - ymin) * sc]; };

  // contour levels, from a smoother copy of the terrain so lines come out clean
  progress("route", 0);
  const Zc = Float64Array.from(elev);
  gaussianBlur(Zc, nx, ny, Math.max(1, 0.8 / cell));
  const auto = autoInterval(Zc, nx, ny, cell, { unit: c.unit });
  const interval = c.interval ?? auto.interval;
  const intervalLabel = c.interval ? `${+(c.interval / (c.unit === "ft" ? 0.3048 : 1)).toFixed(0)} ${c.unit}` : auto.label;
  const levels = [];
  for (let L = Math.ceil(emin / interval) * interval; L <= emax; L += interval) if (L > emin) levels.push(L);
  const isIndex = (L) => Math.round(L / interval) % 5 === 0;

  const { Manifold, CrossSection } = manifold;
  const trash = [], keep = (x) => (trash.push(x), x);
  const union = (list) => (list.length ? keep(CrossSection.union(list)) : null);
  const minus = (a, b) => (a && b ? keep(a.subtract(b)) : a);
  try {
    progress("mesh", 0);
    const r = Math.min(o.cornerRadius, W / 2 - 0.1, D / 2 - 0.1);
    const fp = footprintSection(CrossSection, o.shape, W, D, r, keep);
    const clip = (cs) => keep(cs.intersect(fp));
    const plateT = c.plate, proud = Math.max(0.2, o.trailHeight);

    // what sits on top hides what's under it, so lower parts are trimmed in 2D to stay disjoint
    const markers = markerOutlines(segments, toMM, o, W, D).map((m) => ({ ...m, cs: clip(keep(new CrossSection([m.poly]))) }));
    const markerCS = union(markers.map((m) => m.cs));
    const label = o.label?.contours?.length ? labelFrame(o.label, toMM) : null;
    const labelCS = label && labelSections(CrossSection, label, W, D, keep);
    let routeCS = clip(keep(new CrossSection(segments.flatMap((s) => bufferPolyline(s.map(toMM), o.trailWidth / 2, 12)), "NonZero")));
    routeCS = minus(minus(routeCS, markerCS), labelCS?.plate);

    // the surface height at a grid cell: plate top, or the terrace step it's on
    const levelsBelow = (e) => { let k = 0; while (k < levels.length && e >= levels[k]) k++; return k; };
    const surfaceAt = (i, j) => plateT + (terraced ? levelsBelow(Zc[j * nx + i]) * c.stepHeight : 0);
    const highestUnder = (inside, cx, cy, reach) => {
      let top = plateT;
      for (let j = Math.max(0, Math.floor((cy - reach) / cell)); j <= Math.min(ny - 1, Math.ceil((cy + reach) / cell)); j++)
        for (let i = Math.max(0, Math.floor((cx - reach) / cell)); i <= Math.min(nx - 1, Math.ceil((cx + reach) / cell)); i++)
          if (inside(i * cell, j * cell)) top = Math.max(top, surfaceAt(i, j));
      return top;
    };

    // [name, role, part, grounded]: the part sits exactly on what's below it (for the 3MF, no
    // overlaps); "grounded" is the same footprint extruded from the bed, so the single-colour body
    // is a union of overlapping solids (merging solids that only touch can leave separate shells)
    const parts = [];
    const slab = (cs, z0, z1) => keep(keep(Manifold.extrude(cs, z1 - z0)).translate([0, 0, z0]));
    let terrain, linesTop = plateT;
    progress("solid", 0.2);
    if (!terraced) {
      // contour lines, minor ones dropped where they'd crowd together
      const G = new Float64Array(nx * ny);               // terrain gradient, metres per mm
      for (let j = 1; j < ny - 1; j++)
        for (let i = 1; i < nx - 1; i++) {
          const k = j * nx + i;
          G[k] = Math.hypot(Zc[k + 1] - Zc[k - 1], Zc[k + nx] - Zc[k - nx]) / (2 * cell);
        }
      const spacing = ([x, y]) => interval / (G[Math.min(ny - 2, Math.max(1, Math.round(y / cell))) * nx + Math.min(nx - 2, Math.max(1, Math.round(x / cell)))] || 1e-9);
      const polys = [];
      for (const L of levels) {
        const index = isIndex(L);
        for (const raw of traceLevel(Zc, nx, ny, L)) {
          const line = smoothLine(raw.map(([i, j]) => [i * cell, j * cell]));
          const closed = line.length > 2 && line[0][0] === line.at(-1)[0] && line[0][1] === line.at(-1)[1];
          if (lineLength(line) < (closed ? 4 : 3)) continue;           // specks
          const runs = [];
          if (index) runs.push(line);
          else {
            let run = [];
            for (const p of line) {
              if (spacing(p) >= GAP) run.push(p);
              else { if (run.length > 1) runs.push(run); run = []; }
            }
            if (run.length > 1) runs.push(run);
          }
          for (const run of runs) if (lineLength(run) >= 2) polys.push(...bufferPolyline(run, (index ? c.indexWidth : c.minorWidth) / 2, 10));
        }
      }
      let linesCS = polys.length ? clip(keep(new CrossSection(polys, "NonZero"))) : null;
      linesCS = minus(minus(minus(linesCS, routeCS), markerCS), labelCS?.plate);
      terrain = keep(Manifold.extrude(fp, plateT));
      if (linesCS && c.engraved) {
        terrain = keep(terrain.subtract(keep(keep(Manifold.extrude(linesCS, c.lineHeight + 1)).translate([0, 0, plateT - c.lineHeight]))));
      } else if (linesCS) {
        linesTop = plateT + c.lineHeight;
        parts.push(["Contours", "contours", slab(linesCS, plateT, linesTop), slab(linesCS, 0, linesTop)]);
      }
      const routeTop = plateT + Math.max(proud, linesTop - plateT + 0.4);
      parts.push(["Route", "route", slab(routeCS, plateT, routeTop), slab(routeCS, 0, routeTop)]);
    } else {
      // terrace steps: each level's area above the contour, stacked as flat slabs
      const regions = [fp];
      for (const L of levels) {
        const loops = traceLevel(Zc, nx, ny, L, true).map((raw) => smoothLine(raw.map(([i, j]) => [i * cell, j * cell]), 1));
        const cs = loops.length ? clip(keep(new CrossSection(loops, "EvenOdd"))) : null;
        // drop islands too small to print, and keep each level inside the one below (smoothing can
        // nudge a line outward, which would leave a sliver of step hanging over nothing)
        let kept = cs ? keep(CrossSection.compose(cs.decompose().map(keep).filter((q) => q.area() >= 2))) : null;
        if (kept && regions.at(-1)) kept = keep(kept.intersect(regions.at(-1)));
        regions.push(kept && regions.at(-1) ? kept : null);
      }
      // nested prisms from the bed (each level overlaps the ones below), so they merge into one solid
      const steps = [];
      regions.forEach((rg, k) => { if (rg && !rg.isEmpty()) steps.push(slab(rg, 0, plateT + k * c.stepHeight)); });
      terrain = keep(Manifold.union(steps));
      // the route rides on whichever step it crosses
      const bands = [], grounded = [];
      regions.forEach((rg, k) => {
        if (!rg) return;
        const band = minus(keep(routeCS.intersect(rg)), regions[k + 1] ?? null), z = plateT + k * c.stepHeight;
        if (band && !band.isEmpty()) { bands.push(slab(band, z, z + proud)); grounded.push(slab(band, 0, z + proud)); }
      });
      if (bands.length) parts.push(["Route", "route", keep(Manifold.union(bands)), keep(Manifold.union(grounded))]);
    }
    progress("solid", 0.6);

    // markers stand a set height above the highest surface under them
    for (const m of markers) {
      const top = highestUnder((x, y) => Math.hypot(x - m.cx, y - m.cy) <= o.markerSize / 2 + cell, m.cx, m.cy, o.markerSize / 2 + cell) + o.markerHeight;
      const full = slab(m.cs, 0, top), body = keep(full.subtract(terrain));
      if (!body.isEmpty()) parts.push([m.kind === 2 ? "Start marker" : "Finish marker", m.kind === 2 ? "start" : "finish", body, full]);
    }

    // label: a plate (terrain colour) clear of everything under it, with its lettering
    let lettering = null, letteringGrounded = null;
    if (label) {
      const top = Math.max(linesTop, highestUnder((x, y) => {
        const [u, v] = label.local(x, y);
        return Math.abs(u) <= label.hw + cell && Math.abs(v) <= label.hh + cell;
      }, label.cx, label.cy, Math.max(label.bw, label.bh) + cell)) + 0.2;
      terrain = keep(Manifold.union([terrain, keep(Manifold.extrude(labelCS.plate, top))]));
      if (label.style === "engraved") {
        terrain = keep(terrain.subtract(keep(keep(Manifold.extrude(labelCS.text, label.relief + 1)).translate([0, 0, top - label.relief]))));
        lettering = keep(keep(Manifold.extrude(labelCS.text, label.relief)).translate([0, 0, top - label.relief]));
      } else {
        lettering = slab(labelCS.text, top, top + label.relief);
        letteringGrounded = slab(labelCS.text, 0, top + label.relief);
      }
    }
    progress("solid", 0.8);

    const all = [[terraced ? "Terrain" : "Base", "terrain", terrain, terrain], ...parts.filter(([, , m]) => !m.isEmpty()),
                 ...(lettering && !lettering.isEmpty() ? [["Label text", "lettering", lettering, letteringGrounded]] : [])];
    // single-colour body: everything merged (an engraved label keeps its empty pocket, so its fill
    // has no grounded version)
    const single = keep(Manifold.union(all.map(([, , , g]) => g).filter(Boolean)));
    const status = single.status();
    if (status !== "NoError" || single.isEmpty()) throw new Error(`Mesh is not a valid solid (${status})`);
    const main = meshOut(single), bb = single.boundingBox();
    const parts3mf = all.map(([name, role, m]) => ({ name, role, ...meshOut(m) }));
    return {
      ...main, trail: new Uint8Array(main.positions.length / 3), inlays: [], parts3mf, flat: true,
      stats: {
        width: W, depth: D, height: bb.max[2],
        scale: 1000 / sc, zExag: 1, base: plateT,
        elevMin: emin, elevMax: emax, zoom: plan.z, tiles: plan.tiles.count,
        triangles: main.indices.length / 3, volume: single.volume() / 1000,
        flat: {
          style: o.printStyle, interval: intervalLabel, levels: levels.length,
          // filament swap heights for extra colours on a single-extruder printer
          swaps: terraced ? [] : c.engraved ? [plateT] : [plateT, linesTop],
        },
      },
    };
  } finally {
    for (const x of trash) try { x.delete(); } catch {}
  }
}
