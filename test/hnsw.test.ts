import { test } from "node:test";
import assert from "node:assert/strict";
import { HnswIndex, bruteForceTopK, normalize } from "../src/core/hnsw.js";

function randVec(dim: number, rng: () => number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rng() * 2 - 1;
  return normalize(v);
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("hnsw returns the exact nearest neighbor for a copied query", () => {
  const dim = 64;
  const idx = new HnswIndex(dim, { seed: 7 });
  const r = rng(123);
  const vecs: Float32Array[] = [];
  for (let i = 0; i < 500; i++) { vecs.push(randVec(dim, r)); idx.add(i, vecs[i]); }
  const res = idx.search(vecs[123], 1);
  assert.equal(res[0], 123);
});

test("hnsw recall@10 vs brute force is high on clustered data", () => {
  const dim = 64;
  const idx = new HnswIndex(dim, { M: 16, efConstruction: 200, seed: 7 });
  const r = rng(999);
  // clustered data: 10 cluster centers + noise
  const centers = Array.from({ length: 10 }, () => randVec(dim, r));
  const vecs: Float32Array[] = [];
  for (let i = 0; i < 2000; i++) {
    const c = centers[i % 10];
    const v = new Float32Array(dim);
    for (let j = 0; j < dim; j++) v[j] = c[j] + (r() - 0.5) * 0.1;
    vecs.push(normalize(v));
    idx.add(i, vecs[i]);
  }
  let hits = 0, total = 0;
  for (let q = 0; q < 30; q++) {
    const query = vecs[q * 60];
    const approx = new Set(idx.search(query, 10, 100));
    const exact = bruteForceTopK(query, vecs, 10);
    for (const e of exact) { total++; if (approx.has(e)) hits++; }
  }
  const recall = hits / total;
  assert.ok(recall > 0.9, `recall@10 ${recall} should be > 0.9`);
});

test("index serializes and restores", () => {
  const dim = 16;
  const idx = new HnswIndex(dim, { seed: 1 });
  const r = rng(5);
  const vecs: Float32Array[] = [];
  const map = new Map<number, Float32Array>();
  for (let i = 0; i < 100; i++) { const v = randVec(dim, r); vecs.push(v); map.set(i, v); idx.add(i, v); }
  const json = idx.toJSON();
  const restored = HnswIndex.fromJSON(json, map);
  const q = vecs[42];
  assert.deepEqual(restored.search(q, 5), idx.search(q, 5));
});
