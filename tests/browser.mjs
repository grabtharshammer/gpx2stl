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
  const t0 = Date.now();
  await page.click("#example");
  await page.waitForFunction(() => !document.getElementById("result").hidden || !document.getElementById("error").hidden,
                             { timeout: 180000 });
  const err = await page.$eval("#error", (e) => (e.hidden ? null : e.textContent));
  if (err) return fail(`${name} build error: ${err}`);
  const stats = await page.$eval("#stats", (e) => e.innerText.replace(/\n/g, " "));
  console.log(`${name}: built in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${stats}`);
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: join(shots, `${name}-model.png`), fullPage: true });

  await page.click("#download");
  for (let i = 0; i < 50; i++) {
    const files = (await readdir(dl)).filter((f) => f.endsWith(".stl"));
    if (files.length) {
      const size = (await stat(join(dl, files[0]))).size;
      console.log(`${name}: downloaded ${files[0]} (${size.toLocaleString()} bytes)`);
      if (size !== 84 + 50 * 452004) fail(`${name}: unexpected STL size`);
      break;
    }
    if (i === 49) fail(`${name}: no download`);
    await new Promise((r) => setTimeout(r, 200));
  }

  // change a setting -> rebuild via "Update model"
  const groove = '#trail-style [data-v="groove"]';
  await page.$eval(groove, (b) => b.scrollIntoView({ block: "center" }));
  await page.click(groove);
  const label = await page.$eval("#generate", (b) => b.textContent);
  if (label !== "Update model") fail(`${name}: button says "${label}" after a settings change`);
  await page.click("#generate");
  await page.waitForFunction(() => document.getElementById("generate").textContent === "Model is up to date",
                             { timeout: 180000 });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: join(shots, `${name}-groove.png`) });
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
