/** Index pipeline: scan -> chunk -> embed -> HNSW -> persist.
 * Incremental by default: per-file sha1 in .ember/files.json; unchanged files
 * keep their chunks and vectors, only new/changed files are re-embedded, and
 * chunks from deleted files are dropped. `full` forces a from-scratch rebuild. */

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { scanRepoCapped } from "./scanner.js";
import { chunkFile, type CodeChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import { HnswIndex } from "./hnsw.js";
import { EmberStore, type ChunkRecord, type IndexMeta, type FileHashMap } from "./store.js";

export interface IndexOptions { full?: boolean; }

export interface IndexResult {
  files: number;
  chunks: number;
  dim: number;
  /** chunks reused from unchanged files (0 on fresh/full builds) */
  kept: number;
  /** chunks embedded this run */
  embedded: number;
  /** true when an existing compatible index was reused */
  incremental: boolean;
  /** true when the scan hit the file cap: the index is PARTIAL */
  capped: boolean;
}

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

export async function indexRepo(
  root: string,
  embedder: Embedder,
  onProgress?: (msg: string) => void,
  opts: IndexOptions = {},
): Promise<IndexResult> {
  const log = onProgress ?? (() => {});
  const rootStat = await fs.stat(root).catch(() => null);
  if (!rootStat?.isDirectory()) throw new Error(`repo root not found or not a directory: ${root}`);
  const store = new EmberStore(root);

  // Load previous index state for incremental reuse.
  let oldChunks: ChunkRecord[] = [];
  let oldHashes: FileHashMap = {};
  let oldMeta: IndexMeta | null = null;
  let oldVectors: Map<number, Float32Array> | null = null;
  if (!opts.full) {
    oldMeta = await store.readMeta();
    if (oldMeta) {
      if (oldMeta.dim === embedder.dim && oldMeta.embedderKind === embedder.kind) {
        try {
          const loaded = await store.load();
          oldChunks = loaded.chunks;
          oldVectors = loaded.vectors;
          oldHashes = (await store.loadFileHashes()) ?? {};
        } catch {
          log("existing index unreadable - falling back to a full re-index");
          oldChunks = [];
        }
      } else {
        log(`embedder changed (${oldMeta.embedderKind} dim=${oldMeta.dim} -> ${embedder.kind} dim=${embedder.dim}) - full re-index`);
      }
    }
  }
  const canReuse = oldVectors !== null && oldChunks.length > 0;

  log(`scanning ${root} ...`);
  // The scan cap keeps indexing memory bounded: scanRepo holds every
  // scanned file's content at once, and each chunk costs ~10 KB of query
  // memory (measured 60,190 chunks -> 623 MB peak RSS). EMBER_MAX_FILES
  // raises it deliberately; the PARTIAL warning fires whenever it binds.
  const maxFiles = parseInt(process.env.EMBER_MAX_FILES ?? "", 10) || undefined;
  const scan = await scanRepoCapped(root, maxFiles);
  const files = scan.files;
  if (scan.capped) log(`warning: file limit reached (${scan.cap}) - index is PARTIAL; raise EMBER_MAX_FILES to index more (memory grows ~10 KB per chunk)`);
  const newHashes: FileHashMap = {};
  for (const f of files) newHashes[f.relPath] = { sha1: sha1(f.content), size: f.content.length };

  // Kept chunks: file still present with the same sha1; vectors reused.
  const kept: ChunkRecord[] = [];
  const keptVectors: Float32Array[] = [];
  if (canReuse) {
    for (const c of oldChunks) {
      const nh = newHashes[c.file];
      const oh = oldHashes[c.file];
      if (!nh || !oh || nh.sha1 !== oh.sha1) continue; // deleted or modified
      const v = oldVectors!.get(c.id);
      if (!v) continue;
      kept.push(c);
      keptVectors.push(v);
    }
  }

  const changed = files.filter(f => oldHashes[f.relPath]?.sha1 !== newHashes[f.relPath].sha1);
  log(`${files.length} files: ${files.length - changed.length} unchanged (${kept.length} chunks kept), ${changed.length} new/changed`);

  // Reassign sequential ids; vectors stay aligned with chunks.
  const chunks: ChunkRecord[] = [];
  const vectors: Float32Array[] = [];
  // The HNSW graph is an experimental opt-in (EMBER_HNSW=1). Default is a
  // flat exact scan: measured parity with the graph on the frozen corpus,
  // and it removes the superlinear graph-build cost that made large repos
  // unindexable (measured: 15.9s for 1200 dim-1024 vectors, growing ~n^1.5).
  const index = process.env.EMBER_HNSW === "1" ? new HnswIndex(embedder.dim, { seed: 42 }) : null;
  for (let i = 0; i < kept.length; i++) {
    chunks.push({ ...kept[i], id: chunks.length });
    vectors.push(keptVectors[i]);
    index?.add(chunks.length - 1, keptVectors[i]);
  }

  const fresh: CodeChunk[] = [];
  for (const f of changed) for (const c of chunkFile(f.relPath, f.content)) fresh.push(c);

  if (fresh.length > 0) {
    log(`embedding ${fresh.length} new/changed chunks (${embedder.kind}) ...`);
    const BATCH = 64;
    for (let i = 0; i < fresh.length; i += BATCH) {
      const batch = fresh.slice(i, i + BATCH);
      const inputs = batch.map(c => `${c.file}${c.symbol ? " :: " + c.symbol : ""}\n${c.text}`);
      const vs = await embedder.embed(inputs);
      vs.forEach((v, j) => {
        chunks.push({ ...batch[j], id: chunks.length });
        vectors.push(v);
        index?.add(chunks.length - 1, v);
      });
      if (fresh.length > BATCH) log(`embedded ${Math.min(i + BATCH, fresh.length)}/${fresh.length}`);
    }
  }

  const now = new Date().toISOString();
  const meta: IndexMeta = {
    version: 1,
    repoRoot: root,
    embedderKind: embedder.kind,
    dim: embedder.dim,
    chunkCount: chunks.length,
    fileCount: files.length,
    createdAt: oldMeta?.createdAt ?? now,
    updatedAt: now,
    indexMode: index ? "hnsw" : "flat",
    capped: scan.capped,
  };
  await store.save(meta, chunks, vectors, index, newHashes);
  return {
    files: files.length,
    chunks: chunks.length,
    dim: embedder.dim,
    kept: kept.length,
    embedded: fresh.length,
    incremental: canReuse,
    capped: scan.capped,
  };
}
