/** Browser-side loader for the live demo: fetch a PUBLIC GitHub repo's
 * recognized source files via GitHub's public API (CORS-verified:
 * api.github.com git/trees and raw.githubusercontent.com both send
 * Access-Control-Allow-Origin: *), chunk them with Ember's real chunker,
 * and hand them to the demo's in-browser embedder.
 * No tokens, no credentials, no server. Bounded by construction:
 * DEMO_MAX_FILES / DEMO_MAX_BYTES caps and a per-request timeout. */

import { parseGitHubUrl, type GitHubRepo } from "../src/ui/github-url.js";
import { LANG_BY_EXT, MAX_FILE_BYTES, SKIP_FILES } from "../src/core/langs.js";
import { chunkFile } from "../src/core/chunker.js";
import type { ChunkRecord } from "./search-core.js";

/** Demo bounds: enough for a real search experience, small enough that a
 * phone on mobile data survives the load. */
export const DEMO_MAX_FILES = 120;
export const DEMO_MAX_BYTES = 1_200_000;
const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 20_000;

export interface TreeEntry { path: string; type: string; size?: number; }
export interface RepoTree { defaultBranch: string; entries: TreeEntry[]; truncated: boolean; }
export type FetchText = (url: string) => Promise<{ ok: boolean; status: number; body: string; rateLimitReset?: number }>;

/** Default fetcher with a hard per-request timeout and rate-limit surface. */
export const githubFetchText: FetchText = async (url) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return {
      ok: res.ok,
      status: res.status,
      body: res.ok ? await res.text() : "",
      rateLimitReset: Number(res.headers.get("x-ratelimit-remaining")) === 0
        ? Number(res.headers.get("x-ratelimit-reset")) : undefined,
    };
  } finally { clearTimeout(t); }
};

/** Fetch the repo's default branch and full file tree (2 API calls). */
export async function fetchRepoTree(repo: GitHubRepo, ft: FetchText = githubFetchText): Promise<RepoTree> {
  const meta = await ft(`https://api.github.com/repos/${repo.owner}/${repo.repo}`);
  if (meta.status === 404) throw new Error("repository not found - it is missing or private (this demo loads public repos only, no login)");
  if (meta.status === 403 && meta.rateLimitReset)
    throw new Error(`GitHub's anonymous rate limit is exhausted - try again after ${new Date(meta.rateLimitReset * 1000).toLocaleTimeString()}`);
  if (!meta.ok) throw new Error(`GitHub API error ${meta.status} while reading ${repo.label}`);
  const defaultBranch = repo.ref ?? (JSON.parse(meta.body).default_branch as string);
  const tree = await ft(`https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`);
  if (tree.status === 404) throw new Error(repo.ref ? `branch or tag "${repo.ref}" not found in ${repo.owner}/${repo.repo}` : "repository tree not found");
  if (tree.status === 403 && tree.rateLimitReset)
    throw new Error(`GitHub's anonymous rate limit is exhausted - try again after ${new Date(tree.rateLimitReset * 1000).toLocaleTimeString()}`);
  if (!tree.ok) throw new Error(`GitHub API error ${tree.status} while reading the file tree`);
  const parsed = JSON.parse(tree.body);
  if (parsed.truncated) throw new Error(`this repo's file tree is too large for GitHub's tree API (truncated) - try a smaller repo`);
  return { defaultBranch, entries: parsed.tree as TreeEntry[], truncated: !!parsed.truncated };
}

const SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|\.git|\.github\/workflows|vendor|__pycache__)\//;

/** Pure selection: which tree entries become demo corpus files, and why
 * the rest are skipped. Exported for hermetic tests. */
export function selectFiles(entries: TreeEntry[], maxFiles = DEMO_MAX_FILES, maxBytes = DEMO_MAX_BYTES): { files: { path: string; size: number }[]; skipped: { reason: string; count: number }[]; bounded: boolean } {
  const skipped = new Map<string, number>();
  const bump = (r: string) => skipped.set(r, (skipped.get(r) ?? 0) + 1);
  const candidates: { path: string; size: number }[] = [];
  for (const e of entries) {
    if (e.type !== "blob") continue;
    const name = e.path.split("/").pop() ?? e.path;
    if (SKIP_FILES.has(name) || name.endsWith(".min.js")) { bump("lockfile/minified"); continue; }
    if (SKIP_DIRS.test(e.path)) { bump("dependency/build dir"); continue; }
    const ext = "." + (name.includes(".") ? name.split(".").pop()! : "");
    if (!LANG_BY_EXT[ext]) { bump("unsupported extension"); continue; }
    const size = e.size ?? 0;
    if (size > MAX_FILE_BYTES) { bump("over 256 KB"); continue; }
    if (size === 0) { bump("empty"); continue; }
    candidates.push({ path: e.path, size });
  }
  // Deterministic bound: prefer smaller files first so a capped load still
  // covers many files; report exactly what the cap dropped.
  candidates.sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));
  const files: { path: string; size: number }[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const c of candidates) {
    if (files.length >= maxFiles || bytes + c.size > maxBytes) { dropped++; continue; }
    files.push(c); bytes += c.size;
  }
  if (dropped > 0) skipped.set(`over demo cap (${maxFiles} files / ${(maxBytes / 1e6).toFixed(1)} MB)`, dropped);
  return { files, skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })), bounded: dropped > 0 };
}

export interface LoadedRepo { repo: GitHubRepo; branch: string; chunks: ChunkRecord[]; files: number; bytes: number; bounded: boolean; }

/** Fetch file contents and chunk them. Embedding happens in the caller. */
export async function fetchAndChunk(repo: GitHubRepo, onProgress: (msg: string) => void, ft: FetchText = githubFetchText): Promise<LoadedRepo> {
  onProgress(`reading file tree of ${repo.label} via GitHub's public API...`);
  const { defaultBranch, entries } = await fetchRepoTree(repo, ft);
  const { files, skipped, bounded } = selectFiles(entries);
  if (files.length === 0) {
    const why = skipped.map(s => `${s.count} ${s.reason}`).join(", ") || "no files at all";
    throw new Error(`no recognizable source files to index (${why}) - try a repo with code files (.ts .js .py .go .rs .md ...)`);
  }
  const bytes = files.reduce((a, f) => a + f.size, 0);
  onProgress(`fetching ${files.length} files (${(bytes / 1024).toFixed(0)} KB)${bounded ? ` - bounded: ${skipped.map(s => `${s.count} ${s.reason}`).join(", ")}` : ""}...`);
  const chunks: ChunkRecord[] = [];
  let nextId = 0;
  let done = 0;
  const queue = [...files];
  const worker = async () => {
    while (queue.length > 0) {
      const f = queue.shift()!;
      const r = await ft(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(defaultBranch)}/${f.path.split("/").map(encodeURIComponent).join("/")}`);
      done++;
      if (!r.ok) { onProgress(`skipped ${f.path} (HTTP ${r.status})`); continue; }
      if (done % 20 === 0) onProgress(`fetched ${done}/${files.length} files...`);
      for (const c of chunkFile(f.path, r.body)) {
        chunks.push({ id: nextId++, file: c.file, startLine: c.startLine, endLine: c.endLine, symbol: c.symbol ?? null, text: c.text });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, files.length) }, worker));
  if (chunks.length === 0) throw new Error("files were fetched but none produced searchable chunks");
  return { repo, branch: defaultBranch, chunks, files: files.length, bytes, bounded };
}
