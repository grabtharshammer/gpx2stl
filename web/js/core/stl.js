// Binary STL writer.

export function writeStl(positions, indices, name = "") {
  const n = indices.length / 3;
  const buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf), u8 = new Uint8Array(buf);
  const header = `gpx2stl ${name}`.replace(/[^\x20-\x7e]/g, "?").slice(0, 80).padEnd(80, " ");
  for (let i = 0; i < 80; i++) u8[i] = header.charCodeAt(i);
  dv.setUint32(80, n, true);
  for (let t = 0, o = 84; t < n; t++, o += 50) {
    const a = indices[3 * t] * 3, b = indices[3 * t + 1] * 3, c = indices[3 * t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    for (const [k, p] of [[12, a], [24, b], [36, c]]) {
      dv.setFloat32(o + k, positions[p], true);
      dv.setFloat32(o + k + 4, positions[p + 1], true);
      dv.setFloat32(o + k + 8, positions[p + 2], true);
    }
  }
  return buf;
}
