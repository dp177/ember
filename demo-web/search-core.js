/**
 * Ember live browser demo: runs the REAL search engine client-side.
 * Same HashingEmbedder + HNSW code as the CLI (imported, not copied).
 * Loads the public repo's own pre-built index artifacts as static files.
 * Read-only by construction: no server, no writes, no secrets.
 */
import { HnswIndex } from "../src/core/hnsw.js";
import { HashingEmbedder, tokenize } from "../src/core/embedder.js";
async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`failed to load ${url} (${res.status})`);
    return res.json();
}
/** Load the static index artifacts and rebuild the engine pieces. */
export async function loadDemoIndex(base = "data") {
    const meta = (await fetchJson(`${base}/meta.json`));
    const chunksRaw = await (await fetch(`${base}/chunks.jsonl`)).text();
    const chunks = chunksRaw.trim().split("\n").map(l => JSON.parse(l));
    const hnswJson = await fetchJson(`${base}/hnsw.json`);
    const vecBuf = await (await fetch(`${base}/vectors.f32`)).arrayBuffer();
    const vectors = new Map();
    for (let i = 0; i < chunks.length; i++) {
        vectors.set(chunks[i].id, new Float32Array(vecBuf, i * meta.dim * 4, meta.dim));
    }
    const index = HnswIndex.fromJSON(hnswJson, vectors);
    const embedder = new HashingEmbedder(meta.dim);
    return { meta, chunks, index, embedder };
}
/** Same scoring as EmberEngine.search: HNSW candidates + exact dot product
 * + the same capped path-token boost (kept in lockstep by demo-web.test.ts). */
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
    const ids = d.index.search(qv, k * 3, Math.max(50, k * 4));
    const byId = new Map(d.chunks.map(c => [c.id, c]));
    const hits = [];
    for (const id of ids) {
        const chunk = byId.get(id);
        if (!chunk)
            continue;
        const vec = d.index.getVector(id);
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
