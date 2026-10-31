/**
 * Ember live browser demo: runs the REAL search engine client-side.
 * Same HashingEmbedder + HNSW code as the CLI (imported, not copied).
 * Loads the public repo's own pre-built index artifacts as static files.
 * Read-only by construction: no server, no writes, no secrets.
 */

import { HnswIndex } from "../src/core/hnsw.js";
import { HashingEmbedder, tokenize } from "../src/core/embedder.js";

export interface ChunkRecord {
  id: number; file: string; startLine: number; endLine: number;
  symbol: string | null; text: string;
}
interface IndexMeta { embedderKind: string; dim: number; chunkCount: number; fileCount: number; updatedAt: string; indexMode?: "flat" | "hnsw"; }

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url} (${res.status})`);
  return res.json();
}

export interface DemoIndex {
  meta: IndexMeta;
  chunks: ChunkRecord[];
  index: HnswIndex | null;
  vectors: Map<number, Float32Array>;
  embedder: HashingEmbedder;
}

/** Load the static index artifacts and rebuild the engine pieces. */
export async function loadDemoIndex(base = "data"): Promise<DemoIndex> {
  const meta = (await fetchJson(`${base}/meta.json`)) as IndexMeta;
  const chunksRaw = await (await fetch(`${base}/chunks.jsonl`)).text();
  const chunks: ChunkRecord[] = chunksRaw.trim().split("\n").map(l => JSON.parse(l));
  // The graph is optional (flat indexes have no hnsw.json).
  const hnswRes = await fetch(`${base}/hnsw.json`);
  const hnswJson = hnswRes.ok ? await hnswRes.json() : null;
  const vecBuf = await (await fetch(`${base}/vectors.f32`)).arrayBuffer();
  const vectors = new Map<number, Float32Array>();
  for (let i = 0; i < chunks.length; i++) {
    vectors.set(chunks[i].id, new Float32Array(vecBuf, i * meta.dim * 4, meta.dim));
  }
  const index = hnswJson ? HnswIndex.fromJSON(hnswJson, vectors) : null;
  const embedder = new HashingEmbedder(meta.dim);
  return { meta, chunks, index, vectors, embedder };
}

/** Same scoring as EmberEngine.search: graph or exact-scan candidates +
 * exact dot product + the same capped path-token boost (kept in lockstep by
 * demo-web.test.ts). */
const PATH_BOOST_PER_TOKEN = 0.05;
const PATH_BOOST_CAP = 0.1;

function pathBoost(queryTokens: Set<string>, file: string): number {
  const base = file.split("/").pop()!.replace(/\.[^.]+$/, "");
  let boost = 0;
  for (const t of tokenize(base)) if (queryTokens.has(t)) boost += PATH_BOOST_PER_TOKEN;
  return Math.min(boost, PATH_BOOST_CAP);
}

export interface DemoHit { chunk: ChunkRecord; score: number }

export async function demoSearch(d: DemoIndex, query: string, k = 8): Promise<DemoHit[]> {
  const [qv] = await d.embedder.embed([query]);
  const qTokens = new Set(tokenize(query));
  const ids = d.index
    ? d.index.search(qv, k * 3, Math.max(50, k * 4))
    : [...d.vectors.entries()]
        .map(([id, vec]) => { let s = 0; for (let i = 0; i < qv.length; i++) s += qv[i] * vec[i]; return { id, s }; })
        .sort((a, b) => b.s - a.s)
        .slice(0, k * 3)
        .map(x => x.id);
  const byId = new Map(d.chunks.map(c => [c.id, c]));
  const hits: { chunk: ChunkRecord; score: number }[] = [];
  for (const id of ids) {
    const chunk = byId.get(id);
    if (!chunk) continue;
    const vec = d.vectors.get(id);
    let score = 0;
    if (vec) for (let i = 0; i < qv.length; i++) score += qv[i] * vec[i];
    hits.push({ chunk, score: score + pathBoost(qTokens, chunk.file) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

/** Render one hit. All untrusted content goes through textContent - never innerHTML. */
