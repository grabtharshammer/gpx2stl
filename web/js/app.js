import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { parseGpx, routeLength } from "./core/gpx.js";
import { DEFAULTS, planGrid, routeFrame } from "./core/model.js";
import { writeStl } from "./core/stl.js";
import { FootprintMap } from "./mapview.js";
import { outline, roundedOutline, insidePolygon, fitHexagon } from "./core/footprint.js";
import { MARKER_SHAPES, markerPolygon } from "./core/markers.js";

const $ = (id) => document.getElementById(id);
const STORE = "gpx2stl-settings-v1";

// ------------------------------------------------------------------ settings
const SLIDERS = {
  "area-controls": [
    { key: "marginKm", label: "Terrain around route", unit: "km", min: 0.2, max: 10, step: 0.1, resetsArea: true },
  ],
  "model-controls": [
    { key: "size", label: "Size", unit: "mm", min: 50, max: 300, step: 5, help: "Longest side of the print" },
    { key: "zExag", label: "Vertical exaggeration", unit: "×", min: 1, max: 6, step: 0.1, help: "Makes hills taller than real life" },
  ],
  "trail-controls": [
    { key: "trailDepth", label: "Height", unit: "mm", min: 0.2, max: 3, step: 0.1 },
    { key: "trailWidth", label: "Width", unit: "mm", min: 0.6, max: 5, step: 0.1 },
  ],
  "marker-controls": [
    { key: "markerSize", label: "Marker size", unit: "mm", min: 3, max: 15, step: 0.5 },
    { key: "markerHeight", label: "Marker height", unit: "mm", min: 0.5, max: 6, step: 0.5, help: "Above the highest ground under it" },
  ],
  "advanced-controls": [
    { key: "base", label: "Base thickness", unit: "mm", min: 1, max: 15, step: 0.5, help: "Under the lowest point" },
    { key: "cornerRadius", label: "Corner radius", unit: "mm", min: 0, max: 40, step: 1, help: "0 for square corners" },
    { key: "smooth", label: "Terrain smoothing", unit: "", min: 0, max: 4, step: 0.1, help: "Softens noisy elevation data" },
  ],
};
const UI_DEFAULTS = {
  shape: "fit", size: DEFAULTS.size, zExag: DEFAULTS.zExag, marginKm: DEFAULTS.marginKm, cell: DEFAULTS.cell,
  trailStyle: "raised", trailDepth: Math.abs(DEFAULTS.trailHeight), trailWidth: DEFAULTS.trailWidth,
  base: DEFAULTS.base, cornerRadius: DEFAULTS.cornerRadius, smooth: DEFAULTS.smooth,
  startMarker: "triangle", endMarker: "square", markerSize: DEFAULTS.markerSize, markerHeight: DEFAULTS.markerHeight,
};

let settings = { ...UI_DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE)) ?? {}); } catch {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {} };

const engineOpts = () => ({
  size: settings.size, zExag: settings.zExag, marginKm: settings.marginKm, cell: settings.cell,
  trailHeight: settings.trailStyle === "groove" ? -settings.trailDepth : settings.trailDepth,
  trailWidth: settings.trailWidth, base: settings.base, cornerRadius: settings.cornerRadius, smooth: settings.smooth,
  area: engineArea(),
  shape: footprintShape(),
  startMarker: settings.startMarker, endMarker: settings.endMarker,
  markerSize: settings.markerSize, markerHeight: settings.markerHeight,
});

const inputs = {};
for (const [container, defs] of Object.entries(SLIDERS)) {
  for (const d of defs) {
    const el = document.createElement("div");
    el.className = "field";
    el.innerHTML = `
      <div class="row"><label class="label" for="r-${d.key}">${d.label}</label>
        <span class="val"><input type="number" min="${d.min}" max="${d.max}" step="${d.step}" aria-label="${d.label}">${d.unit}</span></div>
      <input type="range" id="r-${d.key}" min="${d.min}" max="${d.max}" step="${d.step}">
      ${d.help ? `<span class="help">${d.help}</span>` : ""}`;
    const [num, range] = el.querySelectorAll("input");
    const set = (v, from) => {
      v = parseFloat(v);
      if (!Number.isFinite(v)) return;
      if (from !== num) num.value = v;
      if (from !== range) range.value = v;
      settings[d.key] = v;
      if (d.resetsArea) override = null;
      changed();
    };
    range.addEventListener("input", () => set(range.value, range));
    num.addEventListener("change", () => set(Math.min(d.max * 4, Math.max(0, num.value)), num));
    inputs[d.key] = (v) => { num.value = v; range.value = v; };
    $(container).append(el);
  }
}

