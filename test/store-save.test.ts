/** Atomic store saves: a re-index stages the new file set and swaps it in,
 * so files Ember does not own (notes, usage log) survive, no staging
 * directories are left behind, and the swapped store loads cleanly. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HashingEmbedder } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";
import { EmberStore } from "../src/core/store.js";
import { NoteStore } from "../src/core/notes.js";

test("save is atomic at the directory level and preserves foreign files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-store-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaSave(): number { return 1; }\n");
    await indexRepo(dir, new HashingEmbedder());
    const notes = new NoteStore(dir);
    await notes.add("chose jwt over sessions; see auth.ts", ["auth"]);
    await fs.writeFile(path.join(dir, ".ember", "usage.jsonl"), '{"ts":"2026-10-31","ok":true}\n');

    // Modify a file and re-index: triggers save() over an existing store.
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaSave(): number { return 2; }\n");
    await indexRepo(dir, new HashingEmbedder());

    const recalled = await notes.search("jwt", 5);
    assert.equal(recalled.length, 1, "notes survive a re-index");
    const usage = await fs.readFile(path.join(dir, ".ember", "usage.jsonl"), "utf8");
    assert.match(usage, /"ok":true/, "usage log survives a re-index");
    const entries = await fs.readdir(dir);
    assert.ok(!entries.some(e => e.startsWith(".ember.tmp-") || e.startsWith(".ember.backup-")), "no staging directories left behind");
    const loaded = await new EmberStore(dir).load();
    assert.ok(loaded.chunks.length > 0, "swapped store loads cleanly");
    assert.equal(loaded.meta.chunkCount, loaded.chunks.length);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("save clears staging directories left by a crashed earlier save", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-store-crash-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaCrash(): number { return 1; }\n");
    await indexRepo(dir, new HashingEmbedder());
    // Simulate a crashed save: leftover staging + backup dirs.
    await fs.mkdir(path.join(dir, ".ember.tmp-99999"), { recursive: true });
    await fs.mkdir(path.join(dir, ".ember.backup-99999"), { recursive: true });
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaCrash(): number { return 2; }\n");
    await indexRepo(dir, new HashingEmbedder());
    const entries = await fs.readdir(dir);
    assert.ok(!entries.some(e => e.startsWith(".ember.tmp-") || e.startsWith(".ember.backup-")), "stale staging dirs are cleaned");
    const loaded = await new EmberStore(dir).load();
    assert.ok(loaded.chunks.length > 0, "store loads after recovery");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a save crashed between the two renames is recovered on next open", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-store-midswap-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaSwap(): number { return 1; }\n");
    await indexRepo(dir, new HashingEmbedder());
    const before = await new EmberStore(dir).load();
    // Simulate the crash window: live set moved aside, staged set never swapped in.
    await fs.rename(path.join(dir, ".ember"), path.join(dir, ".ember.backup-11111"));
    const store = new EmberStore(dir);
    const meta = await store.readMeta();
    assert.ok(meta, "readMeta recovers the backup instead of reporting unindexed");
    const loaded = await store.load();
    assert.equal(loaded.chunks.length, before.chunks.length, "recovered set is complete");
    const entries = await fs.readdir(dir);
    assert.ok(entries.includes(".ember"), "canonical directory restored");
    assert.ok(!entries.some(e => e.startsWith(".ember.backup-")), "backup consumed by recovery");
    // And a subsequent save still works and keeps foreign files.
    await new NoteStore(dir).add("note after recovery", []);
    await indexRepo(dir, new HashingEmbedder());
    assert.equal((await new NoteStore(dir).list(5)).length, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a leftover backup next to a live store is old swap output and gets dropped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-store-leftover-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaLeft(): number { return 1; }\n");
    await indexRepo(dir, new HashingEmbedder());
    await fs.mkdir(path.join(dir, ".ember.backup-22222"));
    const loaded = await new EmberStore(dir).load();
    assert.ok(loaded.chunks.length > 0, "live set is used, not the leftover");
    const entries = await fs.readdir(dir);
    assert.ok(!entries.some(e => e.startsWith(".ember.backup-")), "stale backup dropped");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
