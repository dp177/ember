// Same-repo retrieval SANITY CHECK - not a benchmark, not a general quality
// measure. 15 fixed questions about this one codebase; ground-truth files
// were chosen by reading the code, before any retrieval run. Metrics: top-1
// and top-5 FILE accuracy (is an expected file the first / among the first
// five distinct chunk hits) and MRR over that ranking. The corpus is frozen
// per comparison: before/after numbers are only ever compared on the same
// indexed tree.
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
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EmberEngine } from "../dist/core/engine.js";
import { HashingEmbedder } from "../dist/core/embedder.js";

const root = path.resolve(import.meta.dirname, "..");
const questions = JSON.parse(await readFile(path.join(root, "eval", "questions.json"), "utf8"));
const hybrid = process.env.EMBER_HYBRID === "1";
const engine = await EmberEngine.load(root, new HashingEmbedder(), { hybrid });

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

console.log(`mode: ${hybrid ? "hybrid (experimental)" : "default"}`);
for (const key of ["q", "pq"]) {
  const { top1, top5, mrr, rows } = await runSet(key);
  const label = key === "q" ? "verbatim  " : "paraphrase";
  for (const r of rows) console.log(`${String(r.rank).padStart(4)}  ${r.q}\n       expected ${r.expected} | top: ${r.topFile}`);
  const n = questions.length;
  console.log(`\n${label} top-1: ${top1}/${n}  top-5: ${top5}/${n}  MRR: ${(mrr / n).toFixed(3)}\n`);
}
