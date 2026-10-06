// Map tab: the route on a topo map plus the print footprint, which can be moved and resized.
// Areas are { x0, x1, y0, y1 } in the route's local metre frame (see core/model.js routeFrame).
import * as L from "leaflet";
import { outline, roundedOutline } from "./core/footprint.js";

const MIN_SIDE = 200;   // metres
const ll = (p) => [p[0], p[1]];   // route points also carry time/elevation, which Leaflet rejects
const lls = (s) => s.map(ll);
const OPPOSITE = { sw: "ne", se: "nw", ne: "sw", nw: "se" };

/** Where each resize handle sits, as fractions of the area's box: on the shape's own corners. */
function handleFractions(shape, w, h) {
  if (shape === "hex")
    return w >= h ? { sw: [0.25, 0], se: [0.75, 0], ne: [0.75, 1], nw: [0.25, 1] }      // flat top
                  : { sw: [0, 0.25], se: [1, 0.25], ne: [1, 0.75], nw: [0, 0.75] };     // pointy top
  return { sw: [0, 0], se: [1, 0], ne: [1, 1], nw: [0, 1] };
}

export class FootprintMap {
  /**
   * onChange(area, final) — the print area was moved/resized on the map.
   * onTrim(end, lat, lon, final) — a start/finish dot was dragged; end is "start" or "end".
   *   Returns the [lat, lon] the dot should snap to.
   * onLabelMove(x, y, final) — the label was dragged to centre (x, y), frame metres.
   */
  constructor(el, { onChange, onTrim, onLabelMove }) {
    this.onChange = onChange;
    this.onTrim = onTrim;
    this.onLabelMove = onLabelMove;
    this.map = L.map(el, { zoomSnap: 0.25, zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: 'Map: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
                   'SRTM | style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }).addTo(this.map);
    this.map.attributionControl.setPrefix(false);
    this.map.setView([39, -98], 4);
    this.routeLayer = L.layerGroup().addTo(this.map);   // whole route, faint
    this.trimLayer = L.layerGroup().addTo(this.map);    // the part that gets printed
    this.box = L.polygon([], { className: "fp-box", weight: 2, fillOpacity: 0.08 }).addTo(this.map);
    this.handles = {};
    for (const k of ["sw", "se", "ne", "nw", "c"]) {
      const h = L.marker([0, 0], {
        draggable: true, keyboard: false, opacity: 0,
        icon: L.divIcon({ className: `fp-handle fp-${k}`, iconSize: k === "c" ? [30, 30] : [16, 16] }),
      }).addTo(this.map);
      h.on("drag", () => this.#drag(k, h.getLatLng(), false));
      h.on("dragend", () => this.#drag(k, h.getLatLng(), true));
      this.handles[k] = h;
    }
    this.dots = {};
    for (const k of ["start", "end"]) {
      const d = L.marker([0, 0], {
        draggable: true, keyboard: false, opacity: 0, zIndexOffset: 1000,
        title: k === "start" ? "Start: drag along the route to trim" : "Finish: drag along the route to trim",
        icon: L.divIcon({ className: `fp-dot fp-dot-${k}`, iconSize: [16, 16] }),
      }).addTo(this.map);
      const snap = (final) => {
        const { lat, lng } = d.getLatLng();
        d.setLatLng(ll(this.onTrim(k, lat, lng, final)));
      };
      d.on("dragstart", () => (this.draggingDot = k));
      d.on("drag", () => snap(false));
      d.on("dragend", () => { this.draggingDot = null; snap(true); });
      this.dots[k] = d;
    }
    this.#bodyDrag();

    // label: an SVG preview (plate + lettering) dragged by its body or a handle (touch)
    this.labelSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.labelSvg.setAttribute("preserveAspectRatio", "none");
    this.labelOverlay = L.svgOverlay(this.labelSvg, [[0, 0], [0, 0]], { interactive: true, className: "fp-label-svg" });
    this.labelHandle = L.marker([0, 0], {
      draggable: true, keyboard: false, zIndexOffset: 900, title: "Drag to move the label",
      icon: L.divIcon({ className: "fp-label-handle", iconSize: [22, 22] }),
    });
    this.labelHandle.on("drag", () => {
      const { lat, lng } = this.labelHandle.getLatLng(), [x, y] = this.frame.toM([lat, lng]);
      this.#moveLabel(x + this.label.wM / 2, y - this.label.hM / 2, false);
    });
    this.labelHandle.on("dragend", () => this.#moveLabel(this.label.x, this.label.y, true));
    let grab = null;
    this.labelOverlay.on("mousedown", (e) => {
      if (e.originalEvent.button !== 0) return;
      L.DomEvent.stop(e);
      this.map.dragging.disable();
      const [x, y] = this.frame.toM([e.latlng.lat, e.latlng.lng]);
      grab = { dx: this.label.x - x, dy: this.label.y - y };
    });
    this.map.on("mousemove", (e) => {
      if (!grab) return;
      const [x, y] = this.frame.toM([e.latlng.lat, e.latlng.lng]);
      this.#moveLabel(x + grab.dx, y + grab.dy, false);
    });
    const drop = () => {
      if (!grab) return;
      grab = null;
      this.map.dragging.enable();
      this.#moveLabel(this.label.x, this.label.y, true);
    };
    this.map.on("mouseup", drop);
    document.addEventListener("mouseup", drop);
  }

  /** label: { x, y, wM, hM (frame metres), w, h (mm), path (SVG path, mm) } or null to hide. */
  setLabel(label) {
    this.label = label;
    if (!label) {
      this.labelOverlay.remove();
      this.labelHandle.remove();
      return;
    }
    const { w, h, path } = label;
    this.labelSvg.setAttribute("viewBox", `${-w / 2} ${-h / 2} ${w} ${h}`);
    this.labelSvg.innerHTML = `<rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${Math.min(1.5, w / 4, h / 4)}"/><path d="${path}"/>`;
    this.#placeLabel();
    this.labelOverlay.addTo(this.map);
    this.labelHandle.addTo(this.map);
  }

  #placeLabel() {
    const { x, y, wM, hM } = this.label, f = this.frame;
    this.labelOverlay.setBounds([f.toLL(x - wM / 2, y - hM / 2), f.toLL(x + wM / 2, y + hM / 2)]);
    this.labelHandle.setLatLng(f.toLL(x - wM / 2, y + hM / 2));   // top-left corner
  }

  #moveLabel(x, y, final) {
    Object.assign(this.label, { x, y });
    this.#placeLabel();
    this.onLabelMove(x, y, final);
  }

  setRoute(segments, frame) {
    this.frame = frame;
    this.routeLayer.clearLayers();
    for (const s of segments) L.polyline(lls(s), { className: "fp-route-full", weight: 3, interactive: false }).addTo(this.routeLayer);
    this.setTrimmed(segments);
    for (const h of [...Object.values(this.handles), ...Object.values(this.dots)]) h.setOpacity(1);
  }

  /** Highlight the printed part of the route and put the start/finish dots on its ends. */
  setTrimmed(segments) {
    this.trimLayer.clearLayers();
    for (const s of segments) L.polyline(lls(s), { className: "fp-casing", weight: 6, interactive: false }).addTo(this.trimLayer);
    for (const s of segments) L.polyline(lls(s), { className: "fp-route", weight: 3, interactive: false }).addTo(this.trimLayer);
    // the dot being dragged is placed by its own snap
    if (this.draggingDot !== "start") this.dots.start.setLatLng(ll(segments[0][0]));
    if (this.draggingDot !== "end") this.dots.end.setLatLng(ll(segments.at(-1).at(-1)));
  }

  /**
   * area: local metres; cornerM: corner radius in metres; aspect: locked w/h ratio or null;
   * shape: "rect" or "hex" (see core/footprint.js outline).
   */
  setFootprint(area, cornerM, aspect, shape = "rect", fit = false) {
    this.area = { ...area };
    this.cornerM = cornerM;
    this.aspect = aspect;
    this.shape = shape;
    this.#draw();
    if (fit) this.fit();
  }

  fit() {
    if (!this.area) return;
    const { x0, x1, y0, y1 } = this.area, f = this.frame;
    this.map.fitBounds([f.toLL(x0, y0), f.toLL(x1, y1)], { padding: [30, 30] });
  }

  invalidate() { this.map.invalidateSize(); }

  #draw() {
    const { x0, x1, y0, y1 } = this.area, f = this.frame;
    const poly = roundedOutline(outline(this.shape, x1 - x0, y1 - y0), this.cornerM);
    this.box.setLatLngs(poly.map(([x, y]) => f.toLL(x0 + x, y0 + y)));
    const fr = handleFractions(this.shape, x1 - x0, y1 - y0);
    for (const [k, [u, v]] of Object.entries(fr)) this.handles[k].setLatLng(f.toLL(x0 + u * (x1 - x0), y0 + v * (y1 - y0)));
    this.handles.c.setLatLng(f.toLL((x0 + x1) / 2, (y0 + y1) / 2));
  }

  #drag(k, ll, final) {
    const [x, y] = this.frame.toM([ll.lat, ll.lng]);
    let { x0, x1, y0, y1 } = this.area;
    if (k === "c") {
      const dx = x - (x0 + x1) / 2, dy = y - (y0 + y1) / 2;
      x0 += dx; x1 += dx; y0 += dy; y1 += dy;
    } else {
      // the opposite handle stays put; handles sit at fractions (u, v) of the box
      const fr = handleFractions(this.shape, x1 - x0, y1 - y0), [u, v] = fr[k], [ou, ov] = fr[OPPOSITE[k]];
      const fx = x0 + ou * (x1 - x0), fy = y0 + ov * (y1 - y0);
      let w = Math.max(Math.abs(x - fx) / Math.abs(u - ou), MIN_SIDE);
      let h = Math.max(Math.abs(y - fy) / Math.abs(v - ov), MIN_SIDE);
      if (this.aspect) {
        if (w / h > this.aspect) h = w / this.aspect;
        else w = h * this.aspect;
      }
      x0 = fx - ou * w; x1 = x0 + w;
      y0 = fy - ov * h; y1 = y0 + h;
    }
    this.area = { x0, x1, y0, y1 };
    this.#draw();
    this.onChange(this.area, final, k === "c" ? "move" : "resize");
  }

  // drag the box itself (mouse only; touch users have the centre handle)
  #bodyDrag() {
    let start = null;
    this.box.on("mousedown", (e) => {
      if (e.originalEvent.button !== 0) return;
      L.DomEvent.stop(e);
      this.map.dragging.disable();
      start = { p: this.frame.toM([e.latlng.lat, e.latlng.lng]), area: { ...this.area } };
    });
    this.map.on("mousemove", (e) => {
      if (!start) return;
      const [x, y] = this.frame.toM([e.latlng.lat, e.latlng.lng]);
      const dx = x - start.p[0], dy = y - start.p[1], a = start.area;
      this.area = { x0: a.x0 + dx, x1: a.x1 + dx, y0: a.y0 + dy, y1: a.y1 + dy };
      this.#draw();
      this.onChange(this.area, false, "move");
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.map.dragging.enable();
      this.onChange(this.area, true, "move");
    };
    this.map.on("mouseup", end);
    document.addEventListener("mouseup", end);
  }
}
