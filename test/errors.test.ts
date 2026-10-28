import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { indexRepo } from "../src/core/indexer.js";
import * as http from "node:http";
import { HashingEmbedder, HttpEmbedder } from "../src/core/embedder.js";
import { EmberEngine } from "../src/core/engine.js";
import { NoteStore } from "../src/core/notes.js";

test("engine load on an unindexed repo fails honestly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-err-"));
  await assert.rejects(() => EmberEngine.load(dir, new HashingEmbedder()));
  await fs.rm(dir, { recursive: true, force: true });
});

test("indexing a nonexistent directory rejects honestly", async () => {
  const target = path.join(os.tmpdir(), `ember-missing-${process.pid}`);
  await assert.rejects(() => indexRepo(target, new HashingEmbedder()), /not found|not a directory/);
});

test("embedder dim mismatch produces an actionable error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-err-"));
  await fs.writeFile(path.join(dir, "a.ts"), "export function alpha() { return 1 }\n");
  await indexRepo(dir, new HashingEmbedder(128));
  await assert.rejects(
    () => EmberEngine.load(dir, new HashingEmbedder(256)),
    /dim=128[\s\S]*dim=256/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("notes on a repo with no notes: empty list and zero hits, no crash", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-err-"));
  const store = new NoteStore(dir);
  assert.equal((await store.list()).length, 0);
  assert.equal((await store.search("anything")).length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test("corrupt index store fails with an actionable re-index message", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-err-"));
  await fs.writeFile(path.join(dir, "a.ts"), "export function alpha() { return 1 }\n");
  await indexRepo(dir, new HashingEmbedder(128));
  // Simulate a crash mid-write: truncate chunks.jsonl.
  const f = path.join(dir, ".ember", "chunks.jsonl");
  const stat = await fs.stat(f);
  await fs.truncate(f, Math.max(1, Math.floor(stat.size / 2)));
  await assert.rejects(
    () => EmberEngine.load(dir, new HashingEmbedder(128)),
    /corrupt or incomplete[\s\S]*ember index --full/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("torn notes line is skipped, earlier notes survive, next add stays readable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-err-"));
  const store = new NoteStore(dir);
  await store.add("first note survives");
  // Simulate an interrupted append: half-written JSON, no trailing newline.
  await fs.appendFile(path.join(dir, ".ember", "notes.jsonl"), '{"id":2,"ts":"2026-10-27",');
  const notes = await store.list();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, "first note survives");
  assert.equal(await store.corruptLineCount(), 1);
  // The critical case: the next add must repair the missing newline so the
  // new note is not glued onto the torn tail and lost.
  const n = await store.add("second note");
  assert.equal(n.id, 2);
  // Re-read from disk: both notes must survive, only the torn line is lost.
  const reread = await new NoteStore(dir).list();
  assert.equal(reread.length, 2);
  assert.deepEqual(reread.map(r => r.text).sort(), ["first note survives", "second note"]);
  assert.equal(await store.corruptLineCount(), 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("http embedder rejects a model whose dim does not match EMBER_EMBED_DIM", async () => {
  // Local stub server - no network, no spend.
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] })); // dim 3, config says 8
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const emb = new HttpEmbedder(`http://127.0.0.1:${port}`, "test-key", "fake-model", 8);
    await assert.rejects(
      () => emb.embed(["hello"]),
      /dim=3[\s\S]*EMBER_EMBED_DIM=8[\s\S]*ember index --full/,
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
});
