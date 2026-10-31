/** `ember ui` - a local web app over the real engine.
 * Local-only by design: binds 127.0.0.1, serves no external assets, makes
 * no outbound calls of its own (the optional chat provider is the only
 * network path, same as the CLI). Source files are served read-only and
 * only from inside the indexed repo root. */

import * as http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { embedderChoiceFromEnv, embedderFromEnv } from "../core/embedder.js";
import { EmberEngine } from "../core/engine.js";
import { readCheckpointInfo } from "../core/indexer.js";
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
  /** Test override for the reindex execution; production uses a child process. */
  indexRunner?: IndexRunner;
}

/** Runs one reindex and reports progress lines; resolves with the result. */
export type IndexRunner = (onLine: (line: string) => void, full: boolean) => Promise<{ chunks: number; files: number; kept?: number; reused?: number; embedded?: number }>;

/** Production reindex runs as a child process. An in-process run shares the
 * server's address space, so a large embed phase can take the whole UI down
 * with it and the panel cannot even show the failure (measured: a 14,905-chunk
 * semantic reindex on the vite repo grew the server's RSS past 1.6 GB on a
 * 2 GB machine; the process died with ~160 MB free). As a child, the server
 * keeps serving the previous index during the run, and a dead worker becomes
 * a visible, resumable error in the panel instead of a vanished server. */
function childIndexRunner(root: string, opts: UiOptions): IndexRunner {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  // The child resolves its own embedder from env, so an injected embedder's
  // identity must be mirrored through it: a test's hashing embedder becomes
  // EMBER_LEXICAL=1, an injected local model stays itself. Without this the
  // child quietly reindexed with the env default - which is how the suite
  // downloaded the real model despite every test injecting a stub.
  const env: NodeJS.ProcessEnv = { ...process.env, EMBER_INDEX_RESULT_JSON: "1" };
  if (opts.embedder) {
    if (opts.embedder.kind === "local-hashing-lexical") env.EMBER_LEXICAL = "1";
    else if (opts.embedder.kind.startsWith("local-wasm:")) env.EMBER_LOCAL_EMBED_MODEL = opts.embedder.kind.slice("local-wasm:".length);
    // Other injected kinds have no env representation; those tests inject
    // indexRunner too.
  }
  return (onLine, full) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "index", ...(full ? ["--full"] : [])], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let result: { chunks: number; files: number } | null = null;
    const feed = (buf: string, chunk: string): string => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.startsWith("EMBER_RESULT_JSON:")) { try { result = JSON.parse(line.slice(18)); } catch { /* ignore */ } }
        else if (line.trim()) onLine(line);
      }
      return buf;
    };
    let outBuf = "", errBuf = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", d => { outBuf = feed(outBuf, d); });
    child.stderr.on("data", d => { errBuf = feed(errBuf, d); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve(result ?? { chunks: 0, files: 0 });
      else reject(new Error(
        signal
          ? `index worker terminated (${signal}); cause unknown - possibilities include the OS killing a memory-heavy process or a direct kill; the run is resumable: press Reindex to continue`
          : `index worker exited with code ${code}; the run is resumable: press Reindex to continue`));
    });
  });
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

/** Source-grounded freshness stamp of the persisted index (same pattern as
 * the MCP server): checked only when a request actually needs the engine. */
async function storeStamp(root: string): Promise<string | null> {
  try {
    const st = await fs.stat(path.join(root, ".ember", "meta.json"));
    return `${st.mtimeMs}:${st.size}`;
  } catch { return null; }
}

/** One in-flight reindex per server: the run is async so the request
 * returns immediately and the page polls /api/index-status. Progress
 * lines are bounded (last 100). */
interface IndexRun { startedAt: string; lines: string[]; done: boolean; error?: string; result?: unknown; }

export function createUiServer(root: string, opts: UiOptions = {}): http.Server {
  let indexRun: IndexRun | null = null;
  if (!opts.embedder) {
    const choice = embedderChoiceFromEnv(process.env, JsonlUsageLogger.forRepo(root));
    if (choice.warning) console.error(`note: ${choice.warning}`);
    if (!choice.embedder.kind.startsWith("local-wasm:")) console.error(`embedder: ${choice.embedder.kind} - ${choice.reason}`);
  }
  // One process-wide provider client backs chat and embeddings alike
  // (sharedClientFromEnv): EMBER_MAX_CALLS and usage accounting aggregate
  // across requests, and its serialized queue keeps concurrent asks from
  // fanning out to the provider.
  const client = (): LlmClient | null => sharedClientFromEnv(process.env, JsonlUsageLogger.forRepo(root));

  // Cache the loaded engine and its embedder across requests: with the
  // semantic default, a per-request load would reload the WASM model and
  // re-read every vector on each search. The stamp check keeps an external
  // re-index (CLI, another agent) honest; a failed load is never cached.
  let cached: { stamp: string; engine: Promise<EmberEngine> } | null = null;
  const engineFor = async (): Promise<EmberEngine> => {
    const stamp = await storeStamp(root);
    if (cached && stamp !== null && cached.stamp === stamp) return cached.engine;
    const p = loadEngine(root, opts);
    p.catch(() => { if (cached?.engine === p) cached = null; });
    cached = { stamp: stamp ?? "missing", engine: p };
    return p;
  };

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
        const cp = await readCheckpointInfo(root);
        json(res, 200, meta
          ? { indexed: true, chunks: meta.chunkCount, files: meta.fileCount, embedder: meta.embedderKind, dim: meta.dim, updatedAt: meta.updatedAt, hybrid: opts.hybrid ?? false, modifiedSinceIndex: drift, resumableCheckpoint: cp ?? undefined }
          : { indexed: false, resumableCheckpoint: cp ?? undefined });
        return;
      }

      if (route === "/api/index" && req.method === "POST") {
        if (indexRun && !indexRun.done) {
          json(res, 409, { error: "an index run is already in progress - poll /api/index-status", running: true });
          return;
        }
        const run: IndexRun = { startedAt: new Date().toISOString(), lines: [], done: false };
        indexRun = run;
        const full = url.searchParams.get("full") === "1";
        const runner = opts.indexRunner ?? childIndexRunner(root, opts);
        void (async () => {
          try {
            const r = await runner(m => { run.lines.push(m); if (run.lines.length > 100) run.lines.splice(0, run.lines.length - 100); }, full);
            cached = null; // next request loads the fresh index
            run.result = r;
          } catch (e) {
            run.error = e instanceof Error ? e.message : String(e);
          } finally {
            run.done = true;
          }
        })();
        json(res, 202, { started: true, full });
        return;
      }

      if (route === "/api/index-status") {
        if (!indexRun) { json(res, 200, { running: false }); return; }
        json(res, 200, {
          running: !indexRun.done,
          startedAt: indexRun.startedAt,
          lines: indexRun.lines.slice(-20),
          result: indexRun.result,
          error: indexRun.error,
        });
        return;
      }

      if (route === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const k = Math.min(parseInt(url.searchParams.get("k") ?? "8", 10) || 8, 50);
        const engine = await engineFor();
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
        const engine = await engineFor();
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
