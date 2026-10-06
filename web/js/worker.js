// Runs the model build off the main thread so the page stays responsive.
import { buildModel } from "./core/model.js";
import { tileUrl, decodeTerrarium } from "./core/tiles.js";
import { routeProfile } from "./core/profile.js";
import { buildCoupon } from "./core/inlay.js";

const MANIFOLD_URL = "https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.js";
const CACHE = "gpx2stl-tiles-v1";

let manifold;
async function getManifold() {
  if (!manifold) {
    manifold = import(MANIFOLD_URL)
      .then((m) => m.default())
      .then((wasm) => (wasm.setup(), wasm));
    manifold.catch(() => (manifold = null));
  }
  return manifold;
}

async function download(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      if (r.status < 500 && r.status !== 429) throw new Error(`HTTP ${r.status}`);
      if (attempt >= 3) throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      if (attempt >= 3 || /^HTTP 4/.test(err.message)) throw err;
    }
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
}

async function getTile(z, x, y) {
  const url = tileUrl(z, x, y);
  let cache = null, res;
  try { cache = await caches.open(CACHE); res = await cache.match(url); } catch {}
  if (!res) {
    try { res = await download(url); }
    catch (err) { throw new Error(`Couldn't download elevation data (tile ${z}/${x}/${y}): ${err.message}`); }
    if (cache) try { await cache.put(url, res.clone()); } catch {}
  }
  return decodeTerrarium(await res.arrayBuffer());
}

self.onmessage = async ({ data: { id, job = "build", segments, opts } }) => {
  if (job === "coupon") {
    try {
      const c = buildCoupon(await getManifold(), opts);
      self.postMessage({ id, type: "coupon", coupon: c });
    } catch (err) { self.postMessage({ id, type: "error", message: err?.message ?? String(err) }); }
    return;
  }
  if (job === "profile") {
    try { self.postMessage({ id, type: "profile", profile: await routeProfile(segments, getTile) }); }
    catch (err) { self.postMessage({ id, type: "error", message: err?.message ?? String(err) }); }
    return;
  }
  const progress = (stage, frac) => self.postMessage({ id, type: "progress", stage, frac });
  try {
    progress("engine", 0);
    const wasm = await getManifold();
    const m = await buildModel(segments, opts, { getTile, manifold: wasm, progress });
    const buffers = [m.positions, m.indices, m.trail, ...m.inlays.flatMap((q) => [q.positions, q.indices, q.trail]),
                     ...[m.lettering, m.plainTerrain].filter(Boolean).flatMap((q) => [q.positions, q.indices])];
    self.postMessage({ id, type: "done", model: m }, buffers.map((b) => b.buffer));
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message ?? String(err) });
  }
};