// marker shape pickers: icons drawn from the same outlines the engine prints
for (const id of ["start-marker", "end-marker"]) {
  $(id).innerHTML = MARKER_SHAPES.map((m) => {
    if (m === "none") return `<button type="button" data-v="none" title="No marker">None</button>`;
    const d = markerPolygon(m, 18, Math.PI / 2).map(([x, y], i) => `${i ? "L" : "M"}${(x + 10).toFixed(2)} ${(10 - y).toFixed(2)}`).join("") + "Z";
    return `<button type="button" data-v="${m}" title="${m[0].toUpperCase() + m.slice(1)}" aria-label="${m}">` +
           `<svg viewBox="0 0 20 20"><path d="${d}"/></svg></button>`;
  }).join("");
}

function bindSeg(id, key, parse = (v) => v) {
  const btns = [...$(id).querySelectorAll("button")];
  const sync = () => btns.forEach((b) => b.setAttribute("aria-checked", parse(b.dataset.v) === settings[key]));
  btns.forEach((b) => {
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => { settings[key] = parse(b.dataset.v); sync(); changed(); });
  });
  return sync;
}
// capture phase: runs before the button's own handler changes settings.shape
$("shape").addEventListener("click", (e) => {
  const v = e.target.closest("button")?.dataset.v;
  if (v && frame) override = v === "custom" ? currentArea() : null;
}, true);
// bubble phase: after the new shape is applied, bring the whole box into view
$("shape").addEventListener("click", () => frame && fpMap.fit());
const segSyncs = [bindSeg("detail", "cell", parseFloat), bindSeg("trail-style", "trailStyle"), bindSeg("shape", "shape"),
                  bindSeg("start-marker", "startMarker"), bindSeg("end-marker", "endMarker")];

function syncControls() {
  for (const [k, set] of Object.entries(inputs)) set(settings[k]);
  segSyncs.forEach((s) => s());
}

const depthLabel = document.querySelector('label[for="r-trailDepth"]');
$("trail-style").addEventListener("click", () => syncTrailLabel());
const syncTrailLabel = () => (depthLabel.textContent = settings.trailStyle === "groove" ? "Depth" : "Height");

$("reset").addEventListener("click", () => { settings = { ...UI_DEFAULTS }; override = null; syncControls(); syncTrailLabel(); changed(); });

// ------------------------------------------------------------------ route loading
let route = null;      // { name, segments, fileName }
let frame = null;      // local metre frame of the route (core/model.js routeFrame)
let routePts = [];     // route points in that frame, metres
let override = null;   // print area set on the map, { x0, x1, y0, y1 } metres; null = automatic
let model = null;      // last built model
let builtFor = null;   // JSON of the settings + route the model was built with

// ------------------------------------------------------------------ print area
const RATIOS = { square: 1, "3:2": 1.5 };
const footprintShape = () => (settings.shape === "hex" ? "hex" : "rect");

function autoHexagon() {
  const b = frame.bounds;
  return fitHexagon(routePts, (b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2, settings.marginKm * 1000);
}

/** Locked width/height ratio for the current shape, oriented like the route; null = free. */
function aspect() {
  if (settings.shape === "hex") return autoHexagon().flat ? 2 / Math.sqrt(3) : Math.sqrt(3) / 2;
  const r = RATIOS[settings.shape], b = frame.bounds;
  return r ? (b.xmax - b.xmin >= b.ymax - b.ymin ? r : 1 / r) : null;
}

function currentArea() {
  if (override) return override;
  if (settings.shape === "hex") {
    const { x0, x1, y0, y1 } = autoHexagon();
    return { x0, x1, y0, y1 };
  }
  const b = frame.bounds, m = settings.marginKm * 1000;
  let x0 = b.xmin - m, x1 = b.xmax + m, y0 = b.ymin - m, y1 = b.ymax + m;
  const a = aspect();
  if (a) {
    const w = x1 - x0, h = y1 - y0;
    if (w / h < a) { const d = (h * a - w) / 2; x0 -= d; x1 += d; }
    else { const d = (w / a - h) / 2; y0 -= d; y1 += d; }
  }
  return { x0, x1, y0, y1 };
}

/** Area for the engine; undefined keeps its own route + margin box (identical to the Python CLI). */
function engineArea() {
  if (!frame || (!override && settings.shape === "fit")) return undefined;
  const { x0, x1, y0, y1 } = currentArea();
  const [south, west] = frame.toLL(x0, y0), [north, east] = frame.toLL(x1, y1);
  return { south, west, north, east };
}

const fpMap = new FootprintMap($("map"), {
  onChange(area, final) {
    override = area;
    if (settings.shape === "fit") { settings.shape = "custom"; syncControls(); }
    changed({ fromMap: !final });
  },
});

function updateArea(p, fromMap) {
  const a = currentArea();
  const cornerM = settings.cornerRadius / p.sc;
  if (!fromMap) fpMap.setFootprint(a, cornerM, aspect(), footprintShape());
  const km = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0);
  const poly = roundedOutline(outline(footprintShape(), a.x1 - a.x0, a.y1 - a.y0), cornerM);
  const cropped = routePts.some(([x, y]) => !insidePolygon(poly, x - a.x0, y - a.y0));
  $("map-info").innerHTML = `${km(a.x1 - a.x0)} × ${km(a.y1 - a.y0)} km → <b>${p.width.toFixed(0)} × ${p.depth.toFixed(0)} mm</b>` +
    (cropped ? `<br><span class="warn">Part of the route is outside the print area</span>` : "");
  $("area-note").innerHTML = override
    ? `Area adjusted on the map. <button class="link" type="button" id="area-reset">Reset</button>`
    : "Drag the box on the map to move it, or its corners to resize.";
  $("area-reset")?.addEventListener("click", () => {
    override = null;
    if (settings.shape === "custom") settings.shape = "fit";
    syncControls();
    changed();
    fpMap.fit();
  });
}

