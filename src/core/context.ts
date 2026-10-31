/** Live source inspection for the CLI: read a line range from a file in the
 * repo, jailed to the repo root (the UI server applies the same jail). The
 * live file may differ from the indexed chunk; callers label it as live. */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface SourceContext {
  lines: string[];
  /** 1-based line number of lines[0] in the file */
  startLine: number;
  /** total lines in the file */
  totalLines: number;
}

export async function readSourceContext(root: string, file: string, startLine: number, endLine: number): Promise<SourceContext> {
  // Jail both lexically AND through symlink resolution: a symlink inside the
  // repo pointing outside must not leak reads (same rule as the UI server).
  const absRoot = await fs.realpath(path.resolve(root));
  const abs = path.resolve(absRoot, file);
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) {
    throw new Error(`path escapes the repo root: ${file}`);
  }
  const real = await fs.realpath(abs).catch(e => {
    throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (real !== absRoot && !real.startsWith(absRoot + path.sep)) {
    throw new Error(`path escapes the repo root via a symlink: ${file}`);
  }
  const raw = await fs.readFile(real, "utf8").catch(e => {
    throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  });
  const all = raw.split("\n");
  const start = Math.max(1, Math.min(startLine, all.length));
  const end = Math.max(start, Math.min(endLine, all.length));
  return { lines: all.slice(start - 1, end), startLine: start, totalLines: all.length };
}
