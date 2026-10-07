import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { parseGpx, routeLength, trimSegments, routeIndex } from "./core/gpx.js";
import { DEFAULTS, planGrid, routeFrame } from "./core/model.js";
import { writeStl } from "./core/stl.js";
import { FootprintMap } from "./mapview.js";
import { layFlat } from "./core/inlay.js";
import { makeZip } from "./core/zip.js";
import { make3mf } from "./core/threemf.js";
import { outline, roundedOutline, insidePolygon, fitHexagon } from "./core/footprint.js";
import { MARKER_SHAPES, markerPolygon } from "./core/markers.js";
import { layoutText, contoursToSvgPath } from "./core/text.js";
import { routeTimes } from "./core/profile.js";

const $ = (id) => document.getElementById(id);
const STORE = "gpx2stl-settings-v1";

// ------------------------------------------------------------------ settings
const MIN_LETTER = 2.5;   // mm capital height; Atkinson Bold stems are 0.23x that (0.57 mm), > a 0.4 mm nozzle line
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
  "inlay-controls": [
    { key: "inlayClearance", label: "Clearance", unit: "mm", min: 0.05, max: 0.5, step: 0.05, help: "Gap on each side between inlay and slot" },
    { key: "inlayDepth", label: "Slot depth", unit: "mm", min: 2, max: 6, step: 0.5, help: "How far the inlay sinks below the terrain, at least" },
    { key: "inlayMaxHeight", label: "Tallest piece", unit: "mm", min: 6, max: 30, step: 1, help: "Allowing taller pieces means fewer of them" },
  ],
  "label-controls": [
    { key: "labelTitleSize", label: "Title size", unit: "mm", min: MIN_LETTER, hardMin: MIN_LETTER, max: 15, step: 0.5, help: "First line (the route name), capital height" },
    { key: "labelSize", label: "Text size", unit: "mm", min: MIN_LETTER, hardMin: MIN_LETTER, max: 12, step: 0.5, help: "The other lines. Below 2.5 mm, strokes get too thin for a 0.4 mm nozzle" },
    { key: "labelRelief", label: "Lettering depth", unit: "mm", min: 0.4, max: 2, step: 0.1, help: "How far letters stand up, or are cut in" },
    { key: "labelAngle", label: "Rotation", unit: "°", min: -180, max: 180, step: 1, help: "Or drag the rotate handle above the label on the map" },
  ],
  "flat-controls": [
    { key: "flatPlate", label: "Plate thickness", unit: "mm", min: 1.2, max: 6, step: 0.2 },
    { key: "flatLine", label: "Line height", unit: "mm", min: 0.2, max: 1.6, step: 0.2, help: "How far contour lines stand up, or are cut in" },
    { key: "flatStep", label: "Step height", unit: "mm", min: 0.2, max: 1.6, step: 0.2, help: "Height of each terrace" },
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
  labelOn: false, labelStyle: "raised", labelSize: 4, labelTitleSize: 6, labelAlign: "center", labelRelief: 0.8, labelAngle: 0,
  inlayClearance: 0.15, inlayDepth: 3, inlayMaxHeight: 10,
  printStyle: "relief", contourStyle: "raised", contourInterval: "auto", flatPlate: 2.4, flatLine: 0.6, flatStep: 0.4,
  labelUnits: /^en-(US|LR|MM)$/i.test(navigator.language) ? "imperial" : "metric",
};

let settings = { ...UI_DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE)) ?? {}); } catch {}
for (const k of ["labelSize", "labelTitleSize"]) settings[k] = Math.max(MIN_LETTER, settings[k]);   // older saves allowed 2 mm
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch {} };

