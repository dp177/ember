// Assemble the static GitHub Pages bundle in demo-web/dist:
//   index.html + compiled ESM (already emitted by tsc) + index data.
// Only the four public index artifacts are copied - notes.jsonl (private
// user memory) is never part of the demo.
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "demo-web", "dist");
const data = path.join(dist, "data");

for (const f of ["meta.json", "chunks.jsonl", "vectors.f32"]) {
  await stat(path.join(root, ".ember", f)).catch(() => {
    throw new Error(`missing .ember/${f} - run \`node dist/cli.js index --full\` first`);
  });
}
// hnsw.json exists only when the graph opt-in (EMBER_HNSW=1) was used.
const hasGraph = await stat(path.join(root, ".ember", "hnsw.json")).then(() => true, () => false);
await rm(data, { recursive: true, force: true });
await mkdir(data, { recursive: true });
await copyFile(path.join(root, "demo-web", "index.html"), path.join(dist, "index.html"));
// Vendored transformers.js so the browser import map resolves offline of any CDN.
await mkdir(path.join(dist, "vendor"), { recursive: true });
await copyFile(path.join(root, "node_modules", "@xenova", "transformers", "dist", "transformers.min.js"), path.join(dist, "vendor", "transformers.min.js"));
for (const f of ["chunks.jsonl", "vectors.f32"]) {
  await copyFile(path.join(root, ".ember", f), path.join(data, f));
}
if (hasGraph) await copyFile(path.join(root, ".ember", "hnsw.json"), path.join(data, "hnsw.json"));
// meta.json carries the absolute build path (repoRoot) - strip it from the
// public bundle; the demo never reads it.
const meta = JSON.parse(await readFile(path.join(root, ".ember", "meta.json"), "utf8"));
delete meta.repoRoot;
await writeFile(path.join(data, "meta.json"), JSON.stringify(meta, null, 2));
console.log("demo bundle ready in demo-web/dist");
