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

function extractiveAnswer(hits: SearchHit[], question: string, header: string): string {
  // A chunk with no positive similarity is not a "source" - presenting it
  // as one invents relevance. Say so instead of padding the list.
  const sources = hits.filter(h => h.score > 0);
  const lines = [header, ""];
  if (sources.length === 0) {
    lines.push(`No chunks scored above zero for: "${question}". Try rephrasing, or check the repo is indexed (ember status).`);
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

  const envCap = typeof process !== "undefined" ? parseInt(process.env.EMBER_MAX_OUTPUT_TOKENS ?? "", 10) : NaN;
  const maxAnswerTokens = opts.maxAnswerTokens ?? (Number.isFinite(envCap) ? envCap : 1024);
  const client = opts.client ?? null;
  if (client?.cfg.chatModel) {
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
        `Chat synthesis FAILED (${why}). Retrieval only - no model-generated claims below.`), hits, synthesized: false };
    }
  }

  return { text: extractiveAnswer(hits, question,
    "Retrieval only (no chat model configured; set EMBER_API_BASE/EMBER_API_KEY/EMBER_CHAT_MODEL for synthesized answers)."), hits, synthesized: false };
}
