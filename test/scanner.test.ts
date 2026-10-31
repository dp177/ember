import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanRepo, scanRepoCapped } from "../src/core/scanner.js";

test(".github directory is indexed while .git is skipped", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-scan-"));
  await fs.mkdir(path.join(dir, ".github", "workflows"), { recursive: true });
  await fs.writeFile(path.join(dir, ".github", "workflows", "ci.yml"), "name: ci\non: [push]\n");
  await fs.mkdir(path.join(dir, ".git", "objects"), { recursive: true });
  await fs.writeFile(path.join(dir, ".git", "config"), "[core]\nbare = false\n");
  await fs.writeFile(path.join(dir, "a.ts"), "export function alpha() { return 1 }\n");
  const files = (await scanRepo(dir)).map(f => f.relPath);
  assert.ok(files.includes(path.join(".github", "workflows", "ci.yml")), ".github content must be indexed");
  assert.ok(!files.some(f => f.startsWith(".git" + path.sep) || f === ".git"), ".git internals must be skipped");
  await fs.rm(dir, { recursive: true, force: true });
});

test("scan order is deterministic (byte-sorted by path) regardless of creation order", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-scan-"));
  // Create in non-alphabetical order on purpose.
  await fs.mkdir(path.join(dir, "zeta"), { recursive: true });
  await fs.writeFile(path.join(dir, "zeta", "b.ts"), "export const zb = 1\n");
  await fs.writeFile(path.join(dir, "m.ts"), "export const m = 1\n");
  await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1\n");
  const files = (await scanRepo(dir)).map(f => f.relPath);
  const sorted = [...files].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  assert.deepEqual(files, sorted);
  await fs.rm(dir, { recursive: true, force: true });
});

test("scanner cap: scanRepoCapped reports capped and stops at the limit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-cap-"));
  try {
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`);
    const r = await scanRepoCapped(dir, 3);
    assert.equal(r.capped, true);
    assert.equal(r.cap, 3);
    assert.ok(r.files.length <= 3);
    const full = await scanRepoCapped(dir);
    assert.equal(full.capped, false);
    assert.equal(full.files.length, 5);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
