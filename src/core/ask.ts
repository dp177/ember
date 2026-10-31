/** Question answering with citations.
 * With an OpenAI-compatible chat model configured (EMBER_API_BASE +
 * EMBER_API_KEY + EMBER_CHAT_MODEL) answers are synthesized by the model,
 * grounded only in retrieved chunks. Without one, answers are extractive.
 *
 * Honesty rules:
 * - The model is instructed to say when the chunks do not contain the answer;
 *   that abstention is passed through untouched.
 * - Citation markers are validated against the retrieved set: markers pointing
 *   outside it are stripped and the stripping is disclosed.
 * - If the synthesis call fails, we say so and fall back to the extractive
 *   answer rather than hiding the failure. */

import type { EmberEngine, SearchHit } from "./engine.js";
import type { LlmClient } from "./llm.js";

export interface AskResult {
  text: string;
  hits: SearchHit[];
  /** true when a chat model produced the prose; false = retrieval only. */
  synthesized: boolean;
}

function cite(h: SearchHit): string {
  return `${h.chunk.file}:${h.chunk.startLine}-${h.chunk.endLine}${h.chunk.symbol ? " (" + h.chunk.symbol + ")" : ""}`;
}

/** Calibrated top-score floor for the local WASM semantic path. Measured
 * 31 October on the two pinned eval corpora (Ember f347319, flask 49943b5,
 * Xenova/all-MiniLM-L6-v2): 60 known-relevant probes all scored above 0.207
 * at top-1 while 20 off-topic probes scored 0.111-0.258. At 0.20: zero false
 * abstentions, 15/20 off-topic caught. This is a calibrated heuristic for
 * THIS model family on THOSE corpora - it cannot prove answerability, and
 * lexical/hybrid scores live on a different scale (floor 0 there, the old
 * behavior). EMBER_ASK_MIN_SCORE overrides. Raw `ember search` never
 * applies this floor; it only gates what Ask presents as evidence. */
export const ASK_MIN_SEMANTIC_SCORE = 0.2;

export function askMinScore(embedderKind: string, env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseFloat(env.EMBER_ASK_MIN_SCORE ?? "");
  if (Number.isFinite(raw)) return raw;
  return embedderKind.startsWith("local-wasm:") ? ASK_MIN_SEMANTIC_SCORE : 0;
}

/** Remove [n] citation markers that point outside the retrieved chunk list.
 * Returns the cleaned answer and how many markers were stripped. */
export function validateCitations(answer: string, chunkCount: number): { answer: string; stripped: number } {
  let stripped = 0;
  const cleaned = answer.replace(/\[(\d+)\]/g, (m, nStr) => {
    const n = parseInt(nStr, 10);
    if (n >= 1 && n <= chunkCount) return m;
    stripped++;
    return "";
  });
  return { answer: cleaned.replace(/[ \t]+\n/g, "\n"), stripped };
}

function extractiveAnswer(hits: SearchHit[], question: string, header: string, minScore = 0): string {
  // A chunk below the score floor is not a "source" - presenting it as one
  // invents relevance. Say so instead of padding the list.
  const sources = hits.filter(h => h.score > minScore);
  const lines = [header, ""];
  if (sources.length === 0) {
    const top = hits[0];
    lines.push(`No chunks scored high enough to treat as relevant for: "${question}"${top ? ` (top score ${top.score.toFixed(3)}, at or below the ${minScore} floor)` : ""}. The closest match${top ? ` (${cite(top)})` : ""} is likely unrelated. Try rephrasing, or check the repo is indexed (ember status).`);
    return lines.join("\n");
  }
  lines.push(`Retrieved sources for: "${question}" (ranked by score; retrieval is not an answer)`, "");
  sources.forEach((h, i) => {
    const excerpt = h.chunk.text.split("\n").slice(0, 6)
      .map((l, j) => `${String(h.chunk.startLine + j).padStart(4)} | ${l}`).join("\n");
    lines.push(`[${i + 1}] ${cite(h)}  (score ${h.score.toFixed(4)})\n${excerpt}\n`);
  });
  return lines.join("\n");
}

export async function answerQuestion(
  engine: EmberEngine,
  question: string,
  k = 10,
  opts: { client?: LlmClient | null; maxAnswerTokens?: number } = {},
): Promise<AskResult> {
  const hits = await engine.search(question, k);
  if (hits.length === 0) {
    return { text: "No relevant code found. Is the repo indexed? Run: ember index", hits, synthesized: false };
  }
  const minScore = askMinScore(engine.embedderKind);
  const passing = hits.filter(h => h.score > minScore);

  const envCap = typeof process !== "undefined" ? parseInt(process.env.EMBER_MAX_OUTPUT_TOKENS ?? "", 10) : NaN;
  const maxAnswerTokens = opts.maxAnswerTokens ?? (Number.isFinite(envCap) ? envCap : 1024);
  const client = opts.client ?? null;
  if (client?.cfg.chatModel && (minScore === 0 || passing.length > 0)) {
    const context = hits.map((h, i) => `[${i + 1}] ${cite(h)}\n${h.chunk.text}`).join("\n\n---\n\n");
    try {
      const result = await client.chat([
        { role: "system", content: "You answer questions about a codebase using only the provided chunks. Cite every claim as [n] referring to the chunk list, and include the file:line reference. If the chunks don't contain the answer, say so plainly - never invent code, files, or behavior that are not in the chunks." },
        { role: "user", content: `Question: ${question}\n\nCode chunks:\n\n${context}` },
      ], { maxTokens: maxAnswerTokens });
      const { answer, stripped } = validateCitations(result.content, hits.length);
      const notes: string[] = [];
      if (stripped > 0) notes.push(`(stripped ${stripped} citation marker(s) pointing outside the retrieved chunks)`);
      if (!/\[\d+\]/.test(answer)) notes.push("(the model answer contains no citation markers - treat it as unverified and check the sources below)");
      const suffix = notes.length ? `\n${notes.join("\n")}` : "";
      return { text: `${answer}${suffix}\n\nSources:\n${hits.map((h, i) => `[${i + 1}] ${cite(h)}`).join("\n")}`, hits, synthesized: true };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { text: extractiveAnswer(hits, question,
        `Chat synthesis FAILED (${why}). Retrieval only - no model-generated claims below.`, minScore), hits, synthesized: false };
    }
  }

  if (client?.cfg.chatModel && minScore > 0 && passing.length === 0) {
    // Synthesis skipped: no retrieved chunk cleared the score floor, so there
    // is no grounded context to send. Say so instead of buying a guess.
    return { text: extractiveAnswer(hits, question,
      "No grounded sources - chat synthesis skipped (nothing retrieved scored above the relevance floor; no request was sent to the model).", minScore), hits, synthesized: false };
  }
  return { text: extractiveAnswer(hits, question,
    "Retrieval only (no chat model configured; set EMBER_API_BASE/EMBER_API_KEY/EMBER_CHAT_MODEL for synthesized answers).", minScore), hits, synthesized: false };
}
