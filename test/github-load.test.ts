/** Load a GitHub repo into the UI: URL parser boundary + server root switch.
 * All network is faked: the parser is pure, the server's repoLoader is
 * injected, and indexing runs in-process with the hashing embedder. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { parseGitHubUrl, cloneOrUpdate, gitEnv, remoteCacheDir } from "../src/ui/github.js";
import { createUiServer } from "../src/ui/server.js";
import { HashingEmbedder } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";

test("parseGitHubUrl accepts the plain repo shapes", () => {
  for (const u of [
    "github.com/pallets/flask",
    "https://github.com/pallets/flask",
    "https://github.com/pallets/flask/",
    "https://github.com/pallets/flask.git",
    "www.github.com/pallets/flask",
  ]) {
    const r = parseGitHubUrl(u);
    assert.equal(r.label, "pallets/flask", u);
    assert.equal(r.ref, undefined, u);
    assert.equal(r.cloneUrl, "https://github.com/pallets/flask.git", u);
  }
});

test("parseGitHubUrl honors a /tree/<branch> link instead of silently loading the default branch", () => {
  const r = parseGitHubUrl("github.com/pallets/flask/tree/2.3.x");
  assert.equal(r.ref, "2.3.x");
  assert.equal(r.label, "pallets/flask@2.3.x");
  assert.match(remoteCacheDir(r), /pallets__flask__2\.3\.x$/);
});

test("cloneOrUpdate passes the requested ref to git, shallow and single-branch", async () => {
  const seen: string[][] = [];
  const dest = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ember-clone-")), "dest");
  const spy = async (args: string[]) => {
    seen.push(args);
    if (args[0] === "clone") await fs.mkdir(args[args.length - 1], { recursive: true });
    return { code: 0, output: "" };
  };
  const repo = parseGitHubUrl("github.com/pallets/flask/tree/2.3.x");
  await cloneOrUpdate(repo, dest, () => {}, spy);
  const clone = seen[0];
  assert.equal(clone[0], "clone");
  assert.ok(clone.includes("--depth") && clone.includes("--single-branch"), "shallow single-branch clone");
  const bi = clone.indexOf("--branch");
  assert.equal(clone[bi + 1], "2.3.x", "the URL's branch is what gets cloned");
  // A failed clone removes the partial cache dir so the next load starts clean.
  const failDir = dest + "-fail";
  await assert.rejects(
    cloneOrUpdate(repo, failDir, () => {}, async () => ({ code: 128, output: "fatal: could not read Username" })),
    /git clone failed/);
  assert.equal(await fs.stat(failDir).then(() => true, () => false), false, "partial clone removed");
});

test("gitEnv neutralizes ambient credentials and host rewriting", () => {
  const env = gitEnv();
  assert.equal(env.GIT_TERMINAL_PROMPT, "0", "never prompt");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.match(env.GIT_CONFIG_GLOBAL ?? "", /^(\/dev\/null|NUL)$/, "user gitconfig (helpers, insteadOf, extraHeader) ignored");
  assert.match(env.GIT_CONFIG_SYSTEM ?? "", /^(\/dev\/null|NUL)$/, "system gitconfig ignored");
  assert.equal(env.GIT_ASKPASS, "", "no askpass program runs");
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
    ["https://github.com/pallets/flask/tree/main/src", "tree subpath"],
    ["github.com/pallets/flask/tree/bad branch", "branch with space"],
    ["github.com/pallets/flask/tree/", "empty branch"],
    ["http://github.com/pallets/flask", "plain http"],
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

test("a failed load keeps the previous repo active and searchable", async () => {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), "ember-local-"));
  await fs.writeFile(path.join(local, "alpha.ts"), "export function localAlpha(): string {\n  return 'local';\n}\n");
  await indexRepo(local, new HashingEmbedder());
  const server = createUiServer(local, {
    embedder: new HashingEmbedder(),
    repoLoader: async () => { throw new Error("git clone failed: could not read Username"); },
    indexRunner: async () => { throw new Error("should never run"); },
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await fetch(`${base}/api/load-repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "github.com/private/repo" }) });
    assert.equal(r.status, 202);
    const done = await waitDone(base);
    assert.match(done.error, /git clone failed/);
    const status = await (await fetch(`${base}/api/status`)).json() as any;
    assert.equal(status.source.kind, "local", "previous root still active");
    assert.equal(status.indexed, true);
    const search = await (await fetch(`${base}/api/search?q=localAlpha`)).json() as any;
    assert.ok(search.hits.some((h: any) => h.file === "alpha.ts"), "previous root still searchable");
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await fs.rm(local, { recursive: true, force: true });
  }
});

test("a failed index keeps the previous root - the root switches only after the new index exists", async () => {
  const local = await fs.mkdtemp(path.join(os.tmpdir(), "ember-local-"));
  await fs.writeFile(path.join(local, "alpha.ts"), "export function localAlpha(): string {\n  return 'local';\n}\n");
  await indexRepo(local, new HashingEmbedder());
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), "ember-remote-"));
  const server = createUiServer(local, {
    embedder: new HashingEmbedder(),
    repoLoader: async () => ({ label: "a/b", dir: remote }),
    indexRunner: async () => { throw new Error("embedding exploded"); },
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fetch(`${base}/api/load-repo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "github.com/a/b" }) });
    const done = await waitDone(base);
    assert.match(done.error, /embedding exploded/);
    const status = await (await fetch(`${base}/api/status`)).json() as any;
    assert.equal(status.source.kind, "local", "root not switched on index failure");
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await fs.rm(local, { recursive: true, force: true });
    await fs.rm(remote, { recursive: true, force: true });
  }
});

test("a repo with no recognizable source files indexes to a VALID empty index - search answers with zero hits, not a corruption error", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "ember-empty-"));
  await fs.writeFile(path.join(empty, "README"), "no file extension, not indexed\n");
  const r = await indexRepo(empty, new HashingEmbedder());
  assert.equal(r.files, 0);
  assert.equal(r.chunks, 0);
  const server = createUiServer(empty, { embedder: new HashingEmbedder() });
  await new Promise<void>(r2 => server.listen(0, "127.0.0.1", r2));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const status = await (await fetch(`${base}/api/status`)).json() as any;
    assert.equal(status.indexed, true);
    assert.equal(status.chunks, 0);
    const search = await (await fetch(`${base}/api/search?q=anything`)).json() as any;
    assert.ok(!search.error, `no corruption error: ${search.error ?? ""}`);
    assert.deepEqual(search.hits, []);
  } finally {
    await new Promise<void>(r2 => server.close(() => r2()));
    await fs.rm(empty, { recursive: true, force: true });
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
