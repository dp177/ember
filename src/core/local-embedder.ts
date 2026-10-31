/** Optional LOCAL semantic embeddings: a real transformer model running in
 * pure WASM via transformers.js - no API key, no provider, no per-call cost,
 * and nothing leaves the machine. This is the measured fix for the lexical
 * paraphrase ceiling (see README "Honest capability notes").
 *
 * Deliberately NOT a hard dependency: @xenova/transformers is a large
 * install, so Ember stays lean for users who only want the offline lexical
 * engine. Enable with EMBER_LOCAL_EMBED=1 after
 * `npm install @xenova/transformers` (or EMBER_LOCAL_EMBED_MODEL for a
 * different feature-extraction model + EMBER_LOCAL_EMBED_DIM for its width).
 * The first embed() downloads the model to the transformers.js cache. */

import type { Embedder } from "./embedder.js";
import { normalize } from "./hnsw.js";

export const DEFAULT_LOCAL_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Pipeline factory signature matching transformers.js `pipeline()`;
 * injectable so tests stay hermetic (no model download in the suite). */
export type PipelineFactory = (task: string, model: string, opts?: Record<string, unknown>) => Promise<FeatureExtractor>;
export interface FeatureExtractor {
  (texts: string[], opts: { pooling: string; normalize: boolean }): Promise<{ dims: number[]; data: Float32Array | number[] }>;
}

export class LocalEmbedder implements Embedder {
  readonly kind: string;
  readonly dim: number;
  private extractor: FeatureExtractor | null = null;

  constructor(
    private model = DEFAULT_LOCAL_EMBED_MODEL,
    dim = 384,
    private factory?: PipelineFactory,
    private onStatus?: (msg: string) => void,
  ) {
    // Kind carries the model (same rule as HttpEmbedder): switching local
    // models forces an honest full rebuild via the indexer comparison.
    this.kind = `local-wasm:${model}`;
    this.dim = dim;
  }

  private async load(): Promise<FeatureExtractor> {
    if (this.extractor) return this.extractor;
    let factory = this.factory;
    if (!factory) {
      let mod: { pipeline?: unknown; env?: { allowLocalModels?: boolean; cacheDir?: string } };
      try {
        mod = await import("@xenova/transformers" as string);
      } catch {
        throw new Error(
          "local semantic embeddings (the default) need transformers.js: run `npm install @xenova/transformers` " +
          "(~large one-time install; the model itself downloads once on first use, then works offline). " +
          "To opt out of semantic search explicitly, set EMBER_LEXICAL=1 for the offline lexical engine, " +
          "or configure EMBER_API_BASE for a provider. Ember never falls back to lexical silently.",
        );
      }
      if (mod.env) mod.env.allowLocalModels = false; // explicit model ids only
      factory = mod.pipeline as PipelineFactory;
    }
    // First-use setup must be visible: the model download can take a while.
    // Node CLIs/servers see this on stderr; injected onStatus can redirect it.
    // First-use setup must be visible: the model download can take a while.
    // Node CLIs/servers see this on stderr; injected onStatus can redirect it.
    const status = this.onStatus ?? ((m: string) => console.error(m));
    status(`loading local semantic model ${this.model} - first use downloads it once, then it runs offline`);
    try {
      this.extractor = await factory("feature-extraction", this.model, { quantized: true });
    } catch (e) {
      throw new Error(
        `the local semantic model ${this.model} could not be loaded (${e instanceof Error ? e.message : String(e)}). ` +
        "The first run downloads it once - check the network connection and retry; after that it works fully offline. " +
        "To keep working without semantic search meanwhile, set EMBER_LEXICAL=1 (explicit diagnostic opt-out, keyword-only). " +
        "Ember never falls back to lexical silently.",
      );
    }
    status(`local semantic model ${this.model} ready`);
    return this.extractor;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const extractor = await this.load();
    const out: Float32Array[] = [];
    const BATCH = 16;
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map(t => t.slice(0, 2000)); // model context guard
      const res = await extractor(batch, { pooling: "mean", normalize: true });
      const rows = res.dims[0], width = res.dims[1];
      if (width !== this.dim) {
        throw new Error(
          `local model ${this.model} returned dim=${width} but EMBER_LOCAL_EMBED_DIM=${this.dim}. Fix EMBER_LOCAL_EMBED_DIM, then re-run: ember index --full`,
        );
      }
      for (let j = 0; j < rows; j++) {
        out.push(normalize(Float32Array.from(Array.from(res.data.slice(j * width, (j + 1) * width)) as number[])));
      }
    }
    return out;
  }
}

/** Build the local embedder from the environment, or null when not enabled. */
export function localEmbedderFromEnv(env: Record<string, string | undefined>): LocalEmbedder | null {
  const enabled = env.EMBER_LOCAL_EMBED === "1" || !!env.EMBER_LOCAL_EMBED_MODEL;
  if (!enabled) return null;
  const dim = env.EMBER_LOCAL_EMBED_DIM ? parseInt(env.EMBER_LOCAL_EMBED_DIM, 10) : 384;
  if (!Number.isFinite(dim) || dim <= 0) throw new Error(`invalid EMBER_LOCAL_EMBED_DIM=${env.EMBER_LOCAL_EMBED_DIM}`);
  return new LocalEmbedder(env.EMBER_LOCAL_EMBED_MODEL || DEFAULT_LOCAL_EMBED_MODEL, dim);
}