// ------------------------------------------------------------------ tabs
function showTab(t) {
  $("viewer").dataset.tab = t;
  for (const b of $("tabs").querySelectorAll("button")) b.setAttribute("aria-selected", b.dataset.tab === t);
  if (t === "map") fpMap.invalidate();
}
$("tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && !b.disabled) showTab(b.dataset.tab);
});

async function loadText(text, fileName) {
  try {
    const g = parseGpx(text);
    route = { ...g, fileName, name: g.name || fileName.replace(/\.gpx$/i, "") };
  } catch (err) {
    showError(err.message);
    return;
  }
  const km = routeLength(route.segments) / 1000;
  const pts = route.segments.reduce((n, s) => n + s.length, 0);
  $("route-name").textContent = route.name;
  $("route-meta").textContent = `${km.toFixed(1)} km · ${pts.toLocaleString()} points` +
    (route.segments.length > 1 ? ` · ${route.segments.length} segments` : "");
  $("drop").hidden = true;
  $("example-hint").hidden = true;
  $("route-info").hidden = false;
  showError(null);

  frame = routeFrame(route.segments);
  routePts = route.segments.flat().map(frame.toM);
  override = null;
  if (settings.shape === "custom") settings.shape = "fit";
  syncControls();
  clearModel();
  $("viewer").classList.add("has-route");
  $("tabs").hidden = false;
  showTab("map");
  fpMap.setRoute(route.segments, frame);
  changed();
  fpMap.fit();
}

$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) loadText(await f.text(), f.name);
  e.target.value = "";
});
$("change-route").addEventListener("click", () => $("file").click());
$("example").addEventListener("click", async () => {
  const r = await fetch("examples/whole_enchilada.gpx");
  loadText(await r.text(), "whole_enchilada.gpx");
});
for (const t of [document.body]) {
  t.addEventListener("dragover", (e) => { e.preventDefault(); $("drop").classList.add("over"); });
  t.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("drop").classList.remove("over"); });
  t.addEventListener("drop", async (e) => {
    e.preventDefault();
    $("drop").classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f) loadText(await f.text(), f.name);
  });
}

// ------------------------------------------------------------------ estimate + state
const fmtMB = (bytes) => (bytes / 1e6 < 10 ? (bytes / 1e6).toFixed(1) : Math.round(bytes / 1e6)) + " MB";
const key = () => route && JSON.stringify([route.fileName, route.segments.length, engineOpts()]);

function changed({ fromMap = false } = {}) {
  save();
  const est = $("estimate"), btn = $("generate");
  if (!route) { est.textContent = ""; btn.disabled = true; return; }
  const p = planGrid(route.segments, engineOpts());
  updateArea(p, fromMap);
  const bytes = 84 + 50 * p.triangles;
  const tooMany = p.tiles.count > 400;
  est.classList.toggle("warn", tooMany || p.triangles > 4e6);
  est.textContent = tooMany
    ? `Too much elevation data for this area (${p.tiles.count} tiles). Pick a coarser detail level or a smaller area.`
    : `≈ ${p.width.toFixed(0)} × ${p.depth.toFixed(0)} mm · 1:${Math.round(1000 / p.sc).toLocaleString()} · ` +
      `${(p.triangles / 1e6).toFixed(p.triangles < 1e6 ? 2 : 1)}M triangles · ${fmtMB(bytes)}` +
      (p.triangles > 4e6 ? " (large: try a coarser detail level)" : "");
  btn.disabled = tooMany || busy;
  const fresh = model && builtFor === key();
  btn.textContent = fresh ? "Model is up to date" : model ? "Update model" : "Generate model";
  if (fresh) btn.disabled = true;
}

function showError(msg) {
  $("error").hidden = !msg;
  $("error").textContent = msg ?? "";
}