const isFlat = () => settings.printStyle !== "relief";
const engineOpts = () => ({
  size: settings.size, zExag: settings.zExag, marginKm: settings.marginKm, cell: settings.cell,
  // flat styles always raise the route; the groove and inlay styles are for the relief
  trailHeight: settings.trailStyle === "groove" && !isFlat() ? -settings.trailDepth : settings.trailDepth,
  inlay: settings.trailStyle === "inlay" && !isFlat()
    ? { clearance: settings.inlayClearance, depth: settings.inlayDepth, maxHeight: settings.inlayMaxHeight } : null,
  printStyle: settings.printStyle,
  contours: isFlat() ? {
    unit: settings.labelUnits === "imperial" ? "ft" : "m",
    interval: settings.contourInterval === "auto" ? null : +settings.contourInterval * (settings.labelUnits === "imperial" ? 0.3048 : 1),
    plate: settings.flatPlate, lineHeight: settings.flatLine, stepHeight: settings.flatStep,
    engraved: settings.contourStyle === "engraved",
  } : null,
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
      if (from !== num || +num.value !== v) num.value = v;   // also show a clamped typed value
      if (from !== range) range.value = v;
      settings[d.key] = v;
      if (d.resetsArea) override = null;
      changed();
    };
    range.addEventListener("input", () => set(range.value, range));
    num.addEventListener("change", () => set(Math.min(d.max * 4, Math.max(d.hardMin ?? Math.min(0, d.min), num.value)), num));
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
                  bindSeg("label-units", "labelUnits"), bindSeg("label-style", "labelStyle"), bindSeg("label-align", "labelAlign"),
                  bindSeg("print-style", "printStyle"), bindSeg("contour-style", "contourStyle"), () => syncFlat(),
                  () => { $("label-on").checked = settings.labelOn; $("label-body").hidden = !settings.labelOn; }];

function syncControls() {
  for (const [k, set] of Object.entries(inputs)) set(settings[k]);
  segSyncs.forEach((s) => s());
}

const depthLabel = document.querySelector('label[for="r-trailDepth"]');
$("trail-style").addEventListener("click", () => syncTrailLabel());
const syncTrailLabel = () => {
  depthLabel.textContent = isFlat() ? "Height" : { groove: "Depth", inlay: "Stands proud by" }[settings.trailStyle] ?? "Height";
  $("inlay-body").hidden = settings.trailStyle !== "inlay" || isFlat();
};

// flat print styles: show their settings, hide the relief-only ones
const INTERVALS = { metric: [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000], imperial: [10, 20, 25, 40, 50, 100, 200, 250, 500, 1000, 2000] };
const fieldOf = (id) => $(id).closest(".field");
function syncFlat() {
  const flat = isFlat(), terraced = settings.printStyle === "terraced";
  $("flat-body").hidden = !flat;
  fieldOf("r-zExag").hidden = flat;
  $("trail-style-field").hidden = flat;
  $("contour-style-field").hidden = terraced;
  fieldOf("r-flatLine").hidden = terraced;
  fieldOf("r-flatStep").hidden = !terraced;
  const unit = settings.labelUnits === "imperial" ? "ft" : "m", list = INTERVALS[settings.labelUnits] ?? INTERVALS.metric;
  if (settings.contourInterval !== "auto" && !list.includes(+settings.contourInterval)) settings.contourInterval = "auto";
  const html = `<option value="auto">Auto</option>` + list.map((v) => `<option value="${v}">${v.toLocaleString("en-US")} ${unit}</option>`).join("");
  if ($("contour-interval").innerHTML !== html) $("contour-interval").innerHTML = html;
  $("contour-interval").value = settings.contourInterval;
  syncTrailLabel();
}
$("contour-interval").addEventListener("change", (e) => { settings.contourInterval = e.target.value; changed(); });
for (const id of ["print-style", "label-units"]) $(id).addEventListener("click", () => syncFlat());

// test-fit coupon: a short slot and its inlay with the current width and clearance
$("coupon").addEventListener("click", () => {
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  w.onmessage = ({ data }) => {
    w.terminate();
    if (data.type !== "coupon") return showError(data.message);
    const { block, piece } = data.coupon;
    saveBlob(makeZip([
      { name: "test-fit-slot.stl", data: writeStl(block.positions, block.indices, "test-fit slot") },
      { name: "test-fit-inlay.stl", data: writeStl(piece.positions, piece.indices, "test-fit inlay") },
    ]), `test-fit_${settings.trailWidth}mm_clearance-${settings.inlayClearance}mm.zip`);
  };
  w.postMessage({ id: 1, job: "coupon", opts: { width: settings.trailWidth, clearance: settings.inlayClearance,
                                                 depth: settings.inlayDepth, proud: settings.trailDepth } });
});

$("reset").addEventListener("click", () => { settings = { ...UI_DEFAULTS }; override = null; syncControls(); syncTrailLabel(); changed(); });

