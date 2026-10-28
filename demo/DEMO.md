# Ember demo script (~2 minutes)

1. **Cold start pain (15s)** — "Every coding agent session starts cold: the
   agent re-derives architecture and past decisions tool call by tool call."
2. **Index (20s)** — `node dist/cli.js index --path .` on a real repo
   (Ember indexes its own source in the demo). Show: files → chunks → HNSW.
3. **Warm orientation (20s)** — `node dist/cli.js map --path .` — entry
   points, hub files, key symbols, instantly.
4. **Search (30s)** — two queries:
   - `node dist/cli.js search "how does the vector index pick neighbors" --path .`
   - `node dist/cli.js search "which files get skipped when scanning" --path .`
   Point at the `file:line` citations.
5. **Ask (20s)** — `node dist/cli.js ask "how is the index persisted between runs" --path .`
   (with an open model configured it synthesizes; otherwise extractive + citations).
6. **MCP (20s)** — show the MCP config block, then in the agent: "call
   ember's repo_map before you touch anything" — the agent starts warm.
7. **Close (10s)** — local-first, `.ember/` folder, open models only, MIT.
