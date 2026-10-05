# gpx2stl — project notes

Browser app that converts a GPX track into a watertight STL: real terrain relief with the route
raised (or grooved) on the surface. Static site in `web/`, no build step, no server; plain ES
modules, with three.js and manifold-3d (WASM) loaded from jsDelivr at pinned versions. The goal is
something shareable that anyone can use from a link. `python/gpx2stl.py` is the original CLI, kept
as the reference implementation.

## How it works (web/js/core/)
1. `gpx.js` — regex parser (no DOMParser, so it runs in workers and Node). lat/lon only, per
   segment; GPX elevation is ignored (Trailforks exports `<ele>0</ele>`). Falls back to `<rte>`.
2. `tiles.js` + `png.js` — AWS terrarium tiles (`elevation = R*256 + G + B/256 - 32768` m). PNGs
   are decoded with our own decoder (DecompressionStream), NOT canvas: canvas colour management
   and anti-fingerprinting noise (Brave, Firefox RFP) would corrupt elevations.
   The worker caches tiles in Cache Storage (`gpx2stl-tiles-v1`) and retries with backoff.
3. `model.js` — `planGrid` (cheap; the UI uses it for size/triangle/tile estimates) and
   `buildModel`: local equirectangular projection, bilinear resample, Gaussian blur, route via exact
   EDT -> tapered bump, top grid + walls + fan bottom, manifold intersect with rounded-rect prism.
4. `filters.js` reproduces scipy `gaussian_filter` (truncate 4, reflect) and `distance_transform_edt`.
5. `stl.js` — binary STL writer.

## Reference output / regression
Defaults on `web/examples/whole_enchilada.gpx`: 180.0 x 111.9 x 32.2 mm, 1:173,067, elevation
1208–3733 m, zoom 12, 452,004 triangles, 255 cm3. The JS engine matches the Python output exactly
(every top-surface vertex, max |dz| = 0). `tests/regression.mjs` checks this; `tests/browser.mjs`
drives the full UI in headless Chromium (mythpi1 has `/usr/bin/chromium`; this PC has no Node).

## Known gaps
- Equirectangular projection; fine at least to ~130 km routes (True Grit 100 tested), not continental.
- Heightmap grid is uniform: file size grows with 1/cell². No mesh decimation.
- Loops/out-and-back sections just merge into one ridge.
- Max 400 tiles per model.

## Ideas
- Map view of the route/footprint (pick or crop the area), start/finish markers, text label.
- Separate trail body for multi-colour printing (3MF export).
- Fixed scale/bbox so several routes can share one terrain set; split big models into bed-sized tiles.
- Deploy to GitHub Pages.

## Printing notes (OrcaSlicer)
0.08–0.12 mm layers, "Ensure vertical shell thickness: All", ~1 mm top shell, 3 walls (Arachne),
10–15% gyroid, no supports. Rounded corners + mouse-ear brim help against lifting.
