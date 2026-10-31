/**
 * Freshness: is the index still in step with the working tree? Compares
 * the live scan against the per-file sha1 map saved at index time. This
 * is the same signal incremental indexing uses, surfaced to the user.
 */
import { createHash } from "node:crypto";
import { scanRepo } from "./scanner.js";
import { promises as fsx } from "node:fs";
import * as pathx from "node:path";
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

/**
 * Cheap drift signal for the query path: how many scanned files carry an
 * mtime after the last index save. mtime is a heuristic - a touch without
 * an edit counts, a rewrite with a preserved mtime does not - so this is
 * a "may be stale" hint, never a verdict. Full hash truth lives in
 * checkFreshness (ember status).
 */
export async function mtimeDrift(store: EmberStore, root: string): Promise<number | null> {
  const meta = await store.readMeta();
  if (!meta?.updatedAt) return null;
  const since = Date.parse(meta.updatedAt);
  const hashes = await store.loadFileHashes();
  if (!hashes) return null;
  // Stat exactly the indexed paths (no tree walk): a full recursive walk
  // cost ~80-110ms on 2,102 files even with per-directory concurrency
  // (measured) - half of total query latency. Statting the known set with
  // a small pool is single-digit milliseconds. Scope: indexed files that
  // changed. A brand-new file is not counted here (nothing references it
  // yet); the hash-accurate `ember status` covers new files, and the hint
  // already says "may be stale".
  const paths = Object.keys(hashes);
  let n = 0, i = 0;
  const POOL = 64;
  async function worker(): Promise<void> {
    while (i < paths.length) {
      const rel = paths[i++];
      try {
        const st = await fsx.stat(pathx.join(root, rel));
        if (st.mtimeMs > since) n++;
      } catch { /* deleted files are not countable drift by mtime */ }
    }
  }
  await Promise.all(Array.from({ length: POOL }, worker));
  return n;
}
