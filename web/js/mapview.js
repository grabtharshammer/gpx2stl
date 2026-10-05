// Map tab: the route on a topo map plus the print footprint, which can be moved and resized.
// Areas are { x0, x1, y0, y1 } in the route's local metre frame (see core/model.js routeFrame).
import * as L from "leaflet";

const MIN_SIDE = 200;   // metres

export class FootprintMap {
  constructor(el, { onChange }) {
    this.onChange = onChange;
    this.map = L.map(el, { zoomSnap: 0.25, zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: 'Map: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
                   'SRTM | style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    }).addTo(this.map);
    this.map.attributionControl.setPrefix(false);
    this.map.setView([39, -98], 4);
    this.routeLayer = L.layerGroup().addTo(this.map);
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
    this.#bodyDrag();
  }

  setRoute(segments, frame) {
    this.frame = frame;
    this.routeLayer.clearLayers();
    for (const s of segments) L.polyline(s, { className: "fp-casing", weight: 6, interactive: false }).addTo(this.routeLayer);
    for (const s of segments) L.polyline(s, { className: "fp-route", weight: 3, interactive: false }).addTo(this.routeLayer);
    const first = segments[0][0], last = segments.at(-1).at(-1);
    L.circleMarker(first, { className: "fp-start", radius: 5, interactive: false }).addTo(this.routeLayer);
    L.circleMarker(last, { className: "fp-end", radius: 5, interactive: false }).addTo(this.routeLayer);
    for (const h of Object.values(this.handles)) h.setOpacity(1);
  }

  /** area: local metres; cornerM: corner radius in metres; aspect: locked w/h ratio or null. */
  setFootprint(area, cornerM, aspect, fit = false) {
    this.area = { ...area };
    this.cornerM = cornerM;
    this.aspect = aspect;
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
    const r = Math.max(0, Math.min(this.cornerM, (x1 - x0) / 2, (y1 - y0) / 2));
    const pts = [];
    const arc = (cx, cy, a0) => {
      for (let i = 0; i <= 8; i++) {
        const a = ((a0 + (i * 90) / 8) * Math.PI) / 180;
        pts.push(f.toLL(cx + r * Math.cos(a), cy + r * Math.sin(a)));
      }
    };
    arc(x1 - r, y0 + r, 270); arc(x1 - r, y1 - r, 0); arc(x0 + r, y1 - r, 90); arc(x0 + r, y0 + r, 180);
    this.box.setLatLngs(pts);
    const at = { sw: [x0, y0], se: [x1, y0], ne: [x1, y1], nw: [x0, y1], c: [(x0 + x1) / 2, (y0 + y1) / 2] };
    for (const [k, [x, y]] of Object.entries(at)) this.handles[k].setLatLng(f.toLL(x, y));
  }

  #drag(k, ll, final) {
    const [x, y] = this.frame.toM([ll.lat, ll.lng]);
    let { x0, x1, y0, y1 } = this.area;
    if (k === "c") {
      const dx = x - (x0 + x1) / 2, dy = y - (y0 + y1) / 2;
      x0 += dx; x1 += dx; y0 += dy; y1 += dy;
    } else {
      // the opposite corner stays put
      const fx = k.includes("w") ? x1 : x0, fy = k.includes("s") ? y1 : y0;
      let w = Math.max(Math.abs(x - fx), MIN_SIDE), h = Math.max(Math.abs(y - fy), MIN_SIDE);
      if (this.aspect) {
        if (w / h > this.aspect) h = w / this.aspect;
        else w = h * this.aspect;
      }
      const sx = k.includes("w") ? -1 : 1, sy = k.includes("s") ? -1 : 1;
      [x0, x1] = sx < 0 ? [fx - w, fx] : [fx, fx + w];
      [y0, y1] = sy < 0 ? [fy - h, fy] : [fy, fy + h];
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
