/** Freshness surfacing: status must tell stale from fresh exactly, using
 * the same hashes incremental indexing trusts. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HashingEmbedder } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";
import { EmberStore } from "../src/core/store.js";
import { checkFreshness } from "../src/core/freshness.js";

test("freshness: clean tree after index, then changed/added/deleted counted exactly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-fresh-"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaFresh(): number { return 1; }\n");
    await fs.writeFile(path.join(dir, "b.ts"), "export function betaFresh(): number { return 2; }\n");
    await indexRepo(dir, new HashingEmbedder());
    const store = new EmberStore(dir);

    const clean = await checkFreshness(store, dir);
    assert.deepEqual(clean, { checked: 2, changed: 0, added: 0, deleted: 0 }, "just-indexed tree is fresh");

    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaFresh(): number { return 10; }\n");
    await fs.writeFile(path.join(dir, "c.ts"), "export function gammaFresh(): number { return 3; }\n");
    await fs.rm(path.join(dir, "b.ts"));
    const stale = await checkFreshness(store, dir);
    assert.deepEqual(stale, { checked: 2, changed: 1, added: 1, deleted: 1 }, "each drift class counted");

    await indexRepo(dir, new HashingEmbedder());
    const refreshed = await checkFreshness(store, dir);
    assert.deepEqual(refreshed, { checked: 2, changed: 0, added: 0, deleted: 0 }, "re-index returns to fresh");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
