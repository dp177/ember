# Ember architecture

One paragraph: Ember indexes a repo into symbol-aware chunks, embeds each
chunk, stores everything under `<repo>/.ember/`, and answers queries through
an HNSW approximate nearest-neighbour search plus (optionally) an
OpenAI-compatible chat model that is only ever shown retrieved chunks. The
same engine serves three frontends: the CLI, an MCP stdio server for coding
agents, and a local web UI.

## Pipeline

```
scan -> chunk -> embed -> HNSW -> persist (.ember/)
                                 |
        +------------------------+------------------------+
        |                        |                        |
      CLI                 MCP server (stdio)        ember ui (127.0.0.1)
```

1. **Scan** (`scanner.ts`): deterministic walk (byte-sorted by path so chunk
   ids are reproducible), skipping dependencies, build output, binaries,
   oversized files, lockfiles, and anything in `.emberignore`. Language from
   extension; 256 KB per-file cap; 4000-file total cap.
2. **Chunk** (`chunker.ts`): symbol-aware - functions/classes/methods become
   chunks with their line ranges and symbol names; files without recognizable
   symbols fall back to overlapping windows. Chunks carry
   `file / startLine / endLine / symbol / text`, which is what makes
   `file:line` citations exact.
3. **Embed** (`embedder.ts`): pluggable.
   - Default `HashingEmbedder`: deterministic, offline, lexical. Tokenizes
     code (camelCase/snake_case split, light stemming) and hashes tokens into
     a 1024-dim vector (FNV-1a, signed slots, log TF). Matches shared
     vocabulary; does not paraphrase.
   - Optional `HttpEmbedder`: any OpenAI-compatible `/embeddings` endpoint.
     The returned dimension is validated against `EMBER_EMBED_DIM` - a
     mismatch fails loudly instead of corrupting the store.
4. **Index** (`hnsw.ts`): pure-TypeScript HNSW (M=16, efConstruction=200,
   cosine, diversity-preserving neighbor selection = paper algorithm 4).
   Tests measure recall@10 against brute force (>0.9 on clustered data).
5. **Persist** (`store.ts`): `meta.json`, `chunks.jsonl`, `vectors.f32`
   (row-major, aligned with chunk ids), `hnsw.json`, `files.json` (per-file
   sha1 for incremental re-index), `notes.jsonl`, `usage.jsonl`. Saves are
   staged in a sibling directory and swapped in with two renames, so a
   crash mid-save cannot leave a half-written file set; a crash between
   the renames is recovered automatically on the next open from the
   backup directory, and notes and the usage log are carried across.
   Writers and recovery are serialized by a lock file (`.ember.lock`);
   a second writer fails fast, and readers never move or delete backups
   while a writer holds the lock. Each saved set carries a generation id
   (`meta.generation` plus a `generation` marker file), so a torn read
   mixing two sets is detected even when chunk and vector counts happen
   to match, and is retried once before failing. A lock left by a crashed
   process is reclaimed when its pid is dead or older than 10 minutes.
   Reads are hardened against torn/corrupt tails; the notes tail is
   repaired before append.

## Retrieval

Default path (`engine.ts`): embed the query, pull `3k` HNSW candidates,
rescore by exact dot product, add a capped filename-token boost, cut to k.

Experimental hybrid path (`--hybrid` / `EMBER_HYBRID=1`): fuse the vector
ranking with a BM25 ranking (chunk text + filename tokens) using reciprocal
rank fusion, lexical leg weighted 0.25. Measured on the 15-question sanity
eval over the frozen corpus pinned in `eval/CORPUS_REF` (a sanity check,
not a benchmark: 15 questions, one corpus, ±1 is noise). Default: verbatim
top-1 5/15, top-5 12/15, MRR 0.483; paraphrased top-1 2/15, top-5 4/15,
MRR 0.167. Hybrid: verbatim 4/11/0.421, paraphrase 2/6/0.228 - it recovers
some paraphrase loss at a verbatim cost; a tradeoff, not a win, so it is
opt-in. Freezing the corpus at a commit (materialized via `git archive`)
keeps every before/after comparison on exactly the same tree.

