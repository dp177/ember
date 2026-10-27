/**
 * Pluggable embedders.
 *
 * Default: HashingEmbedder - deterministic, offline, lexical. It tokenizes
 * code (splitting camelCase/snake_case) and hashes tokens into a fixed-width
 * vector. It is NOT a semantic model: it matches on shared vocabulary, which
 * works well for code (identifiers are meaningful) but it will not paraphrase.
 *
 * Optional: HttpEmbedder - any OpenAI-compatible /embeddings endpoint
 * (OpenRouter, Alan-provided open-model gateway, Ollama, ...). Configure with
 * EMBER_API_BASE / EMBER_API_KEY / EMBER_EMBED_MODEL.
 */
import { normalize } from "./hnsw.js";
/** Very light stemmer: strip common English suffixes so "skipped" matches
 * "skip" and "indexing" matches "index". Not a linguistic stemmer - just
 * enough to bridge natural-language queries and code identifiers. */
function stem(t) {
    for (let i = 0; i < 2; i++) {
        const m = t.match(/^(.*?)(ies|ied|ing|edly|ed|es|s)$/);
        if (!m || m[1].length < 3)
            break;
        t = m[1];
        if (/(ing|ed)$/.test(m[2]) && /(.)\1$/.test(t))
            t = t.slice(0, -1); // skipp -> skip
    }
    return t.replace(/y$/, "i"); // repository -> repositori, memory -> memori
}
/** Split code/prose into lowercase stemmed tokens, splitting camelCase and snake_case. */
export function tokenize(text) {
    return text
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^A-Za-z0-9_]+/)
        .flatMap(t => t.split("_"))
        .map(t => t.toLowerCase())
        .filter(t => t.length >= 2)
        .map(stem);
}
/** FNV-1a 32-bit hash - stable across runs and machines. */
function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
export class HashingEmbedder {
    kind = "local-hashing-lexical";
    dim;
    constructor(dim = 1024) { this.dim = dim; }
    async embed(texts) {
        return texts.map(t => this.embedOne(t));
    }
    embedOne(text) {
        const v = new Float32Array(this.dim);
        const tokens = tokenize(text);
        const tf = new Map();
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
export class HttpEmbedder {
    base;
    apiKey;
    model;
    kind = "http-openai-compatible";
    dim;
    constructor(base, apiKey, model, dim) {
        this.base = base;
        this.apiKey = apiKey;
        this.model = model;
        this.dim = dim;
    }
    async embed(texts) {
        let res;
        try {
            res = await fetch(`${this.base.replace(/\/$/, "")}/embeddings`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify({ model: this.model, input: texts }),
                signal: AbortSignal.timeout(60_000),
            });
        }
        catch (e) {
            throw new Error(`embeddings endpoint unreachable (${this.base}): ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!res.ok)
            throw new Error(`embeddings endpoint ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return data.data.map((d, i) => {
            // A model returning a different width than configured would otherwise
            // silently corrupt the vector store; fail honestly instead.
            if (d.embedding.length !== this.dim) {
                throw new Error(`embeddings model ${this.model} returned dim=${d.embedding.length} but EMBER_EMBED_DIM=${this.dim} (batch item ${i}). Fix EMBER_EMBED_DIM or choose a ${this.dim}-dim model, then re-run: ember index --full`);
            }
            return normalize(Float32Array.from(d.embedding));
        });
    }
}
/** Pick an embedder from the environment; defaults to the offline lexical one.
 * Environment-agnostic: outside Node (e.g. the browser demo bundle) there is
 * no process.env, so it always falls back to the offline lexical embedder. */
export function embedderFromEnv() {
    const env = typeof process !== "undefined" ? process.env : {};
    const base = env.EMBER_API_BASE;
    const key = env.EMBER_API_KEY;
    const model = env.EMBER_EMBED_MODEL;
    if (base && key && model) {
        const dim = parseInt(env.EMBER_EMBED_DIM ?? "1536", 10);
        return new HttpEmbedder(base, key, model, dim);
    }
    return new HashingEmbedder();
}
