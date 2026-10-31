/**
 * Pluggable embedders.
 *
 * Default: HashingEmbedder - deterministic, offline, lexical. It tokenizes
 * code (splitting camelCase/snake_case) and hashes tokens into a fixed-width
 * vector. It is NOT a semantic model: it matches on shared vocabulary, which
 * works well for code (identifiers are meaningful) but it will not paraphrase.
 *
 * Optional: HttpEmbedder - any OpenAI-compatible /embeddings endpoint
 * (OpenRouter, Ollama, or any other compatible gateway). Configure with
 * EMBER_API_BASE / EMBER_API_KEY / EMBER_EMBED_MODEL.
 */

import { normalize } from "./hnsw.js";
import { LlmClient, llmConfigFromEnv, sharedClientFromEnv, type UsageLogger } from "./llm.js";
import { LocalEmbedder, localEmbedderFromEnv } from "./local-embedder.js";

export interface Embedder {
  /** Identity of the embedding space, not just a family label: an embedder
   * backed by a model MUST include the exact model id (HttpEmbedder and
   * LocalEmbedder both embed `:${model}`). Index reuse and resume
   * checkpoints compare kind+dim to decide whether old vectors are valid;
   * two models sharing a kind would silently mix embedding spaces. */
  readonly kind: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Very light stemmer: strip common English suffixes so "skipped" matches
 * "skip" and "indexing" matches "index". Not a linguistic stemmer - just
 * enough to bridge natural-language queries and code identifiers. */
function stem(t: string): string {
  for (let i = 0; i < 2; i++) {
    const m = t.match(/^(.*?)(ies|ied|ing|edly|ed|es|s)$/);
    if (!m || m[1].length < 3) break;
    t = m[1];
    if (/(ing|ed)$/.test(m[2]) && /(.)\1$/.test(t)) t = t.slice(0, -1); // skipp -> skip
  }
  return t.replace(/y$/, "i"); // repository -> repositori, memory -> memori
}

/** Split code/prose into lowercase stemmed tokens, splitting camelCase and snake_case. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_]+/)
    .flatMap(t => t.split("_"))
    .map(t => t.toLowerCase())
    .filter(t => t.length >= 2)
    .map(stem);
}

/** FNV-1a 32-bit hash - stable across runs and machines. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class HashingEmbedder implements Embedder {
  readonly kind = "local-hashing-lexical";
  readonly dim: number;
  constructor(dim = 1024) { this.dim = dim; }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => this.embedOne(t));
  }

  embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const tokens = tokenize(text);
    const tf = new Map<number, number>();
    for (const t of tokens) {
      const h = fnv1a(t);
      tf.set(h, (tf.get(h) ?? 0) + 1);
    }
    for (const [h, c] of tf) {
      const slot = h % this.dim;
      // sign flip from another hash bit reduces collision bias
      const sign = (fnv1a(h.toString(36)) & 1) === 0 ? 1 : -1;
      v[slot] += sign * (1 + Math.log(c));
    }
    return normalize(v);
  }
}

export class HttpEmbedder implements Embedder {
  /** Kind carries the model: two same-dim models are different embedding
   * spaces, and mixing their vectors in one index silently corrupts
   * search. The indexer's kind comparison uses this to force an honest
   * full rebuild when EMBER_EMBED_MODEL changes. */
  readonly kind: string;
  readonly dim: number;
  private client: LlmClient;
  constructor(
    clientOrBase: LlmClient | string,
    apiKey: string | undefined,
    private model: string,
    dim: number,
  ) {
    this.kind = `http-openai-compatible:${model}`;
    this.dim = dim;
    this.client = typeof clientOrBase === "string"
      ? new LlmClient({ base: clientOrBase, apiKey: apiKey ?? "", embedModel: model, embedDim: dim })
      : clientOrBase;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const raw = await this.client.embedRaw(texts);
    return raw.map((embedding, i) => {
      // A model returning a different width than configured would otherwise
      // silently corrupt the vector store; fail honestly instead.
      if (embedding.length !== this.dim) {
        throw new Error(
          `embeddings model ${this.model} returned dim=${embedding.length} but EMBER_EMBED_DIM=${this.dim} (batch item ${i}). Fix EMBER_EMBED_DIM or choose a ${this.dim}-dim model, then re-run: ember index --full`,
        );
      }
      return normalize(Float32Array.from(embedding));
    });
  }
}

/** Pick an embedder from the environment.
 * Default: the local semantic model (WASM, offline after a one-time model
 * download). Explicit provider config (EMBER_API_BASE + EMBER_EMBED_MODEL)
 * wins; EMBER_LEXICAL=1 is the explicit opt-out to the offline lexical
 * engine. A semantic failure throws - Ember never silently falls back to
 * lexical results. Outside Node (e.g. the browser demo bundle) there is no
 * process.env, so it uses the offline lexical embedder. */
export function embedderFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
  usage?: UsageLogger,
): Embedder {
  return embedderChoiceFromEnv(env, usage).embedder;
}

/** Resolve the embedder AND why it was chosen, so callers can surface the
 * choice instead of silently selecting a non-default engine.
 *
 * Retrieval is local by requirement: remote embeddings need BOTH provider
 * config AND the explicit EMBER_REMOTE_EMBED=1 opt-in. Provider config
 * alone (even a previously working EMBER_EMBED_MODEL) never sends code or
 * query text to a provider; it produces a warning instead. Remote CHAT
 * (the ask command's synthesis) is configured separately and is unaffected. */
export function embedderChoiceFromEnv(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
  usage?: UsageLogger,
): { embedder: Embedder; reason: string; warning?: string } {
  const cfg = llmConfigFromEnv(env);
  if (cfg?.embedModel && env.EMBER_REMOTE_EMBED === "1") {
    const dim = cfg.embedDim ?? 1536;
    return {
      embedder: new HttpEmbedder(sharedClientFromEnv(env, usage)!, undefined, cfg.embedModel, dim),
      reason: `EMBER_REMOTE_EMBED=1 with EMBER_EMBED_MODEL=${cfg.embedModel} - explicit remote embedding opt-in, indexed text leaves this machine`,
    };
  }
  let warning: string | undefined;
  if (cfg?.embedModel) {
    warning = `EMBER_EMBED_MODEL=${cfg.embedModel} is set but remote embeddings require the explicit EMBER_REMOTE_EMBED=1 opt-in - using the local semantic default instead (no text leaves this machine)`;
  }
  if (env.EMBER_LEXICAL === "1") {
    return { embedder: new HashingEmbedder(), reason: "explicit lexical opt-out (EMBER_LEXICAL=1) - diagnostic/baseline mode, not the product default", warning };
  }
  // Default: the local semantic model. EMBER_LOCAL_EMBED / EMBER_LOCAL_EMBED_MODEL
  // / EMBER_LOCAL_EMBED_DIM still override the model choice.
  return { embedder: localEmbedderFromEnv(env) ?? new LocalEmbedder(), reason: "local semantic default (WASM, offline after a one-time model download)", warning };
}
