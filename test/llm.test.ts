/** LLM provider layer tests against a LOCAL mock OpenAI-compatible server.
 * No real provider is ever contacted: zero cost, deterministic. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { LlmClient, JsonlUsageLogger, llmConfigFromEnv, sharedClientFromEnv } from "../src/core/llm.js";
import { HttpEmbedder, embedderFromEnv } from "../src/core/embedder.js";

interface MockSpec {
  routes: Record<string, (body: any) => [number, unknown]>;
  seenAuth?: string | null;
  requests: { path: string; body: any }[];
}

async function mockServer(spec: MockSpec): Promise<{ base: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => {
      spec.seenAuth = req.headers.authorization ?? null;
      const body = data ? JSON.parse(data) : {};
      spec.requests.push({ path: req.url ?? "", body });
      const route = spec.routes[req.url ?? ""];
      const [status, out] = route ? route(body) : [404, { error: "no route" }];
      res.writeHead(status, { "content-type": "application/json", "connection": "close" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "ember-llm-"));

test("chat: returns content, sends the key to the server only, logs provider-reported usage", async () => {
  const dir = await tmp();
  const spec: MockSpec = {
    requests: [],
    routes: {
      "/chat/completions": body => [200, {
        choices: [{ message: { content: "It uses HNSW [1]." } }],
        usage: { prompt_tokens: 123, completion_tokens: 9 },
      }],
    },
  };
  const { base, close } = await mockServer(spec);
  const logger = new JsonlUsageLogger(path.join(dir, "usage.jsonl"));
  const client = new LlmClient({ base, apiKey: "sk-test-secret", chatModel: "mock-chat" }, logger);
  const r = await client.chat([{ role: "user", content: "how does search work?" }]);
  assert.equal(r.content, "It uses HNSW [1].");
  assert.equal(r.providerReported, true);
  assert.equal(r.inputTokens, 123);
  assert.equal(spec.seenAuth, "Bearer sk-test-secret", "key goes to the endpoint, as a header");

  const log = await fs.readFile(path.join(dir, "usage.jsonl"), "utf8");
  assert.ok(!log.includes("sk-test-secret"), "usage log must never contain the API key");
  const rec = JSON.parse(log.trim());
  assert.equal(rec.ok, true);
  assert.equal(rec.estimated, false);
  assert.equal(rec.inputTokens, 123);
  assert.equal(rec.outputTokens, 9);
  await close(); await fs.rm(dir, { recursive: true, force: true });
});

test("chat: no usage object from provider -> record is labeled estimated", async () => {
  const dir = await tmp();
  const spec: MockSpec = { requests: [], routes: { "/chat/completions": () => [200, { choices: [{ message: { content: "ok" } }] }] } };
  const { base, close } = await mockServer(spec);
  const logger = new JsonlUsageLogger(path.join(dir, "usage.jsonl"));
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m" }, logger);
  await client.chat([{ role: "user", content: "x".repeat(400) }]);
  const rec = JSON.parse((await fs.readFile(path.join(dir, "usage.jsonl"), "utf8")).trim());
  assert.equal(rec.estimated, true);
  assert.equal(rec.estimatedInputTokens, 100, "chars/4 estimate");
  assert.equal(rec.inputTokens, undefined, "no fake precise figure");
  await close(); await fs.rm(dir, { recursive: true, force: true });
});

test("embeddings: dim mismatch fails honestly instead of corrupting the store", async () => {
  const spec: MockSpec = { requests: [], routes: { "/embeddings": () => [200, { data: [{ embedding: [0.1, 0.2, 0.3] }] }] } };
  const { base, close } = await mockServer(spec);
  const emb = new HttpEmbedder(new LlmClient({ base, apiKey: "k", embedModel: "m", embedDim: 4 }), undefined, "m", 4);
  await assert.rejects(() => emb.embed(["hello"]), /dim=3.*EMBER_EMBED_DIM=4/s);
  await close();
});

test("failure: non-OK response raises an honest error and logs ok=false", async () => {
  const dir = await tmp();
  const spec: MockSpec = { requests: [], routes: { "/chat/completions": () => [400, { error: "bad model" }] } };
  const { base, close } = await mockServer(spec);
  const logger = new JsonlUsageLogger(path.join(dir, "usage.jsonl"));
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m" }, logger);
  await assert.rejects(() => client.chat([{ role: "user", content: "hi" }]), /400.*bad model/);
  const rec = JSON.parse((await fs.readFile(path.join(dir, "usage.jsonl"), "utf8")).trim());
  assert.equal(rec.ok, false);
  assert.match(rec.error, /400/);
  await close(); await fs.rm(dir, { recursive: true, force: true });
});

test("guard: EMBER_MAX_CALLS actually blocks requests past the cap (and says it is not a billing limit)", async () => {
  const spec: MockSpec = { requests: [], routes: { "/chat/completions": () => [200, { choices: [{ message: { content: "ok" } }] }] } };
  const { base, close } = await mockServer(spec);
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m", maxCalls: 1 });
  await client.chat([{ role: "user", content: "one" }]);
  await assert.rejects(() => client.chat([{ role: "user", content: "two" }]), /EMBER_MAX_CALLS=1.*does not track or limit spending/s);
  assert.equal(spec.requests.length, 1, "second request never left the process");
  await close();
});

test("guard: EMBER_MAX_PROMPT_CHARS blocks oversized input before sending", async () => {
  const spec: MockSpec = { requests: [], routes: { "/chat/completions": () => [200, { choices: [{ message: { content: "ok" } }] }] } };
  const { base, close } = await mockServer(spec);
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m", maxPromptCharsPerCall: 10 });
  await assert.rejects(() => client.chat([{ role: "user", content: "x".repeat(50) }]), /EMBER_MAX_PROMPT_CHARS=10/);
  assert.equal(spec.requests.length, 0);
  await close();
});

test("retry: one retry on 429 then success", async () => {
  let n = 0;
  const spec: MockSpec = {
    requests: [],
    routes: { "/chat/completions": () => (++n === 1 ? [429, { error: "slow down" }] : [200, { choices: [{ message: { content: "ok" } }] }]) },
  };
  const { base, close } = await mockServer(spec);
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m" });
  const r = await client.chat([{ role: "user", content: "hi" }]);
  assert.equal(r.content, "ok");
  assert.equal(n, 2);
  await close();
});

test("llmConfigFromEnv: unconfigured env is offline mode (null), EMBER_CHAT_BASE still honored", async () => {
  assert.equal(llmConfigFromEnv({}), null);
  assert.equal(llmConfigFromEnv({ EMBER_API_BASE: "http://x" }), null, "no key -> offline");
  const cfg = llmConfigFromEnv({ EMBER_CHAT_BASE: "http://legacy", EMBER_API_KEY: "k", EMBER_CHAT_MODEL: "m", EMBER_MAX_CALLS: "3" });
  assert.equal(cfg?.base, "http://legacy");
  assert.equal(cfg?.maxCalls, 3);
});

test("concurrency: parallel calls are serialized (max 1 in flight) and share the call cap", async () => {
  let inFlight = 0, maxInFlight = 0;
  // Custom server that tracks in-flight requests and answers slowly.
  const srv = http.createServer((req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    let d = ""; req.on("data", c => (d += c));
    req.on("end", () => setTimeout(() => {
      inFlight--;
      res.writeHead(200, { "content-type": "application/json", "connection": "close" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }, 50));
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;

  const client = new LlmClient({ base, apiKey: "k", chatModel: "m", maxCalls: 3 });
  const [a, b] = await Promise.all([
    client.chat([{ role: "user", content: "one" }]),
    client.chat([{ role: "user", content: "two" }]),
  ]);
  assert.equal(a.content, "ok");
  assert.equal(b.content, "ok");
  assert.equal(maxInFlight, 1, "never more than one provider request in flight");
  // The shared cap counts both: third call succeeds, fourth is blocked.
  await client.chat([{ role: "user", content: "three" }]);
  await assert.rejects(() => client.chat([{ role: "user", content: "four" }]), /EMBER_MAX_CALLS=3/);
  await new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r(null)); });
});

test("sharedClientFromEnv: chat + embeddings share one process-wide request cap", async () => {
  const dir = await tmp();
  let calls = 0;
  const spec: MockSpec = {
    requests: [],
    routes: {
      "/chat/completions": () => { calls++; return [200, { choices: [{ message: { content: "ok" } }] }]; },
      "/embeddings": (body) => { calls++; const inputs = Array.isArray(body.input) ? body.input : [body.input]; return [200, { data: inputs.map(() => ({ embedding: [0.1, 0.2, 0.3, 0.4] })) }]; },
    },
  };
  const { base, close } = await mockServer(spec);
  const env = { EMBER_API_BASE: base, EMBER_API_KEY: "k", EMBER_CHAT_MODEL: "m", EMBER_EMBED_MODEL: "m", EMBER_EMBED_DIM: "4", EMBER_MAX_CALLS: "2" };
  const logger = new JsonlUsageLogger(path.join(dir, "usage.jsonl"));
  const client = sharedClientFromEnv(env, logger);
  assert.ok(client, "configured env yields a client");
  assert.equal(sharedClientFromEnv(env, logger), client, "same config resolves the same client");
  const emb = embedderFromEnv(env, logger);
  assert.ok(emb.kind.startsWith("http-openai-compatible:"), "http embedder in play");
  await emb.embed(["one"]);                              // provider call 1 (embeddings path)
  await client!.chat([{ role: "user", content: "two" }]); // provider call 2 (chat path, same counter)
  await assert.rejects(() => emb.embed(["three"]), /EMBER_MAX_CALLS=2/, "the third request across either path is blocked");
  assert.equal(calls, 2, "exactly two provider requests left the process");
  await close(); await fs.rm(dir, { recursive: true, force: true });
});
