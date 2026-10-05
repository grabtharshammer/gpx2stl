#!/usr/bin/env python3
"""gpx2stl - turn a GPX track into a 3D-printable terrain relief with the route on it.

Pipeline:
  1. Parse the GPX (lat/lon only; elevation in the file is ignored).
  2. Download public elevation tiles (AWS "terrarium" PNGs) covering the route + margin.
  3. Resample the terrain onto a regular grid in millimetres.
  4. Raise (or groove) the route on the terrain surface.
  5. Build a watertight solid, round the footprint corners, write a binary STL.
"""
import argparse, io, math, os, struct, sys, urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
EARTH_R = 6371008.8


# ---------------------------------------------------------------- GPX
def read_gpx(path):
    """Return a list of segments, each an (N, 2) array of (lat, lon)."""
    root = ET.parse(path).getroot()
    for el in root.iter():                       # strip XML namespaces
        el.tag = el.tag.rsplit("}", 1)[-1]
    segs = []
    for seg in root.iter("trkseg"):
        pts = [(float(p.get("lat")), float(p.get("lon"))) for p in seg.iter("trkpt")]
        if len(pts) > 1:
            segs.append(np.array(pts))
    if not segs:                                 # fall back to routes
        for rte in root.iter("rte"):
            pts = [(float(p.get("lat")), float(p.get("lon"))) for p in rte.iter("rtept")]
            if len(pts) > 1:
                segs.append(np.array(pts))
    if not segs:
        sys.exit(f"No track or route points found in {path}")
    return segs


# ---------------------------------------------------------------- tiles
def lonlat_to_tile(lon, lat, z):
    """Fractional tile coordinates (works on scalars and arrays)."""
    n = 2 ** z
    x = (np.asarray(lon) + 180.0) / 360.0 * n
    y = (1 - np.arcsinh(np.tan(np.radians(lat))) / np.pi) / 2 * n
    return x, y


