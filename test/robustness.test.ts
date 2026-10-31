/** Heavy-input and concurrency behavior: bad repos, bad queries, malformed
 * API calls, and readers racing a re-index. Behaviors here were first
 * probed against the real engine, then locked in as tests. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { indexRepo } from "../src/core/indexer.js";
import { EmberEngine } from "../src/core/engine.js";
import { HashingEmbedder } from "../src/core/embedder.js";
import { createUiServer } from "../src/ui/server.js";

const OK = "export function okThing(): number { return 1; }\n";

async function mkrepo(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-robust-"));
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  return dir;
}

test("hostile repo: binaries and non-UTF8 files skipped, .emberignore tolerates blanks/comments, one-line 1MB file indexes", async () => {
  const dir = await mkrepo({
    "ok.ts": OK,
    "blob.bin": Buffer.from([0, 1, 2, 3, 255, 254, 0, 10]),
    "bad.js": Buffer.from([0xff, 0xfe, 0x41, 0x42]),
    "long.ts": "export const x = \"" + "a".repeat(1_000_000) + "\";\n",
    ".emberignore": "\n\n  \n# a comment\nignored-dir/\n",
  });
  try {
    await fs.mkdir(path.join(dir, "ignored-dir"));
    await fs.writeFile(path.join(dir, "ignored-dir", "secret.ts"), "export function hiddenNope() {}\n");
    const r = await indexRepo(dir, new HashingEmbedder());
    assert.equal(r.files, 2, "only ok.ts and long.ts are indexed");
    const engine = await EmberEngine.load(dir, new HashingEmbedder());
    const hits = await engine.search("hiddenNope", 5);
    assert.ok(!hits.some(h => h.chunk.file.startsWith("ignored-dir")), "ignored dir content never surfaces");
    assert.ok((await engine.search("okThing", 5)).length > 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("bad queries: empty and whitespace return nothing, a 100KB query does not hang or crash", async () => {
  const dir = await mkrepo({ "ok.ts": OK });
  try {
    await indexRepo(dir, new HashingEmbedder());
    const engine = await EmberEngine.load(dir, new HashingEmbedder());
    assert.deepEqual(await engine.search("", 8), [], "empty query has no signal -> no hits");
    assert.deepEqual(await engine.search("   \n\t ", 8), []);
    const hits = await engine.search("z".repeat(100_000), 8);
    assert.ok(Array.isArray(hits), "huge query answered without hanging");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("unindexed repo fails honestly and names the fix", async () => {
  const dir = await mkrepo({ "ok.ts": OK });
  try {
    await assert.rejects(() => EmberEngine.load(dir, new HashingEmbedder()), /ember index --full/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ui: malformed notes JSON is a 400, a missing in-repo file is a 404, escapes stay 403", async () => {
  const dir = await mkrepo({ "ok.ts": OK });
  try {
    await indexRepo(dir, new HashingEmbedder());
    const server = createUiServer(dir);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const bad = await fetch(`${base}/api/notes`, { method: "POST", body: "{not json" });
      assert.equal(bad.status, 400, "malformed JSON is a client error, not a server crash");
      const missing = await fetch(`${base}/api/file?path=nope.ts`);
      assert.equal(missing.status, 404);
      const escape = await fetch(`${base}/api/file?path=../outside.ts`);
      assert.equal(escape.status, 403);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("concurrency: 15 searches racing a re-index all get a consistent answer, none fail", async () => {
  const dir = await mkrepo({ "ok.ts": OK, "beta.ts": "export function betaRace(): number { return 2; }\n" });
  try {
    await indexRepo(dir, new HashingEmbedder());
    const server = createUiServer(dir);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const searches = Array.from({ length: 15 }, (_, i) =>
        fetch(`${base}/api/search?q=${i % 2 ? "okThing" : "betaRace"}`).then(async r => ({ status: r.status, body: await r.json() as any })));
      const reindex = fetch(`${base}/api/index`, { method: "POST" }).then(r => r.status);
      const [results, reindexStatus] = await Promise.all([Promise.all(searches), reindex]);
      assert.equal(reindexStatus, 200);
      for (const [i, r] of results.entries()) {
        assert.equal(r.status, 200, `search ${i} survived the swap (no torn read, no crash)`);
        assert.ok(Array.isArray(r.body.hits), `search ${i} returned a well-formed result`);
      }
    } finally { await new Promise<void>(r => server.close(() => r())); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
