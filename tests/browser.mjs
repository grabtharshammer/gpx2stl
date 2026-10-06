// Headless browser smoke test: load the page, build the example route, download the STL.
//   cd tests && npm install --no-save puppeteer-core && node browser.mjs [chromium path] [screenshot dir]
// Set BASE_URL to test a deployed copy instead of serving ../web locally.
import http from "node:http";
import { readFile, mkdtemp, readdir, stat } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "../web");
const chrome = process.argv[2] ?? "/usr/bin/chromium";
const shots = process.argv[3] ?? ".";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".gpx": "application/gpx+xml" };

const server = http.createServer(async (req, res) => {
  const path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = process.env.BASE_URL ?? `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
let failed = false;
const fail = (msg) => { failed = true; console.log("FAIL", msg); };

async function run(name, { width, height, dark }) {
  const ctx = await browser.createBrowserContext();   // fresh localStorage per run
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  if (dark) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
  page.on("console", (m) => m.type() === "error" && fail(`${name} console: ${m.text()}`));
  page.on("pageerror", (e) => fail(`${name} page error: ${e.message}`));
  const dl = await mkdtemp(join(tmpdir(), "gpx2stl-"));
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dl, browserContextId: ctx.id });

  await page.goto(url, { waitUntil: "networkidle0" });
  await page.screenshot({ path: join(shots, `${name}-empty.png`) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = async (sel) => {
    await page.$eval(sel, (b) => b.scrollIntoView({ block: "center" }));
    await page.click(sel);
  };
  const build = async (what) => {
    const t0 = Date.now();
    await click("#generate");
    await page.waitForFunction(() => document.getElementById("generate").textContent === "Model is up to date" ||
                                     !document.getElementById("error").hidden, { timeout: 180000 });
    const err = await page.$eval("#error", (e) => (e.hidden ? null : e.textContent));
    if (err) throw new Error(`${name} build error (${what}): ${err}`);
    const stats = await page.$eval("#stats", (e) => e.innerText.replace(/\n/g, " "));
    console.log(`${name}: ${what} built in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${stats}`);
    await sleep(1500);
    return stats;
  };
  // drag a map handle by (dx, dy) pixels
  const drag = async (sel, dx, dy) => {
    await page.$eval("#viewer", (v) => v.scrollIntoView({ block: "center" }));
    const b = await (await page.$(sel)).boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10);
    await page.mouse.up();
  };
  const info = () => page.$eval("#map-info", (e) => e.innerText.replace(/\n/g, " "));

  // load -> map tab with route + footprint
  await click("#example");
  await page.waitForSelector(".fp-c");
  await sleep(2500);   // map tiles
  if ((await page.$eval("#viewer", (v) => v.dataset.tab)) !== "map") fail(`${name}: map tab not shown after load`);
  console.log(`${name}: map shows ${await info()}`);
  await page.screenshot({ path: join(shots, `${name}-map.png`) });

  // default build -> 3D tab, matches the reference
  await build("default");
  if ((await page.$eval("#viewer", (v) => v.dataset.tab)) !== "3d") fail(`${name}: 3D tab not shown after build`);
  await page.screenshot({ path: join(shots, `${name}-model.png`), fullPage: true });

  await click("#download");
  for (let i = 0; i < 50; i++) {
    const files = (await readdir(dl)).filter((f) => f.endsWith(".stl"));
    if (files.length) {
      const size = (await stat(join(dl, files[0]))).size;
      console.log(`${name}: downloaded ${files[0]} (${size.toLocaleString()} bytes)`);
      const tris = await page.$eval("#stats", (e) => +/TRIANGLES\s+([\d,]+)/i.exec(e.innerText)[1].replace(/,/g, ""));
      if (size !== 84 + 50 * tris) fail(`${name}: STL size ${size} doesn't match ${tris} triangles`);
      break;
    }
    if (i === 49) fail(`${name}: no download`);
    await sleep(200);
  }

  // both markers off -> exactly the reference model
  await click('#start-marker [data-v="none"]');
  await click('#end-marker [data-v="none"]');
  const plain = await build("no markers");
  if (!/TRIANGLES 452,004/.test(plain)) fail(`${name}: without markers expected the reference model, got ${plain}`);
  await click('#start-marker [data-v="star"]');
  await click('#end-marker [data-v="circle"]');
  await build("star + circle markers");
  await page.screenshot({ path: join(shots, `${name}-markers.png`) });

  // change a setting -> rebuild via "Update model"
  await click('#trail-style [data-v="groove"]');
  const label = await page.$eval("#generate", (b) => b.textContent);
  if (label !== "Update model") fail(`${name}: button says "${label}" after a settings change`);
  await build("groove");
  await page.screenshot({ path: join(shots, `${name}-groove.png`) });

  // square shape, then move and crop the box on the map
  await click('#tabs [data-tab="map"]');
  await click('#shape [data-v="square"]');
  const sq = await info();
  if (!/→ 180 × 180 mm/.test(sq)) fail(`${name}: square shape gave "${sq}"`);
  await drag(".fp-c", 40, 30);
  if ((await page.$eval('#shape [aria-checked="true"]', (b) => b.dataset.v)) !== "square") fail(`${name}: moving changed the shape`);
  const moved = await info();
  await drag(".fp-ne", -120, 60);
  const cropped = await info();
  if (cropped === moved) fail(`${name}: resizing the box didn't change the area`);
  console.log(`${name}: after move + resize: ${cropped}`);
  if (!/→ 180 × 180 mm/.test(cropped)) fail(`${name}: square aspect not kept when resizing`);
  if (!(await page.$("#area-reset"))) fail(`${name}: no Reset link after editing the area`);
  await page.screenshot({ path: join(shots, `${name}-map-edited.png`) });
  await build("square, edited area");
  await page.screenshot({ path: join(shots, `${name}-model-edited.png`) });

  // hexagon: regular (w/h = 2/√3 or √3/2), cut as a hexagon
  await click('#tabs [data-tab="map"]');
  await click('#shape [data-v="hex"]');
  const hx = await info(), [, hw, hh] = /→ (\d+) × (\d+) mm/.exec(hx) ?? [];
  const ratio = hw / hh;
  if (!(Math.abs(ratio - 2 / Math.sqrt(3)) < 0.02 || Math.abs(ratio - Math.sqrt(3) / 2) < 0.02)) fail(`${name}: hexagon gave "${hx}"`);
  if (/outside/.test(hx)) fail(`${name}: auto-fitted hexagon crops the route`);
  await page.screenshot({ path: join(shots, `${name}-map-hex.png`) });
  await build("hexagon");
  await click('#tabs [data-tab="map"]');
  await drag(".fp-ne", -40, 30);
  const hx2 = await info(), [, w2, h2] = /→ (\d+) × (\d+) mm/.exec(hx2) ?? [];
  if (hx2 === hx || Math.abs(w2 / h2 - ratio) > 0.02) fail(`${name}: hexagon resize gave "${hx2}" (was "${hx}")`);
  if ((await page.$eval('#shape [aria-checked="true"]', (b) => b.dataset.v)) !== "hex") fail(`${name}: resizing changed the hexagon shape`);
  console.log(`${name}: hexagon resized: ${hx2}`);
  await page.screenshot({ path: join(shots, `${name}-model-hex.png`) });

  // trimming: slider, then drag the finish dot along the route on the map
  await click('#shape [data-v="fit"]');
  await sleep(1000);   // the map animates its zoom to the new box
  await page.$eval("#trim-from", (r) => { r.value = 8000; r.dispatchEvent(new Event("input")); });
  const note1 = await page.$eval("#trim-note", (e) => e.innerText);
  if (!/Printing 39\.4 km of 47\.4 km/.test(note1)) fail(`${name}: trim slider gave "${note1}"`);
  await page.$eval("#viewer", (v) => v.scrollIntoView({ block: "center" }));
  const area0 = await info();
  await drag(".fp-dot-end", 120, -60);
  const note2 = await page.$eval("#trim-note", (e) => e.innerText), area1 = await info();
  console.log(`${name}: trimmed: ${note2.split(".")[0]}; area ${area1}`);
  if (note2 === note1) fail(`${name}: dragging the finish dot didn't trim`);
  if (area1 === area0) fail(`${name}: print area didn't follow the trimmed route`);
  await page.screenshot({ path: join(shots, `${name}-map-trim.png`) });
  await build("trimmed");
  await page.screenshot({ path: join(shots, `${name}-model-trim.png`) });
  await click('#tabs [data-tab="map"]');
  await click("#trim-reset");
  if (!/Or drag/.test(await page.$eval("#trim-note", (e) => e.innerText))) fail(`${name}: trim reset failed`);

  // label: prefilled from the GPX + terrain, placed on the map, raised then engraved
  await click("#label-on");
  await page.waitForFunction(() => /High point/.test(document.getElementById("label-text").value), { timeout: 60000 });
  const ltxt = await page.$eval("#label-text", (e) => e.value);
  console.log(`${name}: label prefill: ${ltxt.replace(/\n/g, " | ")}`);
  if (!/WHOLE enchilada/.test(ltxt) || !/ (mi|km) · \+[\d,]+ \/ -[\d,]+ (ft|m)/.test(ltxt)) fail(`${name}: unexpected label text`);
  await page.waitForSelector(".fp-label-handle");
  await sleep(800);
  const placed = await info();
  console.log(`${name}: label placed automatically: ${placed}`);
  if (/covers part of the route|hangs off/.test(placed)) fail(`${name}: automatic label spot overlaps: ${placed}`);
  await page.screenshot({ path: join(shots, `${name}-map-label.png`) });
  await drag(".fp-label-handle", 30, -50);
  console.log(`${name}: after moving the label: ${await info()}`);
  await build("raised label");
  await page.screenshot({ path: join(shots, `${name}-model-label.png`) });
  await click('#label-style [data-v="engraved"]');
  await build("engraved label");
  await page.screenshot({ path: join(shots, `${name}-model-label-engraved.png`) });
  await click('#tabs [data-tab="map"]');

  // free resize in Fit mode switches to Custom
  await click('#tabs [data-tab="map"]');
  await click('#shape [data-v="fit"]');
  await drag(".fp-sw", 50, -20);
  if ((await page.$eval('#shape [aria-checked="true"]', (b) => b.dataset.v)) !== "custom") fail(`${name}: resizing in Fit mode didn't switch to Custom`);
  await click("#area-reset");
  if ((await page.$eval('#shape [aria-checked="true"]', (b) => b.dataset.v)) !== "fit") fail(`${name}: Reset didn't return to Fit`);
  await ctx.close();
}

try {
  await run("desktop", { width: 1360, height: 860 });
  await run("phone-dark", { width: 390, height: 844, dark: true });
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? "FAILED" : "OK");
process.exit(failed ? 1 : 0);
