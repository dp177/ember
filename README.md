# Ember — a warm start for coding agents

**Persistent, queryable memory for your codebase — CLI, MCP server, and a
local web UI.**
Point Ember at a repo once; every coding agent you use (Claude Code, Cursor,
Windsurf, …) starts warm instead of cold — with hybrid-capable search, a repo
map, a mined decision log, and answers that cite `file:line`. MIT licensed,
local-first, zero native dependencies.

## The problem

Coding agents start every session cold. Architecture, conventions, and the
reasons behind past decisions get reconstructed tool call by tool call —
slowly, expensively, and often wrong. Humans carry that context implicitly.

## What Ember does

- `index_repo` — scans a repo, splits code into symbol-aware chunks, embeds
  them, and builds a **pure-TypeScript HNSW** approximate nearest-neighbour
  index. Everything persists in `<repo>/.ember/` — no database, no daemon.
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
  ranked, line-numbered sources, and zero-score chunks are never presented
  as relevant. If a synthesis call fails, the failure is disclosed and the
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
npm test          # builds, then runs the suite (hermetic from a fresh clone)

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
citation expands the surrounding context. It binds `127.0.0.1` only, serves
source read-only and jailed to the indexed root (traversal, absolute paths
and symlink escapes are refused), and rejects cross-origin mutations. Deep
links: `http://127.0.0.1:4173/#q=...&go=search|ask`.

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

## LLM configuration (optional)

Everything above works offline. For semantic embeddings and synthesized
answers, point Ember at any OpenAI-compatible API (OpenRouter, Ollama, …):

```bash
export EMBER_API_BASE=https://openrouter.ai/api/v1
export EMBER_API_KEY=...
export EMBER_EMBED_MODEL=<an embedding model>   # semantic embeddings
export EMBER_EMBED_DIM=<its dimension>
export EMBER_CHAT_MODEL=<a chat model>          # synthesized answers
node dist/cli.js index --full --path /path/to/repo   # re-embed with the new embedder
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

- **Default embedder is lexical, not semantic.** Out of the box Ember uses a
  deterministic hashing embedder (stemmed token overlap). It matches shared
  vocabulary well — code identifiers are meaningful — but it does not
  paraphrase.
- **Measured retrieval quality (offline).** A 15-question sanity check about
  this repo — not a benchmark. Metrics: top-1/top-5 file accuracy and MRR;
  the corpus is frozen for each comparison; the question file itself is
  excluded via `.emberignore`, but demo/docs legitimately contain
  near-identical phrasing, so each question also runs paraphrased. Default
  engine: verbatim top-1 5/15, top-5 12/15, MRR 0.489; **paraphrase top-1
  3/15, top-5 5/15, MRR 0.230**. On these 15 questions, rewording cuts
  accuracy sharply — concrete evidence of the lexical ceiling on this
  corpus (not a universal bound), and the motivation for semantic
  embeddings. Hybrid mode (BM25 fused at lexical weight 0.25, `--hybrid` /
  `EMBER_HYBRID=1`) trades top-5 for top-1 on verbatim queries
  (6/11/0.493) — a tradeoff, not a win, so it stays opt-in. Reproduce:
  `node scripts/eval.mjs`.
- **HNSW is exact HNSW, not a placeholder.** M=16, efConstruction=200,
  diversity-preserving neighbor selection (paper alg. 4), serialized graph in
  `.ember/`. Tests measure recall@10 vs brute force (>0.9 on clustered data).
- **Incremental indexing is hash-based.** `.ember/files.json` stores a sha1
  per file. Unchanged files keep their chunks and vectors; modified files are
  re-chunked and re-embedded; deleted files are removed. Switching embedders
  (kind or dimension) triggers an automatic full rebuild.
- **Note recall is keyword matching.** `recall_notes` scores by unique
  query-term overlap — predictable and offline, not semantic.
- **Local-first.** The index never leaves your machine; network calls happen
  only when you configure an external endpoint.

## How it fits together

```
src/core/scanner.ts    git-aware file walk + .emberignore (skips deps, build output, binaries)
src/core/chunker.ts    symbol-aware code chunking (falls back to windows)
src/core/embedder.ts   pluggable embedders (offline lexical / HTTP endpoint)
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
repo, rebuilds the HNSW graph client-side, and scores with the exact same
code path as `EmberEngine.search` (parity is enforced by
`test/demo-web.test.ts`). Retrieval is the default offline lexical mode —
no data leaves the browser.

```bash
npm run build:demo   # emits demo-web/dist (index.html + ESM + data/)
```

Deployed via GitHub Pages from the `gh-pages` branch.

## Tests

```bash
npm test          # 47 tests, hermetic from a fresh clone: HNSW recall,
                  # chunking, scanner determinism, end-to-end index+search,
                  # notes persistence, incremental re-index, corrupt/torn
                  # data recovery, LLM provider behavior against a local
                  # mock OpenAI server (usage accounting, guards, retries,
                  # citation validation, fallback), hybrid scorer/fusion,
                  # real MCP stdio sessions, browser-demo parity, and the
                  # web UI API + security (traversal, symlink, CSRF).
npm run e2e:ui    # optional: drives the UI in a real local Chrome
```

## License

MIT © 2026 Daksh Patel

---

_Built by Daksh Patel with AI assistance (Instinct agent): code, tests and docs were developed iteratively with an AI pair-programmer; all claims in this README reflect behavior verified by the test suite. Ember began as a hackathon prototype and is now an independent project._
