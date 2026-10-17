/**
 * Maestro Console on-demand expand (plan Task 9, spec R1). When the operator expands a card, this reads
 * exactly that turn's bytes `[byteStart, byteEnd)` from the dev machine over the read-only expand command,
 * re-splits them, and returns the turn's full text, its reasoning ("why") and its tool calls ("what it
 * did"), every string masked. Nothing is persisted: the store keeps masked faces only, and this module
 * imports no store, database or filesystem — the view lives in the caller's response and nowhere else.
 *
 * Trust boundary: the bytes are machine-supplied (`trusted:false`). Every string in the view goes
 * through `mask` BEFORE it is clipped (a cut first could leave a token short of its pattern and leak its
 * prefix — the Task 6 lesson); one-line summaries are masked, flattened and masked again, as `cards.ts`
 * does. Clips count UTF-16 code units, as `cards.ts` does.
 *
 * Every outcome is a labeled state (CC1) and this never throws. Messages are first-party and name the
 * machine's logicalName only: never user@host, never an exception's text, never the machine's stderr.
 *
 * Raw lines: `splitTurns` does not expose its `TranscriptLine`s, so the turn's lines are re-read here with
 * the same per-line rules (one JSON object per newline-terminated line; `user`/`assistant` lines with a
 * `message` record; a string `content` is one text block) and only those inside the re-split turn's range.
 */

import { SshConnectionError, type RemoteCommand } from "../devmachine/connection.js";
import { type SshTarget } from "../devmachine/provisioning.js";
import { type RemoteCommandResult, type RemoteExec } from "../devmachine/tmux.js";
import { oneLine } from "./cards.js";
import { parseProbeOutput } from "./probe.js";
import { ProbeError, buildExpandCommand } from "./probe-command.js";
import type { ConsoleCardRow } from "./store.js";
import { MAX_LINE_BYTES, splitTurns, type Turn } from "./transcript.js";

export interface ExpandView {
  readonly fullText: string;
  readonly why: string;
  readonly whatItDid: readonly { readonly tool: string; readonly inputSummary: string; readonly outputSummary: string }[];
  readonly agentRuns: number;
}

export type ExpandResult =
  | { readonly state: "ok"; readonly view: ExpandView }
  | { readonly state: "unreachable"; readonly message: string }
  | { readonly state: "changed"; readonly message: string }
  | { readonly state: "failed"; readonly message: string };

const MAX_TEXT_CHARS = 16 * 1024;
const MAX_SUMMARY_CHARS = 2 * 1024;
const MAX_AGENT_SUMMARY_CHARS = 120;
const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const NEWLINE = 0x0a;

type Block = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Line {
  readonly type: "user" | "assistant";
  readonly blocks: readonly Block[];
}

/** The `user`/`assistant` lines of `bytes` that lie inside `[from, to)` (offsets relative to `bytes`). */
function linesIn(bytes: Buffer, from: number, to: number): Line[] {
  const out: Line[] = [];
  let pos = 0;
  for (;;) {
    const nl = bytes.indexOf(NEWLINE, pos);
    if (nl === -1) break;
    const start = pos;
    pos = nl + 1;
    if (start < from || pos > to) continue;
    if (nl - start > MAX_LINE_BYTES) continue; // as `splitTurns`: an oversize line is never parsed
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8", start, nl));
    } catch {
      continue; // `splitTurns` already reported any non-JSON line inside the turn as cantRead
    }
    if (!isRecord(parsed)) continue;
    const type = parsed["type"];
    const message = parsed["message"];
    if ((type !== "user" && type !== "assistant") || !isRecord(message)) continue;
    const content = message["content"];
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.filter(isRecord) : [];
    out.push({ type, blocks });
  }
  return out;
}

