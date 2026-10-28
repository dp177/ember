import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { indexRepo } from "../src/core/indexer.js";
import { HashingEmbedder } from "../src/core/embedder.js";
import { EmberEngine } from "../src/core/engine.js";

test("end-to-end: index a fixture repo and retrieve the right chunk", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-e2e-"));
  await fs.writeFile(path.join(dir, "limiter.ts"),
`export class TokenBucketLimiter {
  private tokens: number;
  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
  }
  allow(): boolean {
    if (this.tokens <= 0) return false;
    this.tokens -= 1;
    return true;
  }
}
`);
  await fs.writeFile(path.join(dir, "render.ts"),
`export function renderMarkdown(title: string, body: string): string {
  return "# " + title + "\\n\\n" + body;
}
`);
  await fs.writeFile(path.join(dir, "cache.py"),
`def evict_lru(cache, max_size):
    while len(cache) > max_size:
        cache.popitem(last=False)
`);
  const embedder = new HashingEmbedder();
  const r = await indexRepo(dir, embedder);
  assert.ok(r.chunks >= 3);
  const engine = await EmberEngine.load(dir, embedder);

  const hits1 = await engine.search("rate limit requests with a token bucket", 3);
  assert.equal(hits1[0].chunk.file, "limiter.ts");

  const hits2 = await engine.search("evict least recently used cache entries", 3);
  assert.equal(hits2[0].chunk.file, "cache.py");

  const hits3 = await engine.search("render markdown document", 3);
  assert.equal(hits3[0].chunk.file, "render.ts");

  // persistence: a second engine loads the same index
  const engine2 = await EmberEngine.load(dir, embedder);
  assert.equal(engine2.chunkCount(), engine.chunkCount());
  await fs.rm(dir, { recursive: true, force: true });
});
