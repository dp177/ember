/** ember ui: full workflow over the real engine + local-server security. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import * as http from "node:http";
import { createUiServer } from "../src/ui/server.js";
import { HashingEmbedder, embedderFromEnv } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";

const ALPHA = "export function alphaSearch(input: string): string {\n  return input.trim();\n}\n";
const BETA = "export function betaHelper(n: number): number {\n  return n * 2;\n}\n";

async function setup(): Promise<{ base: string; dir: string; close: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-ui-"));
  await fs.writeFile(path.join(dir, "alpha.ts"), ALPHA);
  await fs.writeFile(path.join(dir, "beta.ts"), BETA);
  await fs.writeFile(path.join(dir, ".emberignore"), "ignored.ts\n");
  await fs.writeFile(path.join(dir, "ignored.ts"), "export function ignoredSecret(): string {\n  return 'xyzzy-fixture';\n}\n");
  await indexRepo(dir, new HashingEmbedder());
  const server = createUiServer(dir, { embedder: new HashingEmbedder() });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, dir, close: () => new Promise(r => server.close(() => r())) };
}

test("ui workflow: status -> search with real excerpts -> expand context -> ask -> map -> note save and read-back across restart", async () => {
  const { base, dir, close } = await setup();
  try {
    const status = await (await fetch(`${base}/api/status`)).json() as any;
    assert.equal(status.indexed, true);
    assert.equal(status.hybrid, false);
    assert.equal(status.modifiedSinceIndex, 0, "clean tree right after indexing");

    // mtime-drift hint reaches the status API (heuristic, see core/freshness).
    const future = new Date(Date.now() + 3600_000);
    await fs.utimes(path.join(dir, "alpha.ts"), future, future);
    const staleStatus = await (await fetch(`${base}/api/status`)).json() as any;
    assert.equal(staleStatus.modifiedSinceIndex, 1, "touched file reported");
    const now = new Date();
    await fs.utimes(path.join(dir, "alpha.ts"), now, now);

    // .emberignore keeps the fixture out of the corpus entirely.
    const ignored = await (await fetch(`${base}/api/search?q=xyzzy-fixture`)).json() as any;
    assert.ok(!ignored.hits.some((h: any) => h.file === "ignored.ts"), "ignored file never surfaces");

    // Search returns chunks whose text matches the actual file lines.
    const search = await (await fetch(`${base}/api/search?q=trim%20input`)).json() as any;
    const hit = search.hits.find((h: any) => h.file === "alpha.ts");
    assert.ok(hit, "alpha.ts found");
    const fileLines = ALPHA.split("\n");
    const chunkLines = hit.text.split("\n");
    for (let i = 0; i < chunkLines.length; i++) {
      assert.equal(chunkLines[i], fileLines[hit.startLine - 1 + i], `excerpt line ${hit.startLine + i} matches the file`);
    }

    // Expand: surrounding context arrives with correct line numbers.
    const ctx = await (await fetch(`${base}/api/file?path=alpha.ts&start=1&end=3`)).json() as any;
    assert.deepEqual(ctx.lines, fileLines.slice(0, 3));

    // Ask without a chat model: honestly labeled retrieval-only, hits attached.
    const ask = await (await fetch(`${base}/api/ask?q=what%20does%20alphaSearch%20do`)).json() as any;
    assert.equal(ask.synthesized, false);
    assert.ok(ask.answer.includes("Retrieval only"), "labeled as retrieval, not an answer");
    assert.ok(ask.hits.length >= 1 && ask.hits[0].text.length > 0);

    // Repo map renders.
    const map = await (await fetch(`${base}/api/map`)).json() as any;
    assert.ok(map.map.includes("alpha.ts") || map.map.length > 0);

    // Note save -> read back -> survives a server restart (persists on disk).
    await (await fetch(`${base}/api/notes`, { method: "POST", body: JSON.stringify({ text: "ui workflow note", tags: ["ui"] }) })).json();
    await close();
    const server2 = createUiServer(dir, { embedder: new HashingEmbedder() });
    await new Promise<void>(r => server2.listen(0, "127.0.0.1", r));
    const base2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    const notes = await (await fetch(`${base2}/api/notes`)).json() as any;
    assert.equal(notes.notes[0].text, "ui workflow note", "note persisted across restart");
    await new Promise(r => server2.close(() => r(null)));
    return;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ui security: path escapes, symlink escape, and cross-origin mutations are refused", async () => {
  const { base, dir, close } = await setup();
  try {
    // Traversal and absolute paths.
    assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent("../package.json")}`)).status, 403);
    assert.equal((await fetch(`${base}/api/file?path=${encodeURIComponent("/etc/passwd")}`)).status, 403);

    // A symlink inside the repo pointing outside must not leak the target.
    await fs.symlink("/etc/passwd", path.join(dir, "leak.ts"));
    const leak = await fetch(`${base}/api/file?path=leak.ts`);
    assert.equal(leak.status, 403, "symlink escape refused");

    // Cross-origin POST (browser CSRF shape) refused; same-origin allowed.
    const bad = await fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ text: "csrf attempt" }),
    });
    assert.equal(bad.status, 403);
    const good = await fetch(`${base}/api/notes`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${(new URL(base)).port}` },
      body: JSON.stringify({ text: "same-origin ok" }),
    });
    assert.equal(good.status, 200);
    const notes = await (await fetch(`${base}/api/notes`)).json() as any;
    assert.ok(!notes.notes.some((n: any) => n.text === "csrf attempt"), "forged note never written");
    assert.ok(notes.notes.some((n: any) => n.text === "same-origin ok"));
  } finally {
    await close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ui: EMBER_MAX_CALLS holds across requests (one process-wide provider client)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-ui-cap-"));
  await fs.writeFile(path.join(dir, "alpha.ts"), ALPHA);
  let calls = 0;
  const mock = http.createServer((req, res) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => {
      calls++;
      const body = data ? JSON.parse(data) : {};
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: inputs.map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] })) }));
    });
  });
  await new Promise<void>(r => mock.listen(0, "127.0.0.1", r));
  const mockPort = (mock.address() as AddressInfo).port;
  const KEYS = ["EMBER_API_BASE", "EMBER_API_KEY", "EMBER_EMBED_MODEL", "EMBER_EMBED_DIM", "EMBER_MAX_CALLS", "EMBER_REMOTE_EMBED"];
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  try {
    process.env.EMBER_API_BASE = `http://127.0.0.1:${mockPort}`;
    process.env.EMBER_API_KEY = "k";
    process.env.EMBER_EMBED_MODEL = "m";
    process.env.EMBER_EMBED_DIM = "4";
    process.env.EMBER_REMOTE_EMBED = "1"; // remote embeddings need this explicit opt-in since v0.7.0
    await indexRepo(dir, embedderFromEnv());
    const callsAfterIndex = calls;
    // The cap is configured only now: the server's provider client must be
    // a fresh budget of 1 for the whole process, not 1 per request.
    process.env.EMBER_MAX_CALLS = "1";
    const server = createUiServer(dir);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const first = await (await fetch(`${base}/api/search?q=trim`)).json() as any;
      assert.ok(Array.isArray(first.hits), "first search succeeds");
      const second = await (await fetch(`${base}/api/search?q=helper`)).json() as any;
      assert.match(String(second.error ?? ""), /EMBER_MAX_CALLS=1/, "second search hits the process-wide cap instead of resetting it");
      assert.equal(calls, callsAfterIndex + 1, "exactly one provider request left the process for both searches");
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  } finally {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    (mock as any).closeAllConnections?.();
    await new Promise(r => mock.close(() => r(null)));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ui: the engine is cached across requests and a re-index invalidates it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-uicache-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaCache(): number { return 1; }\n");
    await indexRepo(dir, new HashingEmbedder());
    const server = createUiServer(dir, {
      embedder: new HashingEmbedder(),
      indexRunner: (onLine, full) => indexRepo(dir, new HashingEmbedder(), onLine, { full }),
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const first = await (await fetch(`${base}/api/search?q=alphaCache`)).json() as any;
      assert.ok(first.hits.length > 0);
      const second = await (await fetch(`${base}/api/search?q=alphaCache`)).json() as any;
      assert.deepEqual(second.hits, first.hits, "cached engine serves consistent results");
      // Re-index with new content: the next search must see it (no stale cache).
      await fs.writeFile(path.join(dir, "b.ts"), "export function betaCache(): number { return 2; }\n");
      const re = await fetch(`${base}/api/index`, { method: "POST" });
      assert.equal(re.status, 202, "index runs are async now");
      for (let i = 0; i < 50; i++) {
        const st = await (await fetch(`${base}/api/index-status`)).json() as any;
        if (!st.running) { assert.ok(st.result?.chunks > 0, "run completed with a result"); break; }
        await new Promise(r => setTimeout(r, 50));
        if (i === 49) assert.fail("index run did not finish");
      }
      const third = await (await fetch(`${base}/api/search?q=betaCache`)).json() as any;
      assert.ok(third.hits.some((h: any) => h.file === "b.ts"), "post-reindex search sees the new file");
    } finally { await new Promise<void>(r => server.close(() => r())); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ui: a failed reindex surfaces a visible error and leaves the server serving", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-uifail-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaFail(): number { return 1; }\n");
    await indexRepo(dir, new HashingEmbedder());
    const server = createUiServer(dir, {
      embedder: new HashingEmbedder(),
      indexRunner: async () => { throw new Error("index worker terminated (SIGKILL); cause unknown - simulated"); },
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const re = await fetch(`${base}/api/index`, { method: "POST" });
      assert.equal(re.status, 202);
      let st: any = null;
      for (let i = 0; i < 50; i++) {
        st = await (await fetch(`${base}/api/index-status`)).json() as any;
        if (!st.running) break;
        await new Promise(r => setTimeout(r, 50));
      }
      assert.ok(st.error?.includes("terminated (SIGKILL)"), "the worker failure is visible in /api/index-status");
      // The previous index is still searchable after the failed run.
      const hits = await (await fetch(`${base}/api/search?q=alphaFail`)).json() as any;
      assert.ok(hits.hits.length > 0, "previous index keeps serving after a failed reindex");
    } finally { await new Promise<void>(r => server.close(() => r())); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ui: a second reindex during a running one is a 409, not a pile-up", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-ui-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaSlow(): number { return 1; }\n");
    // Slow scripted embedder: deterministic in-progress window.
    let release: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const slow: import("../src/core/embedder.js").Embedder = {
      kind: "local-hashing-lexical", dim: 1024,
      embed: async texts => { await gate; return new HashingEmbedder().embed(texts); },
    };
    const server = createUiServer(dir, { embedder: slow, indexRunner: (onLine, full) => indexRepo(dir, slow, onLine, { full }) });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const first = await fetch(`${base}/api/index`, { method: "POST" });
      assert.equal(first.status, 202);
      for (let i = 0; i < 50; i++) {
        const st = await (await fetch(`${base}/api/index-status`)).json() as any;
        if (st.running) break;
        await new Promise(r => setTimeout(r, 20));
      }
      const second = await fetch(`${base}/api/index`, { method: "POST" });
      assert.equal(second.status, 409, "concurrent reindex refused");
      const body = await second.json() as any;
      assert.match(body.error, /already in progress/);
      release!();
      for (let i = 0; i < 100; i++) {
        const st = await (await fetch(`${base}/api/index-status`)).json() as any;
        if (!st.running) { assert.ok(!st.error, `run finished cleanly: ${st.error}`); break; }
        await new Promise(r => setTimeout(r, 20));
      }
    } finally { await new Promise<void>(r => server.close(() => r())); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("ui: the served page script parses (template-literal escapes are load-bearing)", async () => {
  const { PAGE } = await import("../src/ui/page.js");
  const m = PAGE.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "page has an inline script");
  // Throws SyntaxError on invalid JS (e.g. a \\n that collapsed into a
  // real newline inside a string when authored inside the TS template).
  new Function(m![1]);
});