// ------------------------------------------------------------------ route loading
let route = null;      // { name, segments, fileName }
let frame = null;      // local metre frame of the route (core/model.js routeFrame)
let index = null;      // snapping lookup over the whole route (core/gpx.js routeIndex)
let trim = null;       // printed part of the route: { from, to } metres along it
let segs = [];         // the trimmed route segments; everything downstream uses these
let routePts = [];     // trimmed route points in the frame, metres
let bounds = null;     // their bounding box
// derived once per trim: length, times, points per segment (metres), and a thinned point list
// (<= 800, ~print-resolution) for the per-frame "is the route inside / under the label" checks
let trimmed = { length: 0, times: null, metres: [], check: [] };
let hexCache = {};
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

let printSize = null;          // { w, d } of the print in mm, from the latest plan

/**
 * Text laid out for the plate: { contours, w, h (plate mm), path (SVG), shrink } or null.
 * If the plate would be too big for the print (wider than 90% or taller than 60% of it), the text
 * is scaled down to fit and `shrink` says by how much.
 */
function labelPlate() {
  if (!settings.labelOn || !font) return null;
  const { labelSize: body, labelTitleSize: title, labelAlign: align } = settings;
  const lay = (f) => {
    const k = `${body}|${title}|${align}|${f}|${labelText}`;
    if (labelCache[f === 1 ? "full" : "fit"]?.k === k) return labelCache[f === 1 ? "full" : "fit"].v;
    const t = layoutText(font, labelText, body * f, { titleHeight: title * f, align });
    const pad = Math.max(2, Math.max(body, title) * f * 0.5);
    const v = t && { contours: t.contours, w: t.width + 2 * pad, h: t.height + 2 * pad, path: contoursToSvgPath(t.contours), shrink: f };
    labelCache[f === 1 ? "full" : "fit"] = { k, v };
    return v;
  };
  const full = lay(1);
  // shrink to fit the print, in 1% steps so dragging the size slider doesn't relayout every time
  const shrink = full && printSize ? Math.floor(Math.min(1, (0.9 * printSize.w) / full.w, (0.6 * printSize.d) / full.h) * 100) / 100 : 1;
  const v = shrink < 1 ? lay(shrink) : full, note = $("label-fit");
  note.hidden = !v || v.shrink >= 0.999;
  if (v && v.shrink < 0.999) {
    const smallest = Math.min(body, title) * v.shrink;
    note.textContent = `Text shrunk to ${Math.round(v.shrink * 100)}% to fit the print` +
      (smallest < MIN_LETTER ? ` (${smallest.toFixed(1)} mm letters may be too fine to print; try fewer or shorter lines).` : ".");
  }
  return v;
}

function labelEngineOpts() {
  const L = labelPlate();
  if (!L || !labelCenter || !frame) return null;
  const [lat, lon] = frame.toLL(labelCenter.x, labelCenter.y);
  return { center: { lat, lon }, contours: L.contours, width: L.w, height: L.h,
           style: settings.labelStyle, relief: settings.labelRelief, angle: settings.labelAngle };
}