/** A `tool_result`'s content as text: a string as is, a block list's text blocks joined by newlines. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .flatMap((b) => (b["type"] === "text" && typeof b["text"] === "string" ? [b["text"]] : []))
    .join("\n");
}

function inputText(name: string, input: unknown): { readonly text: string; readonly max: number } {
  const field = (key: string): string | undefined => {
    const v = isRecord(input) ? input[key] : undefined;
    return typeof v === "string" ? v : undefined;
  };
  if (name === "Bash") {
    const command = field("command");
    if (command !== undefined) return { text: command, max: MAX_SUMMARY_CHARS };
  } else if (name === "Edit" || name === "Write") {
    const path = field("file_path");
    if (path !== undefined) return { text: path, max: MAX_SUMMARY_CHARS };
  } else if (AGENT_TOOLS.has(name)) {
    const what = field("description") ?? field("prompt");
    if (what !== undefined) return { text: what, max: MAX_AGENT_SUMMARY_CHARS };
  }
  return { text: JSON.stringify(input ?? {}) ?? "", max: MAX_SUMMARY_CHARS };
}

function buildView(lines: readonly Line[], mask: (t: string) => string): ExpandView {
  // Mask the whole text, then clip; one-line summaries are masked again once flattened.
  const maskClip = (s: string, max: number): string => mask(s).slice(0, max);
  const maskLine = (s: string, max: number): string => mask(oneLine(mask(s))).slice(0, max);

  const texts: string[] = [];
  const thoughts: string[] = [];
  const calls: { readonly id: string | undefined; readonly name: string; readonly input: unknown }[] = [];
  const results = new Map<string, string>();
  for (const line of lines) {
    for (const b of line.blocks) {
      const kind = b["type"];
      if (line.type === "assistant") {
        if (kind === "text" && typeof b["text"] === "string") texts.push(b["text"]);
        else if (kind === "thinking" && typeof b["thinking"] === "string" && b["thinking"].trim() !== "") thoughts.push(b["thinking"]);
        else if (kind === "tool_use") {
          const id = b["id"];
          const name = b["name"];
          calls.push({ id: typeof id === "string" ? id : undefined, name: typeof name === "string" ? name : "", input: b["input"] });
        }
      } else if (kind === "tool_result" && typeof b["tool_use_id"] === "string" && !results.has(b["tool_use_id"])) {
        results.set(b["tool_use_id"], resultText(b["content"]));
      }
    }
  }
  return {
    fullText: maskClip(texts.join("\n\n"), MAX_TEXT_CHARS),
    why: maskClip(thoughts.join("\n\n"), MAX_TEXT_CHARS),
    whatItDid: calls.map((c) => {
      const input = inputText(c.name, c.input);
      const output = c.id !== undefined ? results.get(c.id) : undefined;
      return {
        tool: maskLine(c.name, MAX_SUMMARY_CHARS),
        inputSummary: maskLine(input.text, input.max),
        outputSummary: output !== undefined ? maskClip(output, MAX_SUMMARY_CHARS) : "",
      };
    }),
    agentRuns: calls.filter((c) => AGENT_TOOLS.has(c.name)).length,
  };
}

function classify(card: ConsoleCardRow, target: SshTarget, r: RemoteCommandResult, mask: (t: string) => string): ExpandResult {
  const name = target.logicalName;
  if (r.code !== 0) return { state: "failed", message: `expand on ${name} failed (exit ${r.code})` };
  const report = parseProbeOutput(r.stdout);
  if (!report.ended) return { state: "failed", message: `expand output from ${name} ended early — no end marker (cut at the output cap or interrupted)` };
  const slice = report.slices[0];
  if (report.slices.length !== 1 || slice === undefined || slice.sessionId !== card.sessionId) {
    return { state: "failed", message: `expand output from ${name} did not carry exactly one transcript slice for this session` };
  }
  if (!slice.found) return { state: "changed", message: `the transcript of this card is no longer on ${name}` };
  // `truncated` is set iff the file is now shorter than `byteEnd`: the transcript shrank under the card.
  if (slice.truncated) return { state: "changed", message: `the transcript on ${name} is now shorter than this card's range — it changed under this card` };
  const want = card.byteEnd - card.byteStart;
  if (slice.offset !== card.byteStart || slice.bytes.length !== want) {
    return { state: "failed", message: `expand on ${name} returned ${slice.bytes.length} of the card's ${want} bytes` };
  }

  const split = splitTurns(slice.bytes, card.byteStart, undefined, { closeOpenTurn: true });
  if (split.cantRead) return { state: "failed", message: `the turn on ${name} could not be read (${split.cantReadWhy ?? "unreadable line"})` };
  const turn: Turn | undefined = split.turns.length === 1 ? split.turns[0] : undefined;
  // The uuid alone is not enough: a range that lost its prompt line or gained a trailing line still
  // yields the same final reply, so the re-split turn must span exactly the card's bytes. Nor is the span:
  // a range starting at a tool_result line re-splits as a "tool"-triggered turn with the same span and
  // uuid but fewer tool calls, so the row's own counts must match too.
  if (
    turn === undefined ||
    turn.turnUuid !== card.turnUuid ||
    turn.byteStart !== card.byteStart ||
    turn.byteEnd !== card.byteEnd ||
    turn.toolCallCount !== card.toolCallCount ||
    turn.thinkingChars !== card.thinkingChars
  ) {
    return { state: "changed", message: `the transcript on ${name} changed under this card — its turn is no longer at the recorded place` };
  }
  const lines = linesIn(slice.bytes, turn.byteStart - card.byteStart, turn.byteEnd - card.byteStart);
  return { state: "ok", view: buildView(lines, mask) };
}

/**
 * Reads bytes `[byteStart, byteEnd)` of the card's transcript via `buildExpandCommand`, re-splits them
 * with `splitTurns` (`closeOpenTurn: true`: the range ends at the final reply with no terminator) and
 * requires exactly one turn whose uuid AND byte span are the card's, else "changed". `exec` arrives already bound to the
 * right output cap and timeout. Never throws; persists nothing.
 */
export async function expandCard(
  card: ConsoleCardRow,
  target: SshTarget,
  handle: string,
  exec: RemoteExec,
  mask: (t: string) => string,
): Promise<ExpandResult> {
  let command: RemoteCommand;
  try {
    command = buildExpandCommand(card.sessionId, card.byteStart, card.byteEnd);
  } catch (err) {
    const why = err instanceof ProbeError ? err.message : "invalid request";
    return { state: "failed", message: `expand request for ${target.logicalName} refused — ${why}` };
  }
  let result: RemoteCommandResult;
  try {
    result = await exec(target, handle, command);
  } catch (err) {
    const ssh = err instanceof SshConnectionError;
    const why = ssh && /timed out/.test(err.message) ? "timed out waiting for the machine" : ssh ? "SSH connection failed" : "could not run the expand over SSH";
    return { state: "unreachable", message: `${target.logicalName} unreachable — ${why}` };
  }
  try {
    return classify(card, target, result, mask);
  } catch {
    // Defensive: a masker or parser bug must still yield a labeled state, never raw exception text.
    return { state: "failed", message: `the turn on ${target.logicalName} could not be read` };
  }
}
