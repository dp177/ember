// Same-repo retrieval SANITY CHECK - not a benchmark, not a general quality
// measure. 15 fixed questions about this one codebase; ground-truth files
// were chosen by reading the code, before any retrieval run. Metrics: top-1
// and top-5 FILE accuracy (is an expected file the first / among the first
// five distinct chunk hits) and MRR over that ranking. The corpus is frozen
// at the commit recorded in eval/CORPUS_REF and materialized via `git
// archive`, so before/after numbers are always compared on exactly the same
// tree; the working tree moving no longer moves the benchmark. To re-base
// the corpus intentionally, update eval/CORPUS_REF and re-measure both modes.
//
// Echo caveat: no eval question appears as an exact string in the corpus,
// but product code legitimately contains NEAR-identical phrasing (e.g. the
// demo command's "how does the approximate nearest neighbor index select
// neighbors?" vs question "which heuristic picks graph neighbors when a
// node is inserted?"). Exact-string absence is not absence of query echo;
// that is why each question also runs paraphrased ("pq", minimal phrasing
// shared with docs/demo) - the paraphrase row is the harder, less
// tautological signal for a lexical engine.
//
// eval/questions.json is excluded from the indexed corpus via .emberignore,
// so a question file can never answer itself (asserted). Demo/docs do
// legitimately discuss these topics (they are product code); the metric
// scores the rank of the ANSWER-bearing file, so echo files count as misses
// above it, not as hits.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EmberEngine } from "../dist/core/engine.js";
import { HashingEmbedder } from "../dist/core/embedder.js";
import { localEmbedderFromEnv } from "../dist/core/local-embedder.js";
import { indexRepo } from "../dist/core/indexer.js";

const root = path.resolve(import.meta.dirname, "..");
const questions = JSON.parse(await readFile(path.join(root, "eval", "questions.json"), "utf8"));
const ref = (process.env.EMBER_EVAL_REF ?? (await readFile(path.join(root, "eval", "CORPUS_REF"), "utf8"))).trim();
const hybrid = process.env.EMBER_HYBRID === "1";
// EMBER_EVAL_EMBEDDER=local measures the semantic path on the same frozen
// corpus (needs: npm install @xenova/transformers; downloads the model).
const embedder = process.env.EMBER_EVAL_EMBEDDER === "local"
  ? localEmbedderFromEnv({ ...process.env, EMBER_LOCAL_EMBED: "1" })
  : new HashingEmbedder();

const corpus = await mkdtemp(path.join(os.tmpdir(), "ember-eval-"));
try {
  execFileSync("git", ["archive", ref, "-o", path.join(corpus, "tree.tar")], { cwd: root });
  execFileSync("tar", ["-xf", "tree.tar"], { cwd: corpus });
  await rm(path.join(corpus, "tree.tar"));
  await indexRepo(corpus, embedder);
  var engine = await EmberEngine.load(corpus, embedder, { hybrid });
} catch (e) {
  await rm(corpus, { recursive: true, force: true });
  throw e;
}

async function runSet(key) {
  let top1 = 0, top5 = 0, mrr = 0;
  const rows = [];
  for (const item of questions) {
    const { expect } = item;
    const q = item[key];
    const all = await engine.search(q, 20);
    if (all.some((h) => h.chunk.file === "eval/questions.json")) {
      throw new Error("eval fixture leaked into results - .emberignore is not working");
    }
    const files = all.slice(0, 5).map((h) => h.chunk.file);
    const rank = files.findIndex((f) => expect.includes(f));
    if (rank === 0) top1++;
    if (rank >= 0 && rank < 5) { top5++; mrr += 1 / (rank + 1); }
    rows.push({ q, expected: expect[0], rank: rank < 0 ? "miss" : rank + 1, topFile: files[0] });
  }
  return { top1, top5, mrr, rows };
}

console.log(`mode: ${hybrid ? "hybrid (experimental)" : "default"}  embedder: ${embedder.kind}  corpus: ${ref.slice(0, 7)} (frozen)`);
for (const key of ["q", "pq"]) {
  const { top1, top5, mrr, rows } = await runSet(key);
  const label = key === "q" ? "verbatim  " : "paraphrase";
  for (const r of rows) console.log(`${String(r.rank).padStart(4)}  ${r.q}\n       expected ${r.expected} | top: ${r.topFile}`);
  const n = questions.length;
  console.log(`\n${label} top-1: ${top1}/${n}  top-5: ${top5}/${n}  MRR: ${(mrr / n).toFixed(3)}\n`);
}

await rm(corpus, { recursive: true, force: true });
