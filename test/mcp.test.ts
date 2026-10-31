import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";

/** Minimal newline-delimited JSON-RPC client over the server's stdio. */
class McpTestClient {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, (msg: any) => void>();

  constructor(root: string) {
    this.proc = spawn(process.execPath, [path.resolve("dist/cli.js"), "serve", "--path", root], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", line => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  call(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
    });
  }

  notify(method: string, params: any = {}): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void { this.proc.kill(); }
}

async function handshake(client: McpTestClient): Promise<void> {
  const init = await client.call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "ember-test", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "ember");
  client.notify("notifications/initialized");
}

test("MCP stdio: search-before-index errors honestly; note save/recall; index then search", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-mcp-"));
  await fs.writeFile(path.join(dir, "limiter.ts"), "export class Bucket { allow(): boolean { return true } }\n");

  const client = new McpTestClient(dir);
  try {
    await handshake(client);

    const early = await client.call("tools/call", { name: "search_code", arguments: { query: "bucket" } });
    assert.match(early.result.content[0].text, /error|ENOENT|no index/i);

    const saved = await client.call("tools/call", {
      name: "save_note",
      arguments: { text: "bucket capacity chosen as 100 after load test", tags: ["limiter"] },
    });
    assert.match(saved.result.content[0].text, /note #1 saved/);

    const recalled = await client.call("tools/call", { name: "recall_notes", arguments: { query: "capacity" } });
    assert.match(recalled.result.content[0].text, /bucket capacity chosen as 100/);

    const idx = await client.call("tools/call", { name: "index_repo", arguments: {} });
    assert.match(idx.result.content[0].text, /indexed \d+ chunks/);

    const hits = await client.call("tools/call", { name: "search_code", arguments: { query: "bucket allow" } });
    assert.match(hits.result.content[0].text, /limiter\.ts/);
  } finally {
    client.close();
  }

  // cross-session proof: a brand-new server process recalls the same note
  const client2 = new McpTestClient(dir);
  try {
    await handshake(client2);
    const recalled2 = await client2.call("tools/call", { name: "recall_notes", arguments: { query: "capacity" } });
    assert.match(recalled2.result.content[0].text, /bucket capacity chosen as 100/);
  } finally {
    client2.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("MCP stdio: engine load failures are not cached - external index becomes visible", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-mcp-"));
  await fs.writeFile(path.join(dir, "cache.ts"), "export function warmCache(): string { return 'warm' }\n");

  const client = new McpTestClient(dir);
  try {
    await handshake(client);
    const early = await client.call("tools/call", { name: "search_code", arguments: { query: "warm cache" } });
    assert.match(early.result.content[0].text, /error|ENOENT|no index/i);

    // Index from OUTSIDE the server (the CLI), not via index_repo.
    await new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [path.resolve("dist/cli.js"), "index", "--path", dir], { stdio: "inherit" });
      p.on("exit", code => (code === 0 ? resolve() : reject(new Error(`cli index exited ${code}`))));
    });

    // Same server session must now see the index (no cached failure).
    const hits = await client.call("tools/call", { name: "search_code", arguments: { query: "warm cache" } });
    assert.match(hits.result.content[0].text, /cache\.ts/);
  } finally {
    client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("MCP stdio: cached engine stays fresh across external re-index and delete", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-mcp-"));
  const src = path.join(dir, "cache.ts");
  await fs.writeFile(src, "export function warmCache(): string { return 'warm' }\n");

  const cliIndex = () => new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, [path.resolve("dist/cli.js"), "index", "--path", dir], { stdio: "inherit" });
    p.on("exit", code => (code === 0 ? resolve() : reject(new Error(`cli index exited ${code}`))));
  });

  await cliIndex();
  const client = new McpTestClient(dir);
  try {
    await handshake(client);
    // Load and cache the engine in this session.
    const hits1 = await client.call("tools/call", { name: "search_code", arguments: { query: "warm cache" } });
    assert.match(hits1.result.content[0].text, /cache\.ts/);

    // External change + re-index: same session must see the new content.
    await fs.writeFile(src, "export function frostyCache(): string { return 'frosty' }\n");
    await cliIndex();
    const hits2 = await client.call("tools/call", { name: "search_code", arguments: { query: "frosty cache" } });
    assert.match(hits2.result.content[0].text, /frostyCache/, "same session must serve the re-indexed content");

    // External delete: same session must fail honestly, not serve stale hits.
    await fs.rm(path.join(dir, ".ember"), { recursive: true, force: true });
    const gone = await client.call("tools/call", { name: "search_code", arguments: { query: "frosty cache" } });
    assert.match(gone.result.content[0].text, /error|ENOENT|no index|corrupt/i);
  } finally {
    client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("MCP stdio: index_status carries the mtime staleness hint", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-mcp-"));
  await fs.writeFile(path.join(dir, "limiter.ts"), "export class Bucket { allow(): boolean { return true } }\n");
  const client = new McpTestClient(dir);
  try {
    await handshake(client);
    await client.call("tools/call", { name: "index_repo", arguments: {} });
    const clean = await client.call("tools/call", { name: "index_status", arguments: {} });
    assert.match(clean.result.content[0].text, /indexed: \d+ chunks/);
    assert.doesNotMatch(clean.result.content[0].text, /may be stale/);
    const future = new Date(Date.now() + 3600_000);
    await fs.utimes(path.join(dir, "limiter.ts"), future, future);
    const stale = await client.call("tools/call", { name: "index_status", arguments: {} });
    assert.match(stale.result.content[0].text, /1 file\(s\) modified since indexing.*may be stale/);
  } finally {
    client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
