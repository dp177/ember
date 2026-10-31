/** The single-page UI, served inline (no external assets, no CDN). */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ember</title>
<style>
  :root { --bg:#14100c; --card:#1f1a14; --line:#3a2f24; --fg:#f3e9dc; --dim:#b09b84; --accent:#ff8c42; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 -apple-system, system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { font-size: 22px; margin: 0 0 2px; display:flex; align-items:center; gap:8px; }
  .sub { color: var(--dim); font-size: 13px; margin-bottom: 20px; }
  .bar { display:flex; gap:8px; margin-bottom: 8px; }
  input[type=text] { flex:1; padding:10px 12px; border-radius:10px; border:1px solid var(--line); background:var(--card); color:var(--fg); font:inherit; }
  button { padding:10px 16px; border-radius:10px; border:0; background:var(--accent); color:#1a1005; font-weight:600; cursor:pointer; }
  button.ghost { background:var(--card); color:var(--dim); border:1px solid var(--line); }
  .tabs { display:flex; gap:6px; margin:14px 0 18px; }
  .tabs button { background:var(--card); color:var(--dim); border:1px solid var(--line); font-weight:500; }
  .tabs button.on { color:var(--fg); border-color:var(--accent); }
  .hit { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; margin-bottom:10px; }
  .hit .loc { font-family:ui-monospace,monospace; font-size:13px; color:var(--accent); cursor:pointer; }
  .hit .loc:hover { text-decoration: underline; }
  .hit .sym { color:var(--dim); font-size:12px; margin-left:6px; }
  .hit .score { float:right; color:var(--dim); font-size:12px; }
  pre { background:#0d0a07; border:1px solid var(--line); border-radius:10px; padding:10px 12px; overflow:auto; font:12.5px/1.5 ui-monospace,monospace; margin:8px 0 0; white-space:pre-wrap; }
  pre .ln { color:var(--dim); user-select:none; display:inline-block; width:3em; text-align:right; margin-right:1em; }
  .answer { white-space:pre-wrap; }
  .mode { display:inline-block; font-size:12px; padding:2px 10px; border-radius:999px; margin-bottom:10px; }
  .mode.extractive { background:#3a2f24; color:var(--dim); }
  .mode.synth { background:#274027; color:#9fd89f; }
  .status { font-size:12.5px; color:var(--dim); margin-bottom:14px; }
  .progress { font:11.5px/1.5 ui-monospace,monospace; color:var(--dim); background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:14px; max-height:140px; overflow:auto; white-space:pre-wrap; }
  .err { color:#ff7a7a; }
  .hidden { display:none; }
  .srchead { color:var(--dim); font-size:12.5px; margin:18px 0 8px; }
</style>
</head>
<body>
<main>
  <h1><svg width="20" height="24" viewBox="0 0 20 24" fill="none" aria-hidden="true"><path d="M10 1c1 4-4 6-4 11a6 6 0 0 0 12 0c0-2-1-3.5-2-5-.5 1.5-1.5 2-2.5 2C14.5 6 12 3.5 10 1z" fill="#ff8c42"/><path d="M10 12c.6 2.4-2.4 3.4-2.4 6a3.4 3.4 0 0 0 6.8 0c0-1.2-.6-2.1-1.2-3-.3.9-.9 1.2-1.5 1.2.6-1.8-.6-3.3-1.7-4.2z" fill="#ffd166"/></svg>Ember</h1>
  <div class="sub">warm start for coding agents - local, cited, persistent</div>
  <div class="status" id="status">loading&hellip;</div>
  <div class="bar" style="margin-bottom:14px">
    <button id="reindexBtn" class="ghost">Reindex</button>
  </div>
  <div class="progress hidden" id="progress"></div>

  <div class="bar">
    <input id="q" type="text" placeholder="ask or search this repo&hellip;" autofocus>
    <button id="searchBtn">Search</button>
    <button id="askBtn" class="ghost" title="Needs a configured chat model for synthesis; without one this is labeled retrieval-only">Ask</button>
  </div>
  <div class="tabs">
    <button data-tab="results" class="on">Results</button>
    <button data-tab="map">Repo map</button>
    <button data-tab="notes">Notes</button>
  </div>

  <section id="tab-results"></section>
  <section id="tab-map" class="hidden"><pre id="mapOut">loading&hellip;</pre></section>
  <section id="tab-notes" class="hidden">
    <div class="bar"><input id="noteText" type="text" placeholder="leave a note for the next session&hellip;"><button id="noteBtn" class="ghost">Save</button></div>
    <div id="notesOut"></div>
  </section>
</main>
<script>
const $ = s => document.querySelector(s);
const esc = s => s.replace(/&/g,"&amp;").replace(/</g,"&lt;");
const api = (p) => fetch(p).then(async r => { const d = await r.json().catch(()=>({})); if (!r.ok) throw new Error(d.error || r.statusText); return d; });

async function status() {
  try {
    const s = await api("/api/status");
    $("#status").innerHTML = s.indexed
      ? s.chunks + " chunks / " + s.files + " files &middot; " + esc(s.embedder) + " &middot; updated " + new Date(s.updatedAt).toLocaleString() + (s.hybrid ? " &middot; hybrid (experimental)" : "")
        + (s.modifiedSinceIndex > 0 ? ' &middot; <span class="err">' + s.modifiedSinceIndex + " file(s) modified since indexing - results may be stale; reindex to refresh</span>" : "")
      : 'not indexed yet - run <code>ember index</code> or press Reindex';
    if (s.resumableCheckpoint) $("#status").innerHTML += ' &middot; <span class="err">interrupted run: ' + s.resumableCheckpoint.chunkCount + " chunks checkpointed - Reindex resumes it</span>";
  } catch (e) { $("#status").innerHTML = '<span class="err">' + esc(e.message) + "</span>"; }
}

let polling = false;
$("#reindexBtn").addEventListener("click", async () => {
  const btn = $("#reindexBtn"), prog = $("#progress");
  btn.disabled = true;
  prog.classList.remove("hidden");
  prog.textContent = "starting index run...";
  try {
    const r = await fetch("/api/index", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409) prog.textContent = "an index run is already in progress - watching it...";
    else if (!r.ok) throw new Error(d.error || r.statusText);
  } catch (e) {
    prog.textContent = "could not start indexing: " + e.message;
    btn.disabled = false;
    return;
  }
  if (polling) return;
  polling = true;
  const tick = async () => {
    try {
      const s = await api("/api/index-status");
      if (s.lines && s.lines.length) { prog.textContent = s.lines.join("\\n"); prog.scrollTop = prog.scrollHeight; }
      if (!s.running) {
        polling = false;
        if (s.error) prog.textContent += "\\nindexing failed: " + s.error;
        else if (s.result) {
          prog.textContent += "\\ndone: indexed " + s.result.chunks + " chunks from " + s.result.files + " files";
          if (typeof s.result.embedded === "number")
            prog.textContent += " (kept " + s.result.kept + ", reused " + s.result.reused + ", newly embedded " + s.result.embedded + ")";
        }
        btn.disabled = false;
        status();
        return;
      }
    } catch (e) { /* transient; keep polling */ }
    setTimeout(tick, 1000);
  };
  tick();
});

function linesWithNumbers(text, startLine) {
  return text.split("\\n").map((l, j) => '<span class="ln">' + (startLine + j) + "</span>" + esc(l)).join("\\n");
}

function hitEl(h, i) {
  const el = document.createElement("div");
  el.className = "hit";
  el.innerHTML = '<span class="score">' + h.score.toFixed(4) + '</span>' +
    '<span class="loc">[' + (i+1) + "] " + esc(h.file) + ":" + h.startLine + "-" + h.endLine + "</span>" +
    (h.symbol && h.symbol.length > 2 ? '<span class="sym">' + esc(h.symbol) + "</span>" : "") +
    '<pre>' + linesWithNumbers(h.text, h.startLine) + "</pre>";
  // Click the citation to expand into surrounding file context.
  let expanded = false;
  el.querySelector(".loc").addEventListener("click", async () => {
    if (expanded) return;
    expanded = true;
    const pre = el.querySelector("pre");
    pre.textContent = "loading context...";
    try {
      const start = Math.max(1, h.startLine - 5);
      const f = await api("/api/file?path=" + encodeURIComponent(h.file) + "&start=" + start + "&end=" + (h.endLine + 15));
      pre.innerHTML = linesWithNumbers(f.lines.join("\\n"), f.startLine);
    } catch (e) { pre.textContent = e.message; }
  });
  return el;
}

async function run(kind) {
  const q = $("#q").value.trim();
  if (!q) return;
  const out = $("#tab-results");
  out.innerHTML = "working&hellip;";
  try {
    if (kind === "search") {
      const d = await api("/api/search?q=" + encodeURIComponent(q) + "&k=8");
      out.innerHTML = '<div class="mode extractive">ranked chunks - retrieval, not an answer</div>';
      d.hits.forEach((h, i) => out.appendChild(hitEl(h, i)));
      if (!d.hits.length) out.innerHTML += "no hits";
    } else {
      const d = await api("/api/ask?q=" + encodeURIComponent(q));
      out.innerHTML = "";
      const mode = document.createElement("div");
      mode.className = "mode " + (d.synthesized ? "synth" : "extractive");
      mode.textContent = d.synthesized
        ? "synthesized by a chat model - citations validated against retrieved chunks"
        : "retrieval only - no chat model configured, no model-generated claims";
      out.appendChild(mode);
      const a = document.createElement("div");
      a.className = "hit answer";
      a.textContent = d.answer;
      out.appendChild(a);
      // Source cards matter when a model wrote prose over them; the
      // extractive answer already shows the chunks inline.
      if (d.synthesized && d.hits && d.hits.length) {
        const head = document.createElement("div");
        head.className = "srchead";
        head.textContent = "Sources (click a citation for context):";
        out.appendChild(head);
        d.hits.slice(0, 5).forEach((h, i) => out.appendChild(hitEl(h, i)));
      }
    }
  } catch (e) { out.innerHTML = '<div class="hit err">' + esc(e.message) + "</div>"; }
}

$("#searchBtn").addEventListener("click", () => run("search"));
$("#askBtn").addEventListener("click", () => run("ask"));
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") run(e.shiftKey ? "search" : "ask"); });

document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", async () => {
  document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
  ["results", "map", "notes"].forEach(t => $("#tab-" + t).classList.toggle("hidden", t !== b.dataset.tab));
  if (b.dataset.tab === "map") { try { $("#mapOut").textContent = (await api("/api/map")).map; } catch (e) { $("#mapOut").textContent = e.message; } }
  if (b.dataset.tab === "notes") loadNotes();
}));

async function loadNotes() {
  try {
    const d = await api("/api/notes");
    $("#notesOut").innerHTML = d.notes.length
      ? d.notes.map(n => '<div class="hit">#' + n.id + " &middot; " + esc(n.ts) + "<br>" + esc(n.text) + (n.tags.length ? ' <span class="sym">' + esc(n.tags.join(", ")) + "</span>" : "") + "</div>").join("")
      : '<div class="hit">no notes yet</div>';
  } catch (e) { $("#notesOut").innerHTML = '<div class="hit err">' + esc(e.message) + "</div>"; }
}
$("#noteBtn").addEventListener("click", async () => {
  const text = $("#noteText").value.trim();
  if (!text) return;
  await fetch("/api/notes", { method: "POST", body: JSON.stringify({ text }) });
  $("#noteText").value = "";
  loadNotes();
});

status();
// Deep-link: /#q=...&go=search|ask runs the query on load.
const h = new URLSearchParams(location.hash.slice(1));
if (h.get("q")) { $("#q").value = h.get("q"); run(h.get("go") === "search" ? "search" : "ask"); }
</script>
</body>
</html>`;
