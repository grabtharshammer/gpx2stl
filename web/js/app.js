import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { parseGpx, routeLength, trimSegments, routeIndex } from "./core/gpx.js";
import { DEFAULTS, planGrid, routeFrame } from "./core/model.js";
import { writeStl } from "./core/stl.js";
import { FootprintMap } from "./mapview.js";
import { outline, roundedOutline, insidePolygon, fitHexagon } from "./core/footprint.js";
import { MARKER_SHAPES, markerPolygon } from "./core/markers.js";
import { layoutText, contoursToSvgPath } from "./core/text.js";
import { routeTimes } from "./core/profile.js";

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
    { key: "markerSize", label: "Marker size", unit: "mm", min: 1, max: 15, step: 0.5 },
    { key: "markerHeight", label: "Marker height", unit: "mm", min: 0.5, max: 6, step: 0.5, help: "Above the highest ground under it" },
  ],
  "label-controls": [
    { key: "labelSize", label: "Letter height", unit: "mm", min: 2, max: 12, step: 0.5, help: "Height of capital letters" },
    { key: "labelRelief", label: "Lettering depth", unit: "mm", min: 0.4, max: 2, step: 0.1, help: "How far letters stand up, or are cut in" },
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
  labelOn: false, labelStyle: "raised", labelSize: 4, labelRelief: 0.8,
  labelUnits: /^en-(US|LR|MM)$/i.test(navigator.language) ? "imperial" : "metric",
};

let settings = { ...UI_DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE)) ?? {}); } catch {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {} };

const engineOpts = () => ({
  size: settings.size, zExag: settings.zExag, marginKm: settings.marginKm, cell: settings.cell,
  trailHeight: settings.trailStyle === "groove" ? -settings.trailDepth : settings.trailDepth,
  trailWidth: settings.trailWidth, base: settings.base, cornerRadius: settings.cornerRadius, smooth: settings.smooth,
  area: engineArea(),
  origin: frame && { lat: frame.latc, lon: frame.lonc },   // keep the engine's frame = the map's when trimmed
  shape: footprintShape(),
  startMarker: settings.startMarker, endMarker: settings.endMarker,
  markerSize: settings.markerSize, markerHeight: settings.markerHeight,
  label: labelEngineOpts(),
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
                  bindSeg("start-marker", "startMarker"), bindSeg("end-marker", "endMarker"),
                  bindSeg("label-units", "labelUnits"), bindSeg("label-style", "labelStyle"),
                  () => { $("label-on").checked = settings.labelOn; $("label-body").hidden = !settings.labelOn; }];

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
let index = null;      // snapping lookup over the whole route (core/gpx.js routeIndex)
let trim = null;       // printed part of the route: { from, to } metres along it
let segs = [];         // the trimmed route segments; everything downstream uses these
let routePts = [];     // trimmed route points in the frame, metres
let bounds = null;     // their bounding box
let override = null;   // print area set on the map, { x0, x1, y0, y1 } metres; null = automatic
let model = null;      // last built model
let profile = null;    // elevation along the (trimmed) route from the terrain tiles: { max, min, gain, loss }
let builtFor = null;   // JSON of the settings + route the model was built with

// ------------------------------------------------------------------ label
let font = null;              // opentype.js Font, loaded at startup
let labelText = "";
let labelEdited = false;      // once the user types, stop refilling the text from the GPX
let labelPos = null;          // label centre set on the map (frame metres); null = automatic
let labelCenter = null;       // where the label actually goes (labelPos or the automatic spot)
let labelCache = {};

import("opentype.js")
  .then(async (ot) => {
    font = ot.parse(await (await fetch("fonts/AtkinsonHyperlegible-Bold.ttf")).arrayBuffer());
    changed();
  })
  .catch((err) => console.warn("Label font failed to load", err));

/** Text laid out for the plate: { contours, w, h (plate mm), path (SVG) } or null. */
function labelPlate() {
  if (!settings.labelOn || !font) return null;
  const k = `${settings.labelSize}|${labelText}`;
  if (labelCache.k !== k) {
    const t = layoutText(font, labelText, settings.labelSize);
    const pad = Math.max(2, settings.labelSize * 0.6);
    labelCache = { k, v: t && { contours: t.contours, w: t.width + 2 * pad, h: t.height + 2 * pad, path: contoursToSvgPath(t.contours) } };
  }
  return labelCache.v;
}

function labelEngineOpts() {
  const L = labelPlate();
  if (!L || !labelCenter || !frame) return null;
  const [lat, lon] = frame.toLL(labelCenter.x, labelCenter.y);
  return { center: { lat, lon }, contours: L.contours, width: L.w, height: L.h,
           style: settings.labelStyle, relief: settings.labelRelief };
}

const num = (v, digits = 0) => v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Name, distance, climbing, high point, date and duration, in the chosen units. */
function autoLabelText() {
  const imperial = settings.labelUnits === "imperial", dist = routeLength(segs);
  const elev = (m) => num(Math.round(imperial ? m * 3.28084 : m)), unit = imperial ? "ft" : "m";
  const lines = [route.name];
  let l2 = imperial ? `${num(dist / 1609.344, 1)} mi` : `${num(dist / 1000, 1)} km`;
  if (profile) l2 += ` · +${elev(profile.gain)} / -${elev(profile.loss)} ${unit}`;
  lines.push(l2);
  const l3 = [];
  if (profile) l3.push(`High point ${elev(profile.max)} ${unit}`);
  const t = routeTimes(segs);
  if (t) {
    const mins = Math.round((t.end - t.start) / 60000);
    l3.push(new Date(t.start).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }),
            `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`);
  }
  if (l3.length) lines.push(l3.join(" · "));
  return lines.join("\n");
}

