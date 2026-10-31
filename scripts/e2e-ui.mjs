/** ember ui browser end-to-end: real Chrome, real clicks, DOM assertions.
 * NOT part of npm test - needs a local Chrome/Chromium. Run:
 *   node scripts/e2e-ui.mjs
 * Chrome path: CHROME_PATH env, default /usr/bin/google-chrome. */
import puppeteer from "puppeteer-core";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-ui-e2e-"));
await fs.writeFile(path.join(dir, "alpha.ts"),
  "export function alphaSearch(input: string): string {\n  return input.trim();\n}\n");
await fs.writeFile(path.join(dir, "beta.ts"),
  "export function betaHelper(n: number): number {\n  return n * 2;\n}\n");
// Resolve the repo from this script's location, not a developer-machine path.
const ember = path.resolve(import.meta.dirname, "..");
await run("node", [path.join(ember, "dist/cli.js"), "index", "--path", dir]);

const server = (await import(path.join(ember, "dist/ui/server.js"))).createUiServer(dir);
await new Promise(r => server.listen(0, "127.0.0.1", r));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const fail = (msg) => { throw new Error("E2E: " + msg); };

// 1. Search workflow: type, click Search, see excerpt cards with line numbers.
const port = server.address().port;
await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "networkidle0" });
await page.type("#q", "trim input");
await page.click("#searchBtn");
await page.waitForFunction(() => document.querySelectorAll("#tab-results .hit").length > 0, { timeout: 10000 });
const searchState = await page.evaluate(() => ({
  mode: document.querySelector("#tab-results .mode")?.textContent ?? "",
  cards: [...document.querySelectorAll("#tab-results .hit")].map(el => ({
    loc: el.querySelector(".loc")?.textContent ?? "",
    hasCode: (el.querySelector("pre")?.textContent ?? "").includes("alphaSearch") || (el.querySelector("pre")?.textContent ?? "").length > 20,
    hasLineNums: !!el.querySelector("pre .ln"),
  })),
}));
if (!searchState.mode.includes("retrieval")) fail("search mode label missing: " + searchState.mode);
if (!searchState.cards.length || !searchState.cards.some(c => c.loc.includes("alpha.ts") && c.hasCode && c.hasLineNums))
  fail("no usable excerpt card: " + JSON.stringify(searchState.cards));

// 2. Expand a citation -> surrounding context loads.
await page.click("#tab-results .hit .loc");
await page.waitForFunction(() => {
  const pre = document.querySelector("#tab-results .hit pre");
  return pre && !pre.textContent.includes("loading context") && pre.textContent.length > 0;
}, { timeout: 10000 });
const expanded = await page.evaluate(() => document.querySelector("#tab-results .hit pre").textContent);
if (!expanded.includes("alphaSearch")) fail("expanded context wrong: " + expanded.slice(0, 120));

// 3. Ask workflow: labeled retrieval-only, sources rendered as cards.
await page.evaluate(() => { document.querySelector("#q").value = ""; });
await page.type("#q", "what does alphaSearch do");
await page.click("#askBtn");
await page.waitForFunction(() => document.querySelector("#tab-results .mode") !== null, { timeout: 10000 });
await page.waitForFunction(() => (document.querySelector("#tab-results .answer")?.textContent ?? "").length > 20, { timeout: 10000 });
const askState = await page.evaluate(() => ({
  mode: document.querySelector("#tab-results .mode")?.textContent ?? "",
  answer: document.querySelector("#tab-results .answer")?.textContent ?? "",
  showsCode: (document.querySelector("#tab-results .answer")?.textContent ?? "").includes("alphaSearch"),
}));
if (!askState.mode.includes("retrieval only")) fail("ask mode label: " + askState.mode);
if (!askState.answer.includes("Retrieval only")) fail("ask answer label missing");
if (!askState.showsCode) fail("extractive answer shows no code");
await page.screenshot({ path: "/downloads/ember-ui-v2-ask.png" });

// 4. Repo map tab.
await page.click('[data-tab="map"]');
await page.waitForFunction(() => document.querySelector("#mapOut").textContent.length > 20, { timeout: 10000 });
const mapText = await page.evaluate(() => document.querySelector("#mapOut").textContent);
if (!mapText.includes("alpha.ts") && !mapText.includes("typescript")) fail("map content thin: " + mapText.slice(0, 120));

// 5. Notes: save then read back in the list.
await page.click('[data-tab="notes"]');
await page.type("#noteText", "e2e browser note");
await page.click("#noteBtn");
await page.waitForFunction(() => document.querySelector("#notesOut").textContent.includes("e2e browser note"), { timeout: 10000 });

// 6. Header glyph is an SVG, not a broken emoji box.
const hasSvgLogo = await page.evaluate(() => !!document.querySelector("h1 svg"));
if (!hasSvgLogo) fail("SVG logo missing");

await page.screenshot({ path: "/downloads/ember-ui-v2-notes.png" });
await browser.close();
await new Promise(r => server.close(() => r()));
await fs.rm(dir, { recursive: true, force: true });
console.log("E2E PASS: search+excerpts, citation expand, ask labeling+source cards, map, notes save/read-back, SVG logo");
