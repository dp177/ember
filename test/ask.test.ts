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


/** Semantic-path engine stub with above-floor hits, for synthesis-mechanics tests. */
function wasmStub(): EmberEngine {
  const mk = (file: string, score: number, sym?: string) => ({ score, chunk: { file, startLine: 1, endLine: 5, symbol: sym, text: `export function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }` } });
  return {
    embedderKind: "local-wasm:Xenova/all-MiniLM-L6-v2", hybrid: false,
    async search() { return [mk("vector.ts", 0.55, "cosine"), mk("math.ts", 0.41)]; },
  } as unknown as EmberEngine;
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
  const engine = wasmStub();
  const { base, close } = await chatServer("Cosine similarity is a dot product over the vectors [1]. See also [42].");
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m" });
  const out = (await answerQuestion(engine, "how is cosine computed?", 5, { client })).text;
  assert.ok(out.includes("[1]"));
  assert.ok(!out.includes("[42]"), "out-of-range citation removed");
  assert.ok(out.includes("stripped 1 citation"), "stripping disclosed");
  assert.ok(out.includes("Sources cited in the answer:") && out.includes("vector.ts"));
  await close();
});

test("ask: model abstention ('chunks do not contain the answer') passes through untouched", async () => {
  const engine = wasmStub();
  const { base, close } = await chatServer("The provided chunks do not contain the answer to that question.");
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m" });
  const out = (await answerQuestion(engine, "what database does it use?", 5, { client })).text;
  assert.ok(out.includes("do not contain the answer"), "abstention preserved verbatim");
  assert.ok(out.includes("no citation markers"), "uncited answer is labeled unverified");
  assert.ok(out.includes("Retrieved matches (the answer cited none of them"), "uncited chunks are labeled retrieval matches, not sources");
  assert.ok(!out.includes("Sources cited in the answer:"), "no cited-source block when nothing was cited");
  await close();
});

test("ask: cited and uncited retrieved chunks are listed separately", async () => {
  const engine = wasmStub();
  const { base, close } = await chatServer("Cosine is a dot product [1]. I did not use the other chunk.");
  const client = new LlmClient({ base, apiKey: "k", chatModel: "m" });
  const out = (await answerQuestion(engine, "how is cosine computed?", 5, { client })).text;
  assert.ok(out.includes("Sources cited in the answer:"), "cited block present");
  assert.ok(out.includes("Also retrieved, not cited by the answer"), "uncited block present and labeled as retrieval matches");
  assert.ok(!/not claim support.*\n\[1\]/s.test(out), "cited chunk [1] is not listed as uncited");
  await close();
});

test("ask: chat failure falls back to extractive WITH the failure disclosed", async () => {
  const engine = wasmStub();
  const client = new LlmClient({ base: "http://127.0.0.1:1", apiKey: "k", chatModel: "m" }); // nothing listening
  const out = (await answerQuestion(engine, "how is cosine computed?", 5, { client })).text;
  assert.ok(out.includes("Chat synthesis FAILED"), "failure is disclosed");
  assert.ok(out.includes("vector.ts"), "extractive chunks still returned");
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

test("askMinScore: semantic floor 0.2 by default, 0 for lexical, env overrides", async () => {
  const { askMinScore, ASK_MIN_SEMANTIC_SCORE } = await import("../src/core/ask.js");
  assert.equal(askMinScore("local-wasm:Xenova/all-MiniLM-L6-v2", false, {}), ASK_MIN_SEMANTIC_SCORE);
  assert.equal(askMinScore("local-wasm:Xenova/all-MiniLM-L6-v2", true, {}), ASK_MIN_SEMANTIC_SCORE, "hybrid floors on the underlying cosine, not the RRF score");
  assert.equal(askMinScore("hashing-v1", false, {}), 0);
  assert.equal(askMinScore("local-wasm:anything", false, { EMBER_ASK_MIN_SCORE: "0.42" }), 0.42);
});

test("abstention: all hits below the semantic floor are not presented as sources", async () => {
  const { engine } = await indexedTmp();
  // Hashing engine floor is 0, so drive the semantic floor through a stub
  // engine whose hits score under the calibrated 0.2 bound.
  const weak = {
    embedderKind: "local-wasm:Xenova/all-MiniLM-L6-v2",
    hybrid: false,
    async search() {
      const mk = (score: number) => ({ score, chunk: { file: "vector.ts", startLine: 1, endLine: 5, symbol: "cosine", text: "export function cosine..." } });
      return [mk(0.15), mk(0.11)];
    },
  } as unknown as EmberEngine;
  const r = await answerQuestion(weak, "how to knit a scarf", 5);
  assert.equal(r.synthesized, false);
  assert.match(r.text, /No chunks scored high enough to treat as relevant/);
  assert.match(r.text, /top score 0\.150/);
  assert.doesNotMatch(r.text, /Retrieved sources for/);
});

test("abstention: synthesis is skipped when nothing clears the floor (no request sent)", async () => {
  let called = 0;
  const srv = http.createServer((req, res) => { called++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "answer [1]" } }] })); });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  const client = new LlmClient({ base: `http://127.0.0.1:${port}`, apiKey: "k", chatModel: "m" });
  const weak = {
    embedderKind: "local-wasm:test-model", hybrid: false,
    async search() { return [{ score: 0.1, chunk: { file: "a.ts", startLine: 1, endLine: 2, text: "x" } }]; },
  } as unknown as EmberEngine;
  const r = await answerQuestion(weak, "anything", 5, { client });
  assert.equal(called, 0, "no chat request may be sent when no chunk clears the floor");
  assert.match(r.text, /chat synthesis skipped/);
  await new Promise<void>(r => { srv.closeAllConnections?.(); srv.close(() => r()); });
});