function refreshLabelText() {
  if (!route) return;
  if (!labelEdited) {
    labelText = autoLabelText();
    if ($("label-text").value !== labelText) $("label-text").value = labelText;
  }
  $("label-status").textContent = labelEdited ? "Edited." : profile ? "From the GPX and terrain." : "Loading elevation…";
}

$("label-on").addEventListener("change", (e) => { settings.labelOn = e.target.checked; syncControls(); changed(); });
$("label-text").addEventListener("input", (e) => { labelText = e.target.value; labelEdited = true; changed(); });
$("label-fill").addEventListener("click", () => { labelEdited = false; changed(); });

// elevation profile for the label, in its own worker so builds don't cancel it
let profileWorker = null, profileReq = 0, profileTimer = null;
function requestProfile() {
  clearTimeout(profileTimer);
  profile = null;
  profileTimer = setTimeout(() => {
    profileWorker ??= new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const id = ++profileReq;
    profileWorker.onmessage = ({ data }) => {
      if (data.id !== profileReq) return;
      profile = data.type === "profile" ? data.profile : null;
      changed();
    };
    profileWorker.postMessage({ id, job: "profile", segments: segs });
  }, 300);
}

/**
 * Automatic label spot: inside the footprint, clear of the route, as close to bottom-centre as
 * possible. Route coverage is counted on a grid of `cellM` cells with a summed-area table.
 */
function autoLabelSpot(a, wM, hM, inset, cellM, fits) {
  const gw = Math.ceil((a.x1 - a.x0) / cellM), gh = Math.ceil((a.y1 - a.y0) / cellM);
  const sat = new Int32Array((gw + 1) * (gh + 1));
  const mark = (x, y) => {
    const i = Math.floor((x - a.x0) / cellM), j = Math.floor((y - a.y0) / cellM);
    if (i >= 0 && i < gw && j >= 0 && j < gh) sat[(j + 1) * (gw + 1) + i + 1] = 1;
  };
  for (const s of segs) {
    const m = s.map(frame.toM);
    for (let k = 1; k < m.length; k++) {            // walk each leg so long straight legs count too
      const n = Math.ceil(Math.hypot(m[k][0] - m[k - 1][0], m[k][1] - m[k - 1][1]) / (cellM / 2));
      for (let t = 0; t <= n; t++) mark(m[k - 1][0] + ((m[k][0] - m[k - 1][0]) * t) / n, m[k - 1][1] + ((m[k][1] - m[k - 1][1]) * t) / n);
    }
  }
  for (let j = 1; j <= gh; j++)
    for (let i = 1; i <= gw; i++)
      sat[j * (gw + 1) + i] += sat[(j - 1) * (gw + 1) + i] + sat[j * (gw + 1) + i - 1] - sat[(j - 1) * (gw + 1) + i - 1];
  const covered = (x, y) => {                       // route cells under the plate (plus a cell of margin)
    const i0 = Math.max(0, Math.floor((x - wM / 2 - a.x0) / cellM) - 1), i1 = Math.min(gw, Math.ceil((x + wM / 2 - a.x0) / cellM) + 1);
    const j0 = Math.max(0, Math.floor((y - hM / 2 - a.y0) / cellM) - 1), j1 = Math.min(gh, Math.ceil((y + hM / 2 - a.y0) / cellM) + 1);
    return sat[j1 * (gw + 1) + i1] - sat[j0 * (gw + 1) + i1] - sat[j1 * (gw + 1) + i0] + sat[j0 * (gw + 1) + i0];
  };
  const home = { x: (a.x0 + a.x1) / 2, y: a.y0 + hM / 2 + inset };
  let best = null;
  for (let y = a.y0 + hM / 2; y <= a.y1 - hM / 2; y += cellM)
    for (let x = a.x0 + wM / 2; x <= a.x1 - wM / 2; x += cellM) {
      if (!fits(x, y)) continue;
      const score = covered(x, y) * 1e12 + Math.hypot(x - home.x, (y - home.y) * 2);   // prefer low over sideways
      if (!best || score < best.score) best = { x, y, score };
    }
  return best ? { x: best.x, y: best.y } : { x: home.x, y: (a.y0 + a.y1) / 2 };
}

