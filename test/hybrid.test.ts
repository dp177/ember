/** Hybrid retrieval tests: BM25 lexical scorer, RRF fusion, and an
 * end-to-end check that filename/symbol-carried matches still surface. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LexicalScorer, rrfFuse } from "../src/core/hybrid.js";
import { HashingEmbedder } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";
import { EmberEngine } from "../src/core/engine.js";
import type { ChunkRecord } from "../src/core/store.js";

const mk = (id: number, file: string, text: string): ChunkRecord =>
  ({ id, file, startLine: 1, endLine: 1, symbol: null, text });

test("BM25: the chunk containing a rare query term wins", () => {
  const chunks = [
    mk(0, "src/alpha.ts", "common common common"),
    mk(1, "src/beta.ts", "common rarething"),
    mk(2, "src/gamma.ts", "common nothing special here"),
  ];
  const s = new LexicalScorer(chunks);
  const top = s.topK("rarething", 3);
  assert.equal(top[0], 1, "the chunk containing the rare term wins");
});

test("rrfFuse: items high in both rankings outrank single-list leaders", () => {
  const fused = rrfFuse([[1, 2, 3, 4], [3, 1, 9]]);
  const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  assert.equal(sorted[0], 1, "rank1+rank2 beats rank1 alone");
  assert.ok(sorted.indexOf(3) < sorted.indexOf(2), "rank3+rank1 beats rank2 alone");
});

test("e2e: a query whose best evidence is a filename still surfaces that file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-hybrid-"));
  await fs.writeFile(path.join(dir, "quicksort.ts"),
    "export function quicksort(arr: number[]): number[] {\n  if (arr.length < 2) return arr;\n  const p = arr[0];\n  return [...quicksort(arr.slice(1).filter(x => x < p)), p, ...quicksort(arr.slice(1).filter(x => x >= p))];\n}\n");
  for (let i = 0; i < 12; i++) {
    await fs.writeFile(path.join(dir, `util${i}.ts`),
      `export function helper${i}(input: string): string {\n  return input.trim().toLowerCase();\n}\n`);
  }
  const embedder = new HashingEmbedder();
  await indexRepo(dir, embedder);
  const engine = await EmberEngine.load(dir, embedder, { hybrid: true });
  const hits = await engine.search("sorting algorithm", 5);
  assert.ok(
    hits.some(h => h.chunk.file === "quicksort.ts"),
    `quicksort.ts should surface; got: ${hits.map(h => h.chunk.file).join(", ")}`,
  );
  await fs.rm(dir, { recursive: true, force: true });
});
