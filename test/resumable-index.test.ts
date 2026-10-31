/** Resumable indexing: an interrupted run leaves a checkpoint OUTSIDE the
 * live index (the previous complete index stays searchable), and the next
 * run resumes it after validating model identity and per-file source hashes. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HashingEmbedder, type Embedder } from "../src/core/embedder.js";
import { LocalEmbedder, type PipelineFactory } from "../src/core/local-embedder.js";
import { indexRepo, readCheckpointInfo } from "../src/core/indexer.js";
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

test("different models with the SAME dim share no vectors (kind carries model identity)", async () => {
  // A 384-dim model A and a 384-dim model B are different embedding spaces;
  // resuming A's checkpoint with B would silently mix spaces. The Embedder
  // contract puts the exact model id in kind, so the checkpoint's kind+dim
  // comparison must reject this.
  const factory: PipelineFactory = async (_task, _model) => async (texts, { normalize }) => {
    const dim = 384;
    const data = new Float32Array(texts.length * dim);
    for (let i = 0; i < texts.length; i++) for (let j = 0; j < dim; j++) data[i * dim + j] = ((texts[i].charCodeAt(j % texts[i].length) + j) % 97) / 97 - 0.5;
    if (normalize) for (let i = 0; i < texts.length; i++) {
      let n = 0; for (let j = 0; j < dim; j++) n += data[i * dim + j] ** 2;
      n = Math.sqrt(n) || 1; for (let j = 0; j < dim; j++) data[i * dim + j] /= n;
    }
    return { dims: [texts.length, dim], data };
  };
  const modelA = () => new LocalEmbedder("example/model-a", 384, factory);
  const modelB = () => new LocalEmbedder("example/model-b", 384, factory);
  const dir = await mkrepo(4);
  try {
    await indexRepo(dir, modelA());
    for (let i = 0; i < 4; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export function hn${i}(): number { return ${i}; }\n`);
    process.env.EMBER_CHECKPOINT_FILES = "1";
    // Crash mid-reindex under model A so the checkpoint carries A's identity.
    let calls = 0;
    const flakyA: Embedder = {
      kind: modelA().kind, dim: 384,
      embed: async texts => { if (calls++ >= 1) throw new Error("simulated interruption"); return modelA().embed(texts); },
    };
    await assert.rejects(() => indexRepo(dir, flakyA), /simulated interruption/);
    assert.ok(await fs.stat(`${dir}/.ember.checkpoint/checkpoint.json`).then(() => true, () => false), "model A checkpoint exists");
    const r = await indexRepo(dir, modelB());
    assert.equal(r.kept, 0, "no reuse across same-dim models");
    assert.equal(r.chunks, 4);
    const meta = JSON.parse(await fs.readFile(`${dir}/.ember/meta.json`, "utf8"));
    assert.equal(meta.embedderKind, "local-wasm:example/model-b");
  } finally { delete process.env.EMBER_CHECKPOINT_FILES; await fs.rm(dir, { recursive: true, force: true }); }
});

test("embedding progress is logged between checkpoints (log-only, no checkpoint writes)", async () => {
  const dir = await mkrepo(6);
  try {
    process.env.EMBER_PROGRESS_FILES = "2";
    process.env.EMBER_CHECKPOINT_FILES = "1000"; // no checkpoint this run
    const logs: string[] = [];
    const r = await indexRepo(dir, new HashingEmbedder(), m => logs.push(m));
    const progress = logs.filter(m => /^processed \d+\/\d+ chunks \(\d+\/\d+ files, \d+ newly embedded\)$/.test(m));
    assert.deepEqual(progress, [
      "processed 2/6 chunks (2/6 files, 2 newly embedded)",
      "processed 4/6 chunks (4/6 files, 4 newly embedded)",
      "processed 6/6 chunks (6/6 files, 6 newly embedded)",
    ], "progress lines at the configured cadence, including completion");
    assert.ok(!logs.some(m => m.includes("checkpoint saved")), "no checkpoint at this cadence");
    assert.ok(!(await fs.stat(`${dir}/.ember.checkpoint`).then(() => true, () => false)), "no checkpoint dir written");
    assert.equal(r.chunks, 6);
  } finally {
    delete process.env.EMBER_PROGRESS_FILES;
    delete process.env.EMBER_CHECKPOINT_FILES;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("default cadence: early first checkpoint at 50 files, progress every 100, checkpoints every 200 (no env override)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-progress-"));
  try {
    for (let i = 0; i < 205; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export function fn${i}(): number { return ${i}; }\n`);
    const logs: string[] = [];
    await indexRepo(dir, new HashingEmbedder(), m => logs.push(m));
    const progress = logs.filter(m => /^processed \d+\/\d+ chunks \(\d+\/\d+ files, \d+ newly embedded\)( - checkpoint saved)?$/.test(m));
    assert.deepEqual(progress, [
      "processed 50/205 chunks (50/205 files, 50 newly embedded) - checkpoint saved",
      "processed 100/205 chunks (100/205 files, 100 newly embedded)",
      "processed 200/205 chunks (200/205 files, 200 newly embedded) - checkpoint saved",
    ], "first checkpoint lands at 50 files so a killed run resumes near the death point; then 100-file progress and 200-file checkpoints");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("readCheckpointInfo reports an interrupted run and clears with it", async () => {
  const dir = await mkrepo(6);
  try {
    for (let i = 0; i < 6; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export function fn${i}V3(): number { return ${i}; }\n`);
    await indexRepo(dir, new HashingEmbedder());
    for (let i = 0; i < 6; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export function fn${i}V4(): number { return ${i}; }\n`);
    process.env.EMBER_CHECKPOINT_FILES = "2";
    await assert.rejects(() => indexRepo(dir, new FlakyEmbedder(2)), /simulated interruption/);
    const info = await readCheckpointInfo(dir);
    assert.ok(info, "checkpoint visible to status surfaces");
    assert.equal(info!.chunkCount, 2);
    assert.equal(info!.files, 2);
    assert.equal(info!.embedderKind, "local-hashing-lexical");
    await indexRepo(dir, new HashingEmbedder());
    assert.equal(await readCheckpointInfo(dir), null, "cleared after the completed run");
  } finally { delete process.env.EMBER_CHECKPOINT_FILES; await fs.rm(dir, { recursive: true, force: true }); }
});