const NUM = [0, 1].map((d) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const num = (v, digits = 0) => NUM[digits].format(v);

/** Name, distance, climbing, high point, date and duration, in the chosen units. */
function autoLabelText() {
  const imperial = settings.labelUnits === "imperial", dist = trimmed.length;
  const elev = (m) => num(Math.round(imperial ? m * 3.28084 : m)), unit = imperial ? "ft" : "m";
  const lines = [route.name];
  let l2 = imperial ? `${num(dist / 1609.344, 1)} mi` : `${num(dist / 1000, 1)} km`;
  if (profile) l2 += ` · +${elev(profile.gain)} / -${elev(profile.loss)} ${unit}`;
  lines.push(l2);
  const l3 = [];
  if (profile) l3.push(`High point ${elev(profile.max)} ${unit}`);
  const t = trimmed.times;
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
  if (gw * gh > 4e6) return { x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2 };
  const sat = new Int32Array((gw + 1) * (gh + 1));
  const mark = (x, y) => {
    const i = Math.floor((x - a.x0) / cellM), j = Math.floor((y - a.y0) / cellM);
    if (i >= 0 && i < gw && j >= 0 && j < gh) sat[(j + 1) * (gw + 1) + i + 1] = 1;
  };
  for (const m of trimmed.metres) {
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
  const cand = [];
  for (let y = a.y0 + hM / 2; y <= a.y1 - hM / 2; y += cellM)
    for (let x = a.x0 + wM / 2; x <= a.x1 - wM / 2; x += cellM) cand.push([Math.hypot(x - home.x, (y - home.y) * 2), x, y]);   // prefer low over sideways
  cand.sort((p, q) => p[0] - q[0]);
  for (const [, x, y] of cand) if (!covered(x, y) && fits(x, y)) return { x, y };   // nearest clear spot
  let best = null;                                  // nowhere clear: cover as little route as possible
  for (const [d, x, y] of cand) {
    const score = covered(x, y) * 1e12 + d;
    if ((!best || score < best.score) && fits(x, y)) best = { x, y, score };
  }
  return best ? { x: best.x, y: best.y } : { x: home.x, y: (a.y0 + a.y1) / 2 };
}

/** Put the label where the user dragged it, or in the automatic spot. */
function placeLabel(p, a, poly, skipMap) {
  const L = labelPlate();
  if (!L) { labelCenter = null; fpMap.setLabel(null); return []; }
  const wM = L.w / p.sc, hM = L.h / p.sc, inset = 3 / p.sc;
  const ang = (settings.labelAngle * Math.PI) / 180, ca = Math.cos(ang), sa = Math.sin(ang);
  const bwM = Math.abs(wM * ca) + Math.abs(hM * sa), bhM = Math.abs(wM * sa) + Math.abs(hM * ca);   // rotated bounds
  const fits = (x, y, pad) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sx, sy]) => {
    const u = sx * (wM / 2 + pad), v = sy * (hM / 2 + pad);
    return insidePolygon(poly, x + u * ca - v * sa - a.x0, y + u * sa + v * ca - a.y0);
  });
  const c = labelPos ?? autoLabelSpot(a, bwM, bhM, inset, 2 / p.sc, (x, y) => fits(x, y, inset));
  labelCenter = c;
  if (!skipMap) fpMap.setLabel({ x: c.x, y: c.y, wM, hM, w: L.w, h: L.h, path: L.path, angle: settings.labelAngle });
  const warn = [];
  if (!fits(c.x, c.y, 0)) warn.push("The label hangs off the print");
  const under = ([x, y]) => Math.abs((x - c.x) * ca + (y - c.y) * sa) < wM / 2 && Math.abs(-(x - c.x) * sa + (y - c.y) * ca) < hM / 2;
  if (trimmed.check.some(under)) warn.push("The label covers part of the route");
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
  segs = full ? route.segments : trimSegments(route.segments, trim.from, trim.to, index.cums);
  routePts = segs.flat().map(frame.toM);
  const stride = Math.max(1, Math.floor(routePts.length / 800));
  trimmed = {
    length: full ? index.length : trim.to - trim.from, metres: segs.map((s) => s.map(frame.toM)),
    check: routePts.filter((_, i) => i % stride === 0 || i === routePts.length - 1),
  };
  trimmed.times = routeTimes(segs, trimmed.length);
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
  if (hexCache.pts !== routePts || hexCache.margin !== settings.marginKm) {
    const b = bounds;
    hexCache = { pts: routePts, margin: settings.marginKm,
                 v: fitHexagon(routePts, (b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2, settings.marginKm * 1000) };
  }
  return hexCache.v;
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

/** Area for the engine; undefined keeps its own route + margin box (identical to the reference model). */
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
  onLabelRotate(angle, final) {
    settings.labelAngle = angle;
    inputs.labelAngle(angle);
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
  if (trimmed.check.some(([x, y]) => !insidePolygon(poly, x - a.x0, y - a.y0))) warn.unshift("Part of the route is outside the print area");
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
document.body.addEventListener("dragover", (e) => { e.preventDefault(); $("drop").classList.add("over"); });
document.body.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("drop").classList.remove("over"); });
document.body.addEventListener("drop", async (e) => {
  e.preventDefault();
  $("drop").classList.remove("over");
  const f = e.dataTransfer.files[0];
  if (f) loadText(await f.text(), f.name);
});

// ------------------------------------------------------------------ estimate + state
const fmtMB = (bytes) => (bytes / 1e6 < 10 ? (bytes / 1e6).toFixed(1) : Math.round(bytes / 1e6)) + " MB";
const key = () => route && JSON.stringify([route.fileName, route.segments.length, trim, engineOpts()]);