// ------------------------------------------------------------------ worker
const STAGES = {
  engine: ["Loading geometry engine…", 0, 0.05],
  tiles: ["Downloading elevation data…", 0.05, 0.6],
  terrain: ["Shaping terrain…", 0.6, 0.7],
  route: ["Tracing your route…", 0.7, 0.78],
  mesh: ["Building mesh…", 0.78, 0.85],
  solid: ["Making it printable…", 0.85, 1],
};
let worker = null, busy = false, reqId = 0;

function generate() {
  if (!route) return;
  if (busy) { worker.terminate(); worker = null; }
  worker ??= new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const id = ++reqId, k = key();
  busy = true;
  showError(null);
  $("progress").hidden = false;
  $("generate").disabled = true;
  setProgress("engine", 0);
  worker.onmessage = ({ data }) => {
    if (data.id !== id) return;
    if (data.type === "progress") return setProgress(data.stage, data.frac);
    busy = false;
    $("progress").hidden = true;
    if (data.type === "error") { showError(data.message); changed(); return; }
    model = data.model;
    builtFor = k;
    showModel(model);
    showTab("3d");
    changed();
  };
  worker.onerror = (e) => {
    busy = false;
    $("progress").hidden = true;
    showError(`Something went wrong: ${e.message || "the worker failed to start"}`);
    worker = null;
    changed();
  };
  worker.postMessage({ id, segments: route.segments, opts: engineOpts() });
}
$("generate").addEventListener("click", generate);

function setProgress(stage, frac) {
  const [label, a, b] = STAGES[stage] ?? ["Working…", 0, 1];
  $("progress-bar").style.width = `${(a + (b - a) * frac) * 100}%`;
  $("progress-label").textContent = stage === "tiles" ? `${label} ${Math.round(frac * 100)}%` : label;
}

// ------------------------------------------------------------------ 3D viewer
const canvas = $("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6050, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-1, 1.2, 1.4);
scene.add(sun);
let mesh = null;

const dark = matchMedia("(prefers-color-scheme: dark)");
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function applyTheme() { scene.background = new THREE.Color(css("--viewer")); if (model) showModel(model, false); }
dark.addEventListener("change", applyTheme);

new ResizeObserver(() => {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}).observe(canvas.parentElement);
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

function fitCamera() {
  if (!model) return;
  const { width, depth, height } = model.stats, r = Math.hypot(width, depth, height) / 2;
  const vfov = (camera.fov * Math.PI) / 360, hfov = Math.atan(Math.tan(vfov) * camera.aspect);
  const d = (r / Math.sin(Math.min(vfov, hfov))) * 0.85;
  controls.target.set(0, 0, height / 3);
  camera.position.set(0, -d * 0.72, d * 0.7);
  camera.near = d / 50; camera.far = d * 10;
  camera.updateProjectionMatrix();
  controls.update();
}
$("reset-view").addEventListener("click", fitCamera);

function showModel(m, reframe = true) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  const palette = [new THREE.Color(dark.matches ? 0xb9b3a4 : 0xd8d2c2), new THREE.Color(css("--accent")),
                   new THREE.Color(css("--start")), new THREE.Color(css("--finish"))];   // see core/model.js
  const col = new Float32Array(m.trail.length * 3);
  for (let i = 0; i < m.trail.length; i++) palette[m.trail[i]].toArray(col, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }));
  mesh.position.set(-m.stats.width / 2, -m.stats.depth / 2, 0);   // don't move the vertices: they're also the STL
  scene.add(mesh);
  $("tabs").querySelector('[data-tab="3d"]').disabled = false;
  $("viewer").classList.add("has-model");
  if (reframe) fitCamera();

  const s = m.stats;
  const stats = [
    ["Size", `${s.width.toFixed(0)} × ${s.depth.toFixed(0)} × ${s.height.toFixed(0)} mm`],
    ["Scale", `1:${Math.round(s.scale).toLocaleString()}`],
    ["Elevation", `${Math.round(s.elevMin).toLocaleString()}–${Math.round(s.elevMax).toLocaleString()} m`],
    ["Volume", `${Math.round(s.volume)} cm³`],
    ["Triangles", s.triangles.toLocaleString()],
  ];
  $("stats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  $("download-size").textContent = `(${fmtMB(84 + 50 * s.triangles)})`;
  $("result").hidden = false;
}

function clearModel() {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh = null; }
  model = null;
  builtFor = null;
  $("viewer").classList.remove("has-model");
  $("result").hidden = true;
  $("tabs").querySelector('[data-tab="3d"]').disabled = true;
}

$("download").addEventListener("click", () => {
  if (!model) return;
  const blob = new Blob([writeStl(model.positions, model.indices, route.name)], { type: "model/stl" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (route.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "route") + ".stl";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

syncControls();
syncTrailLabel();
applyTheme();
changed();
