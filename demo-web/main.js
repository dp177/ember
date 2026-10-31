import { loadDemoIndex, demoSearch, createWasmEmbedder } from "./search-core.js";
import { parseGitHubUrl } from "../src/ui/github-url.js";
import { fetchAndChunk } from "./repo-loader.js";
import { buildDemoIndexFromChunks } from "./search-core.js";
const $ = (id) => document.getElementById(id);
function setStatus(msg) { $("status").textContent = msg; }
let active;
let builtin;
function hitUrl(d, file, line) {
    return d.source.kind === "github"
        ? `https://github.com/${d.source.label}/blob/${d.source.branch ?? "main"}/${file.split("/").map(encodeURIComponent).join("/")}#L${line}`
        : `https://github.com/dp177/ember/blob/main/${encodeURIComponent(file)}#L${line}`;
}
function renderHit(d, h, n) {
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
    link.href = hitUrl(d, h.chunk.file, h.chunk.startLine);
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
    const src = d.source.kind === "github" ? `github: ${d.source.label}` : `built-in index of dp177/ember`;
    $("stats").textContent =
        `${src}: ${d.meta.chunkCount} chunks / ${d.meta.fileCount} files, ${langStr}, ` +
            `embedder=${d.meta.embedderKind} (dim ${d.meta.dim})` +
            (d.source.kind === "builtin" ? `, built ${d.meta.updatedAt.slice(0, 10)}.` : ".") +
            ` Search runs entirely in your browser - local semantic retrieval, no server, no account.`;
    $("resetBtn").classList.toggle("hidden", d.source.kind === "builtin");
}
async function runSearch() {
    const input = $("q");
    const q = input.value.trim();
    const out = $("results");
    out.textContent = "";
    if (!q || !active)
        return;
    setStatus("searching ...");
    try {
        const hits = await demoSearch(active, q, 8);
        setStatus(hits.length ? "" : "no hits - try different terms");
        hits.forEach((h, i) => out.appendChild(renderHit(active, h, i + 1)));
    }
    catch (e) {
        setStatus(`search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
async function loadRepo() {
    const input = $("repoUrl");
    const btn = $("repoBtn");
    const url = input.value.trim();
    if (!url) {
        setStatus("paste a GitHub repo URL first, e.g. https://github.com/sindresorhus/parse-json");
        return;
    }
    let repo;
    try {
        repo = parseGitHubUrl(url);
    }
    catch (e) {
        setStatus(e instanceof Error ? e.message : String(e));
        return;
    }
    btn.disabled = true;
    $("results").textContent = ""; // never show the previous repo's hits under a new name
    try {
        const loaded = await fetchAndChunk(repo, setStatus);
        setStatus(`embedding ${loaded.chunks.length} chunks from ${loaded.files} files (local WASM, in your browser)...`);
        const d = await buildDemoIndexFromChunks(loaded.chunks, builtin.embedder, { kind: "github", label: repo.label, branch: loaded.branch }, setStatus);
        active = d;
        renderStats(d);
        setStatus(`loaded ${repo.label}: ${d.meta.chunkCount} chunks from ${d.meta.fileCount} files${loaded.bounded ? " (bounded - see earlier note)" : ""}. Search now runs against this repo.`);
        $("q").focus();
    }
    catch (e) {
        setStatus(`cannot load repo: ${e instanceof Error ? e.message : String(e)}`);
    }
    finally {
        btn.disabled = false;
    }
}
async function boot() {
    try {
        setStatus("loading index artifacts ...");
        builtin = await loadDemoIndex("data", (model) => createWasmEmbedder(model, setStatus));
        active = builtin;
        renderStats(active);
        setStatus("");
        $("form").addEventListener("submit", e => { e.preventDefault(); void runSearch(); });
        $("repoBtn").addEventListener("click", () => void loadRepo());
        $("repoUrl").addEventListener("keydown", e => { if (e.key === "Enter") {
            e.preventDefault();
            void loadRepo();
        } });
        $("resetBtn").addEventListener("click", () => { active = builtin; renderStats(active); $("results").textContent = ""; setStatus("back to the built-in dp177/ember index."); });
        const params = new URLSearchParams(location.search);
        const input = $("q");
        if (params.get("q")) {
            input.value = params.get("q");
            void runSearch();
        }
    }
    catch (e) {
        setStatus(`failed to load the demo index: ${e instanceof Error ? e.message : String(e)}`);
    }
}
if (typeof document !== "undefined")
    void boot();