def fetch_tile(z, x, y, cache):
    from PIL import Image
    f = Path(cache) / str(z) / str(x) / f"{y}.png"
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(TILE_URL.format(z=z, x=x, y=y),
                                     headers={"User-Agent": "gpx2stl/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                f.write_bytes(r.read())
        except OSError as err:
            sys.exit(f"Could not download elevation tile {z}/{x}/{y}: {err}")
    a = np.asarray(Image.open(io.BytesIO(f.read_bytes())).convert("RGB"), dtype=np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768     # metres


def load_dem(lon0, lon1, lat0, lat1, z, cache):
    """Mosaic of tiles covering the box. Returns (dem, tile_x0, tile_y0)."""
    xa, ya = lonlat_to_tile(lon0, lat1, z)       # north-west corner
    xb, yb = lonlat_to_tile(lon1, lat0, z)       # south-east corner
    x0, x1, y0, y1 = int(xa), int(xb), int(ya), int(yb)
    count = (x1 - x0 + 1) * (y1 - y0 + 1)
    if count > 400:
        sys.exit(f"Area needs {count} tiles at zoom {z}; lower --zoom or raise --cell.")
    dem = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256))
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            dem[(ty - y0) * 256:(ty - y0 + 1) * 256,
                (tx - x0) * 256:(tx - x0 + 1) * 256] = fetch_tile(z, tx, ty, cache)
    return dem, x0, y0


# ---------------------------------------------------------------- model
def build(args):
    segs = read_gpx(args.gpx)
    allp = np.vstack(segs)
    latc, lonc = allp[:, 0].mean(), allp[:, 1].mean()
    cosl = math.cos(math.radians(latc))

    def to_m(ll):                                # local metres, east/north of centre
        return (np.radians(ll[:, 1] - lonc) * EARTH_R * cosl,
                np.radians(ll[:, 0] - latc) * EARTH_R)

    ax, ay = to_m(allp)
    marg = args.margin_km * 1000.0
    xmin, xmax, ymin, ymax = ax.min() - marg, ax.max() + marg, ay.min() - marg, ay.max() + marg
    sc = args.size / max(xmax - xmin, ymax - ymin)          # mm per metre
    cell = args.cell
    nx = int(round((xmax - xmin) * sc / cell)) + 1
    ny = int(round((ymax - ymin) * sc / cell)) + 1
    GX, GY = np.meshgrid(np.linspace(xmin, xmax, nx), np.linspace(ymin, ymax, ny))
    lon = lonc + np.degrees(GX / (EARTH_R * cosl))
    lat = latc + np.degrees(GY / EARTH_R)

    # zoom: finest level whose pixels are no coarser than one grid cell
    z = args.zoom
    if z is None:
        ground_per_cell = cell / sc
        z = 8
        while z < 14 and 156543.03 * cosl / 2 ** z > ground_per_cell:
            z += 1
    dem, tx0, ty0 = load_dem(lon.min(), lon.max(), lat.min(), lat.max(), z, args.cache)
    fx, fy = lonlat_to_tile(lon, lat, z)
    px = np.clip((fx - tx0) * 256 - 0.5, 0, dem.shape[1] - 1)
    py = np.clip((fy - ty0) * 256 - 0.5, 0, dem.shape[0] - 1)
    elev = ndi.map_coordinates(dem, [py, px], order=1)
    if args.smooth > 0:
        elev = ndi.gaussian_filter(elev, args.smooth)
    Z = args.base + (elev - elev.min()) * sc * args.z_exag

    # route: distance field from the rasterised track, then a tapered bump
    mask = np.ones((ny, nx), bool)
    for s in segs:
        sx, sy = to_m(s)
        d = np.r_[0, np.cumsum(np.hypot(np.diff(sx), np.diff(sy)))]
        t = np.arange(0, d[-1], cell / 4 / sc)
        ix = np.round((np.interp(t, d, sx) - xmin) * sc / cell).astype(int)
        iy = np.round((np.interp(t, d, sy) - ymin) * sc / cell).astype(int)
        mask[np.clip(iy, 0, ny - 1), np.clip(ix, 0, nx - 1)] = False
    dist = ndi.distance_transform_edt(mask) * cell
    half = args.trail_width / 2
    r0, r1 = max(half - 0.2, 0.0), half + 0.25
    bump = args.trail_height * np.clip((r1 - dist) / (r1 - r0), 0, 1)
    Zt = np.maximum(Z + bump, 0.6)               # keep a floor if grooving

    # watertight solid: top grid, vertical walls, fan-triangulated flat bottom
    W, D = (nx - 1) * cell, (ny - 1) * cell
    VX, VY = np.meshgrid(np.arange(nx) * cell, np.arange(ny) * cell)
    top = np.c_[VX.ravel(), VY.ravel(), Zt.ravel()]
    idx = np.arange(nx * ny).reshape(ny, nx)
    a, b, c, e = idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(), idx[1:, 1:].ravel(), idx[1:, :-1].ravel()
    per = np.r_[idx[0, :-1], idx[:-1, -1], idx[-1, :0:-1], idx[:0:-1, 0]]
    nb = len(per)
    bot = top[per].copy(); bot[:, 2] = 0
    bi, ci = nx * ny + np.arange(nb), nx * ny + nb
    V = np.vstack([top, bot, [[W / 2, D / 2, 0]]])
    j = np.arange(nb); k = (j + 1) % nb
    F = np.vstack([np.c_[a, b, c], np.c_[a, c, e],
                   np.c_[per[j], bi[j], bi[k]], np.c_[per[j], bi[k], per[k]],
                   np.c_[bi[k], bi[j], np.full(nb, ci)]]).astype(np.uint32)

    import manifold3d as m3
    solid = m3.Manifold(m3.Mesh(vert_properties=V.astype(np.float32), tri_verts=F))
    r = min(args.corner_radius, W / 2 - 0.1, D / 2 - 0.1)
    if r > 0:
        cs = m3.CrossSection.square((W - 2 * r, D - 2 * r)).translate((r, r))
        cs = cs.offset(r, m3.JoinType.Round, circular_segments=96)
        solid = solid ^ m3.Manifold.extrude(cs, float(Zt.max()) + 10)
    if solid.status() != m3.Error.NoError or solid.is_empty():
        sys.exit(f"Mesh is not a valid solid: {solid.status()}")
    mesh = solid.to_mesh()
    V = np.asarray(mesh.vert_properties)[:, :3]; F = np.asarray(mesh.tri_verts)

    write_stl(args.output, V, F, Path(args.gpx).stem)
    print(f"wrote {args.output}")
    print(f"  size        {W:.1f} x {D:.1f} x {Zt.max():.1f} mm")
    print(f"  scale       1:{1000 / sc:,.0f}  (vertical x{args.z_exag:g})")
    print(f"  elevation   {elev.min():.0f} - {elev.max():.0f} m  (tile zoom {z})")
    print(f"  triangles   {len(F):,}   volume {solid.volume() / 1000:.0f} cm3")
    if args.preview:
        write_preview(args.preview, Zt, bump, cell)
        print(f"wrote {args.preview}")


def write_stl(path, V, F, name):
    tri = V[F].astype(np.float32)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    n /= np.linalg.norm(n, axis=1)[:, None] + 1e-30
    rec = np.zeros(len(F), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["n"], rec["v"] = n, tri
    with open(path, "wb") as f:
        f.write(f"gpx2stl {name}".encode("ascii", "replace")[:80].ljust(80, b" "))
        f.write(struct.pack("<I", len(F)))
        f.write(rec.tobytes())


def write_preview(path, Z, bump, cell):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LightSource
    hs = LightSource(315, 40).hillshade(Z, dx=cell, dy=cell, vert_exag=1.5)
    rgb = np.dstack([hs * 0.85 + 0.1] * 3)
    rgb[np.abs(bump) > 0.5 * np.abs(bump).max()] = [0.85, 0.2, 0.1]
    fig, ax = plt.subplots(figsize=(10, 10 * Z.shape[0] / Z.shape[1] + 0.6))
    ax.imshow(rgb, origin="lower", extent=[0, Z.shape[1] * cell, 0, Z.shape[0] * cell])
    ax.set_xlabel("mm"); ax.set_ylabel("mm")
    fig.tight_layout(); fig.savefig(path, dpi=110); plt.close(fig)


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("gpx")
    p.add_argument("-o", "--output", help="STL path (default: <gpx name>.stl)")
    p.add_argument("--size", type=float, default=180, help="longest side in mm [180]")
    p.add_argument("--margin-km", type=float, default=1.8, help="terrain around the route [1.8]")
    p.add_argument("--z-exag", type=float, default=2.0, help="vertical exaggeration [2]")
    p.add_argument("--base", type=float, default=3.0, help="thickness under the lowest point, mm [3]")
    p.add_argument("--cell", type=float, default=0.3, help="grid spacing in mm [0.3]")
    p.add_argument("--trail-height", type=float, default=1.0, help="mm; negative cuts a groove [1.0]")
    p.add_argument("--trail-width", type=float, default=1.6, help="mm [1.6]")
    p.add_argument("--corner-radius", type=float, default=10, help="mm; 0 for square corners [10]")
    p.add_argument("--smooth", type=float, default=0.8, help="terrain blur in grid cells [0.8]")
    p.add_argument("--zoom", type=int, help="elevation tile zoom (default: chosen from --cell)")
    p.add_argument("--cache", default="tile_cache", help="tile cache folder [tile_cache]")
    p.add_argument("--preview", help="also write a shaded PNG preview to this path")
    args = p.parse_args()
    if not args.output:
        args.output = str(Path(args.gpx).with_suffix(".stl"))
    build(args)


if __name__ == "__main__":
    main()
