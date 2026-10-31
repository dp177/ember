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
