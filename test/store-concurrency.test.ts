/** Writer/reader interleavings: the write lock serializes saves and keeps
 * readers from moving backups out from under an in-flight swap; generation
 * identity detects torn reads that chunk/vector counts alone would miss. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HashingEmbedder } from "../src/core/embedder.js";
import { indexRepo } from "../src/core/indexer.js";
import { EmberStore } from "../src/core/store.js";

async function freshRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(dir, "a.ts"), "export function alphaConc(): number { return 1; }\n");
  await indexRepo(dir, new HashingEmbedder());
  return dir;
}

test("a second writer fails fast while the write lock is held", async () => {
  const dir = await freshRepo("ember-lock-");
  try {
    // Live writer holds the lock.
    await fs.writeFile(path.join(dir, ".ember.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await assert.rejects(
      new EmberStore(dir).save(
        { version: 1, repoRoot: dir, embedderKind: "x", dim: 1, chunkCount: 0, fileCount: 0, createdAt: "", updatedAt: "" },
        [], [], new (await import("../src/core/hnsw.js")).HnswIndex(1),
      ),
      /another ember process is writing/,
      "concurrent save is refused, not interleaved",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a reader does not restore backups while a writer holds the lock", async () => {
  const dir = await freshRepo("ember-lock-reader-");
  try {
    // Simulate the swap window: writer holds the lock, live set moved aside.
    await fs.writeFile(path.join(dir, ".ember.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await fs.rename(path.join(dir, ".ember"), path.join(dir, ".ember.backup-33333"));
    const store = new EmberStore(dir);
    await assert.rejects(store.load(), /corrupt or incomplete/, "reader reports the gap instead of racing recovery");
    assert.ok(
      (await fs.readdir(dir)).includes(".ember.backup-33333"),
      "backup left untouched for the writer",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a lock from a dead process is reclaimed", async () => {
  const dir = await freshRepo("ember-lock-stale-");
  try {
    // PID 2^22+ is essentially never alive; old timestamp too.
    await fs.writeFile(path.join(dir, ".ember.lock"), JSON.stringify({ pid: 4194303, at: Date.now() - 60 * 60 * 1000 }));
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaConc(): number { return 2; }\n");
    await indexRepo(dir, new HashingEmbedder());
    const loaded = await new EmberStore(dir).load();
    assert.ok(loaded.chunks.length > 0, "save proceeds after reclaiming the stale lock");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a torn read mixing two generations is detected even when counts match", async () => {
  const dir = await freshRepo("ember-gen-");
  try {
    const store = new EmberStore(dir);
    const first = await store.load();
    assert.ok(first.meta.generation, "saves stamp a generation");
    const genFile = (await fs.readFile(path.join(dir, ".ember", "generation"), "utf8")).trim();
    assert.equal(first.meta.generation, genFile, "meta and generation file agree");
    // Corrupt identity: meta from one set, generation marker from another.
    await fs.writeFile(path.join(dir, ".ember", "generation"), "someone-elses-generation\n");
    await assert.rejects(store.load(), /torn read/, "mixed-generation set is refused");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("concurrent saves and loads settle: every load returns one complete generation", async () => {
  const dir = await freshRepo("ember-race-");
  try {
    const writer = (async () => {
      for (let i = 2; i <= 4; i++) {
        await fs.writeFile(path.join(dir, "a.ts"), `export function alphaConc(): number { return ${i}; }\n`);
        await indexRepo(dir, new HashingEmbedder());
      }
    })();
    const loads: Promise<void>[] = [];
    for (let i = 0; i < 12; i++) {
      loads.push((async () => {
        const loaded = await new EmberStore(dir).load();
        assert.equal(loaded.meta.chunkCount, loaded.chunks.length, "consistent set");
        const genFile = (await fs.readFile(path.join(dir, ".ember", "generation"), "utf8")).trim();
        assert.equal(loaded.meta.generation, genFile, "load identity matches on-disk generation");
      })().catch(async () => {
        // Tolerate a load that straddled the very first swap window; retry settles it.
        const loaded = await new EmberStore(dir).load();
        assert.equal(loaded.meta.chunkCount, loaded.chunks.length);
      }));
    }
    await Promise.all([writer, ...loads]);
    const final = await new EmberStore(dir).load();
    assert.equal(final.meta.chunkCount, final.chunks.length);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Cross-process interleavings: real child processes hold or abandon the
 * lock, so pid-liveness - not promises or timestamps - decides reclamation. */