/** Put the label where the user dragged it, or in the automatic spot. */
function placeLabel(p, a, poly, skipMap) {
  const L = labelPlate();
  if (!L) { labelCenter = null; fpMap.setLabel(null); return []; }
  const wM = L.w / p.sc, hM = L.h / p.sc, inset = 3 / p.sc;
  const fits = (x, y, pad) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sx, sy]) =>
    insidePolygon(poly, x + sx * (wM / 2 + pad) - a.x0, y + sy * (hM / 2 + pad) - a.y0));
  const c = labelPos ?? autoLabelSpot(a, wM, hM, inset, 2 / p.sc, (x, y) => fits(x, y, inset));
  labelCenter = c;
  if (!skipMap) fpMap.setLabel({ x: c.x, y: c.y, wM, hM, w: L.w, h: L.h, path: L.path });
  const warn = [];
  if (!fits(c.x, c.y, 0)) warn.push("The label hangs off the print");
  if (routePts.some(([x, y]) => Math.abs(x - c.x) < wM / 2 && Math.abs(y - c.y) < hM / 2)) warn.push("The label covers part of the route");
  return warn;
}

// ------------------------------------------------------------------ print area
const RATIOS = { square: 1, "3:2": 1.5 };
const footprintShape = () => (settings.shape === "hex" ? "hex" : "rect");

// ------------------------------------------------------------------ trimming
const TRIM_GAP = 100;   // metres; shortest route that can be printed
const fmtKm = (m) => `${(m / 1000).toFixed(1)} km`;

function applyTrim() {
  const full = trim.from <= 0 && trim.to >= index.length;
  segs = full ? route.segments : trimSegments(route.segments, trim.from, trim.to);
  routePts = segs.flat().map(frame.toM);
  bounds = { xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity };
  for (const [x, y] of routePts) {
    bounds.xmin = Math.min(bounds.xmin, x); bounds.xmax = Math.max(bounds.xmax, x);
    bounds.ymin = Math.min(bounds.ymin, y); bounds.ymax = Math.max(bounds.ymax, y);
  }
  fpMap.setTrimmed(segs);
  requestProfile();
  $("trim-from").value = trim.from;
  $("trim-to").value = trim.to;
  $("trim-from-v").textContent = fmtKm(trim.from);
  $("trim-to-v").textContent = fmtKm(trim.to);
  $("trim-note").innerHTML = full
    ? "Or drag the green and red dots along the route on the map."
    : `Printing ${fmtKm(trim.to - trim.from)} of ${fmtKm(index.length)}. ` +
      `<button class="link" type="button" id="trim-reset">Use the whole route</button>`;
  $("trim-reset")?.addEventListener("click", () => { trim = { from: 0, to: index.length }; applyTrim(); changed(); });
}

function setTrim(end, metres) {
  if (end === "start") trim.from = Math.max(0, Math.min(metres, trim.to - TRIM_GAP));
  else trim.to = Math.min(index.length, Math.max(metres, trim.from + TRIM_GAP));
  applyTrim();
  changed();
}
$("trim-from").addEventListener("input", (e) => setTrim("start", +e.target.value));
$("trim-to").addEventListener("input", (e) => setTrim("end", +e.target.value));

