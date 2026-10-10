// Settings in the page URL, so the address bar can be copied, bookmarked or shared at any moment.
// Only settings that differ from their defaults are written, as readable query parameters
// (?size=80&cutterOn=1), and the URL follows every change. Opening such a link restores them:
// values are checked against a schema, so a hand-edited or old link can't inject anything odd.
// App-agnostic on purpose: shared by img2stl and gpx2stl, so keep app details out of it.
//
// schema: { key: { type: "number", min, max } | { type: "bool" } | { type: "enum", values: [...] } }
// (enum values may be strings or numbers; they're compared as text)

const fmt = (v) => (typeof v === "number" ? String(+v.toFixed(6)) : typeof v === "boolean" ? (v ? "1" : "0") : String(v));

function parse(spec, raw) {
  if (spec.type === "number") {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return undefined;
    return Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, v));
  }
  if (spec.type === "bool") return raw === "1" || raw === "true" ? true : raw === "0" || raw === "false" ? false : undefined;
  if (spec.type === "enum") return spec.values.find((x) => String(x) === raw);
  return undefined;
}

/** The settings in a query string (validated and clamped), or null when it holds none of them. */
export function decodeSettings(schema, search) {
  const p = new URLSearchParams(search), out = {};
  for (const [key, spec] of Object.entries(schema)) {
    if (!p.has(key)) continue;
    const v = parse(spec, p.get(key));
    if (v !== undefined) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Query string (without "?") for the settings that differ from their defaults, in schema order. */
export function encodeSettings(schema, settings, defaults, omit = []) {
  const p = new URLSearchParams();
  for (const key of Object.keys(schema)) {
    const v = settings[key];
    if (v === undefined || omit.includes(key) || fmt(v) === fmt(defaults[key])) continue;
    p.set(key, fmt(v));
  }
  return p.toString();
}

export const readUrl = (schema) => decodeSettings(schema, location.search);

// Browsers limit how often a page may rewrite its URL (Safari throws after 100 calls in 30 s),
// and sliders fire on every pixel, so updates are batched; shareUrl() flushes the latest.
let pending = null, timer = null;
function flush() {
  clearTimeout(timer);
  timer = null;
  if (pending === null) return;
  const url = pending;
  pending = null;
  try { if (url !== location.pathname + location.search + location.hash) history.replaceState(history.state, "", url); }
  catch {}
}

/** Put the settings in the address bar (within ~150 ms). Other query parameters are dropped. */
export function writeUrl(schema, settings, defaults, omit) {
  const qs = encodeSettings(schema, settings, defaults, omit);
  pending = location.pathname + (qs ? `?${qs}` : "") + location.hash;
  timer ??= setTimeout(flush, 150);
}

/** The page's link with the current settings. */
export function shareUrl() {
  flush();
  return location.href;
}

/** Copy text to the clipboard; resolves false if the browser won't allow it. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  // older browsers, or pages not served over https
  const ta = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}
