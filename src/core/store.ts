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
 * Writes: the new file set is staged in a sibling directory and swapped in
 * with two renames. A crash mid-save can therefore never leave a
 * half-written mix of old and new files inside .ember; at worst the set is
 * briefly absent, and the complete pre-swap set sits in .ember.backup-<pid>.
 * That crash is recovered automatically on the next open (see recover()).
 * Files Ember does not own (notes.jsonl, usage.jsonl, anything future) are
 * carried into the new set before the swap.
 *
 * Concurrency contract (local tool, one writer at a time): writers
 * (index saves) and recovery are serialized by a lock file at
 * <repo>/.ember.lock; a second writer fails fast with a clear error, and
 * readers never move or delete backup dirs while a writer holds the lock.
 * Each saved set carries a generation id (meta.generation + generation
 * file); a torn read that mixes two sets is detected by generation
 * mismatch or consistency validation and retried once before failing.
 * A lock left by a crashed process is reclaimed when its pid is dead or
 * it is older than 10 minutes.
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
  generation?: string;
}

export interface FileHash { sha1: string; size: number; }
export type FileHashMap = Record<string, FileHash>;

const LOCK_STALE_MS = 10 * 60 * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class EmberStore {
  readonly dir: string;
  constructor(readonly repoRoot: string) {
    this.dir = path.join(repoRoot, ".ember");
  }

  async exists(): Promise<boolean> {
    try { await fs.access(path.join(this.dir, "meta.json")); return true; }
    catch { return false; }
  }

  private get lockPath(): string {
    return path.join(this.repoRoot, ".ember.lock");
  }

  /** True while another process holds the write lock. */
  private async writerActive(): Promise<boolean> {
    try { await fs.access(this.lockPath); return true; } catch { return false; }
  }

  private async lockIsStale(): Promise<boolean> {
    try {
      const raw = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as { pid?: number; at?: number };
      if (typeof raw.at === "number" && Date.now() - raw.at > LOCK_STALE_MS) return true;
      if (typeof raw.pid === "number") {
        try { process.kill(raw.pid, 0); return false; } catch { return true; }
      }
      return false;
    } catch { return true; } // unreadable or malformed lock: treat as stale
  }

  /** Serialize writers and recovery. Fails fast while another writer holds the lock. */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    let handle: fs.FileHandle | null = null;
    for (let attempt = 0; attempt < 2 && !handle; attempt++) {
      try {
        handle = await fs.open(this.lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST" && attempt === 0 && await this.lockIsStale()) {
          await fs.rm(this.lockPath, { force: true });
          continue;
        }
        if (code === "EEXIST") {
          throw new Error("another ember process is writing this index; wait for it to finish and try again");
        }
        throw e;
      }
    }
    try {
      return await fn();
    } finally {
      await handle!.close().catch(() => {});
      await fs.rm(this.lockPath, { force: true });
    }
  }

  /** Recovery mutates the repo, so readers only run it while no writer is active. */
  private async recoverIfNoWriter(): Promise<void> {
    if (await this.writerActive()) return;
    try {
      await this.withWriteLock(() => this.recover());
    } catch (e) {
      // A writer grabbed the lock between our check and acquisition: it owns recovery.
      if (e instanceof Error && e.message.includes("another ember process")) return;
      throw e;
    }
  }

  async save(meta: IndexMeta, chunks: ChunkRecord[], vectors: Float32Array[], index: HnswIndex, fileHashes?: FileHashMap): Promise<void> {
    return this.withWriteLock(async () => {
    const parent = path.dirname(this.dir);
    const tmp = `${this.dir}.tmp-${process.pid}`;
    const backup = `${this.dir}.backup-${process.pid}`;
    // Restore-or-drop crash leftovers FIRST: if an earlier save died between
    // the two renames, its backup is the only complete copy - never delete it.
    await this.recover();
    // Staging dirs are never complete sets; safe to drop leftovers now.
    for (const d of await fs.readdir(parent).catch(() => [] as string[])) {
      if (d.startsWith(".ember.tmp-")) {
        await fs.rm(path.join(parent, d), { recursive: true, force: true });
      }
    }
    await fs.mkdir(tmp, { recursive: true });
    // Carry over files this save does not own (notes, usage log, ...).
    await fs.cp(this.dir, tmp, { recursive: true }).catch(() => {});
    const generation = meta.generation ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    meta.generation = generation;
    await fs.writeFile(path.join(tmp, "meta.json"), JSON.stringify(meta, null, 2));
    await fs.writeFile(path.join(tmp, "generation"), generation + "\n");
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
    });
  }

  /** Recover from a save that crashed mid-swap. If .ember is absent but a
   * backup directory exists, the backup is the only complete set: restore
   * the newest one. If .ember is live, leftover backups are the old set
   * from a completed swap: drop them. Staging dirs are left to save(). */
  private async recover(): Promise<void> {
    const parent = path.dirname(this.dir);
    const live = await fs.access(path.join(this.dir, "meta.json")).then(() => true, () => false);
    const entries = await fs.readdir(parent).catch(() => [] as string[]);
    const backups = entries.filter(d => d.startsWith(".ember.backup-"));
    if (!live && backups.length > 0) {
      const timed = await Promise.all(backups.map(async b => ({ b, m: (await fs.stat(path.join(parent, b)).catch(() => null))?.mtimeMs ?? 0 })));
      timed.sort((a, b2) => a.m - b2.m);
      const newest = timed[timed.length - 1].b;
      await fs.rename(path.join(parent, newest), this.dir).catch(() => {});
      for (const { b } of timed.slice(0, -1)) await fs.rm(path.join(parent, b), { recursive: true, force: true });
    } else if (live) {
      for (const b of backups) await fs.rm(path.join(parent, b), { recursive: true, force: true });
    }
  }

  async load(): Promise<{ meta: IndexMeta; chunks: ChunkRecord[]; index: HnswIndex }> {
    await this.recoverIfNoWriter();
    try {
      return await this.loadOnce();
    } catch (first) {
      // A reader can straddle an in-flight save's swap; wait briefly so the
      // swap settles, re-run recovery if no writer is active, then retry once.
      await sleep(50);
      await this.recoverIfNoWriter();
      return await this.loadOnce();
    }
  }

  private async loadOnce(): Promise<{ meta: IndexMeta; chunks: ChunkRecord[]; index: HnswIndex }> {
    try {
      const genPath = path.join(this.dir, "generation");
      const genBefore = await fs.readFile(genPath, "utf8").then(s => s.trim(), () => null);
      const meta = JSON.parse(await fs.readFile(path.join(this.dir, "meta.json"), "utf8")) as IndexMeta;
      if (genBefore !== null && meta.generation !== undefined && meta.generation !== genBefore) {
        throw new Error(`torn read: meta generation ${meta.generation} but generation file ${genBefore}`);
      }
      const lines = (await fs.readFile(path.join(this.dir, "chunks.jsonl"), "utf8")).trim().split("\n");
      const chunks = lines.map(l => JSON.parse(l)) as ChunkRecord[];
      const buf = await fs.readFile(path.join(this.dir, "vectors.f32"));
      if (meta.chunkCount !== chunks.length || buf.byteLength !== chunks.length * meta.dim * 4) {
        throw new Error(`inconsistent file set (meta ${meta.chunkCount} chunks, chunks.jsonl ${chunks.length}, vectors ${buf.byteLength} bytes)`);
      }
      const vectors = new Map<number, Float32Array>();
      for (let i = 0; i < chunks.length; i++) {
        vectors.set(chunks[i].id, new Float32Array(buf.buffer.slice(buf.byteOffset + i * meta.dim * 4, buf.byteOffset + (i + 1) * meta.dim * 4)));
      }
      const hnswJson = JSON.parse(await fs.readFile(path.join(this.dir, "hnsw.json"), "utf8"));
      const index = HnswIndex.fromJSON(hnswJson, vectors);
      // Re-check identity: if a swap replaced the set mid-read, start over.
      const genAfter = await fs.readFile(genPath, "utf8").then(s => s.trim(), () => null);
      if (genBefore !== null && genAfter !== genBefore) {
        throw new Error(`torn read: generation changed ${genBefore} -> ${genAfter} during load`);
      }
      return { meta, chunks, index };
    } catch (e) {
      throw new Error(
        `index store at ${this.dir} is corrupt or incomplete (${e instanceof Error ? e.message : String(e)}). Rebuild it: ember index --full`
      );
    }
  }

  async readMeta(): Promise<IndexMeta | null> {
    await this.recoverIfNoWriter();
    try { return JSON.parse(await fs.readFile(path.join(this.dir, "meta.json"), "utf8")); }
    catch { return null; }
  }

  async loadFileHashes(): Promise<FileHashMap | null> {
    try { return JSON.parse(await fs.readFile(path.join(this.dir, "files.json"), "utf8")); }
    catch { return null; }
  }
}
