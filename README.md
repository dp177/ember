# Ember — a warm start for coding agents

**Persistent, queryable memory for your codebase — CLI, MCP server, and a
local web UI.**
Point Ember at a repo once; every coding agent you use (Claude Code, Cursor,
Windsurf, …) starts warm instead of cold — with hybrid-capable search, a repo
map, a mined decision log, and answers that cite `file:line`. MIT licensed,
local-first, no native modules (three pure-JS runtime deps: MCP SDK, commander, zod).

## The problem

Coding agents start every session cold. Architecture, conventions, and the
reasons behind past decisions get reconstructed tool call by tool call —
slowly, expensively, and often wrong. Humans carry that context implicitly.

## What Ember does

- `index_repo` — scans a repo, splits code into symbol-aware chunks, embeds
  them, and stores them for exact vector search. Everything persists in
  `<repo>/.ember/` — no database, no daemon.
  Re-indexing is incremental: per-file hashes mean unchanged files keep their
  embeddings, only new/changed files are re-embedded, and deleted files drop
  out (`--full` forces a from-scratch rebuild). A `.emberignore` file keeps
  fixtures and generated files out of the corpus.
- `search_code` — ranked `file:line` hits for natural-language queries.
  Default ranking is vector similarity + a filename boost; an experimental
  hybrid mode (`--hybrid` / `EMBER_HYBRID=1`) fuses a BM25 lexical ranking
  (measured tradeoff, see "Honest capability notes").
- `ask` — answers questions with citations. With an OpenAI-compatible chat
  endpoint configured, answers are synthesized by the model — and Ember
  validates every citation marker against the chunks it actually retrieved,
  strips bogus ones (and says it did), and passes model abstentions through
  untouched. Without a chat model, `ask` is honestly labeled retrieval-only:
  ranked, line-numbered sources. Ask only presents chunks above a
  calibrated relevance floor as evidence (default 0.2 on the local
  semantic path, `EMBER_ASK_MIN_SCORE` overrides; hybrid mode gates on
  each hit's underlying vector cosine, since RRF rank scores are not
  relevance; the lexical diagnostic path is retrieval-only by design -
  no calibrated floor exists for it, so synthesis is unsupported there).
  Below the floor, `ask` abstains and says the closest match is likely
  unrelated; the floor filters weak evidence, it cannot prove relevance.
  Only chunks that cleared the floor are sent to a configured chat model
  as grounding, and when nothing clears, the synthesis call is skipped
  entirely. If a synthesis call fails, the failure is disclosed and the
  extractive answer is served instead.
- `repo_map` — entry points, hub files (most referenced), key symbols,
  languages. The orientation pass an agent otherwise burns minutes on.
- `decisions` / `recent_changes` — the "why": decision-like commits and
  ADR-style docs, plus recent history.
- `index_status` — freshness and embedder info.
- `save_note` / `recall_notes` — cross-session agent memory: an agent leaves a
  short factual note (decision, gotcha, task state) and any later session —
  including a different agent — recalls it. Notes persist in
  `.ember/notes.jsonl`; recall is deterministic keyword matching.

## Quickstart

```bash
npm install
npm test          # builds, then runs the suite (hermetic from a fresh clone:
                  # no network, no model download; the MCP stdio tests spawn the
                  # real CLI/server with EMBER_LEXICAL=1)
# EMBER_LIVE_TESTS=1 npm test runs the same suite against the real local
# model instead - that variant downloads the model once and needs network.

# index any repo
node dist/cli.js index --path /path/to/repo

# search it
node dist/cli.js search "how are neighbors selected in the vector index" --path /path/to/repo

# ask with citations
node dist/cli.js ask "where does scanning decide which files to skip" --path /path/to/repo

# repo orientation
node dist/cli.js map --path /path/to/repo
node dist/cli.js decisions --path /path/to/repo

# leave a note for the next session, and recall notes later
node dist/cli.js note "chose jwt over sessions; see auth.ts" --tags auth --path /path/to/repo
node dist/cli.js notes -q auth --path /path/to/repo

# re-index after edits: only changed files are re-embedded
node dist/cli.js index --path /path/to/repo
```

## Local web UI

```bash
node dist/cli.js ui --path /path/to/repo --port 4173
# open http://127.0.0.1:4173
```

