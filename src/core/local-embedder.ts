/** LOCAL semantic embeddings: a real transformer model running in pure
 * WASM via transformers.js - no API key, no provider, no per-call cost,
 * and nothing leaves the machine. This is the measured fix for the lexical
 * paraphrase ceiling (see README "Honest capability notes"), and the
 * default embedding path.
 * EMBER_LOCAL_EMBED_MODEL selects a different feature-extraction model and
 * EMBER_LOCAL_EMBED_DIM its width; EMBER_EMBED_BATCH overrides the
 * memory-driven batch size (see autoEmbedBatch). The first embed()
 * downloads the model to the transformers.js cache, then runs offline. */

import * as os from "node:os";
import type { Embedder } from "./embedder.js";
import { normalize } from "./hnsw.js";

export const DEFAULT_LOCAL_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Pipeline factory signature matching transformers.js `pipeline()`;
 * injectable so tests stay hermetic (no model download in the suite). */
export type PipelineFactory = (task: string, model: string, opts?: Record<string, unknown>) => Promise<FeatureExtractor>;
export interface FeatureExtractor {
  (texts: string[], opts: { pooling: string; normalize: boolean }): Promise<{ dims: number[]; data: Float32Array | number[] }>;
}

/** Conservative ladder: tight machines get small batches. Only the
 * bottom rung is measured (2 GB box: batch 4 stable); 8 is an unmeasured
 * middle rung. Units: bytes free at embed time. */
export function autoEmbedBatch(freeBytes: number): number {
  const gb = freeBytes / (1024 ** 3);
  if (gb < 3) return 4;
  if (gb < 6) return 8;
  return 16;
}

export class LocalEmbedder implements Embedder {
  readonly kind: string;
  readonly dim: number;
  private extractor: FeatureExtractor | null = null;
  private batchNoteShown = false;

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
    // Batch size is a memory knob: the WASM runtime's arena grows with
    // batch x sequence and does not shrink between calls. Measured on a
    // 2-core/2 GB box: batch 16 on real code chunks drove the indexer past
    // 1.3 GB anon RSS and the kernel OOM-killed it (dmesg confirmed);
    // batch 4 ran the same corpus at a stable ~476 MB total RSS.
    // EMBER_EMBED_BATCH overrides; otherwise pick from CURRENT free memory
    // so a memory-tight machine gets the safe size without knowing the knob.
    const BATCH = parseInt(process.env.EMBER_EMBED_BATCH ?? "", 10) || autoEmbedBatch(os.freemem());
    if (BATCH < 16 && !this.batchNoteShown) {
      this.batchNoteShown = true;
      console.error(`local embedder: batch size ${BATCH} (auto from free memory; override with EMBER_EMBED_BATCH)`);
    }
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