function changed({ fromMap = false, labelDrag = false } = {}) {
  save();
  refreshLabelText();
  const est = $("estimate"), btn = $("generate");
  if (!route) { est.textContent = ""; btn.disabled = true; return; }
  const p = planGrid(segs, engineOpts());
  printSize = { w: p.width, d: p.depth };
  updateArea(p, fromMap, labelDrag);
  const bytes = 84 + 50 * p.triangles;
  const tooMany = p.tiles.count > 400;
  est.classList.toggle("warn", tooMany || p.triangles > 4e6);
  est.textContent = tooMany
    ? `Too much elevation data for this area (${p.tiles.count} tiles). Pick a coarser detail level or a smaller area.`
    : `≈ ${p.width.toFixed(0)} × ${p.depth.toFixed(0)} mm · 1:${Math.round(1000 / p.sc).toLocaleString()} · ` +
      `${(p.triangles / 1e6).toFixed(p.triangles < 1e6 ? 2 : 1)}M triangles · ${fmtMB(bytes)}` +
      (p.triangles > 4e6 ? " (large: try a coarser detail level)" : "");
  if (isFlat() && !tooMany)
    est.textContent = `≈ ${p.width.toFixed(0)} × ${p.depth.toFixed(0)} mm · 1:${Math.round(1000 / p.sc).toLocaleString()} · ` +
      `flat ${settings.printStyle === "terraced" ? "terraces" : "contours"} on a ${settings.flatPlate} mm plate`;
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
// share of the progress bar per stage, from measured build times (the geometry step dominates;
// tiles can take a while on a first, uncached build)
const STAGES = {
  engine: ["Loading geometry engine…", 0, 0.03],
  tiles: ["Downloading elevation data…", 0.03, 0.3],
  terrain: ["Shaping terrain…", 0.3, 0.35],
  route: ["Tracing your route…", 0.35, 0.38],
  mesh: ["Building mesh…", 0.38, 0.4],
  solid: ["Making it printable…", 0.4, 1],
};
let worker = null, busy = false, reqId = 0;

function generate() {
  if (!route) return;
  if (busy) { worker.terminate(); worker = null; }
  worker ??= new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const id = ++reqId, k = key(), variant = fileVariant();
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
    model.variant = variant;
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
let meshes = [];          // terrain first, then any inlay pieces
let exploded = false;

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

function disposeMeshes() {
  for (const ms of meshes) { scene.remove(ms); ms.geometry.dispose(); ms.material.dispose(); }
  meshes = [];
}

function placeMeshes() {
  if (!model) return;
  const lift = exploded && !model.flat ? model.stats.height * 0.6 + 6 : 0;
  meshes.forEach((ms, k) => ms.position.set(-model.stats.width / 2, -model.stats.depth / 2, k ? lift : 0));
  requestRender();
}

function showModel(m, reframe = true) {
  disposeMeshes();
  const palette = [new THREE.Color(dark.matches ? 0xb9b3a4 : 0xd8d2c2), new THREE.Color(css("--accent")),
                   new THREE.Color(css("--start")), new THREE.Color(css("--finish")),
                   new THREE.Color(css("--plate")), new THREE.Color(css("--lettering")),
                   new THREE.Color(css("--contour"))];   // see core/model.js; 6 = contour lines
  const ROLE = { terrain: 0, route: 1, start: 2, finish: 3, lettering: 5, contours: 6 };
  // flat prints come as separate parts, one colour each; the relief carries per-vertex colours
  const shown = m.flat ? m.parts3mf.map((q) => ({ ...q, trail: new Uint8Array(q.positions.length / 3).fill(ROLE[q.role] ?? 0) }))
                       : [m, ...m.inlays];
  for (const part of shown) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
    g.setIndex(new THREE.BufferAttribute(part.indices, 1));
    const col = new Float32Array(part.trail.length * 3);
    for (let i = 0; i < part.trail.length; i++) palette[part.trail[i]].toArray(col, i * 3);
    if (m.flat && part.role === "terrain" && m.stats.flat.style === "terraced") {
      // preview only: shade the steps from low to high so the levels read on screen
      const low = palette[0].clone().multiplyScalar(0.72), high = palette[0].clone().lerp(new THREE.Color(1, 1, 1), 0.35);
      const z0 = m.stats.base, z1 = Math.max(z0 + 0.1, m.stats.height - 1), tint = new THREE.Color();
      for (let i = 0; i < part.trail.length; i++)
        tint.lerpColors(low, high, Math.min(1, Math.max(0, (part.positions[i * 3 + 2] - z0) / (z1 - z0)))).toArray(col, i * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    // the mesh is moved, never the vertices: they're also what gets exported
    const ms = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }));
    scene.add(ms);
    meshes.push(ms);
  }
  $("explode").hidden = !m.inlays.length;
  exploded &&= m.inlays.length > 0;
  placeMeshes();
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
  if (s.flat) {
    stats.splice(2, 0, [s.flat.style === "terraced" ? "Terraces" : "Contours", `every ${s.flat.interval} (${s.flat.levels} levels)`]);
    if (s.flat.swaps.length) stats.push(["Change filament at", s.flat.swaps.map((z) => `${z.toFixed(1)} mm`).join(", ")]);
  }
  if (s.inlay) stats.splice(3, 0, ["Inlay", `${s.inlay.pieces} piece${s.inlay.pieces === 1 ? "" : "s"}, up to ${s.inlay.tallest.toFixed(1)} mm`],
                                  ["Base", `${s.base.toFixed(1)} mm`]);
  $("stats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  $("download-size").textContent = `(${fmtMB(84 * (1 + m.inlays.length) + 50 * s.triangles)})`;
  $("download-label").textContent = m.inlays.length ? "Download parts (.zip)" : "Download STL";
  $("download-3mf").hidden = !m.parts3mf;
  $("result").hidden = false;
}

$("explode").addEventListener("click", () => {
  exploded = !exploded;
  $("explode").setAttribute("aria-pressed", exploded);
  placeMeshes();
});

function clearModel() {
  disposeMeshes();
  model = null;
  builtFor = null;
  $("viewer").classList.remove("has-model");
  $("result").hidden = true;
  $("tabs").querySelector('[data-tab="3d"]').disabled = true;
}

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
// e.g. "relief_hex", "contours-engraved_square": taken when the build starts, so the name
// matches the model on screen even if settings have changed since
const SHAPE_NAMES = { fit: "rect", square: "square", "3:2": "3x2", hex: "hex", custom: "custom" };
const fileVariant = () => [isFlat() && settings.printStyle === "contours" && settings.contourStyle === "engraved" ? "contours-engraved" : settings.printStyle,
                           SHAPE_NAMES[settings.shape] ?? settings.shape].join("_");
const fileBase = () => [route.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "route", model?.variant].filter(Boolean).join("_");

$("download").addEventListener("click", () => {
  if (!model) return;
  if (!model.inlays.length) {
    return saveBlob(new Blob([writeStl(model.positions, model.indices, route.name)], { type: "model/stl" }), `${fileBase()}.stl`);
  }
  // terrain as it sits, inlay pieces turned to lie on their sloped bottoms, numbered along the route
  const n = model.inlays.length;
  saveBlob(makeZip([
    { name: "terrain.stl", data: writeStl(model.positions, model.indices, `${route.name} terrain`) },
    ...model.inlays.map((q, k) => ({
      name: `inlay-${k + 1}-of-${n}.stl`, data: writeStl(layFlat(q.positions, q.plane), q.indices, `${route.name} inlay ${k + 1}`),
    })),
    { name: "README.txt", data: [
      `${route.name}: terrain plus ${n} route inlay piece${n === 1 ? "" : "s"}.`, "",
      "Print terrain.stl in one colour and the inlay pieces in another. The inlays are already",
      "turned to lie on their flat (sloped) bottoms, so they need no supports.", "",
      `Pieces are numbered from the start of the route (inlay-1) to the finish (inlay-${n}).`,
      "Press each into its slot; a drop of glue holds them if the fit is loose.", "",
      `Clearance ${settings.inlayClearance} mm per side, inlay width ${settings.trailWidth} mm, slot depth ${settings.inlayDepth} mm.`,
    ].join("\r\n") },
  ]), `${fileBase()}_parts.zip`);
});

$("download-3mf").addEventListener("click", () => {
  if (!model) return;
  // one object, one part per colour: terrain, route pieces, start/finish markers, label lettering
  const COLORS = { terrain: "#D8D2C2", route: "#E8590C", start: "#2F9E44", finish: "#C92A2A", lettering: "#2B2F28", contours: "#6B4F2A" };
  saveBlob(make3mf(model.parts3mf.map((q) => ({ ...q, color: COLORS[q.role] })), route.name), `${fileBase()}.3mf`);
});

syncControls();
syncFlat();
applyTheme();
changed();
