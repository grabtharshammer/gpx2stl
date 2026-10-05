# gpx2stl — project notes

Single-file CLI (`gpx2stl.py`) that converts a GPX track into a watertight STL: real terrain relief
with the route raised (or grooved) on the surface. Started as a one-off for the Whole Enchilada
(Moab) route in `examples/`; the goal now is to make it a solid, repeatable tool.

## How it works
1. `read_gpx` — lat/lon only, per segment. GPX elevation is ignored on purpose: the original
   Trailforks export had `<ele>0</ele>` on every point.
2. `load_dem` — mosaics AWS terrarium tiles (`elevation = R*256 + G + B/256 - 32768` m), cached on
   disk under `tile_cache/z/x/y.png`. Zoom is picked so a tile pixel is no coarser than a grid cell.
3. Local equirectangular projection around the track centre; terrain bilinearly resampled onto a
   regular mm grid and lightly blurred.
4. Route = distance transform of the rasterised track, turned into a tapered bump added to the heights.
5. Solid = top grid + vertical walls + fan-triangulated flat bottom, passed through `manifold3d`
   (validates manifoldness, intersects with a rounded-rectangle prism for the corners), then binary STL.

## Reference output
Defaults on `examples/whole_enchilada.gpx` give 180.0 x 111.9 x 32.2 mm, scale about 1:173,000,
elevation 1208–3733 m, about 452k triangles, 255 cm3. Use this as a regression check.

## Known gaps
- Live tile download has not been exercised yet (the code was developed where the tile host was
  blocked and tested from a pre-filled cache). Verify the first real run.
- No tests, no packaging (`pyproject.toml`), no retry/backoff on downloads.
- Equirectangular projection is fine for routes up to a few tens of km; long routes need UTM.
- Heightmap grid is uniform: file size grows with 1/cell². No mesh decimation.
- Loops/out-and-back sections just merge into one ridge.

## Ideas
- Text label or start/finish markers; separate trail body for multi-colour printing (3MF).
- `--bbox` / fixed scale options, so several routes can share one terrain tile set.
- Split large models into bed-sized tiles.

## Printing notes (OrcaSlicer)
0.08–0.12 mm layers, "Ensure vertical shell thickness: All", ~1 mm top shell, 3 walls (Arachne),
10–15% gyroid, no supports. Rounded corners + mouse-ear brim help against lifting.
