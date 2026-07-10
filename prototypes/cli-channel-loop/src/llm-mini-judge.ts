/**
 * llm-mini progress judge — asks the local brain whether the trailing conversation
 * window is still making progress (SPIKE STUB).
 *
 * Talks to any OpenAI-compatible chat-completions endpoint (llm-mini, the local 27B
 * brain, is expected to be served that way). Config from env:
 *   LLM_MINI_URL   — base URL, e.g. http://10.100.23.90:11434  (unset → no judge)
 *   LLM_MINI_MODEL — model name (default "llm-mini")
 *
 * Any transport/parse failure returns "unknown" — the LoopDetector treats that as
 * non-actionable (the absolute backstops still bound a runaway; see loop-detector.ts).
 */

import type { Judge, JudgeVerdict, TranscriptEntry } from "./loop-detector.js";

/** Framed on PROGRESS vs repetition, not similarity — a deep thread on one topic is fine. */
export const JUDGE_SYSTEM_PROMPT = `You are a conversation-progress judge. You will see the trailing window of an ongoing conversation between AI identities that runs unattended. Decide whether it is still making progress toward resolving its aim.

Respond with exactly one word:
PROGRESS — new information, decisions, or narrowing toward the aim is still happening. Long, deep discussion of one topic counts as PROGRESS if it moves.
LOOPING — the participants are repeating points, re-asking answered questions, or circling without narrowing.
STALLED — the exchange has degenerated into contentless acknowledgements, thanks, or filler.

Judge progress, not similarity. When genuinely unsure, answer PROGRESS.`;

const MAX_CHARS_PER_MESSAGE = 500;

export function formatWindow(window: readonly TranscriptEntry[]): string {
  return window
    .map((e) => {
      const text = e.text.length > MAX_CHARS_PER_MESSAGE ? `${e.text.slice(0, MAX_CHARS_PER_MESSAGE)}…` : e.text;
      return `[${e.direction}] ${e.sender}: ${text}`;
    })
    .join("\n");
}

/** Extract the verdict word from a model reply; anything unparseable is "unknown". */
export function parseVerdict(reply: string): JudgeVerdict {
  const match = /\b(progress|looping|stalled)\b/i.exec(reply);
  if (!match || match[1] === undefined) return "unknown";
  return match[1].toLowerCase() as JudgeVerdict;
}

export function makeLlmMiniJudge(baseUrl: string, model: string): Judge {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  return async (window: readonly TranscriptEntry[]): Promise<JudgeVerdict> => {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 8,
          messages: [
            { role: "system", content: JUDGE_SYSTEM_PROMPT },
            { role: "user", content: formatWindow(window) }
          ]
        })
      });
      if (!res.ok) return "unknown";
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      return typeof content === "string" ? parseVerdict(content) : "unknown";
    } catch {
      return "unknown";
    }
  };
}

/** Judge from env, or undefined when LLM_MINI_URL is unset (caller falls back to backstops-only). */
export function llmMiniJudgeFromEnv(env: NodeJS.ProcessEnv = process.env): Judge | undefined {
  const url = env["LLM_MINI_URL"];
  if (!url) return undefined;
  return makeLlmMiniJudge(url, env["LLM_MINI_MODEL"] ?? "llm-mini");
}
