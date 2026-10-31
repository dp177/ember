// demo-web/main.ts - browser glue for the Ember live demo.
// Three-pane workspace: sources/recent repos on the left, search + results
// in the middle, a full-chunk context preview on the right.
// Search logic lives in search-core.ts, repo loading in repo-loader.ts,
// the recent-repos list in recent-repos.ts.
import type { DemoIndex, DemoHit } from "./search-core.js";
import { loadDemoIndex, demoSearch, createWasmEmbedder, buildDemoIndexFromChunks } from "./search-core.js";
import { parseGitHubUrl } from "../src/ui/github-url.js";
import { fetchAndChunk } from "./repo-loader.js";
import { loadRecents, recordRecent, recentRepoUrl, type RecentRepo } from "./recent-repos.js";

const $ = (id: string) => document.getElementById(id)!;

function setStatus(msg: string): void { $("status").textContent = msg; }

let builtin: DemoIndex;
let active: DemoIndex;
let hits: DemoHit[] = [];
let selected = -1;

function modelTag(d: DemoIndex): string {
  // "local-wasm:Xenova/all-MiniLM-L6-v2" -> "local-wasm all-MiniLM-L6-v2"
  return d.meta.embedderKind.replace("local-wasm:", "local-wasm ").split("/").pop()!;
}

function hitUrl(d: DemoIndex, file: string, line: number): string {
  return d.source.kind === "github"
    ? `https://github.com/${d.source.label}/blob/${d.source.branch ?? "main"}/${file.split("/").map(encodeURIComponent).join("/")}#L${line}`
    : `https://github.com/dp177/ember/blob/main/${encodeURIComponent(file)}#L${line}`;
}

// ---- left pane: sources + recent repos (all real: built-in index, the
// repo actually loaded, and repos the visitor actually loaded before) ----

function srcButton(opts: { name: string; kind: string; sub: string; on: boolean; onClick: () => void }): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "src" + (opts.on ? " on" : "");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = opts.name;
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = opts.kind;
  name.appendChild(kind);
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = opts.sub;
  b.append(name, sub);
  b.addEventListener("click", opts.onClick);
  return b;
}

function renderSources(): void {
  const el = $("sources");
  el.textContent = "";

  const h = document.createElement("h4");
  h.textContent = "Sources";
  el.appendChild(h);

  el.appendChild(srcButton({
    name: "dp177/ember",
    kind: "built-in",
    sub: `${builtin.meta.chunkCount} chunks · ${builtin.meta.fileCount} files`,
    on: active === builtin,
    onClick: () => {
      if (active === builtin) return;
      active = builtin;
      hits = []; selected = -1;
      renderAll();
      setStatus("back to the built-in dp177/ember index.");
    },
  }));

  if (active.source.kind === "github") {
    el.appendChild(srcButton({
      name: active.source.label,
      kind: `@${active.source.branch ?? "main"}`,
      sub: `${active.meta.chunkCount} chunks · ${active.meta.fileCount} files · github`,
      on: true,
      onClick: () => {},
    }));
  }

  const recents = loadRecents(window.localStorage);
  if (recents.length) {
    const h2 = document.createElement("h4");
    h2.textContent = "Recent repos";
    el.appendChild(h2);
    for (const r of recents) {
      const isActive = active.source.kind === "github" &&
        active.source.label === r.label && (active.source.branch ?? "main") === r.branch;
      el.appendChild(srcButton({
        name: r.label,
        kind: `@${r.branch}`,
        sub: `${r.chunkCount} chunks · loaded ${r.loadedAt.slice(0, 10)}`,
        on: isActive,
        onClick: () => void loadRepoUrl(recentRepoUrl(r)),
      }));
    }
  }

  const note = document.createElement("div");
  note.className = "note";
  note.textContent = "Repos load from GitHub's public API. The recent list stays in your browser's local storage - nothing is sent anywhere.";
  el.appendChild(note);
}

// ---- middle pane: search + dense results ----

function renderResults(): void {
  const out = $("results");
  out.textContent = "";
  if (!hits.length) return;
  hits.forEach((h, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row" + (i === selected ? " on" : "");
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = `[${i + 1}]`;
    const f = document.createElement("span");
    f.className = "f";
    f.textContent = `${h.chunk.file}:${h.chunk.startLine}-${h.chunk.endLine} `;
    if (h.chunk.symbol) {
      const sym = document.createElement("small");
      sym.textContent = h.chunk.symbol;
      f.appendChild(sym);
    }
    const s = document.createElement("span");
    s.className = "s";
    s.textContent = h.score.toFixed(3);
    row.append(n, f, s);
    row.addEventListener("click", () => selectHit(i));
    out.appendChild(row);
  });
}

// ---- right pane: full-chunk context preview ----

