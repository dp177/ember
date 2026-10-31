/** Ember MCP server: exposes persistent codebase memory to any MCP client
 * (Claude Code, Cursor, or any other MCP-aware client). Transport: stdio. */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { embedderChoiceFromEnv, embedderFromEnv } from "../core/embedder.js";
import { EmberEngine } from "../core/engine.js";
import { indexRepo, readCheckpointInfo } from "../core/indexer.js";
import { EmberStore } from "../core/store.js";
import { NoteStore } from "../core/notes.js";
import { EMBER_VERSION } from "../core/version.js";
export { EMBER_VERSION };
import { mtimeDrift } from "../core/freshness.js";
import { buildRepoMap, formatRepoMap } from "../core/repomap.js";
import { getCommits, getDecisions } from "../core/decisions.js";
import { answerQuestion } from "../core/ask.js";

export async function startMcpServer(defaultRoot: string): Promise<void> {
  const server = new McpServer({ name: "ember", version: EMBER_VERSION });
  {
    const choice = embedderChoiceFromEnv();
    if (choice.warning) console.error(`note: ${choice.warning}`);
    if (!choice.embedder.kind.startsWith("local-wasm:")) console.error(`embedder: ${choice.embedder.kind} - ${choice.reason}`);
  }
  const engines = new Map<string, { engine: Promise<EmberEngine>; stamp: string }>();

  const resolveRoot = (p?: string) => path.resolve(p ?? defaultRoot);

  /** Source-grounded freshness stamp of the persisted index (no polling:
   * checked only when a tool call actually needs the engine). */
  async function storeStamp(root: string): Promise<string | null> {
    try {
      const st = await fs.stat(path.join(root, ".ember", "meta.json"));
      return `${st.mtimeMs}:${st.size}`;
    } catch { return null; }
  }

  const getEngine = async (root: string): Promise<EmberEngine> => {
    const stamp = await storeStamp(root);
    const cached = engines.get(root);
    // Reuse the cached engine only while the on-disk index is untouched.
    // An external re-index (CLI, another agent) rewrites meta.json; a delete
    // removes it - both invalidate the cache and force a fresh load, which
    // fails honestly when no index exists.
    if (cached && stamp !== null && cached.stamp === stamp) return cached.engine;
    engines.delete(root);
    const p = EmberEngine.load(root, embedderFromEnv());
    // A failed load must not be cached for the server's lifetime either.
    p.catch(() => { if (engines.get(root)?.engine === p) engines.delete(root); });
    engines.set(root, { engine: p, stamp: stamp ?? "missing" });
    return p;
  };
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const fail = (e: unknown) => text(`error: ${e instanceof Error ? e.message : String(e)}`);

  server.registerTool("index_repo", {
    title: "Index a repository",
    description: "Scan, chunk, embed and index a repository into persistent local memory (.ember/). Incremental by default: unchanged files keep their embeddings; pass full=true to rebuild from scratch.",
    inputSchema: {
      path: z.string().optional().describe("repo root (defaults to the server working directory)"),
      full: z.boolean().optional().describe("rebuild from scratch instead of an incremental update"),
    },
  }, async ({ path: p, full }) => {
    try {
      const root = resolveRoot(p);
      const r = await indexRepo(root, embedderFromEnv(), undefined, { full });
      engines.delete(root);
      return text(`indexed ${r.chunks} chunks from ${r.files} files (dim ${r.dim})${r.incremental ? ` - incremental: reused ${r.kept} chunks, embedded ${r.embedded} new/changed` : ""}. Memory persisted in ${root}/.ember/`);
    } catch (e) { return fail(e); }
  });

  server.registerTool("search_code", {
    title: "Code search with citations",
    description: "Search the indexed repo for code relevant to a natural-language query. Returns file:line citations with snippets.",
    inputSchema: {
      query: z.string(),
      k: z.number().int().min(1).max(30).optional(),
      path: z.string().optional(),
    },
  }, async ({ query, k, path: p }) => {
    try {
      const engine = await getEngine(resolveRoot(p));
      const hits = await engine.search(query, k ?? 8);
      if (hits.length === 0) return text("no hits - is the repo indexed? call index_repo first");
      return text(hits.map((h, i) =>
        `[${i + 1}] ${h.chunk.file}:${h.chunk.startLine}-${h.chunk.endLine}${h.chunk.symbol ? ` (${h.chunk.symbol})` : ""} score=${h.score.toFixed(3)}\n${h.chunk.text.split("\n").slice(0, 10).join("\n")}`
      ).join("\n\n"));
    } catch (e) { return fail(e); }
  });

  server.registerTool("ask", {
    title: "Ask about the codebase",
    description: "Answer a question about the indexed repo with citations. Uses a configured open model when available, otherwise extractive answers.",
    inputSchema: { question: z.string(), path: z.string().optional() },
  }, async ({ question, path: p }) => {
    try { return text((await answerQuestion(await getEngine(resolveRoot(p)), question)).text); }
    catch (e) { return fail(e); }
  });

  server.registerTool("save_note", {
    title: "Save a note for future sessions",
    description: "Persist a short factual note (decision, gotcha, task state) into the repo's cross-session memory (.ember/notes.jsonl). Future sessions - including different agents - can recall it.",
    inputSchema: {
      text: z.string().describe("the note to remember"),
      tags: z.array(z.string()).optional().describe("short labels for filtering"),
      path: z.string().optional(),
    },
  }, async ({ text: t, tags, path: p }) => {
    try {
      const n = await new NoteStore(resolveRoot(p)).add(t, tags ?? []);
      return text(`note #${n.id} saved at ${n.ts}`);
    } catch (e) { return fail(e); }
  });

  server.registerTool("recall_notes", {
    title: "Recall notes from previous sessions",
    description: "Read notes left by earlier agent sessions. With a query, returns keyword-matched notes; without, the most recent ones.",
    inputSchema: {
      query: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
      path: z.string().optional(),
    },
  }, async ({ query, limit, path: p }) => {
    try {
      const store = new NoteStore(resolveRoot(p));
      const corrupt = await store.corruptLineCount();
      const warn = corrupt > 0 ? `(warning: skipped ${corrupt} corrupt line(s) in notes.jsonl - likely an interrupted write; readable notes are unaffected)\n` : "";
      if (query) {
        const hits = await store.search(query, limit ?? 5);
        if (hits.length === 0) return text(warn + "no matching notes");
        return text(warn + hits.map(h => `- [#${h.id} ${h.ts}] ${h.text}`).join("\n"));
      }
      const notes = await store.list(limit ?? 10);
      if (notes.length === 0) return text(warn + "no notes yet - save one with save_note");
      return text(warn + notes.map(n => `- [#${n.id} ${n.ts}] ${n.text}${n.tags.length ? `  (tags: ${n.tags.join(", ")})` : ""}`).join("\n"));
    } catch (e) { return fail(e); }
  });

  server.registerTool("repo_map", {
    title: "Repository map",
    description: "Structure overview: entry points, hub files, key symbols, languages. The fastest way to orient in an unfamiliar repo.",
    inputSchema: { path: z.string().optional() },
  }, async ({ path: p }) => {
    try {
      const root = resolveRoot(p);
      const store = new EmberStore(root);
      const { chunks } = await store.load();
      return text(formatRepoMap(await buildRepoMap(root, chunks)));
    } catch (e) { return fail(e); }
  });

  server.registerTool("decisions", {
    title: "Decision log",
    description: "Architectural decisions mined from git history and ADR docs - the 'why' that code alone doesn't carry.",
    inputSchema: { path: z.string().optional() },
  }, async ({ path: p }) => {
    try {
      const d = await getDecisions(resolveRoot(p));
      const lines: string[] = [];
      if (d.note) lines.push(`note: ${d.note}`);
      lines.push("## Decision-like commits");
      for (const c of d.decisions) lines.push(`- ${c.date} ${c.hash} ${c.subject}`);
      lines.push("\n## ADR / decision documents");
      for (const f of d.adrFiles) lines.push(`- ${f}`);
      return text(lines.join("\n"));
    } catch (e) { return fail(e); }
  });

  server.registerTool("recent_changes", {
    title: "Recent changes",
    description: "Latest commits - what changed most recently in this repo.",
    inputSchema: { path: z.string().optional(), n: z.number().int().min(1).max(100).optional() },
  }, async ({ path: p, n }) => {
    try {
      const commits = await getCommits(resolveRoot(p), n ?? 15);
      if (commits.length === 0) return text("no git history found");
      return text(commits.map(c => `- ${c.date} ${c.hash} ${c.subject}`).join("\n"));
    } catch (e) { return fail(e); }
  });

  server.registerTool("index_status", {
    title: "Index status",
    description: "Whether the repo is indexed, with what embedder, when, and an mtime-heuristic hint of files modified since indexing.",
    inputSchema: { path: z.string().optional() },
  }, async ({ path: p }) => {
    const root = resolveRoot(p);
    const meta = await new EmberStore(root).readMeta();
    if (!meta) return text(`no index at ${root}/.ember - run index_repo first`);
    const drift = await mtimeDrift(new EmberStore(root), root).catch(() => null);
    const stale = drift && drift > 0 ? `, ${drift} file(s) modified since indexing (mtime heuristic - may be stale; re-run index_repo to refresh)` : "";
    const cp = await readCheckpointInfo(root);
    const resumable = cp ? `, resumable checkpoint: ${cp.chunkCount} chunks from an interrupted run (next index_repo resumes after validating model and sources)` : "";
    return text(`indexed: ${meta.chunkCount} chunks / ${meta.fileCount} files, embedder=${meta.embedderKind} dim=${meta.dim}, updated ${meta.updatedAt}${stale}${resumable}`);
  });

  await server.connect(new StdioServerTransport());
}
