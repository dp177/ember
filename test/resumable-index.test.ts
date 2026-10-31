/** Resumable indexing: an interrupted run leaves a checkpoint OUTSIDE the
 * live index (the previous complete index stays searchable), and the next
 * run resumes it after validating model identity and per-file source hashes. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HashingEmbedder, type Embedder } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";
import { EmberEngine } from "../src/core/engine.js";

class FlakyEmbedder implements Embedder {
  readonly kind = "local-hashing-lexical";
  readonly dim = 1024;
  private inner = new HashingEmbedder();
  filesEmbedded = 0;
  constructor(private failAfterFiles: number) {}
  async embed(texts: string[]): Promise<Float32Array[]> {
    // indexRepo embeds per file: each call is one file.
    if (this.filesEmbedded >= this.failAfterFiles) throw new Error("simulated interruption (crash, OOM, Ctrl-C)");
    this.filesEmbedded++;
    return this.inner.embed(texts);
  }
}

async function mkrepo(n: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-resume-"));
  for (let i = 0; i < n; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export function fn${i}(): number { return ${i}; }\n`);
  return dir;
}

test("interrupted indexing preserves the previous complete index and resumes from the checkpoint", async () => {
  const dir = await mkrepo(6);
  try {
    // 1. Complete index exists.
    const first = await indexRepo(dir, new HashingEmbedder());
    assert.equal(first.files, 6);
    const before = await EmberEngine.load(dir, new HashingEmbedder());
    assert.ok((await before.search("fn3", 1))[0].chunk.file === "f3.ts");

    // 2. Change all sources, then crash mid-reindex.
    for (let i = 0; i < 6; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export function fn${i}V2(): number { return ${i}; }\n`);
    process.env.EMBER_CHECKPOINT_FILES = "2"; // shrink the cadence for the test
    await assert.rejects(() => indexRepo(dir, new FlakyEmbedder(2)), /simulated interruption/);

    // 3. The previous complete index is still the live, searchable one.
    const during = await EmberEngine.load(dir, new HashingEmbedder());
    assert.ok((await during.search("fn3", 1))[0].chunk.file === "f3.ts", "old complete index still searchable");
    assert.ok(await fs.stat(`${dir}/.ember.checkpoint/checkpoint.json`).then(() => true, () => false), "checkpoint exists outside .ember");

    // 4. Resume: checkpointed chunks are kept, only the rest embedded.
    const resumed = await indexRepo(dir, new HashingEmbedder());
    assert.equal(resumed.chunks, 6);
    assert.ok(resumed.kept >= 2, `resumed ${resumed.kept} chunks from the checkpoint`);
    assert.equal(resumed.embedded, 6 - resumed.kept);
    assert.ok(!(await fs.stat(`${dir}/.ember.checkpoint`).then(() => true, () => false)), "checkpoint cleared after completion");
    const after = await EmberEngine.load(dir, new HashingEmbedder());
    assert.ok((await after.search("fn4V2", 1))[0].chunk.file === "f4.ts", "resumed index serves the new sources");
  } finally { delete process.env.EMBER_CHECKPOINT_FILES; await fs.rm(dir, { recursive: true, force: true }); }
});

test("a model change invalidates the checkpoint (no cross-model reuse)", async () => {
  const dir = await mkrepo(4);
  try {
    await indexRepo(dir, new HashingEmbedder());
    for (let i = 0; i < 4; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export function gn${i}(): number { return ${i}; }\n`);
    process.env.EMBER_CHECKPOINT_FILES = "1";
    await assert.rejects(() => indexRepo(dir, new FlakyEmbedder(1)), /simulated interruption/);
    // Resume with a different embedder identity: checkpoint must be discarded,
    // the run does a full re-embed and succeeds (kept = 0).
    const other: Embedder = { kind: "local-hashing-lexical-v2", dim: 1024, embed: t => new HashingEmbedder().embed(t) };
    const r = await indexRepo(dir, other);
    assert.equal(r.kept, 0, "no reuse across embedding spaces");
    assert.equal(r.chunks, 4);
    const engine = await EmberEngine.load(dir, other);
    assert.ok((await engine.search("gn2", 1))[0].chunk.file === "f2.ts");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