function renderPreview(): void {
  const el = $("preview");
  el.textContent = "";
  const h = document.createElement("h4");
  h.textContent = "Context preview";
  el.appendChild(h);
  const hit = selected >= 0 ? hits[selected] : undefined;
  if (!hit) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = "Search, then pick a result to read the full chunk here.";
    el.appendChild(p);
    return;
  }
  const file = document.createElement("div");
  file.id = "pvFile";
  file.textContent = `${hit.chunk.file} · lines ${hit.chunk.startLine}-${hit.chunk.endLine}` +
    (hit.chunk.symbol ? ` · ${hit.chunk.symbol}` : "");
  const pre = document.createElement("pre");
  pre.id = "pvCode";
  const lines = hit.chunk.text.split("\n");
  lines.forEach((text, i) => {
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.textContent = String(hit.chunk.startLine + i);
    pre.append(ln, document.createTextNode(text + (i < lines.length - 1 ? "\n" : "")));
  });
  const meta = document.createElement("div");
  meta.id = "pvMeta";
  const score = document.createElement("span");
  score.textContent = `score ${hit.score.toFixed(3)}`;
  const link = document.createElement("a");
  link.textContent = "view on GitHub ↗";
  link.href = hitUrl(active, hit.chunk.file, hit.chunk.startLine);
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  meta.append(score, link);
  el.append(file, pre, meta);
}

function renderHeaderStats(): void {
  $("hdrStats").textContent = `${active.meta.chunkCount} chunks · ${modelTag(active)}`;
}

function renderAll(): void {
  renderSources();
  renderResults();
  renderPreview();
  renderHeaderStats();
}

function selectHit(i: number): void {
  selected = i;
  renderResults();
  renderPreview();
}

async function runSearch(): Promise<void> {
  const input = $("q") as HTMLInputElement;
  const q = input.value.trim();
  hits = []; selected = -1;
  renderResults(); renderPreview();
  if (!q || !active) return;
  setStatus("searching ...");
  try {
    hits = await demoSearch(active, q, 8);
    if (!hits.length) { setStatus("no hits - try different terms"); return; }
    setStatus(`${hits.length} ranked chunks - retrieval, not an answer · semantic, local`);
    selectHit(0);
  } catch (e) {
    setStatus(`search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function loadRepoUrl(url: string): Promise<void> {
  const input = $("repoUrl") as HTMLInputElement;
  const btn = $("repoBtn") as HTMLButtonElement;
  input.value = url;
  let repo;
  try { repo = parseGitHubUrl(url); } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
    return;
  }
  btn.disabled = true;
  hits = []; selected = -1;
  renderResults(); renderPreview(); // never show the previous repo's hits under a new name
  try {
    const loaded = await fetchAndChunk(repo, setStatus);
    setStatus(`embedding ${loaded.chunks.length} chunks from ${loaded.files} files (local WASM, in your browser)...`);
    const d = await buildDemoIndexFromChunks(loaded.chunks, builtin.embedder,
      { kind: "github", label: repo.label, branch: loaded.branch }, setStatus);
    active = d;
    const rec: RecentRepo = {
      label: repo.label, branch: loaded.branch,
      chunkCount: d.meta.chunkCount, fileCount: d.meta.fileCount,
      loadedAt: new Date().toISOString(),
    };
    recordRecent(window.localStorage, rec);
    renderAll();
    setStatus(`loaded ${repo.label}: ${d.meta.chunkCount} chunks from ${d.meta.fileCount} files${loaded.bounded ? " (bounded - see earlier note)" : ""}. Search now runs against this repo.`);
    ($("q") as HTMLInputElement).focus();
  } catch (e) {
    setStatus(`cannot load repo: ${e instanceof Error ? e.message : String(e)}`);
    renderAll();
  } finally {
    btn.disabled = false;
  }
}

async function boot(): Promise<void> {
  try {
    setStatus("loading index artifacts ...");
    builtin = await loadDemoIndex("data", (model) => createWasmEmbedder(model, setStatus));
    active = builtin;
    renderAll();
    setStatus("");
    ($("form") as HTMLFormElement).addEventListener("submit", e => { e.preventDefault(); void runSearch(); });
    $("repoBtn").addEventListener("click", () => {
      const url = ($("repoUrl") as HTMLInputElement).value.trim();
      if (!url) { setStatus("paste a GitHub repo URL first, e.g. https://github.com/sindresorhus/parse-json"); return; }
      void loadRepoUrl(url);
    });
    ($("repoUrl") as HTMLInputElement).addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        const url = ($("repoUrl") as HTMLInputElement).value.trim();
        if (url) void loadRepoUrl(url);
      }
    });
    // Up/down moves the result selection when not typing in a field.
    document.addEventListener("keydown", e => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "ArrowDown" && selected + 1 < hits.length) { e.preventDefault(); selectHit(selected + 1); }
      if (e.key === "ArrowUp" && selected > 0) { e.preventDefault(); selectHit(selected - 1); }
    });
    const params = new URLSearchParams(location.search);
    if (params.get("q")) {
      ($("q") as HTMLInputElement).value = params.get("q")!;
      void runSearch();
    }
  } catch (e) {
    setStatus(`failed to load the demo index: ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (typeof document !== "undefined") void boot();