A single-page app over the real engine: search, ask, repo map, and notes.
Hit cards show the actual code with line numbers; clicking a `file:line`
citation expands the surrounding context. The Reindex button runs indexing
in the background with live progress (the run is async; a second click
during a run is refused with 409, not piled up), and the status bar flags
an interrupted run's resumable checkpoint. It binds `127.0.0.1` only, serves
source read-only and jailed to the indexed root (traversal, absolute paths
and symlink escapes are refused), and rejects cross-origin mutations. Deep
links: `http://127.0.0.1:4173/#q=...&go=search|ask`.

The Load repo field loads a **public GitHub repo**: paste
`github.com/owner/repo` and Ember shallow-clones it into
`~/.ember/remotes/`, switches the active root, and indexes it with the same
local embedder and live progress - then search/ask run against the loaded
repo (the status bar shows `github: owner/repo` vs `local: <dir>`). Loading
again fetches the latest default branch. The URL parser is the security
boundary and it is deliberately narrow: github.com only, no SSH/file URLs,
no credentials in URLs, no deep links - private repos simply fail the clone
(`GIT_TERMINAL_PROMPT=0`, never a prompt, never a credential) and the error
surfaces in the progress log.

## Use it from your coding agent (MCP)

Ember speaks MCP over stdio. Add it to your agent's MCP config:

```json
{
  "mcpServers": {
    "ember": {
      "command": "node",
      "args": ["/absolute/path/to/ember/dist/cli.js", "serve", "--path", "/path/to/your/repo"]
    }
  }
}
```

Then ask your agent to call `index_repo` once, and `repo_map` / `search_code`
/ `ask` whenever it would otherwise grope around the tree.

## Local tuning knobs (optional, no provider needed)

```bash
export EMBER_EMBED_BATCH=4        # embed batch size; default is auto from free memory
export EMBER_ASK_MIN_SCORE=0.25   # Ask evidence floor on the semantic path (default 0.2)
export EMBER_CHECKPOINT_MS=15000  # checkpoint cadence in ms (default 30000)
```

## LLM configuration (optional)

Everything above works offline. Retrieval is local by requirement: remote
embeddings are NEVER selected by provider config alone. To send code and
query text to an OpenAI-compatible provider for embeddings (OpenRouter,
Ollama, …), opt in explicitly:

```bash
export EMBER_API_BASE=https://openrouter.ai/api/v1
export EMBER_API_KEY=...
export EMBER_EMBED_MODEL=<an embedding model>   # semantic embeddings
export EMBER_EMBED_DIM=<its dimension>
export EMBER_REMOTE_EMBED=1                     # required explicit opt-in for remote embeddings
node dist/cli.js index --full --path /path/to/repo   # re-embed with the new embedder
```

Without `EMBER_REMOTE_EMBED=1`, an `EMBER_EMBED_MODEL` setting prints a
note and the local semantic default is used instead - no indexed text
leaves the machine. Synthesized answers are configured separately and do
not affect retrieval:

```bash
export EMBER_CHAT_MODEL=<a chat model>          # synthesized answers
```

(`EMBER_CHAT_BASE` is still honored as a legacy alias for `EMBER_API_BASE`.)

**Usage accounting and request guards.** Every provider call is appended to
`.ember/usage.jsonl` and summarized by `node dist/cli.js usage`:
provider-reported token counts are recorded exactly; when a provider returns
no usage object, a chars/4 approximation is recorded and explicitly labeled
`estimated`. The API key is never logged. `EMBER_MAX_CALLS` caps provider
requests per process and `EMBER_MAX_PROMPT_CHARS` caps input size per call —
both genuinely block the requests they name, but they are **request guards,
not spending limits**: Ember never sees billing; actual spend is only on your
provider's dashboard.

_Status: the endpoint paths are integration-tested against an in-process
mock OpenAI-compatible server (dimensions, retries, guards, usage records,
failure fallback). Live provider verification with real models is pending a
user-approved API budget; the offline configuration above is the verified
one. A configured endpoint receives the text it embeds or answers over (code
chunks and queries). Token counts in the usage log are not billing -
provider-reported or estimated, real spend is decided by posted prices,
routing, caching and discounts on the provider's side._

## Honest capability notes

- **Default embedder is local semantic.** Out of the box Ember embeds with
  all-MiniLM-L6-v2 running locally in WASM via transformers.js (no API key,
  no per-call cost; the model downloads once on first use, then works
  offline). `EMBER_LEXICAL=1` is the explicit opt-out to the deterministic
  hashing embedder (stemmed token overlap) - it matches shared vocabulary
  well but does not paraphrase. A semantic failure (missing package,
  failed download) is an error, never a silent lexical fallback.
