#!/usr/bin/env node
/** ember - a warm start for coding agents. CLI entry. */

import { Command } from "commander";
import * as path from "node:path";
import { embedderChoiceFromEnv, embedderFromEnv } from "./core/embedder.js";
import { EmberEngine } from "./core/engine.js";
import { indexRepo, readCheckpointInfo } from "./core/indexer.js";
import { readSourceContext } from "./core/context.js";
import { checkFreshness, mtimeDrift } from "./core/freshness.js";
import { EmberStore } from "./core/store.js";
import { NoteStore } from "./core/notes.js";
import { buildRepoMap, formatRepoMap } from "./core/repomap.js";
import { getCommits, getDecisions } from "./core/decisions.js";
import { answerQuestion } from "./core/ask.js";
import { JsonlUsageLogger, llmConfigFromEnv, sharedClientFromEnv } from "./core/llm.js";
import { promises as fs } from "node:fs";
import { startMcpServer } from "./mcp/server.js";
import { createUiServer } from "./ui/server.js";

const program = new Command();
program
  .name("ember")
  .description("Ember - a warm start for coding agents: persistent, queryable memory for your codebase.")
  .version("0.3.0");

const rootOf = (p?: string) => path.resolve(p ?? process.cwd());
const hybridOf = (opts: { hybrid?: boolean }) => ({ hybrid: opts.hybrid || process.env.EMBER_HYBRID === "1" });

/** Resolve the embedder for a CLI command and disclose any non-default
 * choice on stderr - remote or lexical selection must never be silent. */
function cliEmbedder(usage?: Parameters<typeof embedderChoiceFromEnv>[1]) {
  const { embedder, reason, warning } = embedderChoiceFromEnv(process.env, usage);
  if (warning) console.error(`note: ${warning}`);
  if (!embedder.kind.startsWith("local-wasm:")) console.error(`embedder: ${embedder.kind} - ${reason}`);
  return embedder;
}

program.command("index")
  .description("Index a repository into persistent local memory (.ember/). Incremental by default.")
  .option("--path <dir>", "repo root", ".")
  .option("--full", "ignore existing state and rebuild from scratch", false)
  .action(async (opts) => {
    const root = rootOf(opts.path);
    const r = await indexRepo(root, cliEmbedder(JsonlUsageLogger.forRepo(root)), m => console.error(m), { full: opts.full });
    console.log(`indexed ${r.chunks} chunks from ${r.files} files (dim ${r.dim})`);
    // Machine-readable result for the UI server's child-process runner (unset on human runs).
    if (process.env.EMBER_INDEX_RESULT_JSON === "1") console.log("EMBER_RESULT_JSON:" + JSON.stringify({ chunks: r.chunks, files: r.files }));
    if (r.incremental) console.log(`incremental: kept ${r.kept} chunks from unchanged files${r.reused ? `, reused ${r.reused} unchanged chunks inside changed files` : ""}, embedded ${r.embedded} new/changed`);
  });

program.command("search <query>")
  .description("Search the indexed repo; returns file:line citations")
  .option("-k <n>", "number of hits", "8")
  .option("--path <dir>", "repo root", ".")
  .option("--hybrid", "experimental: fuse vector ranking with BM25 (EMBER_HYBRID=1)", false)
  .option("--lines <n>", "lines of each chunk to print", "8")
  .option("--context <n>", "also print n lines of live file source around each hit", "0")
  .action(async (query, opts) => {
    const root = rootOf(opts.path);
    const engine = await EmberEngine.load(root, cliEmbedder(), hybridOf(opts));
    const hits = await engine.search(query, parseInt(opts.k, 10));
    const maxLines = parseInt(opts.lines, 10);
    const context = parseInt(opts.context, 10);
    for (const [i, h] of hits.entries()) {
      console.log(`\n[${i + 1}] ${h.chunk.file}:${h.chunk.startLine}-${h.chunk.endLine}${h.chunk.symbol ? ` (${h.chunk.symbol})` : ""}  score=${h.score.toFixed(3)}`);
      const chunkLines = h.chunk.text.split("\n");
      console.log(chunkLines.slice(0, maxLines).join("\n"));
      if (chunkLines.length > maxLines) {
        console.log(`\u2026 (${chunkLines.length - maxLines} more lines in this chunk - widen with --lines, or open ${h.chunk.file}:${h.chunk.startLine})`);
      }
      if (context > 0) {
        const c = await readSourceContext(root, h.chunk.file, h.chunk.startLine - context, h.chunk.endLine + context).catch(e => ({ error: e instanceof Error ? e.message : String(e) }));
        console.log(`-- live file context (${h.chunk.file}, may differ from the indexed chunk) --`);
        if ("error" in c) console.log(`   unavailable: ${c.error}`);
        else c.lines.forEach((l, j) => console.log(`${String(c.startLine + j).padStart(5)}  ${l}`));
      }
    }
    const drift = await mtimeDrift(new EmberStore(root), root).catch(() => null);
    if (drift && drift > 0) {
      console.log(`\nnote: ${drift} file(s) modified since the last index (mtime) - results may be stale; run: ember index`);
    }
  });

