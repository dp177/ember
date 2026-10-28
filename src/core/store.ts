/**
 * Local-first persistence. Everything lives in <repo>/.ember/:
 *   meta.json    - config, counts, embedder identity, timestamps
 *   files.json   - per-file sha1/size at last index (incremental re-index)
 *   chunks.jsonl - one JSON CodeChunk + id per line
 *   vectors.f32  - raw Float32 vector data, row-major, aligned with chunk ids
 *   hnsw.json    - serialized graph topology
 *   notes.jsonl  - cross-session agent notes (see notes.ts)
 * No external database; the directory can be deleted to reset.
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
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, "meta.json"), JSON.stringify(meta, null, 2));
    const lines = chunks.map(c => JSON.stringify(c)).join("\n") + "\n";
    await fs.writeFile(path.join(this.dir, "chunks.jsonl"), lines);
    const buf = Buffer.alloc(vectors.length * meta.dim * 4);
    vectors.forEach((v, i) => { Buffer.from(v.buffer, v.byteOffset, meta.dim * 4).copy(buf, i * meta.dim * 4); });
    await fs.writeFile(path.join(this.dir, "vectors.f32"), buf);
    await fs.writeFile(path.join(this.dir, "hnsw.json"), JSON.stringify(index.toJSON()));
    if (fileHashes) await fs.writeFile(path.join(this.dir, "files.json"), JSON.stringify(fileHashes));
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
