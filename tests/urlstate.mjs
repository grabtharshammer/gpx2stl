// Settings <-> query string rules.   node urlstate.mjs
import { encodeSettings, decodeSettings } from "../web/js/urlstate.js";

let failed = false;
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) failed = true; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const schema = {
  size: { type: "number", min: 20, max: 800 }, smooth: { type: "number", min: 0, max: 4 },
  shape: { type: "enum", values: ["outline", "rect", "circle"] }, cell: { type: "enum", values: [0.2, 0.1, 0.05] },
  cutterOn: { type: "bool" }, threshold: { type: "number", min: 1, max: 99 },
};
const defaults = { size: 60, smooth: 0.15, shape: "outline", cell: 0.1, cutterOn: false, threshold: 50 };

check(encodeSettings(schema, defaults, defaults) === "", "defaults give an empty query");
const s = { ...defaults, size: 80, smooth: 0.1 + 0.2, shape: "circle", cell: 0.05, cutterOn: true };
const qs = encodeSettings(schema, s, defaults);
check(qs === "size=80&smooth=0.3&shape=circle&cell=0.05&cutterOn=1", `only changes, tidy numbers: ${qs}`);
check(same(decodeSettings(schema, `?${qs}`), { size: 80, smooth: 0.3, shape: "circle", cell: 0.05, cutterOn: true }), "round trip");
check(encodeSettings(schema, { ...s, threshold: 30 }, defaults, ["threshold"]).indexOf("threshold") < 0, "omitted keys stay out");
check(decodeSettings(schema, "") === null && decodeSettings(schema, "?utm_source=x") === null, "no settings: null");
check(same(decodeSettings(schema, "?size=5000&smooth=-1&threshold=42.5"), { size: 800, smooth: 0, threshold: 42.5 }), "numbers clamped");
check(same(decodeSettings(schema, "?size=abc&shape=hexagon&cell=0.3&cutterOn=maybe&size2=1"), null), "junk ignored");
check(same(decodeSettings(schema, "?cutterOn=true&shape=rect&cell=0.2"), { shape: "rect", cell: 0.2, cutterOn: true }), "bool words, numeric enums");
check(same(decodeSettings(schema, "?shape=%3Cscript%3E&size=60"), { size: 60 }), "unknown enum text dropped");

process.exit(failed ? 1 : 0);
