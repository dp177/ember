import { loadDemoIndex, demoSearch } from "./search-core.js";
const $ = (id) => document.getElementById(id);
function setStatus(msg) { $("status").textContent = msg; }
function renderHit(h, n) {
    const div = document.createElement("div");
    div.className = "hit";
    const head = document.createElement("div");
    head.className = "hit-head";
    head.textContent = `[${n}] ${h.chunk.file}:${h.chunk.startLine}-${h.chunk.endLine}` +
        (h.chunk.symbol ? ` (${h.chunk.symbol})` : "") + `  score=${h.score.toFixed(3)}`;
    const pre = document.createElement("pre");
    pre.textContent = h.chunk.text.split("\n").slice(0, 8).join("\n");
    const link = document.createElement("a");
    link.textContent = "view on GitHub";
    link.href = `https://github.com/dp177/ember/blob/main/${encodeURIComponent(h.chunk.file)}#L${h.chunk.startLine}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    div.append(head, pre, link);
    return div;
}
function renderStats(d) {
    const files = [...new Set(d.chunks.map(c => c.file))];
    const langs = new Map();
    for (const f of files) {
        const ext = f.split(".").pop() ?? "?";
        langs.set(ext, (langs.get(ext) ?? 0) + 1);
    }
    const langStr = [...langs.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}(${v})`).join(", ");
    $("stats").textContent =
        `Index of the public dp177/ember repo: ${d.meta.chunkCount} chunks / ${d.meta.fileCount} files, ` +
            `${langStr}, embedder=${d.meta.embedderKind} (dim ${d.meta.dim}), built ${d.meta.updatedAt.slice(0, 10)}. ` +
            `Search runs entirely in your browser with Ember's real HNSW + lexical embedder.`;
}
async function boot() {
    try {
        setStatus("loading index artifacts ...");
        const d = await loadDemoIndex();
        renderStats(d);
        setStatus("");
        const form = $("form");
        const input = $("q");
        const run = async () => {
            const q = input.value.trim();
            const out = $("results");
            out.textContent = "";
            if (!q)
                return;
            setStatus("searching ...");
            const hits = await demoSearch(d, q, 8);
            setStatus(hits.length ? "" : "no hits - try different terms (lexical matching, not semantic)");
            hits.forEach((h, i) => out.appendChild(renderHit(h, i + 1)));
        };
        form.addEventListener("submit", e => { e.preventDefault(); void run(); });
        const params = new URLSearchParams(location.search);
        if (params.get("q")) {
            input.value = params.get("q");
            void run();
        }
    }
    catch (e) {
        setStatus(`failed to load the demo index: ${e instanceof Error ? e.message : String(e)}`);
    }
}
if (typeof document !== "undefined")
    void boot();
