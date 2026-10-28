/** ask: synthesized answers with citation validation and honest fallback. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { validateCitations, answerQuestion } from "../src/core/ask.js";
import { LlmClient } from "../src/core/llm.js";
import { HashingEmbedder } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";
import { EmberEngine } from "../src/core/engine.js";

test("validateCitations: in-range markers kept, out-of-range stripped and counted", () => {
  const { answer, stripped } = validateCitations("Uses HNSW [1] and magic [9]. Also [0] and [2].", 3);
  assert.ok(answer.includes("[1]"));
  assert.ok(answer.includes("[2]"));
  assert.ok(!answer.includes("[9]") && !answer.includes("[0]"));
  assert.equal(stripped, 2);
});

async function indexedTmp(): Promise<{ dir: string; engine: EmberEngine }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-ask-"));
  await fs.writeFile(path.join(dir, "vector.ts"),
    "export function cosine(a: number[], b: number[]): number {\n  let s = 0;\n  for (let i = 0; i < a.length; i++) s += a[i] * b[i];\n  return s;\n}\n");
  const embedder = new HashingEmbedder();
  await indexRepo(dir, embedder);
  return { dir, engine: await EmberEngine.load(dir, embedder) };
}

async function chatServer(reply: string): Promise<{ base: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    let d = ""; req.on("data", c => (d += c));
    req.on("end", () => { res.writeHead(200, { "content-type": "application/json", "connection": "close" }); res.end(JSON.stringify({ choices: [{ message: { content: reply } }] })); });
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

test("ask: synthesized answer keeps valid citations, strips bogus ones, lists sources", async () => {
  const { dir, engine } = await indexedTmp();
  const { base, close } = await chatServer("Cosine similarity is a dot product over the vectors [1]. See also [42].");
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m" });
  const out = (await answerQuestion(engine, "how is cosine computed?", 5, { client })).text;
  assert.ok(out.includes("[1]"));
  assert.ok(!out.includes("[42]"), "out-of-range citation removed");
  assert.ok(out.includes("stripped 1 citation"), "stripping disclosed");
  assert.ok(out.includes("Sources:") && out.includes("vector.ts"));
  await close(); await fs.rm(dir, { recursive: true, force: true });
});

test("ask: model abstention ('chunks do not contain the answer') passes through untouched", async () => {
  const { dir, engine } = await indexedTmp();
  const { base, close } = await chatServer("The provided chunks do not contain the answer to that question.");
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m" });
  const out = (await answerQuestion(engine, "what database does it use?", 5, { client })).text;
  assert.ok(out.includes("do not contain the answer"), "abstention preserved verbatim");
  await close(); await fs.rm(dir, { recursive: true, force: true });
});

test("ask: chat failure falls back to extractive WITH the failure disclosed", async () => {
  const { dir, engine } = await indexedTmp();
  const client = new LlmClient({ base: "http://127.0.0.1:1", apiKey: "k", chatModel: "m" }); // nothing listening
  const out = (await answerQuestion(engine, "how is cosine computed?", 5, { client })).text;
  assert.ok(out.includes("Chat synthesis FAILED"), "failure is disclosed");
  assert.ok(out.includes("vector.ts"), "extractive chunks still returned");
  await fs.rm(dir, { recursive: true, force: true });
});

test("ask: no client configured -> plain extractive answer, no failure theater", async () => {
  const { dir, engine } = await indexedTmp();
  const out = (await answerQuestion(engine, "how is cosine computed?", 5, { client: null })).text;
  assert.ok(out.includes("Retrieval only"));
  assert.ok(!out.includes("FAILED"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("ask: zero-score chunks are never presented as sources", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-ask-zero-"));
  await fs.writeFile(path.join(dir, "a.ts"), "export function applePieRecipe(): string {\n  return 'apples';\n}\n");
  await fs.writeFile(path.join(dir, "b.ts"), "export function zebraStripeCount(): number {\n  return 42;\n}\n");
  const embedder = new HashingEmbedder();
  await indexRepo(dir, embedder);
  const engine = await EmberEngine.load(dir, embedder);
  const r = await answerQuestion(engine, "apple pie", 10, { client: null });
  // zebra has no vocabulary overlap with the query: score 0, must not appear.
  assert.ok(!r.text.includes("zebra"), "zero-score chunk excluded");
  assert.ok(r.text.includes("applePieRecipe"));
  assert.ok(!r.text.includes("relevant chunks"), "no invented relevance");
  await fs.rm(dir, { recursive: true, force: true });
});
