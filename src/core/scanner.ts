/**
 * Repo scanner: git-aware-ish file walk. Skips dependencies, build output,
 * binary and oversized files. Detects language from extension.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface ScannedFile {
  relPath: string;
  absPath: string;
  language: string;
  size: number;
  content: string;
}

/** Stat-only view of a scanned file (no content read). */
export interface ScannedFileStat {
  relPath: string;
  size: number;
  mtimeMs: number;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target",
  "vendor", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".idea",
  ".vscode", "venv", ".venv", "env", ".ember", "tmp", "temp", "logs", "dist-test",
]);

const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
  "Gemfile.lock", "poetry.lock", "Cargo.lock", "go.sum",
]);

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".go": "go",
  ".rs": "rust", ".java": "java", ".kt": "kotlin", ".cpp": "cpp", ".cc": "cpp",
  ".cxx": "cpp", ".c": "c", ".h": "c-header", ".hpp": "cpp-header", ".cs": "csharp",
  ".rb": "ruby", ".php": "php", ".swift": "swift", ".scala": "scala",
  ".md": "markdown", ".mdx": "markdown", ".sql": "sql", ".sh": "shell",
  ".yml": "yaml", ".yaml": "yaml", ".json": "json", ".toml": "toml",
};

const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_FILES = 4000;

/** Optional <root>/.emberignore: one repo-relative path per line. A line
 * matches that exact file, or everything under that directory prefix.
 * Lines starting with # are comments. Use it to keep fixtures, generated
 * snapshots and eval corpora out of the index. */
async function loadEmberIgnore(root: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(root, ".emberignore"), "utf8");
    return raw.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  } catch { return []; }
}

/** The same repo walk without reading file contents: for cheap drift
 * checks where reading every file would double query latency. */
export async function scanRepoStat(root: string): Promise<ScannedFileStat[]> {
  return (await collect(root, false)).files as ScannedFileStat[];
}

export interface ScanResult {
  files: ScannedFile[];
  /** True when the walk stopped at the file cap: the index is PARTIAL. */
  capped: boolean;
  cap: number;
}

export async function scanRepo(root: string, maxFiles = MAX_TOTAL_FILES): Promise<ScannedFile[]> {
  return (await collect(root, true, maxFiles)).files as ScannedFile[];
}

export async function scanRepoCapped(root: string, maxFiles = MAX_TOTAL_FILES): Promise<ScanResult> {
  const r = await collect(root, true, maxFiles);
  return { files: r.files as ScannedFile[], capped: r.capped, cap: maxFiles };
}

async function collect(root: string, readContent: boolean, maxFiles = MAX_TOTAL_FILES): Promise<{ files: (ScannedFile | ScannedFileStat)[]; capped: boolean }> {
  const out: (ScannedFile | ScannedFileStat)[] = [];
  let capped = false;
  const ignored = await loadEmberIgnore(root);
  const isIgnored = (rel: string): boolean =>
    ignored.some(p => rel === p || rel.startsWith(p.replace(/\/$/, "") + "/"));
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) { capped = true; return; }
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) { capped = true; return; }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        // Exact ".git" only: startsWith(".git") would also skip ".github",
        // silently dropping workflows, issue templates and docs from the index.
        if (SKIP_DIRS.has(e.name) || e.name === ".git") continue;
        await walk(abs);
      } else if (e.isFile()) {
        if (SKIP_FILES.has(e.name) || e.name.endsWith(".min.js")) continue;
        const ext = path.extname(e.name).toLowerCase();
        const language = LANG_BY_EXT[ext];
        if (!language) continue;
        let st;
        try { st = await fs.stat(abs); } catch { continue; }
        if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
        const relPath = path.relative(root, abs);
        if (!readContent) {
          if (isIgnored(relPath)) continue;
          out.push({ relPath, size: st.size, mtimeMs: st.mtimeMs });
          continue;
        }
        let content: string;
        try { content = await fs.readFile(abs, "utf8"); } catch { continue; }
        if (content.indexOf("\0") !== -1) continue; // binary sniff
        if (isIgnored(relPath)) continue;
        out.push({ relPath, absPath: abs, language, size: st.size, content });
      }
    }
  }
  await walk(root);
  // Deterministic order: chunk ids are assigned sequentially in scan order,
  // so a stable byte-order sort keeps ids reproducible across runs, clones
  // and filesystems (readdir order is arbitrary).
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files: out, capped };
}
