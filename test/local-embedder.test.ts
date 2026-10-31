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

test("embedderFromEnv precedence: provider > local > lexical", () => {
  assert.ok(embedderFromEnv({}) instanceof HashingEmbedder);
  assert.equal(embedderFromEnv({ EMBER_LOCAL_EMBED: "1" }).kind, `local-wasm:${DEFAULT_LOCAL_EMBED_MODEL}`);
  assert.equal(
    embedderFromEnv({ EMBER_API_BASE: "http://x", EMBER_API_KEY: "k", EMBER_EMBED_MODEL: "m", EMBER_LOCAL_EMBED: "1" }).kind,
    "http-openai-compatible:m",
    "explicit provider config wins over local",
  );
});
