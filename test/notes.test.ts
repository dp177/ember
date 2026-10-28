import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { NoteStore } from "../src/core/notes.js";

async function tmp(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), "ember-notes-")); }

test("notes: add, list recent-first, and persist across a fresh store (restart)", async () => {
  const dir = await tmp();
  const store = new NoteStore(dir);
  const n1 = await store.add("jwt auth chosen over sessions", ["auth"]);
  const n2 = await store.add("hnsw M=16 build is fast enough offline");
  assert.equal(n1.id, 1);
  assert.equal(n2.id, 2);

  // a fresh NoteStore (new "session") sees the same notes
  const reloaded = new NoteStore(dir);
  const all = await reloaded.list();
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 2, "most recent first");
  assert.equal(all[1].tags[0], "auth");
  await fs.rm(dir, { recursive: true, force: true });
});

test("notes: deterministic lexical search ranks by overlap, no embedder", async () => {
  const dir = await tmp();
  const store = new NoteStore(dir);
  await store.add("database uses sqlite with wal mode");
  await store.add("auth tokens expire after one hour");
  await store.add("sqlite checkpoint runs every minute");
  const hits = await store.search("sqlite");
  assert.equal(hits.length, 2);
  assert.ok(hits[0].text.includes("sqlite"));
  assert.equal((await store.search("kubernetes")).length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});
