/** Repo map: structure, entry points, key symbols, and hub files - the things
 * an agent otherwise burns its first N tool calls discovering. */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ChunkRecord } from "./store.js";

export interface RepoMap {
  totalFiles: number;
  totalChunks: number;
  filesByLanguage: Record<string, number>;
  topDirectories: { dir: string; files: number }[];
  entryPoints: string[];
  hubFiles: { file: string; referencedBy: number }[];
  symbols: { file: string; names: string[] }[];
}

const ENTRY_NAMES = new Set(["cli", "main", "index", "app", "server", "mod", "__main__", "bin"]);

export async function buildRepoMap(root: string, chunks: ChunkRecord[]): Promise<RepoMap> {
  const files = [...new Set(chunks.map(c => c.file))];
  const filesByLanguage: Record<string, number> = {};
  for (const f of files) {
    const ext = path.extname(f).slice(1) || "other";
    filesByLanguage[ext] = (filesByLanguage[ext] ?? 0) + 1;
  }
  const dirCount = new Map<string, number>();
  for (const f of files) {
    const d = path.dirname(f).split(path.sep)[0] || ".";
    dirCount.set(d, (dirCount.get(d) ?? 0) + 1);
  }
  const topDirectories = [...dirCount.entries()].map(([dir, n]) => ({ dir, files: n }))
    .sort((a, b) => b.files - a.files).slice(0, 12);

  const entryPoints: string[] = [];
  for (const f of files) {
    const base = path.basename(f, path.extname(f)).toLowerCase();
    if (ENTRY_NAMES.has(base)) entryPoints.push(f);
  }
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    if (pkg.main) entryPoints.push(String(pkg.main));
    if (pkg.bin) for (const v of Object.values(pkg.bin)) entryPoints.push(String(v));
  } catch { /* not a node repo */ }

  // hub files: referenced by import specifiers of other files (approximate, basename match)
  const refCount = new Map<string, Set<string>>();
  const byStem = new Map<string, string[]>();
  for (const f of files) {
    const stem = path.basename(f).replace(/\.[^.]+$/, "");
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem)!.push(f);
  }
  const IMPORT_RE = /(?:import[\s\S]{0,120}?from\s+|require\(|from\s+|import\s+)['"]([^'"]+)['"]/g;
  const perFileText = new Map<string, string>();
  for (const c of chunks) perFileText.set(c.file, (perFileText.get(c.file) ?? "") + "\n" + c.text);
  for (const [f, text] of perFileText) {
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(text)) !== null) {
      const spec = m[1];
      const stem = path.basename(spec).replace(/\.[^.]+$/, "");
      const targets = byStem.get(stem);
      if (!targets) continue;
      for (const t of targets) {
        if (t === f) continue;
        if (!refCount.has(t)) refCount.set(t, new Set());
        refCount.get(t)!.add(f);
      }
    }
  }
  const hubFiles = [...refCount.entries()]
    .map(([file, set]) => ({ file, referencedBy: set.size }))
    .sort((a, b) => b.referencedBy - a.referencedBy).slice(0, 10);

  const symMap = new Map<string, Set<string>>();
  for (const c of chunks) {
    if (!c.symbol) continue;
    if (!symMap.has(c.file)) symMap.set(c.file, new Set());
    symMap.get(c.file)!.add(c.symbol);
  }
  const symbols = [...symMap.entries()]
    .map(([file, set]) => ({ file, names: [...set].slice(0, 12) }))
    .sort((a, b) => b.names.length - a.names.length).slice(0, 25);

  return {
    totalFiles: files.length, totalChunks: chunks.length, filesByLanguage,
    topDirectories, entryPoints: [...new Set(entryPoints)], hubFiles, symbols,
  };
}

export function formatRepoMap(m: RepoMap): string {
  const lines: string[] = [];
  lines.push(`# Repo map - ${m.totalFiles} files, ${m.totalChunks} chunks`);
  lines.push(`Languages: ${Object.entries(m.filesByLanguage).map(([k, v]) => `${k}(${v})`).join(", ")}`);
  lines.push(`\n## Entry points`);
  for (const e of m.entryPoints) lines.push(`- ${e}`);
  lines.push(`\n## Hub files (most referenced)`);
  for (const h of m.hubFiles) lines.push(`- ${h.file}  <- ${h.referencedBy} files`);
  lines.push(`\n## Key symbols by file`);
  for (const s of m.symbols) lines.push(`- ${s.file}: ${s.names.join(", ")}`);
  return lines.join("\n");
}
