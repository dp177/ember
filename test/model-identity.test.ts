/** Model identity is part of embedder identity. Two embedding models with
 * the same dimension produce different vector spaces; silently mixing their
 * vectors in one index corrupts search. Switching EMBER_EMBED_MODEL must
 * therefore force an honest full rebuild. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import { HttpEmbedder } from "../src/core/embedder.js";
import { LlmClient } from "../src/core/llm.js";
import { indexRepo } from "../src/core/indexer.js";
import { EmberStore } from "../src/core/store.js";

test("HttpEmbedder kind carries the model; a same-dim model switch forces a full re-index", async () => {
  assert.notEqual(
    new HttpEmbedder(new LlmClient({ base: "http://x", apiKey: "k", embedModel: "model-a", embedDim: 4 }), undefined, "model-a", 4).kind,
    new HttpEmbedder(new LlmClient({ base: "http://x", apiKey: "k", embedModel: "model-b", embedDim: 4 }), undefined, "model-b", 4).kind,
    "same-dim models must not share an embedder kind",
  );

  let calls = 0;
  const srv = http.createServer((req, res) => {
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
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-model-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaOne(): number { return 1; }\n");
    const mk = (model: string) =>
      new HttpEmbedder(new LlmClient({ base, apiKey: "k", embedModel: model, embedDim: 4 }), undefined, model, 4);

    const first = await indexRepo(dir, mk("model-a"));
    assert.equal(first.incremental, false);
    const afterFirst = calls;

    // Nothing changed on disk: with a model-blind kind this second index
    // would reuse every vector. With model identity it must re-embed all.
    const logs: string[] = [];
    const second = await indexRepo(dir, mk("model-b"), m => logs.push(m));
    assert.ok(calls > afterFirst, "vectors are re-embedded under the new model, not reused");
    assert.ok(logs.some(l => /embedder changed/.test(l)), "the model switch is disclosed in the index log");
    assert.equal(second.incremental, false, "model switch is a full rebuild, not incremental reuse");
    const meta = await new EmberStore(dir).readMeta();
    assert.equal(meta?.embedderKind, "http-openai-compatible:model-b");
  } finally {
    (srv as any).closeAllConnections?.();
    await new Promise(r => srv.close(() => r(null)));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
