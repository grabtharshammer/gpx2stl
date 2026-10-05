# gpx2stl

Turn a GPX track into a 3D-printable terrain relief with the route marked on it.

## Setup

    python -m venv .venv
    .venv\Scripts\activate          # Windows;  source .venv/bin/activate on macOS/Linux
    pip install -r requirements.txt

## Use

    python gpx2stl.py examples/whole_enchilada.gpx -o whole_enchilada.stl --preview preview.png

Elevation tiles are downloaded on first run and kept in `tile_cache/`, so repeat runs are offline and fast.

| Option | Default | Meaning |
|---|---|---|
| `--size` | 180 | Longest side of the model, mm |
| `--margin-km` | 1.8 | Terrain included around the route |
| `--z-exag` | 2 | Vertical exaggeration |
| `--base` | 3 | Thickness under the lowest point, mm |
| `--cell` | 0.3 | Grid spacing, mm (smaller = more detail, bigger file) |
| `--trail-height` | 1.0 | Route ridge height, mm; negative cuts a groove |
| `--trail-width` | 1.6 | Route width, mm |
| `--corner-radius` | 10 | Footprint corner radius, mm; 0 for square |
| `--smooth` | 0.8 | Terrain blur, in grid cells |
| `--zoom` | auto | Elevation tile zoom level |
| `--cache` | tile_cache | Tile cache folder |
| `--preview` | off | Write a shaded PNG of the result |

Elevation data: Mapzen/AWS Terrain Tiles (terrarium PNG), about 30 m resolution in the US at zoom 12.
