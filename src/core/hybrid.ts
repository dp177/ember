/** Hybrid retrieval: fuse the vector (HNSW) ranking with a lexical BM25
 * ranking using reciprocal rank fusion (RRF).
 *
 * Why: pure vector similarity misses exact-identifier matches ("HnswIndex",
 * "EMBER_MAX_CALLS") that lexical search nails, and pure lexical misses
 * paraphrase. RRF combines rankings without needing comparable score scales:
 * a chunk's fused score is sum over rankings of 1/(60 + rank). */

import { tokenize } from "./embedder.js";

/** Structural minimum - the browser demo supplies its own chunk type. */
export interface ScorableChunk { file: string; text: string; }

const K1 = 1.2;
const B = 0.75;

/** BM25 over chunk text plus file-basename tokens (basename weighted by
 * duplication - filenames are strong signals in code search). */
export class LexicalScorer {
  private tfs: Map<string, number>[] = [];
  private lens: number[] = [];
  private avgLen = 1;
  private df = new Map<string, number>();
  readonly n: number;

  constructor(chunks: ScorableChunk[]) {
    this.n = chunks.length;
    let total = 0;
    for (const c of chunks) {
      const base = c.file.split("/").pop()!.replace(/\.[^.]+$/, "");
      const tokens = [...tokenize(c.text), ...tokenize(base)];
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.tfs.push(tf);
      this.lens.push(tokens.length);
      total += tokens.length;
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = Math.max(1, total / Math.max(1, chunks.length));
  }

  private idf(t: string): number {
    const df = this.df.get(t) ?? 0;
    return Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
  }

  scoreOne(queryTokens: string[], i: number): number {
    const tf = this.tfs[i];
    if (!tf) return 0;
    let s = 0;
    for (const t of queryTokens) {
      const f = tf.get(t);
      if (!f) continue;
      const lenNorm = 1 - B + B * (this.lens[i] / this.avgLen);
      s += this.idf(t) * ((f * (K1 + 1)) / (f + K1 * lenNorm));
    }
    return s;
  }

  /** Indices of the top-k chunks by BM25 for this query. */
  topK(query: string, k: number): number[] {
    const q = tokenize(query);
    const scored: { i: number; s: number }[] = [];
    for (let i = 0; i < this.n; i++) {
      const s = this.scoreOne(q, i);
      if (s > 0) scored.push({ i, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, k).map(x => x.i);
  }
}

const RRF_K = 60;

/** Reciprocal rank fusion over multiple ranked id lists. */
export function rrfFuse(rankings: number[][], weights?: number[]): Map<number, number> {
  const fused = new Map<number, number>();
  rankings.forEach((ranking, li) => {
    const w = weights?.[li] ?? 1;
    ranking.forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + w / (RRF_K + rank + 1));
    });
  });
  return fused;
}
