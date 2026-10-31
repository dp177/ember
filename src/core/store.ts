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
 * A lock left by a crashed process is reclaimed only when its recorded
 * pid no longer exists. An unidentifiable lock (malformed, unreadable,
 * no pid) is never auto-reclaimed: the writer-conflict error names the
 * file so the user can remove it manually once no ember process runs.
 * After a crash, the next open (read or write) reclaims the dead lock
 * and restores the backup; if the lock somehow blocks, the error names
 * the lock file to remove.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
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

  /** Classify the lock. Reclaim ("dead") only when the owner is provably
   * gone: the recorded pid no longer exists on this host (ESRCH). Every
   * other state - malformed or empty content (possibly a create-in-progress
   * or a paused writer), unreadable file, EPERM (alive for another user),
   * pid reuse - fails closed as "live". An unidentified lock is never
   * auto-removed: the error names the file for manual recovery. */
  private async lockState(): Promise<"live" | "dead"> {
    let raw: { pid?: number };
    try {
      raw = JSON.parse(await fs.readFile(this.lockPath, "utf8")) as { pid?: number };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "dead"; // no lock
      return "live"; // malformed, empty or unreadable: owner unknown, fail closed
    }
    if (typeof raw.pid !== "number") return "live";
    try { process.kill(raw.pid, 0); return "live"; }
    catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "live"; }
  }

  /** Serialize writers and recovery. Fails fast while another writer holds the lock. */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const token = randomBytes(8).toString("hex");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(this.lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: "wx" });
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EEXIST" && attempt === 0 && (await this.lockState()) === "dead") {
          await fs.rm(this.lockPath, { force: true });
          continue;
        }
        if (code === "EEXIST") {
          throw new Error(`another ember process is writing this index; wait for it to finish, or if no ember process is running, remove ${this.lockPath} and try again`);
        }
        throw e;
      }
    }
    try {
      return await fn();
    } finally {
      // Remove only the lock this call created: if ours was reclaimed and a
      // replacement now sits there, unlinking it would expose a live writer.
      const held = await fs.readFile(this.lockPath, "utf8").then(s => {
        try { return (JSON.parse(s) as { token?: string }).token === token; } catch { return false; }
      }, () => false);
      if (held) await fs.rm(this.lockPath, { force: true });
    }
  }

  /** Recovery mutates the repo, so readers only run it while no live writer
   * is active. withWriteLock reclaims a dead owner's lock, so a read-only
   * open after a crash recovers on its own; a live writer's lock makes this
   * a no-op (the writer owns recovery). */
  private async recoverIfNoWriter(): Promise<void> {
    try {
      await this.withWriteLock(() => this.recover());
    } catch (e) {
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