test("mode-aware evidence gating and disclosures", async () => {
  const { askModeNote, evidenceScore } = await import("../src/core/ask.js");
  assert.match(askModeNote("local-wasm:m", true), /underlying semantic score/);
  assert.match(askModeNote("local-hashing-lexical", false), /lexical diagnostic mode/);
  assert.equal(askModeNote("local-wasm:m", false), "");
  assert.equal(evidenceScore({ score: 0.018, vectorScore: 0.31 } as never), 0.31);
  assert.equal(evidenceScore({ score: 0.018 } as never), 0.018);

  // hybrid: RRF score below 0.2 but underlying cosine strong -> sources shown
  const grounded = {
    embedderKind: "local-wasm:m", hybrid: true,
    async search() { return [{ score: 0.018, vectorScore: 0.31, chunk: { file: "a.ts", startLine: 1, endLine: 2, text: "x" } }]; },
  } as unknown as EmberEngine;
  const ok = await answerQuestion(grounded, "anything", 5);
  assert.match(ok.text, /Retrieved sources for/, "hybrid gates on vectorScore, not RRF score");

  // hybrid: underlying cosine weak -> abstains, synthesis skipped
  const weak = {
    embedderKind: "local-wasm:m", hybrid: true,
    async search() { return [{ score: 0.017, vectorScore: 0.11, chunk: { file: "a.ts", startLine: 1, endLine: 2, text: "x" } }]; },
  } as unknown as EmberEngine;
  const no = await answerQuestion(weak, "how to knit a scarf", 5);
  assert.match(no.text, /No chunks scored high enough/, "weak underlying cosine abstains in hybrid");

  // hybrid hit with no vectorScore (lexically ranked only) cannot clear the floor
  const lexOnly = {
    embedderKind: "local-wasm:m", hybrid: true,
    async search() { return [{ score: 0.019, chunk: { file: "a.ts", startLine: 1, endLine: 2, text: "x" } }]; },
  } as unknown as EmberEngine;
  const r2 = await answerQuestion(lexOnly, "anything", 5);
  assert.match(r2.text, /No chunks scored high enough/, "hits without a calibrated score are not Ask evidence");
});

test("synthesis context contains ONLY chunks that cleared the floor", async () => {
  let seen = "";
  const srv = http.createServer((req, res) => {
    let d = ""; req.on("data", c => (d += c));
    req.on("end", () => { seen = d; res.writeHead(200, { "content-type": "application/json", "connection": "close" }); res.end(JSON.stringify({ choices: [{ message: { content: "answer [1]" } }] })); });
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  const client = new LlmClient({ base: `http://127.0.0.1:${port}`, apiKey: "k", chatModel: "m" });
  const mixed = {
    embedderKind: "local-wasm:m", hybrid: false,
    async search() { return [
      { score: 0.5, chunk: { file: "strong.ts", startLine: 1, endLine: 2, text: "STRONG-EVIDENCE-MARKER" } },
      { score: 0.1, chunk: { file: "weak.ts", startLine: 1, endLine: 2, text: "WEAK-NONEVIDENCE-MARKER" } },
    ]; },
  } as unknown as EmberEngine;
  const r = await answerQuestion(mixed, "q", 5, { client });
  assert.ok(seen.includes("STRONG-EVIDENCE-MARKER"), "above-floor chunk sent");
  assert.ok(!seen.includes("WEAK-NONEVIDENCE-MARKER"), "below-floor chunk must not be sent as grounding");
  assert.ok(!r.text.includes("weak.ts"), "below-floor chunk not listed as a Source");
  await new Promise<void>(r => { srv.closeAllConnections?.(); srv.close(() => r()); });
});

test("hybrid: weak underlying cosine skips the chat call (no request sent)", async () => {
  let called = 0;
  const srv = http.createServer((req, res) => { called++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "x" } }] })); });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  const client = new LlmClient({ base: `http://127.0.0.1:${port}`, apiKey: "k", chatModel: "m" });
  const weakHybrid = {
    embedderKind: "local-wasm:m", hybrid: true,
    async search() { return [{ score: 0.017, vectorScore: 0.11, chunk: { file: "a.ts", startLine: 1, endLine: 2, text: "x" } }]; },
  } as unknown as EmberEngine;
  await answerQuestion(weakHybrid, "anything", 5, { client });
  assert.equal(called, 0, "hybrid weak evidence must not reach the chat model");
  await new Promise<void>(r => { srv.closeAllConnections?.(); srv.close(() => r()); });
});

test("lexical mode: no automatic synthesis even with a chat model configured", async () => {
  let called = 0;
  const srv = http.createServer((req, res) => { called++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "x" } }] })); });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  const client = new LlmClient({ base: `http://127.0.0.1:${port}`, apiKey: "k", chatModel: "m" });
  const lex = {
    embedderKind: "local-hashing-lexical", hybrid: false,
    async search() { return [{ score: 0.35, chunk: { file: "a.ts", startLine: 1, endLine: 2, text: "x" } }]; },
  } as unknown as EmberEngine;
  const r = await answerQuestion(lex, "anything", 5, { client });
  assert.equal(called, 0, "lexical mode must not auto-synthesize");
  assert.match(r.text, /synthesis is unsupported/);
  await new Promise<void>(r => { srv.closeAllConnections?.(); srv.close(() => r()); });
});
