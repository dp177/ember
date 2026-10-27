/**
 * Pure-TypeScript HNSW (Hierarchical Navigable Small World) approximate
 * nearest-neighbour index. Zero dependencies.
 *
 * Cosine similarity on L2-normalized vectors (dot product).
 * Based on Malkov & Yashunin (2016), "Efficient and robust approximate
 * nearest neighbor search using Hierarchical Navigable Small World graphs".
 */
/** Small deterministic PRNG (mulberry32) so builds are reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export class HnswIndex {
    dim;
    M;
    efConstruction;
    mL;
    rand;
    nodes = [];
    entryPoint = -1;
    maxLevel = -1;
    constructor(dim, opts = {}) {
        if (dim <= 0)
            throw new Error("dim must be positive");
        this.dim = dim;
        this.M = opts.M ?? 16;
        this.efConstruction = opts.efConstruction ?? 200;
        this.mL = opts.mL ?? 1 / Math.log(this.M);
        this.rand = mulberry32(opts.seed ?? 42);
    }
    get size() {
        return this.nodes.length;
    }
    sim(a, b) {
        let s = 0;
        for (let i = 0; i < a.length; i++)
            s += a[i] * b[i];
        return s; // vectors are pre-normalized -> cosine
    }
    randomLevel() {
        return Math.floor(-Math.log(this.rand() + 1e-12) * this.mL);
    }
    /** Greedy search from entry points down to `targetLayer + 1`. Returns closest id. */
    searchLayerSimple(query, ep, fromLevel, toLevel) {
        let curr = ep;
        for (let l = fromLevel; l > toLevel; l--) {
            let changed = true;
            while (changed) {
                changed = false;
                const cn = this.nodes[curr];
                const cnbrs = cn.neighbors[l] ?? [];
                let best = curr;
                let bestSim = this.sim(query, cn.vector);
                for (const nb of cnbrs) {
                    const n = this.nodes[nb];
                    if (!n)
                        continue;
                    const s = this.sim(query, n.vector);
                    if (s > bestSim) {
                        bestSim = s;
                        best = nb;
                    }
                }
                if (best !== curr) {
                    curr = best;
                    changed = true;
                }
            }
        }
        return curr;
    }
    /** Beam search on one layer. Returns ids sorted by similarity desc, up to ef. */
    searchLayer(query, entryIds, ef, level) {
        const visited = new Set(entryIds);
        // candidates: min-heap by similarity (worst at top is unnecessary; use arrays + sort, n small)
        const cand = [];
        const results = [];
        for (const id of entryIds) {
            const n = this.nodes[id];
            if (!n)
                continue;
            const s = this.sim(query, n.vector);
            cand.push({ id, s });
            results.push({ id, s });
        }
        while (cand.length > 0) {
            cand.sort((a, b) => b.s - a.s);
            const best = cand.shift();
            results.sort((a, b) => a.s - b.s); // ascending; [0] = worst
            const worst = results[0];
            if (best.s < worst.s && results.length >= ef)
                break;
            const node = this.nodes[best.id];
            const nbrs = node.neighbors[level] ?? [];
            for (const nb of nbrs) {
                if (visited.has(nb))
                    continue;
                visited.add(nb);
                const n = this.nodes[nb];
                if (!n)
                    continue;
                const s = this.sim(query, n.vector);
                results.sort((a, b) => a.s - b.s);
                if (s > results[0].s || results.length < ef) {
                    cand.push({ id: nb, s });
                    results.push({ id: nb, s });
                    if (results.length > ef)
                        results.shift(); // drop worst
                }
            }
        }
        results.sort((a, b) => b.s - a.s);
        return results.map(r => r.id);
    }
    /**
     * HNSW neighbor-selection heuristic (alg. 4 from the paper): walk candidates
     * nearest-first and keep a candidate only if it is closer to the query than
     * to any already-selected neighbor. This preserves long-range "bridge" edges
     * that pure nearest-M selection would prune away, which is what keeps the
     * graph connected on clustered data.
     */
    selectNeighbors(query, candidates, m) {
        const selected = [];
        for (const c of candidates) {
            if (selected.length >= m)
                break;
            const cv = this.nodes[c].vector;
            const simQC = this.sim(query, cv);
            let diverse = true;
            for (const s of selected) {
                if (this.sim(cv, this.nodes[s].vector) > simQC) {
                    diverse = false;
                    break;
                }
            }
            if (diverse)
                selected.push(c);
        }
        // If diversity filtering returned too few, fill up with nearest leftovers.
        if (selected.length < m) {
            for (const c of candidates) {
                if (selected.length >= m)
                    break;
                if (!selected.includes(c))
                    selected.push(c);
            }
        }
        return selected;
    }
    add(id, vector) {
        if (vector.length !== this.dim)
            throw new Error(`vector dim ${vector.length} != index dim ${this.dim}`);
        if (this.nodes[id])
            throw new Error(`id ${id} already exists`);
        const level = this.randomLevel();
        const neighbors = [];
        for (let l = 0; l <= level; l++)
            neighbors.push([]);
        const node = { id, level, vector, neighbors };
        this.nodes[id] = node;
        if (this.entryPoint === -1) {
            this.entryPoint = id;
            this.maxLevel = level;
            return;
        }
        let ep = this.entryPoint;
        // Zoom from top down to level+1 (greedy)
        if (level < this.maxLevel) {
            ep = this.searchLayerSimple(vector, ep, this.maxLevel, level);
        }
        const topL = Math.min(level, this.maxLevel);
        for (let l = topL; l >= 0; l--) {
            const layerCands = this.searchLayer(vector, [ep], this.efConstruction, l);
            const m = l === 0 ? this.M * 2 : this.M;
            const chosen = this.selectNeighbors(vector, layerCands, m);
            node.neighbors[l] = chosen;
            for (const nbId of chosen) {
                const nb = this.nodes[nbId];
                if (!nb.neighbors[l])
                    nb.neighbors[l] = [];
                nb.neighbors[l].push(id);
                if (nb.neighbors[l].length > m) {
                    // prune with the same diversity heuristic, centred on nb
                    const scored = nb.neighbors[l].map(x => ({ x, s: this.sim(nb.vector, this.nodes[x].vector) }));
                    scored.sort((a, b) => b.s - a.s);
                    nb.neighbors[l] = this.selectNeighbors(nb.vector, scored.map(e => e.x), m);
                }
            }
            if (layerCands.length > 0)
                ep = layerCands[0];
        }
        if (level > this.maxLevel) {
            this.maxLevel = level;
            this.entryPoint = id;
        }
    }
    /** Approximate k nearest neighbors. Returns ids sorted by similarity desc. */
    /** Vector of a stored node (used by incremental re-index to reuse embeddings). */
    getVector(id) {
        return this.nodes[id]?.vector;
    }
    search(query, k, ef) {
        if (this.entryPoint === -1)
            return [];
        const efSearch = Math.max(ef ?? 50, k);
        let ep = this.entryPoint;
        if (this.maxLevel > 0)
            ep = this.searchLayerSimple(query, ep, this.maxLevel, 0);
        return this.searchLayer(query, [ep], efSearch, 0).slice(0, k);
    }
    /** Serialize to plain JSON. */
    toJSON() {
        return {
            dim: this.dim, M: this.M, efConstruction: this.efConstruction,
            entryPoint: this.entryPoint, maxLevel: this.maxLevel,
            nodes: this.nodes.map(n => n ? { id: n.id, level: n.level, neighbors: n.neighbors } : null),
        };
    }
    /** Rebuild graph topology (vectors are re-attached by the caller). */
    static fromJSON(data, vectors) {
        const idx = new HnswIndex(data.dim, { M: data.M, efConstruction: data.efConstruction });
        idx.entryPoint = data.entryPoint;
        idx.maxLevel = data.maxLevel;
        idx.nodes = data.nodes.map((n) => {
            if (!n)
                return null;
            const v = vectors.get(n.id);
            if (!v)
                throw new Error(`missing vector for node ${n.id}`);
            return { id: n.id, level: n.level, vector: v, neighbors: n.neighbors };
        });
        return idx;
    }
}
/** Exact brute-force top-k (for tests and small sets). */
export function bruteForceTopK(query, vectors, k) {
    const scored = vectors.map((v, i) => {
        let s = 0;
        for (let j = 0; j < v.length; j++)
            s += query[j] * v[j];
        return { i, s };
    });
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, k).map(e => e.i);
}
/** L2-normalize in place and return the vector. */
export function normalize(v) {
    let n = 0;
    for (let i = 0; i < v.length; i++)
        n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++)
        v[i] /= n;
    return v;
}
