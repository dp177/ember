/** Load a GitHub repo into the UI: URL parser boundary + server root switch.
 * All network is faked: the parser is pure, the server's repoLoader is
 * injected, and indexing runs in-process with the hashing embedder. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { parseGitHubUrl } from "../src/ui/github.js";
import { createUiServer } from "../src/ui/server.js";
import { HashingEmbedder } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";

test("parseGitHubUrl accepts the plain repo shapes", () => {
  for (const u of [
    "github.com/pallets/flask",
    "https://github.com/pallets/flask",
    "https://github.com/pallets/flask/",
    "https://github.com/pallets/flask.git",
    "github.com/pallets/flask/tree/main",
    "www.github.com/pallets/flask",
  ]) {
    const r = parseGitHubUrl(u);
    assert.equal(r.label, "pallets/flask", u);
    assert.equal(r.cloneUrl, "https://github.com/pallets/flask.git", u);
  }
});

test("parseGitHubUrl refuses everything outside the public-https boundary", () => {
  for (const [u, why] of [
    ["", "empty"],
    ["git@github.com:pallets/flask.git", "ssh remote"],
    ["ssh://git@github.com/pallets/flask", "ssh scheme"],
    ["file:///tmp/x", "file scheme"],
    ["https://user:pass@github.com/pallets/flask", "credentials in URL"],
    ["https://evil-github.com/pallets/flask", "non-github host"],
    ["https://github.com/pallets", "no repo"],
    ["https://github.com/pallets/flask/blob/main/x.py", "deep link"],
    ["not a url at all", "garbage"],
  ] as const) {
    assert.throws(() => parseGitHubUrl(u), Error, `${why}: ${u}`);
  }
});

const REMOTE_SRC = "export function remoteGreeter(name: string): string {\n  return `hello ${name}`;\n}\n";

async function waitDone(base: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const s = await (await fetch(`${base}/api/index-status`)).json() as any;
    if (!s.running) return s;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("index run never finished");
}

test("load-repo switches the active root and indexes the loaded repo", async () => {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), "ember-local-"));
  await fs.writeFile(path.join(local, "alpha.ts"), "export function localOnly(): string {\n  return 'local';\n}\n");
  await indexRepo(local, new HashingEmbedder());

  const remote = await fs.mkdtemp(path.join(os.tmpdir(), "ember-remote-"));
  let loadedUrl = "";
  const repoLoader = async (url: string, log: (m: string) => void) => {
    loadedUrl = url;
    await fs.writeFile(path.join(remote, "remote.ts"), REMOTE_SRC);
    log("fake clone of octocat/Hello-World complete");
    return { label: "octocat/Hello-World", dir: remote };
  };
  const server = createUiServer(local, {
    embedder: new HashingEmbedder(),
    repoLoader,
    indexRunner: async (log) => {
      const r = await indexRepo(remote, new HashingEmbedder(), log);
      return { chunks: r.chunks, files: r.files, kept: r.kept, reused: r.reused, embedded: r.embedded };
    },
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const before = await (await fetch(`${base}/api/status`)).json() as any;
    assert.equal(before.source.kind, "local");

    // Bad URLs are rejected before anything starts (400, no run).
    const bad = await fetch(`${base}/api/load-repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://evil.com/a/b" }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json() as any).error, /only github\.com/);

    // Valid URL: accepted, loader receives the user's URL verbatim.
    const ok = await fetch(`${base}/api/load-repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "github.com/octocat/Hello-World" }) });
    assert.equal(ok.status, 202);
    const done = await waitDone(base);
    assert.ok(!done.error, `run finished clean: ${done.error ?? ""}`);
    assert.equal(loadedUrl, "github.com/octocat/Hello-World");
    assert.ok(done.lines.some((l: string) => l.includes("octocat/Hello-World")), "clone progress visible in run log");

    // Status and search now reflect the loaded repo, not the local one.
    const after = await (await fetch(`${base}/api/status`)).json() as any;
    assert.equal(after.source.kind, "github");
    assert.equal(after.source.label, "octocat/Hello-World");
    assert.equal(after.indexed, true);
    const search = await (await fetch(`${base}/api/search?q=greeter%20hello`)).json() as any;
    assert.ok(search.hits.some((h: any) => h.file === "remote.ts"), "search hits the loaded repo");
    const stale = await (await fetch(`${base}/api/search?q=localOnly`)).json() as any;
    assert.ok(!stale.hits.some((h: any) => h.file === "alpha.ts"), "previous root no longer searched");
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await fs.rm(local, { recursive: true, force: true });
    await fs.rm(remote, { recursive: true, force: true });
  }
});

test("load-repo rejects while a run is in flight (409)", async () => {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), "ember-local-"));
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const server = createUiServer(local, {
    embedder: new HashingEmbedder(),
    repoLoader: async (url, log) => { await gate; return { label: "a/b", dir: local }; },
    indexRunner: async () => ({ chunks: 0, files: 0 }),
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const first = await fetch(`${base}/api/load-repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "github.com/a/b" }) });
    assert.equal(first.status, 202);
    const second = await fetch(`${base}/api/load-repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "github.com/c/d" }) });
    assert.equal(second.status, 409);
    release();
    const done = await waitDone(base);
    assert.ok(!done.error);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await fs.rm(local, { recursive: true, force: true });
  }
});
