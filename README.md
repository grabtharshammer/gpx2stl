# gpx2stl

Turn a GPX track into a 3D-printable terrain relief with the route marked on it.
Everything runs in the browser: drop in a GPX file, trim it, choose the print area on a topo map, adjust
the settings, preview the model in 3D and download a watertight STL. Your GPX file never leaves
your computer.

## Run it locally

The app is a static site in `web/` with no build step. Serve it over `http://localhost`
(opening `index.html` as a file won't work, because browsers block module workers on `file://`):

    cd web
    python -m http.server 8000

Then open <http://localhost:8000>.

Live at **<https://grabtharshammer.github.io/gpx2stl/>**. It is deployed from `web/` by GitHub Actions on every push to `main`
(`.github/workflows/pages.yml`). Any other static host works too (Netlify, Cloudflare Pages…).
It must be served over HTTPS (or localhost) so the elevation tile cache works.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Start at / Finish at | whole route | Trim the track: use the sliders, or drag the green/red dots along the route on the map |
| Shape | Fit route | Fit route, Square, 3:2, Hexagon, or Custom. Drag the shape on the map to move it, drag its corners to resize (Square, 3:2 and Hexagon keep their proportions). Hexagon fits itself tightly around the route and picks flat- or pointy-top, whichever is smaller |
| Size | 180 mm | Longest side of the model |
| Vertical exaggeration | 2× | Makes hills taller than real life |
| Terrain around route | 1.8 km | Margin around the track; resets any area edited on the map |
| Detail | Standard (0.3 mm grid) | Draft 0.5 mm, Fine 0.2 mm. Finer = bigger file |
| Trail style | Raised | Raised ridge, carved groove, or **separate inlay**: the route prints as its own piece(s) in another colour and drops into a slot in the terrain. Each piece has a flat, sloped bottom (a best-fit plane), so it prints without supports; the route is split only where a piece would get taller than "Tallest piece". Download as a zip (terrain + numbered pieces laid flat) or a 3MF for multi-colour printers; a test-fit piece checks the clearance first |
| Inlay clearance, slot depth, tallest piece | 0.15 mm, 3 mm, 10 mm | The base is raised (to about 5.7 mm) to make room for the slot |
| Trail height/depth, width | 1.0 mm, 1.6 mm | |
| Start / finish marker | Triangle / Square | None, Triangle, Circle, Square, Star or Hexagon; raised solids that face the direction of travel (the triangle points the way) |
| Marker size, height | 6 mm, 2 mm | Height is above the highest ground under the marker |
| Label | off | Text printed on a flat plate (top level with the highest ground under it), raised or engraved. Prefilled with the route name, distance, climb/descent, high point, and date/duration when the GPX has timestamps; edit freely. Drag it on the map; by default it sits low and central, clear of the route |
| Letter height, lettering depth | 4 mm, 0.8 mm | |
| Label rotation | 0° | Slider, or drag the rotate handle above the label on the map (snaps to 15° steps when close) |
| Base thickness | 3 mm | Under the lowest point |
| Corner radius | 10 mm | 0 for square corners |
| Terrain smoothing | 0.8 | Blur in grid cells |

## Layout

    web/                 the app (static site)
      js/core/           engine: GPX parsing, PNG/tile decoding, filters, footprint shapes, markers, label text,
                         elevation profile, inlay pieces, model builder, STL / ZIP / 3MF writers
      js/worker.js       runs the engine in a Web Worker; loads manifold-3d (WASM) from jsDelivr
      js/app.js          UI, print-area state and three.js preview
      js/mapview.js      Leaflet map: route + draggable/resizable print footprint
    tests/               Node regression test + headless-browser smoke test
    python/              original Python CLI, kept as the reference implementation

## Tests

    cd tests
    npm install
    node regression.mjs                    # engine vs. the Python reference numbers
    (puppeteer-core is a dev dependency; it uses your own Chromium)
    node browser.mjs /path/to/chromium     # full UI flow in headless Chromium

## Python CLI (reference)

    cd python
    python -m venv .venv && .venv/bin/pip install -r requirements.txt   # .venv\Scripts\ on Windows
    python gpx2stl.py ../web/examples/whole_enchilada.gpx -o out.stl --preview out.png

## Credits

Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (terrarium PNGs; SRTM,
USGS 3DEP, GMTED and others), about 30 m resolution in the US at zoom 12.
Map: [OpenTopoMap](https://opentopomap.org) (© OpenStreetMap contributors, SRTM) via [Leaflet](https://leafletjs.com).
Geometry: [manifold-3d](https://github.com/elalish/manifold). Preview: [three.js](https://threejs.org).
Label font: [Atkinson Hyperlegible](https://www.brailleinstitute.org/freefont/) Bold (SIL OFL, `web/fonts/OFL.txt`), read with [opentype.js](https://opentype.js.org).