Optional local semantic embeddings (`local-embedder.ts`, `EMBER_LOCAL_EMBED=1`):
all-MiniLM-L6-v2 via transformers.js in pure WASM - no API key, no cost; a
deliberately unbundled optional install. The one-time model download
fetches public model files from Hugging Face; after that, no code or
query leaves the machine for retrieval. Ember itself sends no telemetry. Measured on
the frozen corpus: paraphrase top-1 2/15 -> 5/15, top-5 4/15 -> 10/15, MRR
0.167 -> 0.472; with hybrid fusion, verbatim top-1 6/15, MRR 0.499 (the best
measured configuration). Embedder kind carries the model id, so switching
models forces an honest full rebuild (same rule as the HTTP embedder). The paraphrase collapse quantifies the lexical
embedder's core limitation and motivates semantic embeddings (M2). Equal weighting was measured and rejected (top-5 13 -> 10
on the earlier corpus: exact-match ranking over-rewards files that echo
query phrasing).

## Answer synthesis (`ask.ts`)

Retrieval always comes first: the model only ever sees the top-k retrieved
chunks, numbered. The system prompt forbids inventing code and requires
`[n]` citations. After the model answers, Ember:

- validates every `[n]` marker against the retrieved set - out-of-range
  markers are stripped and the stripping is disclosed;
- passes abstention ("the chunks don't contain the answer") through
  untouched;
- appends the Sources list itself (citations are never model-authored);
- on any provider failure, discloses it and serves the extractive answer.

Without a chat model, `ask` is labeled retrieval-only, excerpts are
line-numbered, and zero-score chunks are dropped rather than presented as
relevant.

## Provider client (`llm.ts`)

One `LlmClient` for chat + embeddings: 60s timeout, a single retry with 1s
backoff on transient statuses (408/409/425/429/5xx), honest errors otherwise.
Every call appends a usage record to `.ember/usage.jsonl`:
provider-reported token counts exactly; chars/4 estimates explicitly labeled
`estimated`. The API key is sent to the configured endpoint as a bearer
header and never logged.

`EMBER_MAX_CALLS` and `EMBER_MAX_PROMPT_CHARS` are process-level request
guards: they block the named request, and their error messages say so.
`EMBER_MAX_OUTPUT_TOKENS` caps synthesized answer length (default 1024).
Requests are serialized per client instance (concurrency 1, enforced by an
in-process queue). Every entry point (CLI, MCP server, web UI) resolves
chat and embeddings through one memoized process-wide client
(`sharedClientFromEnv`), so the cap, queue and usage accounting genuinely
hold per process rather than per request. None of this tracks
or limits spending: Ember has no access to provider billing, and logged
token counts (provider-reported or estimated) are never converted to
dollars.

## Trust and security model

- **Local-first.** With no endpoint configured there is zero network I/O.
- **What a configured endpoint sees:** the text it embeds (code chunks and
  queries) and the chunks sent for answer synthesis. Nothing else leaves the
  machine. The key lives only in the environment / process memory.
- **ember ui** binds `127.0.0.1` only. Source files are served read-only and
  jailed to the indexed root by realpath resolution - `../`, absolute paths
  and symlinks pointing outside are refused (tested). Non-GET requests with
  a cross-site `Origin` are refused (CSRF guard). Responses are `nosniff`.
- **MCP** runs over stdio; the parent process controls it. Tool args are
  validated with zod.
- **The browser demo** is static and read-only: it fetches this repo's
  published index artifacts and runs the same search code client-side.

## Testing strategy

65 tests, hermetic from a fresh clone (`npm test` builds first). Provider
behavior is tested against an in-process mock OpenAI-compatible server, so
the LLM layer is fully verified with zero real calls. MCP is tested through
real stdio sessions. The web UI has API-level workflow + security tests and
an opt-in real-Chrome e2e (`npm run e2e:ui`). The browser demo's parity with
the engine is asserted by serving the demo over HTTP and comparing hits and
scores exactly.