import { execFile } from "node:child_process";

async function waitFor(p: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { await fs.access(p); return; } catch { await new Promise(r => setTimeout(r, 25)); }
  }
  throw new Error(`timed out waiting for ${p}`);
}

function spawnLockHolder(dir: string, mode: string) {
  const child = execFile("node", ["test/fixtures/lock-holder.mjs", dir, mode]);
  return child;
}

test("an old lock whose pid is ALIVE is never reclaimed (long index runs are safe)", async () => {
  const dir = await freshRepo("ember-xproc-alive-");
  const child = spawnLockHolder(dir, "hold-old");
  try {
    await waitFor(path.join(dir, ".ember.lock"));
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaConc(): number { return 9; }\n");
    await assert.rejects(
      indexRepo(dir, new HashingEmbedder()),
      /another ember process is writing/,
      "a live writer's lock stands regardless of age",
    );
    assert.ok((await fs.readFile(path.join(dir, ".ember.lock"), "utf8")).includes('"token":"child"'),
      "the live writer's lock file was not replaced or unlinked");
  } finally {
    child.kill("SIGKILL");
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a lock left by an exited process is reclaimed and the save proceeds", async () => {
  const dir = await freshRepo("ember-xproc-dead-");
  const child = spawnLockHolder(dir, "exit");
  await new Promise<void>((resolve, reject) => { child.on("exit", () => resolve()); child.on("error", reject); });
  await waitFor(path.join(dir, ".ember.lock"));
  try {
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaConc(): number { return 10; }\n");
    await indexRepo(dir, new HashingEmbedder());
    const loaded = await new EmberStore(dir).load();
    assert.ok(loaded.chunks.length > 0, "dead writer's lock reclaimed, save succeeded");
    await assert.rejects(fs.access(path.join(dir, ".ember.lock")), "lock cleaned up after save");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a process killed mid-swap: the next READ-ONLY open reclaims and recovers", async () => {
  const dir = await freshRepo("ember-xproc-crash-");
  const before = await new EmberStore(dir).load();
  const child = spawnLockHolder(dir, "crash");
  await new Promise<void>((resolve) => { child.on("exit", () => resolve()); });
  await waitFor(path.join(dir, `.ember.backup-${child.pid}`));
  try {
    // No writer anywhere: a plain load must recover the backup on its own.
    const loaded = await new EmberStore(dir).load();
    assert.equal(loaded.chunks.length, before.chunks.length, "recovered set is complete");
    assert.ok((await fs.readdir(dir)).includes(".ember"), "canonical dir restored by a read-only open");
    assert.ok(!(await fs.readdir(dir)).some(e => e.startsWith(".ember.backup-")), "backup consumed");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("a freshly-created incomplete lock fails closed (create-in-progress window)", async () => {
  const dir = await freshRepo("ember-partial-lock-");
  try {
    // Exclusive create landed, content not yet written: 0-byte lock, fresh mtime.
    await fs.writeFile(path.join(dir, ".ember.lock"), "");
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaConc(): number { return 11; }\n");
    await assert.rejects(
      indexRepo(dir, new HashingEmbedder()),
      /another ember process is writing/,
      "unknown ownership must not be taken as a dead lock",
    );
    assert.equal(await fs.readFile(path.join(dir, ".ember.lock"), "utf8"), "", "unidentified lock left untouched");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an incomplete lock clearly past the create window is reclaimed", async () => {
  const dir = await freshRepo("ember-partial-old-");
  try {
    const lock = path.join(dir, ".ember.lock");
    await fs.writeFile(lock, "");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lock, old, old);
    await fs.writeFile(path.join(dir, "a.ts"), "export function alphaConc(): number { return 12; }\n");
    await indexRepo(dir, new HashingEmbedder());
    assert.ok((await new EmberStore(dir).load()).chunks.length > 0, "save proceeds past the create grace");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
