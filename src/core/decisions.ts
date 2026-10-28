/** Decision log + recent changes, mined from git history and ADR-style docs. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const run = promisify(execFile);

export interface Commit { hash: string; date: string; subject: string; }

const DECISION_RE = /\b(decid|chose|choose|instead|migrat|switch(ed)?\s+to|revert|because|trade[- ]?off|deprecat|adopt|rfc|adr)\b/i;

export async function getCommits(root: string, n = 400): Promise<Commit[]> {
  try {
    const { stdout } = await run("git", ["log", `--format=%h%x1f%ad%x1f%s`, "--date=short", "-n", String(n)], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim().split("\n").filter(Boolean).map(l => {
      const [hash, date, ...rest] = l.split("\x1f");
      return { hash, date, subject: rest.join("\x1f") };
    });
  } catch { return []; }
}

export async function getDecisions(root: string): Promise<{ decisions: Commit[]; adrFiles: string[]; note?: string }> {
  const commits = await getCommits(root);
  const decisions = commits.filter(c => DECISION_RE.test(c.subject)).slice(0, 50);
  const adrFiles: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", ".git", "dist", "build"].includes(e.name)) continue;
        if (/^(adr|adrs|decisions?)$/i.test(e.name)) {
          try {
            for (const f of await fs.readdir(abs)) adrFiles.push(path.relative(root, path.join(abs, f)));
          } catch { /* ignore */ }
        }
        await walk(abs, depth + 1);
      } else if (/(^|-)adr(-|\d)|decision/i.test(e.name) && /\.(md|mdx|rst|txt)$/i.test(e.name)) {
        adrFiles.push(path.relative(root, abs));
      }
    }
  }
  await walk(root, 0);
  return {
    decisions, adrFiles: adrFiles.slice(0, 25),
    note: commits.length === 0 ? "not a git repository or no history available" : undefined,
  };
}
