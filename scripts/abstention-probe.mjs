// Calibration probe for Ask abstention - NOT the benchmark. Measures score
// distributions for known-relevant questions vs off-topic probes so an
// abstention rule can be calibrated honestly. Calibration on the self-corpus
// must be evaluated on the holdout (flask) before any claim. A threshold
// tuned on eval/questions.json would contaminate the untuned-benchmark claim,
// so this script writes its raw data and the benchmark stays untouched.
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EmberEngine } from "../dist/core/engine.js";
import { localEmbedderFromEnv } from "../dist/core/local-embedder.js";
import { indexRepo } from "../dist/core/indexer.js";

const root = path.resolve(import.meta.dirname, "..");
const evalDir = process.env.EMBER_EVAL_DIR ?? "eval";
const out = process.env.EMBER_PROBE_OUT ?? "/tmp/abstention-probe.json";
const questions = JSON.parse(await readFile(path.join(root, evalDir, "questions.json"), "utf8"));
let ref, corpusRepo = root;
try {
  const spec = JSON.parse(await readFile(path.join(root, evalDir, "CORPUS.json"), "utf8"));
  ref = spec.ref.trim();
  corpusRepo = process.env.EMBER_EVAL_REPO ?? spec.repo;
} catch {
  ref = (await readFile(path.join(root, evalDir, "CORPUS_REF"), "utf8")).trim();
}

const OFFTOPIC = [
  "how do I bake sourdough bread",
  "what is the capital of Norway",
  "how to change a car tire",
  "best exercises for lower back pain",
  "how do I renew a passport",
  "what causes rainbows",
  "how to make cold brew coffee",
  "when was the moon landing",
  "how to knit a scarf",
  "what is compound interest",
];

const embedder = localEmbedderFromEnv({ ...process.env, EMBER_LOCAL_EMBED: "1" });
const corpus = await mkdtemp(path.join(os.tmpdir(), "ember-probe-"));
execFileSync("git", ["archive", ref, "-o", path.join(corpus, "tree.tar")], { cwd: corpusRepo });
execFileSync("tar", ["-xf", "tree.tar"], { cwd: corpus });
await rm(path.join(corpus, "tree.tar"));
console.error("indexing", corpusRepo, "at", ref.slice(0, 7));
await indexRepo(corpus, embedder);
const engine = await EmberEngine.load(corpus, embedder, { hybrid: false });

async function probe(q) {
  const hits = await engine.search(q, 5);
  return { top: hits[0]?.score ?? null, scores: hits.map(h => h.score), topFile: hits[0]?.chunk.file ?? null };
}

const relevant = [];
for (const item of questions) {
  for (const key of ["q", "pq"]) {
    const p = await probe(item[key]);
    const hits = await engine.search(item[key], 20);
    const rank = hits.map(h => h.chunk.file).findIndex(f => item.expect.includes(f));
    relevant.push({ q: item[key], kind: key, rank: rank < 0 ? "miss" : rank + 1, ...p });
  }
}
const offtopic = [];
for (const q of OFFTOPIC) offtopic.push({ q, ...(await probe(q)) });

const relTops = relevant.map(r => r.top).sort((a, b) => a - b);
const offTops = offtopic.map(r => r.top).sort((a, b) => a - b);
const summary = {
  corpus: ref, embedder: embedder.kind,
  relevant: { n: relTops.length, min: relTops[0], median: relTops[Math.floor(relTops.length / 2)], max: relTops[relTops.length - 1] },
  offtopic: { n: offTops.length, min: offTops[0], median: offTops[Math.floor(offTops.length / 2)], max: offTops[offTops.length - 1] },
};
console.log(JSON.stringify(summary, null, 2));
await writeFile(out, JSON.stringify({ summary, relevant, offtopic }, null, 2));
console.error("wrote", out);
await rm(corpus, { recursive: true, force: true });
