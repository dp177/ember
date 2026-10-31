/** Flat (exact-scan) retrieval is the default structure: indexes carry no
 * graph, search is exact, and the opt-in HNSW mode agrees on the fixture's
 * top hit. Measured basis: parity on the frozen eval corpus. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HashingEmbedder } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";
import { EmberStore } from "../src/core/store.js";
import { EmberEngine } from "../src/core/engine.js";

const FIXTURE: [string, string][] = [
  ["limiter.ts", `export class TokenBucketLimiter {
  private tokens: number;
  constructor(private capacity: number, private refillPerSec: number) { this.tokens = capacity; }
  allow(): boolean { if (this.tokens <= 0) return false; this.tokens -= 1; return true; }
}
`],
  ["render.ts", `export function renderMarkdown(title: string, body: string): string {
  return "# " + title + "\\n\\n" + body;
}
`],
];

async function makeRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  for (const [name, content] of FIXTURE) await fs.writeFile(path.join(dir, name), content);
  return dir;
}

test("default index is flat: no graph file, exact search finds the right chunk", async () => {
  const dir = await makeRepo("ember-flat-");
  try {
    delete process.env.EMBER_HNSW;
    await indexRepo(dir, new HashingEmbedder());
    const meta = await new EmberStore(dir).readMeta();
    assert.equal(meta?.indexMode, "flat");
    await assert.rejects(fs.access(path.join(dir, ".ember", "hnsw.json")), "no graph persisted");
    const engine = await EmberEngine.load(dir, new HashingEmbedder());
    const hits = await engine.search("token bucket rate limiting", 3);
    assert.equal(hits[0]?.chunk.file, "limiter.ts");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("opt-in HNSW mode persists a graph and agrees with flat on the top hit", async () => {
  const dir = await makeRepo("ember-graph-");
  try {
    process.env.EMBER_HNSW = "1";
    await indexRepo(dir, new HashingEmbedder());
    delete process.env.EMBER_HNSW;
    const meta = await new EmberStore(dir).readMeta();
    assert.equal(meta?.indexMode, "hnsw");
    await fs.access(path.join(dir, ".ember", "hnsw.json"));
    const graphEngine = await EmberEngine.load(dir, new HashingEmbedder());
    const graphHits = await graphEngine.search("token bucket rate limiting", 3);
    assert.equal(graphHits[0]?.chunk.file, "limiter.ts");

    // Re-index flat over the same repo: same answer, graph gone.
    await indexRepo(dir, new HashingEmbedder(), undefined, { full: true });
    await assert.rejects(fs.access(path.join(dir, ".ember", "hnsw.json")), "flat re-index drops the stale graph");
    const flatEngine = await EmberEngine.load(dir, new HashingEmbedder());
    const flatHits = await flatEngine.search("token bucket rate limiting", 3);
    assert.equal(flatHits[0]?.chunk.file, "limiter.ts");
  } finally {
    delete process.env.EMBER_HNSW;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("flat incremental re-index reflects edits", async () => {
  const dir = await makeRepo("ember-flat-inc-");
  try {
    delete process.env.EMBER_HNSW;
    await indexRepo(dir, new HashingEmbedder());
    await fs.writeFile(path.join(dir, "render.ts"), `export function renderMarkdown(title: string, body: string): string {
  return "# " + title + "\\n\\n" + body;
}
export function renderAsciiDoc(title: string, body: string): string {
  // asciidoc rendering for plain-text documents
  return "= " + title + "\\n\\n" + body;
}
`);
    await indexRepo(dir, new HashingEmbedder());
    const engine = await EmberEngine.load(dir, new HashingEmbedder());
    const hits = await engine.search("asciidoc rendering", 3);
    assert.equal(hits[0]?.chunk.file, "render.ts");
    assert.ok(hits[0]?.chunk.text.includes("renderAsciiDoc"), "new content searchable");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
