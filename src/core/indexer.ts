/** Index pipeline: scan -> chunk -> embed -> HNSW -> persist.
 * Incremental by default: per-file sha1 in .ember/files.json; unchanged files
 * keep their chunks and vectors, changed files are re-chunked but chunks whose
 * content is unchanged keep their vectors (chunk-level reuse), and chunks from
 * deleted files are dropped. `full` forces a from-scratch rebuild. */

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { scanRepoCapped } from "./scanner.js";
import { chunkFile, type CodeChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import { HnswIndex } from "./hnsw.js";
import { EmberStore, type ChunkRecord, type IndexMeta, type FileHashMap } from "./store.js";

export interface IndexOptions { full?: boolean; }

/** Resumable-indexing checkpoint, stored in a SIBLING directory
 * (.ember.checkpoint/) - never in the live .ember/ generation, so an
 * interrupted run always leaves the previous COMPLETE index searchable.
 * The checkpoint carries the embedder identity; a model/dim change
 * invalidates it, and per-file sha1s are re-validated against the current
 * source on resume (changed files are simply re-embedded). */
interface Checkpoint {
  embedderKind: string;
  dim: number;
  hashes: FileHashMap; // only files FULLY processed so far
  chunkCount: number;
}

const checkpointDir = (root: string) => `${root}/.ember.checkpoint`;

async function writeCheckpoint(root: string, cp: Checkpoint, chunks: ChunkRecord[], vectors: Float32Array[]): Promise<void> {
  const dir = checkpointDir(root);
  const tmp = `${dir}.tmp-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(`${tmp}/checkpoint.json`, JSON.stringify(cp));
  // Batched writes: one joined string of every chunk is a transient copy of
  // the whole corpus in memory (~150 MB at 14,905 chunks), repeated per checkpoint.
  const ch = await fs.open(`${tmp}/chunks.jsonl`, "w");
  try {
    for (let b = 0; b < chunks.length; b += 500) {
      await ch.write(chunks.slice(b, b + 500).map(c => JSON.stringify(c)).join("\n") + "\n");
    }
  } finally { await ch.close(); }
  const buf = Buffer.alloc(vectors.length * cp.dim * 4);
  vectors.forEach((v, i) => { Buffer.from(v.buffer, v.byteOffset, cp.dim * 4).copy(buf, i * cp.dim * 4); });
  await fs.writeFile(`${tmp}/vectors.f32`, buf);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rename(tmp, dir);
}

async function readCheckpoint(root: string, embedder: Embedder): Promise<{ cp: Checkpoint; chunks: ChunkRecord[]; vectors: Float32Array[] } | null> {
  const dir = checkpointDir(root);
  try {
    const cp = JSON.parse(await fs.readFile(`${dir}/checkpoint.json`, "utf8")) as Checkpoint;
    if (cp.embedderKind !== embedder.kind || cp.dim !== embedder.dim) return null; // model change: discard
    const chunks = (await fs.readFile(`${dir}/chunks.jsonl`, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as ChunkRecord);
    const raw = await fs.readFile(`${dir}/vectors.f32`);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < chunks.length; i++) vectors.push(new Float32Array(raw.buffer, raw.byteOffset + i * cp.dim * 4, cp.dim).slice());
    if (vectors.length !== cp.chunkCount) return null; // torn checkpoint: discard
    return { cp, chunks, vectors };
  } catch { return null; }
}

/** Status surfaces read the checkpoint WITHOUT an embedder: presence is
 * reported, model/source validation happens on the actual resume. */
export async function readCheckpointInfo(root: string): Promise<{ chunkCount: number; embedderKind: string; dim: number; files: number } | null> {
  try {
    const cp = JSON.parse(await fs.readFile(`${checkpointDir(root)}/checkpoint.json`, "utf8")) as Checkpoint;
    return { chunkCount: cp.chunkCount, embedderKind: cp.embedderKind, dim: cp.dim, files: Object.keys(cp.hashes).length };
  } catch { return null; }
}

async function clearCheckpoint(root: string): Promise<void> {
  await fs.rm(checkpointDir(root), { recursive: true, force: true });
}

export interface IndexResult {
  files: number;
  chunks: number;
  dim: number;
  /** chunks reused from unchanged files (0 on fresh/full builds) */
  kept: number;
  /** chunks inside changed files whose content was unchanged (vector reused) */
  reused: number;
  /** chunks actually embedded this run */
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
  let canReuse = oldVectors !== null && oldChunks.length > 0;

  // Resumable indexing: a valid checkpoint from an interrupted run takes
  // over as the old state (it already includes everything reused from the
  // live index). Model/dim changes or a torn checkpoint discard it.
  if (opts.full) {
    await clearCheckpoint(root);
  } else {
    const resumed = await readCheckpoint(root, embedder);
    if (resumed) {
      oldChunks = resumed.chunks;
      oldVectors = new Map(resumed.chunks.map((c, i) => [c.id, resumed.vectors[i]]));
      oldHashes = resumed.cp.hashes;
      canReuse = true;
      log(`resuming from checkpoint: ${resumed.chunks.length} chunks already embedded`);
    }
  }

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

  // Chunk-level reuse: re-chunking a changed file rebuilds every chunk of
  // it, but a chunk whose full embed input (path + symbol + text) is unchanged
  // keeps its vector. Measured motivation: 241 one-line appends on the vite
  // repo re-chunked 7,426 chunks of which only ~241 actually needed embedding.
  const reusableByInputHash = new Map<string, Float32Array>();
  if (canReuse) {
    for (const c of oldChunks) {
      const h = sha1(`${c.file}${c.symbol ? " :: " + c.symbol : ""}\n${c.text}`);
      if (!reusableByInputHash.has(h)) {
        const v = oldVectors!.get(c.id);
        if (v) reusableByInputHash.set(h, v);
      }
    }
  }

  // Peak-RSS control before the embed phase: everything still needed from
  // the previous index was copied into kept/keptVectors/reusableByInputHash,
  // and file contents are re-chunked below into freshByFile.
  oldChunks = [];
  oldVectors = null;
  oldHashes = {};

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

  const freshByFile: { file: string; chunks: CodeChunk[] }[] = [];
  for (const f of changed) {
    const fc = chunkFile(f.relPath, f.content);
    if (fc.length > 0) freshByFile.push({ file: f.relPath, chunks: fc });
  }
  const freshTotal = freshByFile.reduce((n, f) => n + f.chunks.length, 0);
  // Free the scanned file contents: chunk texts are all the embed phase needs.
  for (const f of files) f.content = "";

  const embedInput = (c: CodeChunk): string => `${c.file}${c.symbol ? " :: " + c.symbol : ""}\n${c.text}`;
  let chunkReuse = 0;
  for (const f of freshByFile) for (const c of f.chunks) if (reusableByInputHash.has(sha1(embedInput(c)))) chunkReuse++;

  if (freshByFile.length > 0) {
    log(`embedding ${freshTotal - chunkReuse} new/changed chunks from ${freshByFile.length} files${chunkReuse ? ` (${chunkReuse} unchanged chunks keep their vectors)` : ""} (${embedder.kind}) ...`);
    // Per-file embedding makes every file an atomic resume unit: a file's
    // hash enters the checkpoint only after ALL its chunks are embedded.
    const processedHashes: FileHashMap = {};
    for (const c of chunks) {
      const nh = newHashes[c.file];
      if (nh) processedHashes[c.file] = nh; // kept (unchanged) files are complete already
    }
    let doneFiles = 0, doneChunks = 0, sinceCheckpoint = 0, sinceProgress = 0, embeddedSoFar = 0;
    const CHECKPOINT_EVERY_FILES = parseInt(process.env.EMBER_CHECKPOINT_FILES ?? "", 10) || 200;
    const CHECKPOINT_EVERY_CHUNKS = parseInt(process.env.EMBER_CHECKPOINT_CHUNKS ?? "", 10) || 2000;
    // Progress is visible between checkpoints: a long embed no longer sits
    // silent for minutes. Log-only; checkpoints stay on their own cadence.
    const PROGRESS_EVERY_FILES = parseInt(process.env.EMBER_PROGRESS_FILES ?? "", 10) || 100;
    // First checkpoint comes early (50 files / 500 chunks): a killed run then
    // resumes close to the death point instead of from zero. Later checkpoints
    // stay on the normal cadence, plus a time-based cadence (default 30s,
    // EMBER_CHECKPOINT_MS) so slow large-corpus runs never lose more than
    // ~30s of embedding to a kill - measured motivation: on a 2-core/2 GB
    // box embedding runs at ~14 chunks/s, so the 2000-chunk cadence meant
    // ~2 minutes of lost work per interruption. Per-file atomicity is
    // unchanged: a file's hash enters the checkpoint only after all its
    // chunks are resolved.
    let wroteEarlyCheckpoint = false;
    const CHECKPOINT_MS = parseInt(process.env.EMBER_CHECKPOINT_MS ?? "", 10) || 30000;
    let lastCheckpointAt = Date.now();
    for (const { file, chunks: fc } of freshByFile) {
      const inputs = fc.map(embedInput);
      // Resolve each chunk from the reuse map first; embed only the rest.
      const resolved: (Float32Array | null)[] = inputs.map(inp => reusableByInputHash.get(sha1(inp)) ?? null);
      const toEmbed = inputs.filter((_, j) => !resolved[j]);
      if (toEmbed.length > 0) {
        const vs = await embedder.embed(toEmbed);
        let k = 0;
        for (let j = 0; j < resolved.length; j++) if (!resolved[j]) resolved[j] = vs[k++];
      }
      resolved.forEach((v, j) => {
        chunks.push({ ...fc[j], id: chunks.length });
        vectors.push(v!);
        index?.add(chunks.length - 1, v!);
      });
      embeddedSoFar += toEmbed.length;
      processedHashes[file] = newHashes[file];
      doneFiles++; doneChunks += fc.length; sinceCheckpoint += fc.length; sinceProgress += fc.length;
      const earlyDue = !wroteEarlyCheckpoint && (doneFiles >= 50 || sinceCheckpoint >= 500);
      const timeDue = Date.now() - lastCheckpointAt >= CHECKPOINT_MS;
      if (earlyDue || timeDue || doneFiles % CHECKPOINT_EVERY_FILES === 0 || sinceCheckpoint >= CHECKPOINT_EVERY_CHUNKS) {
        await writeCheckpoint(root, { embedderKind: embedder.kind, dim: embedder.dim, hashes: processedHashes, chunkCount: chunks.length }, chunks, vectors);
        wroteEarlyCheckpoint = true;
        lastCheckpointAt = Date.now();
        sinceCheckpoint = 0; sinceProgress = 0;
        log(`processed ${doneChunks}/${freshTotal} chunks (${doneFiles}/${freshByFile.length} files, ${embeddedSoFar} newly embedded) - checkpoint saved`);
      } else if (doneFiles % PROGRESS_EVERY_FILES === 0) {
        log(`processed ${doneChunks}/${freshTotal} chunks (${doneFiles}/${freshByFile.length} files, ${embeddedSoFar} newly embedded)`);
      }
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
  await clearCheckpoint(root); // completed: the resume state is no longer needed
  return {
    files: files.length,
    chunks: chunks.length,
    dim: embedder.dim,
    kept: kept.length,
    reused: chunkReuse,
    embedded: freshTotal - chunkReuse,
    incremental: canReuse,
    capped: scan.capped,
  };
}
