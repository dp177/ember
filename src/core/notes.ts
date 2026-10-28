/**
 * Cross-session agent notes. An agent leaves short factual notes for its next
 * session (decisions, gotchas, task state); they persist in
 * <repo>/.ember/notes.jsonl and survive restarts and other agents.
 * Search is deterministic lexical overlap - no embedder involved.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface Note {
  id: number;
  ts: string;
  text: string;
  tags: string[];
}

export interface NoteHit extends Note { score: number; }

export class NoteStore {
  readonly file: string;
  constructor(readonly repoRoot: string) {
    this.file = path.join(repoRoot, ".ember", "notes.jsonl");
  }

  private async readAllStats(): Promise<{ notes: Note[]; skipped: number }> {
    let raw: string;
    try { raw = await fs.readFile(this.file, "utf8"); }
    catch { return { notes: [], skipped: 0 }; }
    // A torn line (interrupted append) must not lose the whole history:
    // skip unparseable lines, keep the rest - but count the loss so it
    // can be surfaced instead of failing silently.
    const notes: Note[] = [];
    let skipped = 0;
    for (const l of raw.trim().split("\n")) {
      if (!l) continue;
      try { notes.push(JSON.parse(l) as Note); } catch { skipped++; }
    }
    return { notes, skipped };
  }

  private async readAll(): Promise<Note[]> {
    return (await this.readAllStats()).notes;
  }

  /** Unreadable lines in notes.jsonl (e.g. torn by an interrupted append). */
  async corruptLineCount(): Promise<number> {
    return (await this.readAllStats()).skipped;
  }

  async add(text: string, tags: string[] = []): Promise<Note> {
    const notes = await this.readAll();
    const note: Note = {
      id: notes.length ? Math.max(...notes.map(n => n.id)) + 1 : 1,
      ts: new Date().toISOString(),
      text,
      tags,
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // If a previous append was interrupted mid-line, the file ends without a
    // newline; appending directly would glue this record onto the torn tail
    // and lose it. Repair the boundary first.
    const fd = await fs.open(this.file, "r").catch(() => null);
    if (fd) {
      try {
        const st = await fd.stat();
        if (st.size > 0) {
          const last = Buffer.alloc(1);
          await fd.read(last, 0, 1, st.size - 1);
          if (last[0] !== 0x0a) await fs.appendFile(this.file, "\n");
        }
      } finally { await fd.close(); }
    }
    await fs.appendFile(this.file, JSON.stringify(note) + "\n");
    return note;
  }

  /** Most recent first. */
  async list(limit = 20): Promise<Note[]> {
    const notes = await this.readAll();
    return notes.slice(-limit).reverse();
  }

  /** Deterministic lexical scoring: unique query terms present in text+tags. */
  async search(query: string, limit = 5): Promise<NoteHit[]> {
    const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 1))];
    if (terms.length === 0) return [];
    const hits: NoteHit[] = [];
    for (const n of await this.readAll()) {
      const hay = `${n.text} ${n.tags.join(" ")}`.toLowerCase();
      const score = terms.filter(t => hay.includes(t)).length;
      if (score > 0) hits.push({ ...n, score });
    }
    hits.sort((a, b) => b.score - a.score || b.ts.localeCompare(a.ts));
    return hits.slice(0, limit);
  }
}