- **Measured retrieval quality (offline).** A 15-question sanity check about
  this repo — not a benchmark. Metrics: top-1/top-5 file accuracy and MRR;
  the corpus is frozen for each comparison; the question file itself is
  excluded via `.emberignore`, but demo/docs legitimately contain
  near-identical phrasing, so each question also runs paraphrased. Default
  engine: verbatim top-1 5/15, top-5 12/15, MRR 0.483; **paraphrase top-1
  2/15, top-5 4/15, MRR 0.167**. On these 15 questions, rewording cuts
  accuracy sharply — concrete evidence of the lexical ceiling on this
  corpus (not a universal bound), and the motivation for semantic
  embeddings. Hybrid mode (BM25 fused at lexical weight 0.25, `--hybrid` /
  `EMBER_HYBRID=1`) recovers some paraphrase loss on this corpus (top-5
  6/15 vs 4/15) at a verbatim cost (top-1 4/15 vs 5/15, MRR 0.421 vs
  0.483) — a tradeoff, not a win, so it stays opt-in for the lexical engine.
- **Local semantic embeddings (default, free).** The default runs
  all-MiniLM-L6-v2 locally in WASM (no API, no cost; @xenova/transformers
  is a regular dependency since v0.6.0). Measured on the same frozen corpus:
  **paraphrase top-1 2/15 → 5/15, top-5 4/15 → 10/15, MRR 0.167 → 0.472**.
  With hybrid fusion on top (`EMBER_HYBRID=1`) it is the best measured
  configuration: verbatim top-1 6/15, MRR 0.499; paraphrase 5/15, 10/15,
  0.452. Caveats: same 15-question single-corpus sanity check; verbatim
  top-5 is 11/15 vs lexical's 12/15; first use downloads the model once
  (a status line says so), then it runs offline. Measured cost on the
  frozen corpus (814 chunks, 47 files, 2-core 2 GB test machine):
  indexing 46 s wall clock with 1,355 MB peak memory (~18 chunks/s on
  real code chunks - much slower than hashing), a cold CLI query 0.3-0.4 s
  with ~200 MB peak memory (cached model loads in ~205 ms; ~2 ms per
  query embedding after that). An earlier "1,200 chunks in 4.8 seconds"
  figure was measured under different, unrecorded conditions and is
  superseded by these numbers. Reproduce: `EMBER_EVAL_EMBEDDER=local node
  scripts/eval.mjs` (add `EMBER_HYBRID=1` for the fused row).
- The corpus is frozen at the commit pinned in `eval/CORPUS_REF`, so these
  numbers are reproducible and comparable across changes. Reproduce:
  `node scripts/eval.mjs` (`EMBER_HYBRID=1` for the hybrid row).
- **Default retrieval is an exact flat scan, not approximate.** The
  pure-TypeScript HNSW graph (M=16, efConstruction=200, paper alg. 4 neighbor
  selection, recall@10 >0.9 vs brute force in tests) is available as an
  opt-in (`EMBER_HNSW=1` at index time) for very large repos. Measured on
  the frozen eval corpus, flat and graph return identical results; the
  graph's superlinear build cost is why it is not the default.
- **Incremental indexing is hash-based.** `.ember/files.json` stores a sha1
  per file. Unchanged files keep their chunks and vectors; modified files are
  re-chunked and re-embedded; deleted files are removed. Switching embedders
  (kind, model or dimension) triggers an automatic full rebuild.
- **Note recall is keyword matching.** `recall_notes` scores by unique
  query-term overlap — predictable and offline, not semantic.
- **Local-first.** Your code and queries stay on your machine. The only
  network calls are the ones you configure: an external embedding endpoint,
  an LLM for `ask`, or the one-time public model download from Hugging Face
  when you first enable local semantic embeddings. Ember itself sends no
  telemetry anywhere.

- **Embedding memory scales with the machine.** The local embedder's
  batch size is chosen from free memory at startup (4 below 3 GB free,
  8 below 6 GB, else 16) and announced once; `EMBER_EMBED_BATCH`
  overrides. On a 2-core 2 GB test machine the old fixed default was
  killed by the OS out-of-memory killer during stress indexing; the
  automatic ladder completes a 14,905-chunk rebuild at ~477 MB RSS
  (run-scoped measurement, batch 4).
