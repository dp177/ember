/**
 * Offline lexical embedder + tokenizer - pure TS with no Node imports, so
 * the browser demo imports THIS module instead of embedder.ts (which pulls
 * the LLM client and the Node-only local model loader).
 *
 * HashingEmbedder: deterministic, offline, lexical. It tokenizes code
 * (splitting camelCase/snake_case) and hashes tokens into a fixed-width
 * vector. It is NOT a semantic model: it matches on shared vocabulary.
 */

import { normalize } from "./hnsw.js";

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

