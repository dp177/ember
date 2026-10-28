// Parity test: the browser demo's search path (demo-web/search-core.ts,
// loading index artifacts over HTTP) must return exactly the same hits and
// scores as the engine itself (EmberEngine.search) on the same artifacts.
// Hermetic: builds its own fixture index in a tmpdir, so it passes on a
// fresh clone without a pre-built .ember.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { indexRepo } from "../src/core/indexer.js";
import { EmberEngine } from "../src/core/engine.js";
import { HashingEmbedder } from "../src/core/embedder.js";
import { loadDemoIndex, demoSearch } from "../demo-web/search-core.js";

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".jsonl": "application/jsonl",
  ".f32": "application/octet-stream",
};

let server: http.Server;
let base = "";
let repoDir = "";

before(async () => {
  repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-demoparity-"));
  await fs.writeFile(path.join(repoDir, "limiter.ts"),
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
  await fs.writeFile(path.join(repoDir, "render.ts"),
`export function renderMarkdown(title: string, body: string): string {
  return "# " + title + "\\n\\n" + body;
}
`);
  await fs.writeFile(path.join(repoDir, "cache.py"),
`def evict_lru(cache, max_size):
    while len(cache) > max_size:
        cache.popitem(last=False)
`);
  const embedder = new HashingEmbedder();
  const r = await indexRepo(repoDir, embedder);
  assert.ok(r.chunks >= 3, "fixture should produce chunks");

  const emberDir = path.join(repoDir, ".ember");
  server = http.createServer(async (req, res) => {
    const rel = (req.url ?? "/").replace(/^\//, "");
    const file = path.join(emberDir, rel);
    if (!file.startsWith(emberDir)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(async () => {
  server.close();
  await fs.rm(repoDir, { recursive: true, force: true });
});

const QUERIES: { q: string; expectTop: string }[] = [
  { q: "rate limit requests with a token bucket", expectTop: "limiter.ts" },
  { q: "render markdown with a title", expectTop: "render.ts" },
  { q: "evict least recently used cache entries", expectTop: "cache.py" },
];

test("demo-web search-core loads index artifacts over HTTP", async () => {
  const d = await loadDemoIndex(base);
  assert.ok(d.meta.chunkCount >= 3, `expected a real index, got ${d.meta.chunkCount} chunks`);
  assert.equal(d.meta.embedderKind, "local-hashing-lexical");
});

for (const { q, expectTop } of QUERIES) {
  test(`parity with EmberEngine.search: "${q}"`, async () => {
    const engine = await EmberEngine.load(repoDir, new HashingEmbedder());
    const engineHits = await engine.search(q, 3);
    assert.ok(engineHits.length > 0, "engine should find fixture chunks");
    assert.equal(engineHits[0].chunk.file, expectTop, "engine sanity: right file on top");
    const d = await loadDemoIndex(base);
    const demoHits = await demoSearch(d, q, 3);
    assert.equal(demoHits.length, engineHits.length);
    for (let i = 0; i < engineHits.length; i++) {
      assert.equal(demoHits[i].chunk.id, engineHits[i].chunk.id, `hit ${i} id mismatch`);
      assert.ok(
        Math.abs(demoHits[i].score - engineHits[i].score) < 1e-6,
        `hit ${i} score mismatch: demo ${demoHits[i].score} vs engine ${engineHits[i].score}`
      );
    }
  });
}
