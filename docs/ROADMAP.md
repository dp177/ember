# Ember roadmap: from hackathon prototype to primary project

Ember started as a 24-hour hackathon build. This roadmap turns it into a
full-fledged, LLM-backed, end-to-end project. Ordering is by leverage:
retrieval quality first, then the interface, then proof.

## M0 - Honest foundations (done)

- [x] `npm test` is hermetic on a fresh clone (was 3 failing MCP tests).

## M1 - Real LLM layer, zero-spend tested (done)

- [x] `LlmClient`: OpenAI-compatible chat + embeddings with timeouts, one
      retry on transient errors, and process-level request guards
      (`EMBER_MAX_CALLS`, `EMBER_MAX_PROMPT_CHARS`). These guards block
      requests; they are NOT billing limits - real spend is only ever on
      the provider's dashboard.
- [x] Usage accounting in `.ember/usage.jsonl` + `ember usage` command.
      Provider-reported tokens recorded exactly; chars/4 approximations
      labeled estimated. The API key is never logged.
- [x] `ask`: citation markers validated against retrieved chunks (bogus
      ones stripped, stripping disclosed), model abstention preserved,
      extractive fallback with the failure disclosed on API errors.
- [x] Hybrid retrieval built but OPT-IN (`--hybrid` / `EMBER_HYBRID=1`):
      HNSW vector ranking fused with BM25 (chunk text + filename tokens)
      via weighted RRF (lexical 0.25). Measured on the 15-question
      same-repo sanity eval, old engine vs hybrid on the same corpus:
      top-1 5 -> 6, top-5 13 -> 12, MRR .502 -> .510. Top-5 regressing
      means it is a tradeoff, not a win, so the pre-hybrid ranking stays
      the default until semantic embeddings make the two legs genuinely
      diverge (M2). Equal weighting was measured and rejected outright
      (top-5 13 -> 10). Caveats: 15 questions, one corpus, +/-1 is noise.
- [x] All LLM behavior tested against an in-process mock OpenAI server.
      44/44 tests, zero real provider calls.

## M2 - Semantic embeddings + live provider verification

- [x] Local semantic embeddings, opt-in and free (`EMBER_LOCAL_EMBED=1`,
      all-MiniLM-L6-v2 in pure WASM via transformers.js, unbundled install):
      measured on the frozen eval corpus, paraphrase MRR 0.167 -> 0.472
      (top-1 2/15 -> 5/15, top-5 4/15 -> 10/15); semantic + hybrid is the
      best measured configuration (verbatim 6/11/0.499, paraphrase
      5/10/0.452). Reproducible: EMBER_EVAL_EMBEDDER=local node scripts/eval.mjs.

- [ ] Live provider verification (still blocked: needs an approved API
      budget - the local path now covers semantic retrieval without one; a
      budget is only needed for synthesized chat answers and for verifying
      the HTTP provider path against real endpoints).
- [ ] Verify embeddings + chat against OpenRouter with real models;
      measure and report per-call token usage (provider-reported).
- [ ] Re-run the retrieval sanity check with real embeddings; publish the
      before/after (same frozen corpus, verbatim + paraphrase rows).
- [ ] Re-check current model IDs and pricing at verification time - do not
      trust remembered ones.

Spend discipline for the paid run (authority-critical):
- EMBER_MAX_CALLS caps REQUEST COUNT, never dollars; an approved dollar
  amount cannot be mapped to a request count without conservative,
  currently-verified token and pricing figures covering retries, embedding
  batches and provider routing differences.
- Before the first paid call: confirm the account/key's available credit
  and current pricing from the provider itself, prefer a provider-enforced
  spend cap on the key where available, and compute a maximum aggregate
  token envelope for the scoped run. Stop and escalate if the run cannot
  be bounded within the approved amount.
- Proposed (unverified until then): qwen/qwen3-embedding-8b (dim 4096,
  $0.01/M tokens listed 2026-10-28) and qwen/qwen3-30b-a3b-instruct-2507
  ($0.09/M in, $0.30/M out listed 2026-10-28). Estimates, not bounds.

## M3 - `ember ui`: local web UI (the end-to-end interface) (done)

- [x] Local-only (127.0.0.1) HTTP server + single-page UI: search, ask,
      repo map, notes - all over the real engine.
- [x] Hit cards show the actual code with line numbers; clicking a
      citation expands surrounding context. Retrieval-only mode is
      labeled as such (no chat model => no model-generated claims).
- [x] Security: source serving jailed to the repo root (traversal,
      absolute paths and symlink escapes refused); cross-origin
      mutations refused (CSRF guard); nosniff.
- [x] `.emberignore` keeps fixtures out of the corpus; the eval question
      file can no longer masquerade as answer knowledge.
- [x] Tests: API workflow (search/ask/expand/map/notes incl. read-back
      across restart) + security tests in ui.test.ts; real-Chrome e2e
      (scripts/e2e-ui.mjs, needs a local Chrome) clicks through search,
      expand, ask, map and notes.
- [x] Re-based eval baseline on the decontaminated corpus (44 files,
      720 chunks): default top-1 5/15, top-5 12/15, MRR 0.489; hybrid
      top-1 6/15, top-5 11/15, MRR 0.493 (same tradeoff). Earlier numbers
      were measured on a corpus containing the benchmark fixture.
- [x] Hardening (2026-10-31): embedder identity now carries the model, so a
      same-dimension EMBER_EMBED_MODEL switch forces an honest full rebuild
      instead of silently mixing two embedding spaces. .ember saves are
      staged and swapped atomically (no half-written stores on crash) and
      preserve notes/usage files. One memoized process-wide provider client
      across CLI, MCP and the web UI makes EMBER_MAX_CALLS per-process for
      real (previously each UI/MCP request restarted the counter). Eval
      re-measured on the frozen corpus pinned in eval/CORPUS_REF: default
      verbatim 5/12/0.483, paraphrase 2/4/0.167; hybrid verbatim 4/11/0.421,
      paraphrase 2/6/0.228. The eval now materializes the pinned commit via
      `git archive`, so the benchmark no longer moves with the working tree;
      re-base intentionally by updating the ref and re-measuring both modes.

## M4 - Portfolio-grade presentation (mostly done)

- [x] README rewrite: problem, honest capability and limits section with
      measured numbers, setup, UI and LLM configuration. Hackathon framing
      reduced to a footnote.
- [x] Architecture doc (`docs/ARCHITECTURE.md`): pipeline, retrieval,
      synthesis validation, provider client, trust and security model,
      testing strategy.
- [ ] Refresh the public browser demo deployment (gh-pages) with the
      current engine.

## Non-goals (for now)

- No paid hosting, no hosted multi-user service, no account creation on
  external services without explicit approval.
- Offline mode stays a first-class citizen: everything except synthesized
  answers works with zero network and zero cost.
