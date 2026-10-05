// Grid filters matching the scipy.ndimage calls in the Python reference.

/** In-place separable Gaussian blur (scipy gaussian_filter: truncate=4, mode='reflect'). */
export function gaussianBlur(a, nx, ny, sigma) {
  const r = Math.floor(4 * sigma + 0.5);
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2);
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const reflect = (i, n) => {
    const p = 2 * n;
    i = ((i % p) + p) % p;
    return i < n ? i : p - 1 - i;
  };
  const pass = (n, lines, at) => {
    const line = new Float64Array(n);
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < n; i++) line[i] = a[at(l, i)];
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let j = -r; j <= r; j++) v += k[j + r] * line[reflect(i + j, n)];
        a[at(l, i)] = v;
      }
    }
  };
  pass(ny, nx, (col, row) => row * nx + col);   // axis 0 first, as scipy does
  pass(nx, ny, (row, col) => row * nx + col);
  return a;
}

/**
 * Exact Euclidean distance (in cells) from every cell to the nearest seed cell
 * (Felzenszwalb & Huttenlocher), equivalent to scipy distance_transform_edt(~seed).
 */
export function distanceTransform(seed, nx, ny) {
  const INF = 1e20, n = Math.max(nx, ny);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const g = new Float64Array(nx * ny);
  for (let i = 0; i < g.length; i++) g[i] = seed[i] ? 0 : INF;

  const dt1 = (len) => {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s;
      do {
        const p = v[k];
        s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      } while (s <= z[k] && k-- > 0);
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + f[v[k]];
    }
  };
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) f[y] = g[y * nx + x];
    dt1(ny);
    for (let y = 0; y < ny; y++) g[y * nx + x] = d[y];
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) f[x] = g[y * nx + x];
    dt1(nx);
    for (let x = 0; x < nx; x++) g[y * nx + x] = Math.sqrt(d[x]);
  }
  return g;
}
