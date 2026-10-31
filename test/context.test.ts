/** Live source-context reader: repo jailing, range clamping, honest errors. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readSourceContext } from "../src/core/context.js";

async function mkfile(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-context-"));
  await fs.writeFile(path.join(dir, "a.ts"), Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("reads the requested 1-based inclusive range", async () => {
  const { dir, cleanup } = await mkfile();
  try {
    const c = await readSourceContext(dir, "a.ts", 5, 8);
    assert.deepEqual(c.lines, ["line5", "line6", "line7", "line8"]);
    assert.equal(c.startLine, 5);
  } finally { await cleanup(); }
});

test("clamps out-of-range bounds to the file", async () => {
  const { dir, cleanup } = await mkfile();
  try {
    const c = await readSourceContext(dir, "a.ts", -10, 999);
    assert.equal(c.startLine, 1);
    assert.equal(c.lines.length, 21, "20 lines + trailing empty from final newline");
    assert.equal(c.lines[0], "line1");
    assert.equal(c.lines[19], "line20");
  } finally { await cleanup(); }
});

test("refuses path escapes outside the repo root", async () => {
  const { dir, cleanup } = await mkfile();
  try {
    await assert.rejects(() => readSourceContext(dir, "../outside.ts", 1, 5), /escapes the repo root/);
    await assert.rejects(() => readSourceContext(dir, "/etc/passwd", 1, 5), /escapes the repo root/);
  } finally { await cleanup(); }
});

test("a missing file is an honest error naming the path", async () => {
  const { dir, cleanup } = await mkfile();
  try {
    await assert.rejects(() => readSourceContext(dir, "nope.ts", 1, 5), /cannot read nope\.ts/);
  } finally { await cleanup(); }
});

test("a symlink pointing outside the repo is refused; an inside symlink is followed", async () => {
  const { dir, cleanup } = await mkfile();
  const outside = path.join(os.tmpdir(), `ember-secret-${process.pid}.txt`);
  await fs.writeFile(outside, "secret outside the repo\n");
  try {
    await fs.symlink(outside, path.join(dir, "escape.ts"));
    await assert.rejects(() => readSourceContext(dir, "escape.ts", 1, 5), /escapes the repo root via a symlink/);
    await fs.symlink(path.join(dir, "a.ts"), path.join(dir, "alias.ts"));
    const c = await readSourceContext(dir, "alias.ts", 1, 2);
    assert.deepEqual(c.lines, ["line1", "line2"], "a symlink staying inside the repo is fine");
  } finally {
    await fs.rm(outside, { force: true });
    await cleanup();
  }
});
