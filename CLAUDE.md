# gpx2stl — project notes

Browser app that converts a GPX track into a watertight STL: real terrain relief with the route
raised (or grooved) on the surface. Static site in `web/`, no build step, no server; plain ES
modules, with three.js and manifold-3d (WASM) loaded from jsDelivr at pinned versions. The goal is
something shareable that anyone can use from a link. It began as a Python CLI (removed; it's in
git history before the "Remove the Python reference script" commit), which the engine was ported
from and whose output fixed the reference numbers below.

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
- Shape "fit" with no map edit passes NO area, so the engine uses route + margin exactly as the
  reference model was made (this is what keeps the regression identical). Square / 3:2 expand the fit box to that
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

## Trimming (core/gpx.js trimSegments / routeIndex)
`trim = {from, to}` metres along the route (great-circle, gaps between segments not counted).
`trimSegments` cuts exactly at those distances (interpolated points); the full range returns the
original segments. Everything downstream (fit area, hexagon, markers, engine) uses the trimmed
`segs`. The UI frame stays on the whole route and the engine gets `opts.origin` = that frame's
centre, so map and engine agree after trimming (untrimmed, origin = route mean = engine default).
Map dots snap via `routeIndex.nearest` (planar metres in the frame).

## Label (core/text.js, core/profile.js)
- Text -> polygons on the main thread (opentype.js 2.0 + vendored `web/fonts/AtkinsonHyperlegible-Bold.ttf`);
  `layoutText` sizes by cap height, flattens curves, centres on the origin; contours use the
  non-zero fill rule. The engine gets `opts.label = {center {lat,lon}, contours, width, height,
  style, relief}`: plate (rounded rect) extruded to max terrain under it + 0.2 mm, text added on
  top or subtracted (engraved). `trail` codes 4 = plate, 5 = lettering.
- Prefill: `autoLabelText` (name, distance, +gain/-loss, high point, date, duration) until the
  user types. Elevation comes from `routeProfile` (terrain tiles along the trimmed route, z12,
  30 m resampling, 3 m hysteresis) run in a separate worker job ("profile") so builds don't
  cancel it. GPX points are [lat, lon, time, ele] (NaN when missing; pre-1990 times ignored).
  Leaflet rejects 4-element points: mapview converts with `ll()`.
- Rotation: `label.angle` degrees CCW. Engine rotates plate + text CrossSections and tests terrain
  cells / vertex colours in the plate's own frame. The map's SVG overlay is axis-aligned, so it
  spans the rotated bounding box and draws the plate rotated inside (`rotate(-angle)`, SVG is y-down).
- Sizes: `labelTitleSize` (first line) and `labelSize` (rest), min 2.5 mm (Atkinson Bold stems are
  0.228x cap height). `labelPlate` shrinks the text if the plate would exceed 90% of the print's
  width or 60% of its depth, and says so in `#label-fit`.
- Auto placement: summed-area table of route cells, nearest to bottom-centre without covering
  the route and inside the footprint.
- Multi-colour 3MF: the engine returns `parts3mf` [{name, role, mesh}] (terrain, route pieces,
  start/finish markers, lettering), disjoint and adding up to the model (regression checks both).
  Lettering and markers stay separate bodies until the end and are merged only into the
  single-colour main body; marker parts are the marker minus a heightfield patch of the ground
  (or, with an inlay, split off the end pieces). `threemf.js` writes ONE object with components,
  so slicers keep the parts aligned instead of dropping each onto the bed.
- Without WebGL the app still works (no preview).

## Separate inlay (core/inlay.js)
`opts.inlay = {clearance, depth, maxHeight, minFloor, maxTilt}`: no bump in the terrain; instead
`planPieces` samples the route every 0.5 mm (lo = lowest ground within the slot, top = highest
ground + proud) and greedily grows pieces (gallop + binary search) while a sloped floor keeps the
piece <= maxHeight and the floor >= minFloor. Floor fit = minimax: pattern search over the tilt
minimising max(top - plane) - min(lo - plane), starting from least squares. Outlines are
capsule polygons (`bufferPolyline`, non-zero union); later pieces subtract earlier pieces'
outlines + clearance, so joints and crossings get a clearance gap. Terrain: subtract each piece's
outer outline extruded and `trimByPlane`d above its floor. Piece: inner outline above its floor
intersected with a heightfield patch (`gridSolid`, Zt + proud). Markers ride on the first/last
piece. Base is raised to depth + minFloor + 1.5 mm. Exports: zip (terrain + `layFlat` pieces +
README) and 3MF (assembled objects). Meshes use `mergedTris` so indexed exports are closed.
Whole Enchilada at defaults: 3 pieces (single flat floor would need ~28 mm fins).

## Performance (measured on the Pi 5, ~4x slower than a laptop)
- Builds: 85-95% is the manifold "solid" stage. Building the terrain Manifold (~0.5M tris) is
  ~1.2 s; every boolean with the whole terrain is another ~1 s pass. So small bodies are batched:
  adds (label plate) in one union, cuts (engraving, inlay slots) in one subtract, the footprint,
  then markers + raised letters in one final union. Default ~3.2 s, markers + label ~5 s,
  inlay ~8.4 s. `status()` is forced between stages so the progress bar moves honestly.
- UI: `changed()` runs on every slider input; keep it under ~16 ms. Per-trim data lives in
  `trimmed` (length, times, per-segment metres, a <= 800-point `check` list); the hexagon fit is
  cached per trim/margin; text layout is cached at full size and at the shrink-to-fit size (1%
  steps); the automatic label spot tries candidates nearest bottom-centre first and stops at the
  first clear one. Profile with CDP `Profiler` in headless Chromium if it regresses.

## 3D preview
Renders on demand (`requestRender`), not every frame: a ~0.5M-triangle model at 60 fps drains
batteries and stalled the Pi's software GL in the headless tests.

## Markers (core/markers.js)
`startMarker` / `endMarker` (engine default "none", UI default triangle / square): the shape's
outline (CCW polygon, `markerPolygon`) is rotated to the direction of travel, clipped to the grid,
extruded from z=0 to (highest terrain under it + markerHeight) and unioned with the terrain
before the footprint cut. In the returned `trail` array, 2 = start and 3 = finish vertices (for
the preview colours). With both markers off the model is still byte-identical to the reference.

## Reference output / regression
Defaults on `web/examples/whole_enchilada.gpx`: 180.0 x 111.9 x 32.2 mm, 1:173,067, elevation
1208–3733 m, zoom 12, 452,004 triangles, 255 cm3. These came from the original Python script,
which the JS engine matched exactly (every top-surface vertex, max |dz| = 0). `tests/regression.mjs` checks this; `tests/browser.mjs`
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
