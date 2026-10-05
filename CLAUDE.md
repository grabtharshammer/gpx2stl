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

## Print area (web/js/app.js + mapview.js)
- `routeFrame` (core/model.js) is the local metre frame; the UI keeps areas as {x0,x1,y0,y1} metres
  in it and passes `opts.area = {south, west, north, east}` to the engine. Because x depends only on
  lon and y only on lat, that box maps exactly to a rectangle.
- Shape "fit" with no map edit passes NO area, so the engine uses route + margin exactly like the
  Python CLI (this is what keeps the regression identical). Square / 3:2 expand the fit box to that
  ratio (landscape/portrait follows the route). Dragging in Fit switches to Custom; Square / 3:2 keep
  their ratio while resizing. Margin changes and shape clicks discard map edits.
- Hexagon: `opts.shape = "hex"` cuts a hexagon inscribed in the area box (flat top if wider than
  tall, else pointy), with corners rounded by inset/round-offset in manifold. `core/footprint.js`
  holds the outline, a JS rounded outline for the map, and `fitHexagon` (smallest regular hexagon
  around the route points + margin, in the tighter orientation). Map resize handles sit on the
  shape's corners (`handleFractions` in mapview.js).
- Route points outside the area are skipped when rasterising (not clamped, which would draw a fake
  ridge along the edge).
- Map: Leaflet 1.9.4 ESM + OpenTopoMap tiles (needs attribution; fine for hobby traffic).

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
- (done) Map view with movable/resizable print area. Next: start/finish markers, text label.
- Separate trail body for multi-colour printing (3MF export).
- Fixed scale/bbox so several routes can share one terrain set; split big models into bed-sized tiles.
- (done) Live at https://grabtharshammer.github.io/gpx2stl/, deployed from `web/` by `.github/workflows/pages.yml`.

## Printing notes (OrcaSlicer)
0.08–0.12 mm layers, "Ensure vertical shell thickness: All", ~1 mm top shell, 3 walls (Arachne),
10–15% gyroid, no supports. Rounded corners + mouse-ear brim help against lifting.
