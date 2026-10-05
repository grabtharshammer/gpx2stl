// Minimal PNG decoder for 8-bit, non-interlaced RGB/RGBA/grey images (what terrain tiles use).
// Decoding ourselves avoids canvas colour management and the anti-fingerprinting noise some
// browsers add to getImageData, either of which would corrupt elevation values.

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns { width, height, channels, data: Uint8Array } (row-major, interleaved). */
export async function decodePng(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (!SIG.every((v, i) => b[i] === v)) throw new Error("Not a PNG file");
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < b.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(...b.subarray(pos + 4, pos + 8));
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      const depth = body[8], ctype = body[9], interlace = body[12];
      channels = CHANNELS[ctype];
      if (depth !== 8 || !channels || interlace) throw new Error(`Unsupported PNG (depth ${depth}, type ${ctype})`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const zipped = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((o, c) => (zipped.set(c, o), o + c.length), 0);
  const raw = await inflate(zipped);

  const stride = width * channels, out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[row + i - channels] : 0;
      const c = y && i >= channels ? out[up + i - channels] : 0;
      const u = y ? out[up + i] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + u; break;
        case 3: v = x + ((a + u) >> 1); break;
        case 4: {
          const p = a + u - c, pa = Math.abs(p - a), pb = Math.abs(p - u), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? u : c);
          break;
        }
        default: throw new Error(`Bad PNG filter ${f}`);
      }
      out[row + i] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}