program.command("ask <question>")
  .description("Answer a question about the repo with citations")
  .option("--path <dir>", "repo root", ".")
  .option("--hybrid", "experimental: fuse vector ranking with BM25 (EMBER_HYBRID=1)", false)
  .action(async (question, opts) => {
    const root = rootOf(opts.path);
    const engine = await EmberEngine.load(root, cliEmbedder(), hybridOf(opts));
    // Shared with the query embedder above: one cap counter per process.
    const client = sharedClientFromEnv(process.env, JsonlUsageLogger.forRepo(root));
    console.log((await answerQuestion(engine, question, 10, { client })).text);
  });

program.command("map")
  .description("Print the repo map (entry points, hub files, key symbols)")
  .option("--path <dir>", "repo root", ".")
  .action(async (opts) => {
    const root = rootOf(opts.path);
    const { chunks } = await new EmberStore(root).load();
    console.log(formatRepoMap(await buildRepoMap(root, chunks)));
  });

program.command("decisions")
  .description("Mine the decision log from git history and ADR docs")
  .option("--path <dir>", "repo root", ".")
  .action(async (opts) => {
    const d = await getDecisions(rootOf(opts.path));
    if (d.note) console.log(`note: ${d.note}`);
    console.log("## Decision-like commits");
    for (const c of d.decisions) console.log(`- ${c.date} ${c.hash} ${c.subject}`);
    console.log("\n## ADR / decision documents");
    for (const f of d.adrFiles) console.log(`- ${f}`);
  });

program.command("recent")
  .description("Show recent commits")
  .option("-n <n>", "count", "15")
  .option("--path <dir>", "repo root", ".")
  .action(async (opts) => {
    const commits = await getCommits(rootOf(opts.path), parseInt(opts.n, 10));
    for (const c of commits) console.log(`- ${c.date} ${c.hash} ${c.subject}`);
  });

program.command("note <text>")
  .description("Leave a note for future agent sessions (persists in .ember/notes.jsonl)")
  .option("--tags <csv>", "comma-separated tags")
  .option("--path <dir>", "repo root", ".")
  .action(async (text, opts) => {
    const tags = opts.tags ? String(opts.tags).split(",").map((t: string) => t.trim()).filter(Boolean) : [];
    const n = await new NoteStore(rootOf(opts.path)).add(text, tags);
    console.log(`note #${n.id} saved - persists in .ember/notes.jsonl; recall with: ember notes, or recall_notes via MCP`);
  });

program.command("notes")
  .description("Recall notes left by previous agent sessions")
  .option("-q, --query <text>", "filter by keywords")
  .option("--limit <n>", "max notes", "10")
  .option("--path <dir>", "repo root", ".")
  .action(async (opts) => {
    const store = new NoteStore(rootOf(opts.path));
    const limit = parseInt(opts.limit, 10);
    const corrupt = await store.corruptLineCount();
    if (corrupt > 0) console.error(`warning: skipped ${corrupt} corrupt line(s) in notes.jsonl (interrupted write?); readable notes are unaffected`);
    if (opts.query) {
      const hits = await store.search(opts.query, limit);
      if (hits.length === 0) { console.log("no matching notes"); return; }
      for (const h of hits) console.log(`- [#${h.id} ${h.ts}] ${h.text}`);
    } else {
      const notes = await store.list(limit);
      if (notes.length === 0) { console.log(`no notes yet - leave one with: ember note "..."`); return; }
      for (const n of notes) console.log(`- [#${n.id} ${n.ts}] ${n.text}${n.tags.length ? `  (tags: ${n.tags.join(", ")})` : ""}`);
    }
  });

