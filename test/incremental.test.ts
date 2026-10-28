import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { indexRepo } from "../src/core/indexer.js";
import { HashingEmbedder } from "../src/core/embedder.js";
import { EmberStore } from "../src/core/store.js";

async function tmpRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-incr-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

test("incremental: unchanged files keep chunks, zero re-embedding", async () => {
  const dir = await tmpRepo({
    "a.ts": "export function alpha() { return 1 }\n",
    "b.py": "def beta():\n    return 2\n",
  });
  const emb = new HashingEmbedder();
  const r1 = await indexRepo(dir, emb);
  assert.equal(r1.incremental, false);
  const r2 = await indexRepo(dir, emb);
  assert.equal(r2.incremental, true);
  assert.equal(r2.embedded, 0, "nothing re-embedded");
  assert.equal(r2.kept, r1.chunks, "all chunks reused");
  assert.equal(r2.chunks, r1.chunks);
  await fs.rm(dir, { recursive: true, force: true });
});

test("incremental: modified file re-chunked, deleted file dropped", async () => {
  const dir = await tmpRepo({
    "a.ts": "export function alpha() { return 1 }\n",
    "b.py": "def beta():\n    return 2\n",
  });
  const emb = new HashingEmbedder();
  await indexRepo(dir, emb);
  await fs.writeFile(path.join(dir, "a.ts"), "export function gamma() { return 3 }\n");
  await fs.rm(path.join(dir, "b.py"));
  const r2 = await indexRepo(dir, emb);
  assert.equal(r2.incremental, true);
  assert.ok(r2.embedded >= 1, "modified file re-embedded");
  const { chunks } = await new EmberStore(dir).load();
  assert.ok(chunks.some(c => c.text.includes("gamma")), "new content indexed");
  assert.ok(!chunks.some(c => c.text.includes("alpha")), "stale chunk removed");
  assert.ok(!chunks.some(c => c.file === "b.py"), "deleted file dropped");
  await fs.rm(dir, { recursive: true, force: true });
});

test("incremental: full=true forces re-embedding everything", async () => {
  const dir = await tmpRepo({ "a.ts": "export function alpha() { return 1 }\n" });
  const emb = new HashingEmbedder();
  const r1 = await indexRepo(dir, emb);
  const r2 = await indexRepo(dir, emb, undefined, { full: true });
  assert.equal(r2.incremental, false);
  assert.equal(r2.kept, 0);
  assert.equal(r2.embedded, r1.chunks);
  await fs.rm(dir, { recursive: true, force: true });
});
