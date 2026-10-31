/** Local WASM semantic embedder: interface, batching, identity and honest
 * failures - hermetic via an injected pipeline stub (no model download). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalEmbedder, localEmbedderFromEnv, DEFAULT_LOCAL_EMBED_MODEL, type FeatureExtractor } from "../src/core/local-embedder.js";
import { embedderFromEnv, HashingEmbedder } from "../src/core/embedder.js";

function stub(dim: number, calls: string[][]): FeatureExtractor {
  return async (texts: string[]) => {
    calls.push(texts);
    const data = new Float32Array(texts.length * dim);
    texts.forEach((t, i) => { for (let j = 0; j < dim; j++) data[i * dim + j] = (t.length + j) / 100; });
    return { dims: [texts.length, dim], data };
  };
}

test("local embedder: kind carries the model; vectors are normalized to the configured dim", async () => {
  const calls: string[][] = [];
  const emb = new LocalEmbedder("Xenova/test-model", 8, (t, m) => { assert.equal(m, "Xenova/test-model"); return Promise.resolve(stub(8, calls)); });
  assert.equal(emb.kind, "local-wasm:Xenova/test-model");
  assert.notEqual(new LocalEmbedder("Xenova/other", 8).kind, emb.kind, "different local model = different embedding space identity");
  const out = await emb.embed(["hello world", "x"]);
  assert.equal(out.length, 2);
  assert.equal(out[0].length, 8);
  const norm = Math.sqrt(out[0].reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5, "unit-normalized");
});

test("local embedder: batches in 16s and caps text length", async () => {
  const calls: string[][] = [];
  const emb = new LocalEmbedder("m", 4, () => Promise.resolve(stub(4, calls)));
  const texts = Array.from({ length: 35 }, (_, i) => `t${i}`);
  texts[0] = "y".repeat(5000);
  const out = await emb.embed(texts);
  assert.equal(out.length, 35);
  assert.deepEqual(calls.map(c => c.length), [16, 16, 3], "16/16/3 batches");
  assert.equal(calls[0][0].length, 2000, "overlong text is capped at the model context guard");
});

test("local embedder: model dim mismatch fails honestly", async () => {
  const calls: string[][] = [];
  const emb = new LocalEmbedder("m", 8, () => Promise.resolve(stub(3, calls)));
  await assert.rejects(() => emb.embed(["a"]), /dim=3.*EMBER_LOCAL_EMBED_DIM=8/s);
});

test("localEmbedderFromEnv: off by default, explicit opt-in, validated dim", () => {
  assert.equal(localEmbedderFromEnv({}), null);
  assert.equal(localEmbedderFromEnv({ EMBER_API_BASE: "http://x" }), null, "provider config alone does not enable local");
  const on = localEmbedderFromEnv({ EMBER_LOCAL_EMBED: "1" });
  assert.equal(on?.kind, `local-wasm:${DEFAULT_LOCAL_EMBED_MODEL}`);
  assert.equal(on?.dim, 384);
  assert.equal(localEmbedderFromEnv({ EMBER_LOCAL_EMBED_MODEL: "Xenova/bge-small", EMBER_LOCAL_EMBED_DIM: "512" })?.dim, 512);
  assert.throws(() => localEmbedderFromEnv({ EMBER_LOCAL_EMBED: "1", EMBER_LOCAL_EMBED_DIM: "nope" }), /invalid EMBER_LOCAL_EMBED_DIM/);
});

test("embedderFromEnv precedence: provider > explicit lexical opt-out > local semantic default", () => {
  // Semantic is the default: no env at all selects the local WASM model.
  const dflt = embedderFromEnv({});
  assert.equal(dflt.kind, `local-wasm:${DEFAULT_LOCAL_EMBED_MODEL}`);
  assert.equal(dflt.dim, 384);
  // EMBER_LOCAL_EMBED=1 still selects the same default explicitly.
  assert.equal(embedderFromEnv({ EMBER_LOCAL_EMBED: "1" }).kind, `local-wasm:${DEFAULT_LOCAL_EMBED_MODEL}`);
  // Model overrides still apply.
  assert.equal(embedderFromEnv({ EMBER_LOCAL_EMBED_MODEL: "Xenova/bge-small", EMBER_LOCAL_EMBED_DIM: "512" }).kind, "local-wasm:Xenova/bge-small");
  // Explicit lexical opt-out.
  assert.ok(embedderFromEnv({ EMBER_LEXICAL: "1" }) instanceof HashingEmbedder);
  // Provider config alone is NOT enough: remote embeddings need the explicit
  // EMBER_REMOTE_EMBED=1 opt-in (retrieval is local by requirement).
  assert.equal(
    embedderFromEnv({ EMBER_API_BASE: "http://x", EMBER_API_KEY: "k", EMBER_EMBED_MODEL: "m", EMBER_LEXICAL: "1", EMBER_REMOTE_EMBED: "1" }).kind,
    "http-openai-compatible:m",
    "explicit remote opt-in wins over the lexical opt-out and the semantic default",
  );
  assert.equal(
    embedderFromEnv({ EMBER_API_BASE: "http://x", EMBER_API_KEY: "k", EMBER_EMBED_MODEL: "m" }).kind,
    `local-wasm:${DEFAULT_LOCAL_EMBED_MODEL}`,
    "provider config without EMBER_REMOTE_EMBED=1 must not send code remotely - local default wins",
  );
});

test("local embedder: a failed first download is an actionable error, and a ready line follows a successful load", async () => {
  const statuses: string[] = [];
  const failing = new LocalEmbedder("Xenova/test-model", 8,
    () => Promise.reject(new Error("ENETUNREACH 1.2.3.4:443")),
    m => statuses.push(m));
  await assert.rejects(() => failing.embed(["x"]), (e: Error) => {
    assert.match(e.message, /could not be loaded/, "names the failure");
    assert.match(e.message, /ENETUNREACH/, "keeps the underlying cause");
    assert.match(e.message, /check the network connection and retry/, "says what to do");
    assert.match(e.message, /works fully offline/, "sets the after-download expectation");
    assert.match(e.message, /EMBER_LEXICAL=1/, "offers the explicit opt-out");
    assert.match(e.message, /never falls back to lexical silently/, "restates the guarantee");
    return true;
  });

  const calls: string[][] = [];
  const ok = new LocalEmbedder("Xenova/test-model", 8, () => Promise.resolve(stub(8, calls)), m => statuses.push(m));
  await ok.embed(["x"]);
  assert.ok(statuses.some(m => m.includes("loading local semantic model")), "load announced");
  assert.ok(statuses.some(m => m.includes("model Xenova/test-model ready")), "completion confirmed");
});
