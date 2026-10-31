/**
 * Ember live browser demo: runs the REAL search engine client-side.
 * Same HashingEmbedder + HNSW code as the CLI (imported, not copied).
 * Loads the public repo's own pre-built index artifacts as static files.
 * Read-only by construction: no server, no writes, no secrets.
 */
import { HnswIndex, normalize } from "../src/core/hnsw.js";
import { HashingEmbedder, tokenize } from "../src/core/hashing-embedder.js";
/** Semantic embedder running the same quantized all-MiniLM-L6-v2 model as
 * the CLI, in the visitor's browser via transformers.js (WASM). The model
 * (~23 MB) downloads once from Hugging Face's CDN and is cached by the
 * browser; a progress callback reports that first download. */
export async function createWasmEmbedder(model, onProgress) {
    const mod = await import("@xenova/transformers");
    const kind = `local-wasm:${model}`;
    onProgress?.(`downloading the local embedding model ${model} (~23 MB, once)...`);
    let lastPct = -1;
    const extractor = await mod.pipeline("feature-extraction", model, {
        quantized: true,
        progress_callback: (p) => {
            if (p?.status === "progress" && typeof p.progress === "number") {
                const pct = Math.floor(p.progress);
                if (pct >= lastPct + 10) {
                    lastPct = pct;
                    onProgress?.(`downloading the local embedding model: ${pct}%`);
                }
            }
        },
    });
    onProgress?.("local embedding model ready - everything from here runs in your browser");
    return {
        kind,
        dim: 384,
        async embed(texts) {
            const out = [];
            for (let i = 0; i < texts.length; i += 8) {
                const batch = texts.slice(i, i + 8);
                const res = await extractor(batch, { pooling: "mean", normalize: true });
                const width = res.dims[res.dims.length - 1];
                for (let j = 0; j < batch.length; j++)
                    out.push(normalize(Float32Array.from(Array.from(res.data.slice(j * width, (j + 1) * width)))));
            }
            return out;
        },
    };
}
async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`failed to load ${url} (${res.status})`);
    return res.json();
}
/** Load the static index artifacts and rebuild the engine pieces. The
 * embedder matches the index meta: semantic indexes get the WASM model
 * (injectable for tests), hashing indexes the lexical embedder. */
export async function loadDemoIndex(base = "data", wasmFactory) {
    const meta = (await fetchJson(`${base}/meta.json`));
    const chunksRaw = await (await fetch(`${base}/chunks.jsonl`)).text();
    const chunks = chunksRaw.trim().split("\n").map(l => JSON.parse(l));
    // The graph is optional (flat indexes have no hnsw.json).
    const hnswRes = await fetch(`${base}/hnsw.json`);
    const hnswJson = hnswRes.ok ? await hnswRes.json() : null;
    const vecBuf = await (await fetch(`${base}/vectors.f32`)).arrayBuffer();
    const vectors = new Map();
    for (let i = 0; i < chunks.length; i++) {
        vectors.set(chunks[i].id, new Float32Array(vecBuf, i * meta.dim * 4, meta.dim));
    }
    const index = hnswJson ? HnswIndex.fromJSON(hnswJson, vectors) : null;
    const embedder = meta.embedderKind.startsWith("local-wasm:")
        ? await (wasmFactory ?? createWasmEmbedder)(meta.embedderKind.slice("local-wasm:".length))
        : new HashingEmbedder(meta.dim);
    return { meta, chunks, index, vectors, embedder, source: { kind: "builtin", label: "dp177/ember" } };
}
/** Build a searchable dataset in memory from freshly chunked repo files:
 * embed every chunk with the (already loaded) embedder, exact-scan search. */
export async function buildDemoIndexFromChunks(chunks, embedder, source, onProgress) {
    const vectors = new Map();
    const BATCH = 16;
    for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        const vecs = await embedder.embed(batch.map(c => c.text));
        batch.forEach((c, j) => vectors.set(c.id, vecs[j]));
        onProgress?.(`embedding chunks: ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
    }
    const meta = {
        embedderKind: embedder.kind, dim: embedder.dim,
        chunkCount: chunks.length, fileCount: new Set(chunks.map(c => c.file)).size,
        updatedAt: new Date().toISOString(), indexMode: "flat",
    };
    return { meta, chunks, index: null, vectors, embedder, source };
}
/** Same scoring as EmberEngine.search: graph or exact-scan candidates +
 * exact dot product + the same capped path-token boost (kept in lockstep by
 * demo-web.test.ts). */
const PATH_BOOST_PER_TOKEN = 0.05;
const PATH_BOOST_CAP = 0.1;
function pathBoost(queryTokens, file) {
    const base = file.split("/").pop().replace(/\.[^.]+$/, "");
    let boost = 0;
    for (const t of tokenize(base))
        if (queryTokens.has(t))
            boost += PATH_BOOST_PER_TOKEN;
    return Math.min(boost, PATH_BOOST_CAP);
}
export async function demoSearch(d, query, k = 8) {
    const [qv] = await d.embedder.embed([query]);
    const qTokens = new Set(tokenize(query));
    const ids = d.index
        ? d.index.search(qv, k * 3, Math.max(50, k * 4))
        : [...d.vectors.entries()]
            .map(([id, vec]) => { let s = 0; for (let i = 0; i < qv.length; i++)
            s += qv[i] * vec[i]; return { id, s }; })
            .sort((a, b) => b.s - a.s)
            .slice(0, k * 3)
            .map(x => x.id);
    const byId = new Map(d.chunks.map(c => [c.id, c]));
    const hits = [];
    for (const id of ids) {
        const chunk = byId.get(id);
        if (!chunk)
            continue;
        const vec = d.vectors.get(id);
        let score = 0;
        if (vec)
            for (let i = 0; i < qv.length; i++)
                score += qv[i] * vec[i];
        hits.push({ chunk, score: score + pathBoost(qTokens, chunk.file) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
}
/** Render one hit. All untrusted content goes through textContent - never innerHTML. */
