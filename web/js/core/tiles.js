// Elevation tiles: AWS/Mapzen "terrarium" PNGs, elevation = R*256 + G + B/256 - 32768 metres.
import { decodePng } from "./png.js";

export const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const TILE = 256;

export const tileUrl = (z, x, y) => TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);

/** Fractional Web-Mercator tile coordinates. */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  return [((lon + 180) / 360) * n, ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n];
}

/** PNG bytes -> Float64Array(256*256) of metres. */
export async function decodeTerrarium(buf) {
  const { width, height, channels, data } = await decodePng(buf);
  if (width !== TILE || height !== TILE || channels < 3) throw new Error("Unexpected elevation tile format");
  const out = new Float64Array(TILE * TILE);
  for (let i = 0, p = 0; i < out.length; i++, p += channels)
    out[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  return out;
}