function autoHexagon() {
  const b = bounds;
  return fitHexagon(routePts, (b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2, settings.marginKm * 1000);
}

/** Locked width/height ratio for the current shape, oriented like the route; null = free. */
function aspect() {
  if (settings.shape === "hex") return autoHexagon().flat ? 2 / Math.sqrt(3) : Math.sqrt(3) / 2;
  const r = RATIOS[settings.shape], b = bounds;
  return r ? (b.xmax - b.xmin >= b.ymax - b.ymin ? r : 1 / r) : null;
}

function currentArea() {
  if (override) return override;
  if (settings.shape === "hex") {
    const { x0, x1, y0, y1 } = autoHexagon();
    return { x0, x1, y0, y1 };
  }
  const b = bounds, m = settings.marginKm * 1000;
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
  onLabelMove(x, y, final) {
    labelPos = { x, y };
    changed({ fromMap: true, labelDrag: !final });
  },
  onTrim(end, lat, lon) {
    setTrim(end, index.nearest(...frame.toM([lat, lon])).distance);
    return end === "start" ? segs[0][0] : segs.at(-1).at(-1);
  },
});

function updateArea(p, fromMap, labelDrag) {
  const a = currentArea();
  const cornerM = settings.cornerRadius / p.sc;
  if (!fromMap) fpMap.setFootprint(a, cornerM, aspect(), footprintShape());
  const km = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0);
  const poly = roundedOutline(outline(footprintShape(), a.x1 - a.x0, a.y1 - a.y0), cornerM);
  const warn = placeLabel(p, a, poly, labelDrag);
  if (routePts.some(([x, y]) => !insidePolygon(poly, x - a.x0, y - a.y0))) warn.unshift("Part of the route is outside the print area");
  $("map-info").innerHTML = `${km(a.x1 - a.x0)} × ${km(a.y1 - a.y0)} km → <b>${p.width.toFixed(0)} × ${p.depth.toFixed(0)} mm</b>` +
    warn.map((w) => `<br><span class="warn">${w}</span>`).join("");
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
  if (t === "3d") requestRender();
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
  index = routeIndex(route.segments, frame.toM);
  trim = { from: 0, to: index.length };
  labelEdited = false;
  labelPos = null;
  for (const id of ["trim-from", "trim-to"]) Object.assign($(id), { max: index.length });
  override = null;
  if (settings.shape === "custom") settings.shape = "fit";
  syncControls();
  clearModel();
  $("viewer").classList.add("has-route");
  $("tabs").hidden = false;
  showTab("map");
  fpMap.setRoute(route.segments, frame);
  applyTrim();
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
const key = () => route && JSON.stringify([route.fileName, route.segments.length, trim, engineOpts()]);

function changed({ fromMap = false, labelDrag = false } = {}) {
  save();
  refreshLabelText();
  const est = $("estimate"), btn = $("generate");
  if (!route) { est.textContent = ""; btn.disabled = true; return; }
  const p = planGrid(segs, engineOpts());
  updateArea(p, fromMap, labelDrag);
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
  worker.postMessage({ id, segments: segs, opts: engineOpts() });
}
$("generate").addEventListener("click", generate);

function setProgress(stage, frac) {
  const [label, a, b] = STAGES[stage] ?? ["Working…", 0, 1];
  $("progress-bar").style.width = `${(a + (b - a) * frac) * 100}%`;
  $("progress-label").textContent = stage === "tiles" ? `${label} ${Math.round(frac * 100)}%` : label;
}

// ------------------------------------------------------------------ 3D viewer
const canvas = $("canvas");
// without WebGL the app still builds and downloads models; only the preview is missing
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
} catch (err) {
  console.warn("3D preview unavailable:", err.message);
  $("no-gl").hidden = false;
}
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
function applyTheme() { scene.background = new THREE.Color(css("--viewer")); if (model) showModel(model, false); requestRender(); }
dark.addEventListener("change", applyTheme);

new ResizeObserver(() => {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement;
  if (!w || !h) return;
  renderer?.setSize(w, h, false);
  requestRender();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}).observe(canvas.parentElement);
// render on demand only: a big model redrawn every frame drains batteries (and stalls software GL)
let renderQueued = false;
function requestRender() {
  if (renderQueued || !renderer) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if ($("viewer").dataset.tab !== "3d") return;
    if (controls.update()) requestRender();   // still easing (damping)
    renderer.render(scene, camera);
  });
}
controls.addEventListener("change", requestRender);

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
                   new THREE.Color(css("--start")), new THREE.Color(css("--finish")),
                   new THREE.Color(css("--plate")), new THREE.Color(css("--lettering"))];   // see core/model.js
  const col = new Float32Array(m.trail.length * 3);
  for (let i = 0; i < m.trail.length; i++) palette[m.trail[i]].toArray(col, i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }));
  mesh.position.set(-m.stats.width / 2, -m.stats.depth / 2, 0);   // don't move the vertices: they're also the STL
  scene.add(mesh);
  requestRender();
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