- **A missing index is not "corruption".** First-run `ember search` says
  "no index at <repo>/.ember - run: ember index"; the corruption wording
  (with `--full` rebuild guidance) is reserved for a genuinely torn store.
- **Search results inspect their source.** `ember search --lines N` widens
  chunk output (a truncation marker counts hidden lines and names the
  citation to open), and `--context N` prints N lines of the live file
  around each hit with real line numbers - labeled as live source, which
  may differ from the indexed chunk. Repo-jailed through symlink resolution - lexical escapes and symlinks pointing outside the repo are both refused.
- **Long indexing narrates itself.** Progress lines print every 100 files
  (`EMBER_PROGRESS_FILES` overrides) between checkpoints. A first-run model
  download ends with an explicit "model ready" line; if it fails, the error
  keeps the underlying cause, says to check the network and retry (it works
  offline after one download), and offers `EMBER_LEXICAL=1` as an explicit
  diagnostic opt-out - never a silent fallback.
- **Interrupted indexing resumes.** Embedding work is checkpointed to
  `.ember.checkpoint/` (a sibling of the live `.ember/`, which stays
  searchable throughout) every 30 seconds and every 200 files or 2,000
  chunks (`EMBER_CHECKPOINT_MS` / `EMBER_CHECKPOINT_FILES` /
  `EMBER_CHECKPOINT_CHUNKS` override). A rerun
  validates the embedder identity and per-file hashes, keeps checkpointed
  work, and embeds only the rest; a model change or a torn checkpoint is
  discarded. A completed run or `ember index --full` clears it.

## How it fits together

```
src/core/scanner.ts    git-aware file walk + .emberignore (skips deps, build output, binaries)
src/core/chunker.ts    symbol-aware code chunking (falls back to windows)
src/core/embedder.ts   pluggable embedders (local WASM semantic default /
                       HTTP endpoint / explicit lexical opt-out)
src/core/llm.ts        OpenAI-compatible client: retries, request guards, usage records
src/core/hybrid.ts     BM25 lexical scorer + reciprocal rank fusion (opt-in)
src/core/hnsw.ts       pure-TS HNSW index (cosine, diversity selection)
src/core/store.ts      .ember/ persistence (chunks + vectors + graph + file hashes)
src/core/notes.ts      cross-session agent notes (notes.jsonl)
src/core/engine.ts     load + search (default and hybrid paths)
src/core/repomap.ts    structure / entry points / hub files
src/core/decisions.ts  decision log + recent changes from git
src/core/ask.ts        cited answers (validated synthesis or labeled retrieval-only)
src/mcp/server.ts      MCP server (stdio)
src/ui/server.ts       local web app backend (read-only, repo-jailed, CSRF-guarded)
src/ui/page.ts         single-page UI (no external assets)
src/cli.ts             CLI
```

See `docs/ARCHITECTURE.md` for the design in depth and `docs/ROADMAP.md` for
where it is going.

## Live demo (browser)

`demo-web/` is a static, read-only demo that runs Ember's real search engine
in the browser: it fetches the published `.ember` index artifacts of this
repo and scores with the exact same code path as `EmberEngine.search`,
using the graph when the artifacts include one and an exact scan otherwise
(parity is enforced by `test/demo-web.test.ts`). Retrieval in the demo is the
offline lexical mode (a browser bundle cannot run the WASM model) —
no data leaves the browser.

```bash
npm run build:demo   # emits demo-web/dist (index.html + ESM + data/)
```

Deployed via GitHub Pages from the `gh-pages` branch.

## Tests

```bash
npm test          # 114 tests, hermetic from a fresh clone: HNSW recall,
                  # chunking, scanner determinism, end-to-end index+search,
                  # notes persistence, incremental re-index, corrupt/torn
                  # data recovery, LLM provider behavior against a local
                  # mock OpenAI server (usage accounting, guards, retries,
                  # citation validation, fallback), hybrid scorer/fusion,
                  # real MCP stdio sessions, browser-demo parity, and the
                  # web UI API + security (traversal, symlink, CSRF),
                  # Ask evidence gating per retrieval mode, and
                  # CLI/MCP/package version agreement.
npm run e2e:ui    # optional: drives the UI in a real local Chrome
```

## License

MIT © 2026 Daksh Patel

---

_Built by Daksh Patel with AI assistance (Instinct agent): code, tests and docs were developed iteratively with an AI pair-programmer; all claims in this README reflect behavior verified by the test suite. Ember began as a hackathon prototype and is now an independent project._
