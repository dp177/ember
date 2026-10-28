import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkFile } from "../src/core/chunker.js";

test("splits typescript declarations with symbol names", () => {
  const src = `import x from "y";
export function alpha() {
  return 1;
}
export class Beta {
  run() { return 2; }
}
const gamma = 3;
`;
  const chunks = chunkFile("a.ts", src);
  assert.ok(chunks.length >= 2);
  const symbols = chunks.map(c => c.symbol).filter(Boolean);
  assert.ok(symbols.includes("alpha"));
  assert.ok(symbols.includes("Beta"));
  assert.ok(chunks.every(c => c.startLine >= 1 && c.endLine >= c.startLine));
});

test("falls back to windows for prose", () => {
  const src = Array.from({ length: 200 }, (_, i) => `line ${i} of plain prose text`).join("\n");
  const chunks = chunkFile("b.md", src);
  assert.ok(chunks.length >= 2);
  // windows overlap
  assert.ok(chunks[1].startLine <= chunks[0].endLine);
});

test("skips tiny noise chunks", () => {
  const chunks = chunkFile("c.py", "x = 1\n");
  assert.equal(chunks.length, 0);
});
