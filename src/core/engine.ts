/** Query engine over a persisted index.
 *
 * Default retrieval is the measured baseline: HNSW vector ranking + a
 * capped filename boost. An experimental hybrid mode (EMBER_HYBRID=1 or
 * --hybrid) additionally fuses a BM25 lexical ranking via weighted
 * reciprocal rank fusion. Measured on the 15-question same-repo sanity
 * eval on the current corpus (measured 2026-10-31):
 *   baseline:            top-1 5/15, top-5 12/15, MRR 0.483 (paraphrase 1/15, 4/15, 0.133)
 *   hybrid, weight 0.25: top-1 5/15, top-5 11/15, MRR 0.466 (paraphrase 2/15, 7/15, 0.241)
 * i.e. hybrid recovers much of the paraphrase loss but gives back a little
 * verbatim top-5 and MRR - a tradeoff, not a clear win, so hybrid stays
 * opt-in until real
 * semantic embeddings (where the two legs genuinely diverge) are verified.
 * Small 15-question, single-corpus eval; treat differences of 1 as noise.
 * Reproduce: node scripts/eval.mjs (EMBER_HYBRID=1 for the hybrid row). */

import { HnswIndex } from "./hnsw.js";
import { EmberStore, type ChunkRecord, type IndexMeta } from "./store.js";
import { tokenize, type Embedder } from "./embedder.js";
import { LexicalScorer, rrfFuse } from "./hybrid.js";

/** Filename boost for the default path (cosine-score scale). */
const PATH_BOOST_PER_TOKEN = 0.05;
const PATH_BOOST_CAP = 0.1;
/** Same idea, rescaled to RRF magnitude, for the hybrid path. */
const HYBRID_PATH_BOOST_PER_TOKEN = 0.004;
const HYBRID_PATH_BOOST_CAP = 0.008;
/** Weight of the lexical leg in hybrid fusion (see header for measurement). */
const HYBRID_LEXICAL_WEIGHT = 0.25;

function pathBoost(queryTokens: Set<string>, file: string, perToken: number, cap: number): number {
  const base = file.split("/").pop()!.replace(/\.[^.]+$/, "");
  let boost = 0;
  for (const t of tokenize(base)) if (queryTokens.has(t)) boost += perToken;
  return Math.min(boost, cap);
}

export interface SearchHit {
  chunk: ChunkRecord;
  score: number;
}

export interface EngineOptions {
  /** Opt into experimental hybrid (vector + BM25 fused) retrieval. */
  hybrid?: boolean;
}

export class EmberEngine {
  private scorer: LexicalScorer | null = null;

  private constructor(
    readonly meta: IndexMeta,
    private chunks: ChunkRecord[],
    private index: HnswIndex,
    private embedder: Embedder,
    readonly hybrid: boolean,
  ) {}

  static async load(repoRoot: string, embedder: Embedder, opts: EngineOptions = {}): Promise<EmberEngine> {
    const store = new EmberStore(repoRoot);
    const { meta, chunks, index } = await store.load();
    if (meta.dim !== embedder.dim) {
      throw new Error(
        `index was built with dim=${meta.dim} (${meta.embedderKind}) but the current embedder has dim=${embedder.dim} (${embedder.kind}). Re-run 'ember index'.`,
      );
    }
    return new EmberEngine(meta, chunks, index, embedder, opts.hybrid ?? false);
  }

  async search(query: string, k = 8): Promise<SearchHit[]> {
    return this.hybrid ? this.searchHybrid(query, k) : this.searchVector(query, k);
  }

  /** Default: vector ranking + capped filename boost. */
  private async searchVector(query: string, k: number): Promise<SearchHit[]> {
    const [qv] = await this.embedder.embed([query]);
    const qTokens = new Set(tokenize(query));
    // Fetch beyond k so the path boost can promote relevant chunks that the
    // pure vector ranking placed just outside the cut; re-rank, then slice.
    const ids = this.index.search(qv, k * 3, Math.max(50, k * 4));
    const byId = new Map(this.chunks.map(c => [c.id, c]));
    const hits: SearchHit[] = [];
    for (const id of ids) {
      const chunk = byId.get(id);
      if (!chunk) continue;
      let score = 0;
      const vec = this.index.getVector(id);
      if (vec) { for (let i = 0; i < qv.length; i++) score += qv[i] * vec[i]; }
      hits.push({ chunk, score: score + pathBoost(qTokens, chunk.file, PATH_BOOST_PER_TOKEN, PATH_BOOST_CAP) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  /** Experimental: fuse the HNSW ranking with a BM25 lexical ranking (RRF,
   * lexical weighted 0.25) + rescaled filename boost. See header for the
   * measured tradeoff. */
  private async searchHybrid(query: string, k: number): Promise<SearchHit[]> {
    const [qv] = await this.embedder.embed([query]);
    const qTokens = new Set(tokenize(query));
    const byId = new Map(this.chunks.map(c => [c.id, c]));

    const ids = this.index.search(qv, k * 3, Math.max(50, k * 4));
    const vecScored: { id: number; s: number }[] = [];
    for (const id of ids) {
      if (!byId.has(id)) continue;
      const vec = this.index.getVector(id);
      let s = 0;
      if (vec) { for (let i = 0; i < qv.length; i++) s += qv[i] * vec[i]; }
      vecScored.push({ id, s });
    }
    vecScored.sort((a, b) => b.s - a.s);
    const vecRanking = vecScored.map(x => x.id);

    if (!this.scorer) this.scorer = new LexicalScorer(this.chunks);
    const lexRanking = this.scorer.topK(query, k * 3)
      .map(i => this.chunks[i]?.id)
      .filter((id): id is number => id !== undefined);

    const fused = rrfFuse([vecRanking, lexRanking], [1.0, HYBRID_LEXICAL_WEIGHT]);
    const hits: SearchHit[] = [];
    for (const [id, score] of fused) {
      const chunk = byId.get(id);
      if (!chunk) continue;
      hits.push({ chunk, score: score + pathBoost(qTokens, chunk.file, HYBRID_PATH_BOOST_PER_TOKEN, HYBRID_PATH_BOOST_CAP) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  chunkCount(): number { return this.chunks.length; }
}