program.command("status")
  .description("Show index status")
  .option("--path <dir>", "repo root", ".")
  .action(async (opts) => {
    const root = rootOf(opts.path);
    const store = new EmberStore(root);
    const meta = await store.readMeta();
    if (!meta) { console.log(`no index at ${path.join(root, ".ember")} - run: ember index`); return; }
    console.log(`indexed: ${meta.chunkCount} chunks / ${meta.fileCount} files`);
    console.log(`embedder: ${meta.embedderKind} (dim ${meta.dim})`);
    console.log(`updated:  ${meta.updatedAt}`);
    const cp = await readCheckpointInfo(root);
    if (cp) console.log(`resumable: an interrupted index run left a checkpoint (${cp.chunkCount} chunks from ${cp.files} files, ${cp.embedderKind}) - the next 'ember index' resumes it after validating model and sources`);
    if (meta.capped) console.log(`partial:  scan hit the file cap - the index covers only part of this repo`);
    const fresh = await checkFreshness(store, root);
    if (fresh) {
      if (fresh.changed + fresh.added + fresh.deleted === 0) {
        console.log(`fresh:    index matches the working tree (${fresh.checked} files checked)`);
      } else {
        console.log(`stale:    ${fresh.changed} changed, ${fresh.added} new, ${fresh.deleted} deleted since the last index - run: ember index`);
      }
    }
  });

program.command("usage")
  .description("Summarize provider API usage recorded in .ember/usage.jsonl (tokens; estimates labeled)")
  .option("--path <dir>", "repo root", ".")
  .action(async (opts) => {
    const file = `${rootOf(opts.path)}/.ember/usage.jsonl`;
    let lines: string[];
    try { lines = (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean); }
    catch { console.log("no provider calls recorded yet"); return; }
    let calls = 0, failed = 0, inTok = 0, outTok = 0, estTok = 0;
    const byModel = new Map<string, number>();
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        calls++;
        if (!r.ok) failed++;
        if (r.inputTokens) inTok += r.inputTokens;
        if (r.outputTokens) outTok += r.outputTokens;
        if (r.estimatedInputTokens) estTok += r.estimatedInputTokens;
        byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
      } catch { /* skip torn tail */ }
    }
    console.log(`provider calls: ${calls} (${failed} failed)`);
    for (const [m, n] of byModel) console.log(`  ${m}: ${n} call(s)`);
    console.log(`provider-reported tokens: ${inTok} in / ${outTok} out`);
    if (estTok > 0) console.log(`estimated input tokens (chars/4, provider reported nothing): ${estTok}`);
    console.log("note: Ember never sees billing - actual spend is on your provider's dashboard.");
  });

program.command("ui")
  .description("Local web app over the engine: search, ask, repo map, notes (binds 127.0.0.1 only)")
  .option("--path <dir>", "repo root", ".")
  .option("--port <n>", "port", "4173")
  .option("--hybrid", "experimental: fuse vector ranking with BM25 (EMBER_HYBRID=1)", false)
  .action(async (opts) => {
    const root = rootOf(opts.path);
    const server = createUiServer(root, hybridOf(opts));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(parseInt(opts.port, 10), "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : opts.port;
    console.log(`ember ui listening on http://127.0.0.1:${port}  (local only; Ctrl-C to stop)`);
  });

program.command("serve")
  .description("Run the MCP server (stdio) so coding agents can use this memory")
  .option("--path <dir>", "default repo root", ".")
  .action(async (opts) => { await startMcpServer(rootOf(opts.path)); });

program.command("demo")
  .description("Guided demo on Ember's own source tree")
  .action(async () => {
    const root = rootOf(".");
    if (!(await new EmberStore(root).exists())) {
      console.error("indexing ember's own source first ...");
      await indexRepo(root, cliEmbedder(), m => console.error(m));
    }
    const engine = await EmberEngine.load(root, cliEmbedder());
    const qs = [
      "how does the approximate nearest neighbor index select neighbors?",
      "where does repo scanning decide which files to skip?",
      "how are decisions mined from git history?",
    ];
    for (const q of qs) {
      console.log(`\n=== Q: ${q}`);
      const hits = await engine.search(q, 3);
      for (const h of hits) {
        console.log(`  -> ${h.chunk.file}:${h.chunk.startLine}-${h.chunk.endLine}${h.chunk.symbol ? ` (${h.chunk.symbol})` : ""} score=${h.score.toFixed(3)}`);
      }
    }
  });

program.parseAsync().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
