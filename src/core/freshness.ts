/**
 * Freshness: is the index still in step with the working tree? Compares
 * the live scan against the per-file sha1 map saved at index time. This
 * is the same signal incremental indexing uses, surfaced to the user.
 */
import { createHash } from "node:crypto";
import { scanRepo } from "./scanner.js";
import type { EmberStore } from "./store.js";

export interface Freshness {
  checked: number;
  changed: number;
  added: number;
  deleted: number;
}

/** null when the index predates files.json (full re-index records it). */
export async function checkFreshness(store: EmberStore, root: string): Promise<Freshness | null> {
  const indexed = await store.loadFileHashes();
  if (!indexed) return null;
  const files = await scanRepo(root);
  const seen = new Set<string>();
  let changed = 0, added = 0;
  for (const f of files) {
    seen.add(f.relPath);
    const h = indexed[f.relPath];
    if (!h) { added++; continue; }
    const sha1 = createHash("sha1").update(f.content).digest("hex");
    if (h.sha1 !== sha1 || h.size !== f.content.length) changed++;
  }
  let deleted = 0;
  for (const p of Object.keys(indexed)) if (!seen.has(p)) deleted++;
  return { checked: files.length, changed, added, deleted };
}
