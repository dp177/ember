/**
 * Local-first persistence. Everything lives in <repo>/.ember/:
 *   meta.json    - config, counts, embedder identity, timestamps
 *   files.json   - per-file sha1/size at last index (incremental re-index)
 *   chunks.jsonl - one JSON CodeChunk + id per line
 *   vectors.f32  - raw Float32 vector data, row-major, aligned with chunk ids
 *   hnsw.json    - serialized graph topology
 *   notes.jsonl  - cross-session agent notes (see notes.ts)
 * No external database; the directory can be deleted to reset.
 *
 * Saves are atomic at the directory level: the new file set is staged in a
 * sibling directory and swapped in with renames (atomic on the same
 * filesystem), so a crash mid-save can never leave a half-written mix of
 * old and new files. Files Ember does not own (notes.jsonl, usage.jsonl,
 * anything future) are carried into the new set before the swap. Worst-case
 * crash between the two renames leaves .ember.backup-<pid> next to a
 * missing .ember; load() then fails honestly and says to rebuild.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { HnswIndex } from "./hnsw.js";
import type { CodeChunk } from "./chunker.js";

export interface ChunkRecord extends CodeChunk { id: number; }

export interface IndexMeta {
  version: 1;
  repoRoot: string;
  embedderKind: string;
  dim: number;
  chunkCount: number;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileHash { sha1: string; size: number; }
export type FileHashMap = Record<string, FileHash>;

export class EmberStore {
  readonly dir: string;
  constructor(readonly repoRoot: string) {
    this.dir = path.join(repoRoot, ".ember");
  }

  async exists(): Promise<boolean> {
    try { await fs.access(path.join(this.dir, "meta.json")); return true; }
    catch { return false; }
  }

  async save(meta: IndexMeta, chunks: ChunkRecord[], vectors: Float32Array[], index: HnswIndex, fileHashes?: FileHashMap): Promise<void> {
    const parent = path.dirname(this.dir);
    const tmp = `${this.dir}.tmp-${process.pid}`;
    const backup = `${this.dir}.backup-${process.pid}`;
    // Clear staging dirs left by any crashed earlier save in this repo.
    for (const d of await fs.readdir(parent).catch(() => [] as string[])) {
      if (d.startsWith(".ember.tmp-") || d.startsWith(".ember.backup-")) {
        await fs.rm(path.join(parent, d), { recursive: true, force: true });
      }
    }
    await fs.mkdir(tmp, { recursive: true });
    // Carry over files this save does not own (notes, usage log, ...).
    await fs.cp(this.dir, tmp, { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(tmp, "meta.json"), JSON.stringify(meta, null, 2));
    const lines = chunks.map(c => JSON.stringify(c)).join("\n") + "\n";
    await fs.writeFile(path.join(tmp, "chunks.jsonl"), lines);
    const buf = Buffer.alloc(vectors.length * meta.dim * 4);
    vectors.forEach((v, i) => { Buffer.from(v.buffer, v.byteOffset, meta.dim * 4).copy(buf, i * meta.dim * 4); });
    await fs.writeFile(path.join(tmp, "vectors.f32"), buf);
    await fs.writeFile(path.join(tmp, "hnsw.json"), JSON.stringify(index.toJSON()));
    if (fileHashes) await fs.writeFile(path.join(tmp, "files.json"), JSON.stringify(fileHashes));
    // Swap: move the live set aside, move the staged set in, drop the old.
    await fs.rename(this.dir, backup).catch(() => {}); // no prior store on first save
    try {
      await fs.rename(tmp, this.dir);
    } catch (e) {
      await fs.rename(backup, this.dir).catch(() => {}); // best-effort rollback
      throw e;
    }
    await fs.rm(backup, { recursive: true, force: true });
  }

  async load(): Promise<{ meta: IndexMeta; chunks: ChunkRecord[]; index: HnswIndex }> {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(this.dir, "meta.json"), "utf8")) as IndexMeta;
      const lines = (await fs.readFile(path.join(this.dir, "chunks.jsonl"), "utf8")).trim().split("\n");
      const chunks = lines.map(l => JSON.parse(l)) as ChunkRecord[];
      const buf = await fs.readFile(path.join(this.dir, "vectors.f32"));
      const vectors = new Map<number, Float32Array>();
      for (let i = 0; i < chunks.length; i++) {
        vectors.set(chunks[i].id, new Float32Array(buf.buffer.slice(buf.byteOffset + i * meta.dim * 4, buf.byteOffset + (i + 1) * meta.dim * 4)));
      }
      const hnswJson = JSON.parse(await fs.readFile(path.join(this.dir, "hnsw.json"), "utf8"));
      const index = HnswIndex.fromJSON(hnswJson, vectors);
      return { meta, chunks, index };
    } catch (e) {
      throw new Error(
        `index store at ${this.dir} is corrupt or incomplete (${e instanceof Error ? e.message : String(e)}). Rebuild it: ember index --full`
      );
    }
  }

  async readMeta(): Promise<IndexMeta | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir, "meta.json"), "utf8")); }
    catch { return null; }
  }

  async loadFileHashes(): Promise<FileHashMap | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir, "files.json"), "utf8")); }
    catch { return null; }
  }
}
