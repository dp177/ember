/** `ember ui` - a local web app over the real engine.
 * Local-only by design: binds 127.0.0.1, serves no external assets, makes
 * no outbound calls of its own (the optional chat provider is the only
 * network path, same as the CLI). Source files are served read-only and
 * only from inside the indexed repo root. */

import * as http from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { embedderChoiceFromEnv, embedderFromEnv } from "../core/embedder.js";
import { EmberEngine } from "../core/engine.js";
import { indexRepo } from "../core/indexer.js";
import { EmberStore } from "../core/store.js";
import { mtimeDrift } from "../core/freshness.js";
import { NoteStore } from "../core/notes.js";
import { buildRepoMap, formatRepoMap } from "../core/repomap.js";
import { answerQuestion } from "../core/ask.js";
import { JsonlUsageLogger, LlmClient, sharedClientFromEnv } from "../core/llm.js";
import { PAGE } from "./page.js";

export interface UiOptions {
  hybrid?: boolean;
  /** Test/embedder override; production resolves embedderChoiceFromEnv. */
  embedder?: import("../core/embedder.js").Embedder;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

/** Resolve a repo-relative path safely inside the root; null on escape. */
async function resolveInside(root: string, rel: string): Promise<string | null> {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  const real = await fs.realpath(p).catch(() => null);
  if (!real || (real !== root && !real.startsWith(root + path.sep))) return null;
  return real;
}

async function loadEngine(root: string, opts: UiOptions): Promise<EmberEngine> {
  // embedderFromEnv resolves the shared process-wide provider client, so
  // per-request engine loads no longer restart the EMBER_MAX_CALLS budget.
  const embedder = opts.embedder ?? embedderFromEnv(process.env, JsonlUsageLogger.forRepo(root));
  return EmberEngine.load(root, embedder, { hybrid: opts.hybrid });
}

export function createUiServer(root: string, opts: UiOptions = {}): http.Server {
  if (!opts.embedder) {
    const choice = embedderChoiceFromEnv(process.env, JsonlUsageLogger.forRepo(root));
    if (!choice.embedder.kind.startsWith("local-wasm:")) console.error(`embedder: ${choice.embedder.kind} - ${choice.reason}`);
  }
  // One process-wide provider client backs chat and embeddings alike
  // (sharedClientFromEnv): EMBER_MAX_CALLS and usage accounting aggregate
  // across requests, and its serialized queue keeps concurrent asks from
  // fanning out to the provider.
  const client = (): LlmClient | null => sharedClientFromEnv(process.env, JsonlUsageLogger.forRepo(root));
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = url.pathname;

      // CSRF guard: this local server has ambient authority over the repo
      // (re-index, save notes). Browsers send Origin on cross-site fetches;
      // refuse any mutation whose Origin is not this same local server.
      if (req.method && req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.origin;
        if (origin) {
          let host = "";
          try { host = new URL(origin).hostname; } catch { host = ""; }
          if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
            json(res, 403, { error: "cross-origin mutation refused" });
            return;
          }
        }
      }

      if (route === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE);
        return;
      }

      if (route === "/api/status") {
        const meta = await new EmberStore(root).readMeta();
        // Cheap mtime heuristic (see core/freshness.ts): can be wrong in
        // both directions, so the UI phrases it as "may be stale".
        const drift = meta ? await mtimeDrift(new EmberStore(root), root).catch(() => null) : null;
        json(res, 200, meta
          ? { indexed: true, chunks: meta.chunkCount, files: meta.fileCount, embedder: meta.embedderKind, dim: meta.dim, updatedAt: meta.updatedAt, hybrid: opts.hybrid ?? false, modifiedSinceIndex: drift }
          : { indexed: false });
        return;
      }

      if (route === "/api/index" && req.method === "POST") {
        const r = await indexRepo(root, opts.embedder ?? embedderFromEnv(process.env, JsonlUsageLogger.forRepo(root)), undefined, { full: url.searchParams.get("full") === "1" });
        json(res, 200, r);
        return;
      }

      if (route === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const k = Math.min(parseInt(url.searchParams.get("k") ?? "8", 10) || 8, 50);
        const engine = await loadEngine(root, opts);
        const hits = await engine.search(q, k);
        json(res, 200, {
          query: q,
          hits: hits.map(h => ({
            file: h.chunk.file, startLine: h.chunk.startLine, endLine: h.chunk.endLine,
            symbol: h.chunk.symbol, score: h.score, text: h.chunk.text,
          })),
        });
        return;
      }

      if (route === "/api/ask") {
        const q = url.searchParams.get("q") ?? "";
        const engine = await loadEngine(root, opts);
        const r = await answerQuestion(engine, q, 10, { client: client() });
        json(res, 200, {
          question: q, answer: r.text, synthesized: r.synthesized,
          hits: r.hits.map(h => ({
            file: h.chunk.file, startLine: h.chunk.startLine, endLine: h.chunk.endLine,
            symbol: h.chunk.symbol, score: h.score, text: h.chunk.text,
          })),
        });
        return;
      }

      if (route === "/api/map") {
        const { chunks } = await new EmberStore(root).load();
        json(res, 200, { map: formatRepoMap(await buildRepoMap(root, chunks)) });
        return;
      }

      if (route === "/api/notes" && req.method !== "POST") {
        const store = new NoteStore(root);
        const q = url.searchParams.get("q");
        const notes = q ? await store.search(q, 20) : await store.list(20);
        json(res, 200, { notes, corruptLinesSkipped: await store.corruptLineCount() });
        return;
      }

      if (route === "/api/notes" && req.method === "POST") {
        let body = "";
        for await (const c of req) body += c;
        let parsed: { text?: unknown; tags?: unknown };
        try { parsed = JSON.parse(body || "{}"); }
        catch { json(res, 400, { error: "request body is not valid JSON" }); return; }
        const { text, tags } = parsed;
        if (!text || typeof text !== "string") { json(res, 400, { error: "text required" }); return; }
        const n = await new NoteStore(root).add(text, Array.isArray(tags) ? tags : []);
        json(res, 200, n);
        return;
      }

      if (route === "/api/file") {
        const rel = url.searchParams.get("path") ?? "";
        const real = await resolveInside(root, rel);
        if (!real) {
          // Distinguish "does not exist" from "tried to escape the root"
          // (including a symlink that resolves outside): both are refused,
          // but they are not the same event.
          const p = path.resolve(root, rel);
          const inside = p === root || p.startsWith(root + path.sep);
          const exists = inside && await fs.stat(p).then(() => true, () => false);
          json(res, exists ? 403 : inside ? 404 : 403, { error: exists || !inside ? "path outside the indexed repo" : "file not found in the indexed repo" });
          return;
        }
        const content = await fs.readFile(real, "utf8");
        const start = Math.max(1, parseInt(url.searchParams.get("start") ?? "1", 10) || 1);
        const end = Math.min(parseInt(url.searchParams.get("end") ?? String(start + 40), 10) || start + 40, start + 200);
        const lines = content.split("\n").slice(start - 1, end);
        json(res, 200, { path: rel, startLine: start, lines });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
