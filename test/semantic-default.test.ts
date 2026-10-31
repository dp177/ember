/** Semantic-as-default product path: the UI serves semantic indexes, a
 * semantic failure is an honest error (never a silent lexical fallback),
 * and the resolved embedder choice carries a disclosable reason. Hermetic:
 * the WASM pipeline is stubbed, no model download. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { LocalEmbedder, DEFAULT_LOCAL_EMBED_MODEL, type FeatureExtractor } from "../src/core/local-embedder.js";
import { embedderChoiceFromEnv } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";
import { createUiServer } from "../src/ui/server.js";

const OK = "export function okThing(): number { return 1; }\n";

function stub(dim: number): FeatureExtractor {
  return async (texts: string[]) => {
    const data = new Float32Array(texts.length * dim);
    texts.forEach((t, i) => { for (let j = 0; j < dim; j++) data[i * dim + j] = (t.length + j) / 100; });
    return { dims: [texts.length, dim], data };
  };
}

async function mkrepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-semdef-"));
  for (const [rel, content] of Object.entries(files)) await fs.writeFile(path.join(dir, rel), content);
  return dir;
}

test("choice disclosure: default names local semantic; provider and lexical choices name themselves and their tradeoffs", () => {
  const dflt = embedderChoiceFromEnv({});
  assert.equal(dflt.embedder.kind, `local-wasm:${DEFAULT_LOCAL_EMBED_MODEL}`);
  assert.match(dflt.reason, /local semantic default/);
  // Legacy provider config alone must NOT route code/query text remotely:
  // retrieval is local by requirement; the choice carries a warning instead.
  const legacy = embedderChoiceFromEnv({ EMBER_API_BASE: "http://x", EMBER_API_KEY: "k", EMBER_EMBED_MODEL: "m" });
  assert.equal(legacy.embedder.kind, `local-wasm:${DEFAULT_LOCAL_EMBED_MODEL}`);
  assert.match(legacy.warning ?? "", /EMBER_REMOTE_EMBED=1/);
  const provider = embedderChoiceFromEnv({ EMBER_API_BASE: "http://x", EMBER_API_KEY: "k", EMBER_EMBED_MODEL: "m", EMBER_REMOTE_EMBED: "1" });
  assert.equal(provider.embedder.kind, "http-openai-compatible:m");
  assert.match(provider.reason, /explicit remote embedding opt-in.*leaves this machine/, "provider selection must disclose that text leaves the machine");
  const lexical = embedderChoiceFromEnv({ EMBER_LEXICAL: "1" });
  assert.equal(lexical.embedder.kind, "local-hashing-lexical");
  assert.match(lexical.reason, /explicit lexical opt-out.*not the product default/s);
});

test("ui: a semantic index is served end-to-end (search works on the default path)", async () => {
  const dir = await mkrepo({ "ok.ts": OK });
  try {
    const emb = new LocalEmbedder(DEFAULT_LOCAL_EMBED_MODEL, 384, () => Promise.resolve(stub(384)));
    const r = await indexRepo(dir, emb);
    assert.equal(r.dim, 384);
    const server = createUiServer(dir, { embedder: emb });
    await new Promise<void>(res => server.listen(0, "127.0.0.1", res));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const resp = await fetch(`${base}/api/search?q=okThing`);
      assert.equal(resp.status, 200);
      const body = await resp.json() as any;
      assert.ok(Array.isArray(body.hits) && body.hits.length > 0, "semantic-path search returns hits");
      assert.equal(body.hits[0].file, "ok.ts");
    } finally { await new Promise<void>(res => server.close(() => res())); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("semantic failure is an error, never a silent lexical fallback", async () => {
  const dir = await mkrepo({ "ok.ts": OK });
  try {
    const broken = new LocalEmbedder(DEFAULT_LOCAL_EMBED_MODEL, 384, () => Promise.reject(new Error("model download failed: network unreachable")));
    await assert.rejects(() => indexRepo(dir, broken), /model download failed/, "indexing fails honestly");
    // Index a good semantic index, then break the model: search must fail too.
    const good = new LocalEmbedder(DEFAULT_LOCAL_EMBED_MODEL, 384, () => Promise.resolve(stub(384)));
    await indexRepo(dir, good);
    const server = createUiServer(dir, { embedder: broken });
    await new Promise<void>(res => server.listen(0, "127.0.0.1", res));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const resp = await fetch(`${base}/api/search?q=okThing`);
      assert.equal(resp.status, 500, "failed semantic model is a server error, not lexical results");
      const body = await resp.json() as any;
      assert.match(JSON.stringify(body), /model download failed/);
    } finally { await new Promise<void>(res => server.close(() => res())); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
