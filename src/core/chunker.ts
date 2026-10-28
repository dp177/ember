/**
 * Code-aware chunking. Strategy:
 *  - detect language from file extension
 *  - for brace/indent languages, split at top-level declaration boundaries
 *    (function/class/interface/export blocks) using lightweight heuristics
 *  - fall back to overlapping line windows
 * Every chunk records file, line range and (when detected) the symbol name.
 */

export interface CodeChunk {
  file: string;
  startLine: number; // 1-based
  endLine: number;   // inclusive
  symbol: string | null;
  text: string;
}

const DECL_PATTERNS: RegExp[] = [
  /^\s*export\s+(default\s+)?(async\s+)?(function|class|interface|type|const|let|var)\s+([A-Za-z0-9_$]+)/,
  /^\s*(export\s+)?(const|let|var)\s+([A-Za-z0-9_$]+)\s*=/,
  /^\s*(async\s+)?function\s+([A-Za-z0-9_$]+)/,
  /^\s*(export\s+)?(abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
  /^\s*(public|private|protected|static|final|async|\s)*\s*[A-Za-z0-9_$<>\[\], ]+\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*(throws\s+\w+\s*)?\{?\s*$/, // java/c-like method
  /^\s*def\s+([A-Za-z0-9_]+)/,
  /^\s*(async\s+def)\s+([A-Za-z0-9_]+)/,
  /^\s*class\s+([A-Za-z0-9_]+)/,
  /^\s*func\s+(\([^)]*\)\s*)?([A-Za-z0-9_]+)/, // go
  /^\s*(pub\s+)?(async\s+)?fn\s+([A-Za-z0-9_]+)/, // rust
];

const MAX_CHUNK_LINES = 80;
const OVERLAP_LINES = 12;
const MAX_CHUNK_CHARS = 4000;

function symbolOf(line: string): string | null {
  for (const p of DECL_PATTERNS) {
    const m = line.match(p);
    if (m) {
      // last defined capture group that exists
      for (let i = m.length - 1; i >= 1; i--) if (m[i]) return m[i];
    }
  }
  return null;
}

export function chunkFile(file: string, content: string): CodeChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  // Find declaration boundaries
  const bounds: { line: number; symbol: string | null }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const s = symbolOf(lines[i]);
    if (s) bounds.push({ line: i, symbol: s });
  }

  const chunks: CodeChunk[] = [];
  const push = (startLine: number, endLine: number, symbol: string | null) => {
    if (endLine < startLine) return;
    let text = lines.slice(startLine, endLine + 1).join("\n");
    if (text.trim().length < 24) return; // skip noise chunks
    if (text.length > MAX_CHUNK_CHARS) text = text.slice(0, MAX_CHUNK_CHARS);
    chunks.push({ file, startLine: startLine + 1, endLine: endLine + 1, symbol, text });
  };

  if (bounds.length === 0) {
    // sliding window
    for (let i = 0; i < lines.length; i += MAX_CHUNK_LINES - OVERLAP_LINES) {
      push(i, Math.min(i + MAX_CHUNK_LINES - 1, lines.length - 1), null);
    }
    return chunks;
  }

  // header before the first declaration (imports, docstring) attaches to it
  for (let b = 0; b < bounds.length; b++) {
    const start0 = b === 0 ? 0 : bounds[b].line;
    const end = (b + 1 < bounds.length ? bounds[b + 1].line : lines.length) - 1;
    let start = start0;
    while (end - start > MAX_CHUNK_LINES) {
      push(start, start + MAX_CHUNK_LINES - 1, bounds[b].symbol);
      start += MAX_CHUNK_LINES - OVERLAP_LINES;
    }
    push(start, end, bounds[b].symbol);
  }
  return chunks;
}
