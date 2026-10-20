/**
 * Maestro Console transcript turn splitter (plan Task 5, spec §6.4). Reads a byte range of a Claude Code
 * session transcript (JSONL) and returns the finished turns in it.
 *
 * Trust boundary: the transcript is machine-supplied (`trusted:false`). Nothing here masks or renders;
 * callers mask before storage. Failure is loud but bounded: a complete line that is not JSON, or a
 * user/assistant line missing its identity fields, sets `cantRead` with a fixed reason; a line over
 * `MAX_LINE_BYTES` is skipped and counted, never parsed; other line types are counted, not failed. An
 * assistant text line with no turn to attach to is counted too. `ignoredLines` and `cantRead` cover only the
 * lines before `consumedBytes`: lines in the held-back region are fed again with the next call and counted
 * there, so the counts of successive calls sum to the counts of a single pass.
 *
 * Turn completion (controller ruling, live-feed): a turn is COMPLETE at the earliest of (i) the next
 * turn-starting user line, or (ii) a `system` line with `subtype:"turn_duration"` that follows at least one
 * assistant text line of the turn; `turnUuid`/`byteEnd` come from the last assistant text line before the
 * terminator. A turn with a prompt but no terminator is OPEN: it is not emitted and `consumedBytes` stops at
 * its first line (`openTurnStart` reports that file offset and `openTurnSource` its kind), so the caller feeds
 * `carry` (the unconsumed bytes) back with the next slice and the completed turn appears exactly once.
 * `opts.closeOpenTurn` closes an open turn that already has an assistant text line at its last one; an open
 * turn with no assistant text yet stays open regardless. CONTRACT: pass it only for a session whose status is
 * IDLE (never "waiting" or "busy") AND whose transcript gained no bytes since the previous poll; otherwise a
 * reply still being written is cut short. Re-splitting exactly `[byteStart, byteEnd)` of a turn (Task 9)
 * requires `closeOpenTurn: true`, since that range ends at the final reply with no terminator after it.
 * An assistant text line after a terminator with no non-human prompt behind it belongs to no turn; it is
 * counted in `ignoredLines`.
 *
 * Replies outside any turn: an assistant text line that appears with no turn open (after a terminator, or at the
 * start of a range) starts a turn of its own, attributed to the nearest preceding non-human `user` line since the
 * terminator: `promptSource` "system" (`promptSource:"system"`, checked first), "meta" (`isMeta`) or "tool" (a
 * `tool_result` line; `promptText` is then ""); any other user line, in practice a human line with no text block
 * such as an image-only prompt, yields "human" with `promptText` "". A human text prompt always yields
 * "human". Such a prompt line that has
 * not yet been answered is held back like an open turn (`consumedBytes` stops at it, `openTurnStart` reports it);
 * a prompt line already used by a closed turn is never reused, so a late assistant line with only that behind it
 * belongs to no turn.
 *
 * Replies: `replyText` is the text blocks of the FINAL assistant text line only (earlier narration lines are
 * not included); `toolCallCount` and `thinkingChars` run across every assistant line of the turn up to and
 * including that line; `promptText` joins the prompt's text blocks, leaving out blocks that begin with
 * `<system-reminder>` (Claude Code appends them to the first prompt line). A `tool_result` line arriving while a
 * non-human candidate is waiting for its reply joins that candidate (its tool calls stay counted, `byteStart`
 * stays at the candidate) instead of replacing it.
 *
 * Byte offsets: `baseOffset` is the file offset of the first byte handed over (of `carry`'s first byte when a
 * carry is given, since the carry directly precedes `bytes` in the file). A turn's `byteStart`/`byteEnd`
 * are file offsets covering exactly its lines, from the start of the prompt line to just after the newline
 * of the final assistant text line. `baseOffset + consumedBytes` is where the returned `carry` begins.
 *
 * Oversize tail: an unterminated tail longer than `MAX_LINE_BYTES` is dropped and counted in `ignoredLines`
 * like an oversize complete line, and the splitter resyncs at the next newline. To stay stateless it keeps
 * the last `MAX_LINE_BYTES + 1` bytes as `carry` (contiguous, so offsets hold); a newline-free carry that
 * long is the marker, and the next call skips through its first newline without counting it again. An open turn that
 * precedes such a tail is resolved first (closed if it has assistant text, else dropped), since its lines
 * cannot stay contiguous with the retained bytes; a prompt that gets no reply this way (including a non-human
 * prompt still awaiting its reply) is lost. After an oversize tail `consumedBytes` may point into the middle of a
 * line, so a consumer that restarts without the returned `carry` resumes from the last turn's `byteEnd`.
 */

export interface TranscriptLine {
  readonly uuid: string;
  readonly type: "user" | "assistant";
  readonly timestamp: string;
  readonly raw: Record<string, unknown>;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface Turn {
  readonly turnUuid: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly promptText: string;
  /** What triggered the turn: a human prompt (spec §6.4), or the nearest preceding user line of another kind. */
  readonly promptSource: "human" | "system" | "meta" | "tool";
  readonly replyText: string;
  readonly toolCallCount: number;
  readonly thinkingChars: number;
}

export interface SplitResult {
  readonly turns: readonly Turn[];
  readonly carry: Buffer;
  readonly ignoredLines: number;
  readonly cantRead: boolean;
  readonly cantReadWhy?: string;
  readonly consumedBytes: number;
  /**
   * File offset of the first line of the still-open turn (a prompt with no terminator yet), or of a non-human
   * prompt line still awaiting its reply, if any.
   */
  readonly openTurnStart?: number;
  /** The kind of that held-back prompt, so a poller can tell an in-progress human turn from a line that may never be answered. */
  readonly openTurnSource?: Turn["promptSource"];
}

export interface SplitOptions {
  /**
   * Close an open turn that already has an assistant text line at that line. Pass it only for a session whose
   * status is IDLE (never "waiting" or "busy") AND whose transcript gained no bytes since the previous poll.
   */
  readonly closeOpenTurn?: boolean;
}

export const MAX_LINE_BYTES = 2 * 1024 * 1024;

const WHY_NOT_JSON = "line is not JSON";
const WHY_LACKS = "user/assistant line lacks uuid, timestamp or message";
const TLDR_FALLBACK_CHARS = 280;
const NEWLINE = 0x0a;

type Block = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The content as a block list; a bare string is one text block. */
function blocksOf(line: TranscriptLine): readonly Block[] {
  const message = line.raw["message"];
  const content = isRecord(message) ? message["content"] : undefined;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

const SYSTEM_REMINDER_PREFIX = "<system-reminder>";

function textBlocks(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b["type"] === "text" && typeof b["text"] === "string") out.push(b["text"]);
  }
  return out;
}

/** Spec §6.4: a real prompt is a non-meta, non-system-sourced user line whose content is text. */
function startsTurn(line: TranscriptLine): boolean {
  if (line.type !== "user") return false;
  if (line.raw["isMeta"] === true) return false;
  if (line.raw["promptSource"] === "system") return false;
  const blocks = blocksOf(line);
  if (blocks.some((b) => b["type"] === "tool_result")) return false;
  return textBlocks(blocks).length > 0;
}

/**
 * The kind of a user line that did not start a turn, when it triggers a reply; "system" outranks "meta" (a
 * line can be both). Every line that reaches this already failed `startsTurn`, so what is left over is a human
 * line with no text block (an image-only prompt).
 */
function replyTriggerSource(line: TranscriptLine): Turn["promptSource"] {
  if (line.raw["promptSource"] === "system") return "system";
  if (line.raw["isMeta"] === true) return "meta";
  if (blocksOf(line).some((b) => b["type"] === "tool_result")) return "tool";
  return "human";
}

interface OpenTurn {
  readonly prompt: TranscriptLine;
  readonly promptRel: number; // offset of the prompt line within the data being split
  readonly source: Turn["promptSource"];
  // Running counts over assistant lines so far, and a snapshot at the last assistant text line.
  toolCalls: number;
  thinking: number;
  last?: { line: TranscriptLine; toolCalls: number; thinking: number };
}

function closeTurn(open: OpenTurn): Turn | undefined {
  const last = open.last;
  if (last === undefined) return undefined;
  return {
    turnUuid: last.line.uuid,
    startedAt: open.prompt.timestamp,
    endedAt: last.line.timestamp,
    byteStart: open.prompt.byteStart,
    byteEnd: last.line.byteEnd,
    promptText: textBlocks(blocksOf(open.prompt))
      .filter((t) => !t.trimStart().startsWith(SYSTEM_REMINDER_PREFIX))
      .join("\n\n"),
    promptSource: open.source,
    replyText: textBlocks(blocksOf(last.line)).join("\n\n"),
    toolCallCount: last.toolCalls,
    thinkingChars: last.thinking,
  };
}

export function splitTurns(bytes: Buffer, baseOffset: number, carry?: Buffer, opts?: SplitOptions): SplitResult {
  const data = carry !== undefined && carry.length > 0 ? Buffer.concat([carry, bytes]) : bytes;
  const turns: Turn[] = [];
  // Counted lines, kept with their offset so only those before `consumedBytes` are reported.
  const notes: { readonly at: number; readonly why?: string }[] = [];
  let open: OpenTurn | undefined;
  // A non-human user line seen with no turn open, awaiting the assistant text that makes it a turn.
  let idle: OpenTurn | undefined;

  const closeOpen = (): void => {
    if (open === undefined) return;
    const done = closeTurn(open);
    if (done !== undefined) turns.push(done);
    open = undefined;
  };

  let pos = 0;
  if (carry !== undefined && carry.length > MAX_LINE_BYTES && carry.indexOf(NEWLINE) === -1) {
    // The carry is the retained head of an oversize line already counted: skip through its newline.
    const nl = data.indexOf(NEWLINE);
    if (nl === -1) return oversizeTail(data, [], [], 0);
    pos = nl + 1;
  }

  for (;;) {
    const nl = data.indexOf(NEWLINE, pos);
    if (nl === -1) break; // trailing unterminated line: carried, never parsed
    const start = pos;
    const end = nl + 1;
    pos = end;

    if (nl - start > MAX_LINE_BYTES) {
      notes.push({ at: start });
      continue;
    }
    const text = data.toString("utf8", start, nl);
    if (text.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      notes.push({ at: start, why: WHY_NOT_JSON });
      continue;
    }
    if (!isRecord(parsed)) {
      notes.push({ at: start, why: WHY_NOT_JSON });
      continue;
    }
    const type = parsed["type"];
    if (type !== "user" && type !== "assistant") {
      notes.push({ at: start });
      // A turn_duration after at least one assistant text line completes the open turn.
      if (type === "system" && parsed["subtype"] === "turn_duration" && open?.last !== undefined) closeOpen();
      continue;
    }
    const uuid = parsed["uuid"];
    const timestamp = parsed["timestamp"];
    if (typeof uuid !== "string" || typeof timestamp !== "string" || !isRecord(parsed["message"])) {
      notes.push({ at: start, why: WHY_LACKS });
      continue;
    }
    const line: TranscriptLine = {
      uuid,
      type,
      timestamp,
      raw: parsed,
      byteStart: baseOffset + start,
      byteEnd: baseOffset + end,
    };

    if (type === "user") {
      if (startsTurn(line)) {
        closeOpen();
        idle = undefined;
        open = { prompt: line, promptRel: start, source: "human", toolCalls: 0, thinking: 0 };
      } else if (open === undefined) {
        const source = replyTriggerSource(line);
        // A tool_result answering the candidate's own tool calls joins it; any other user line replaces it.
        if (!(source === "tool" && idle !== undefined)) {
          idle = { prompt: line, promptRel: start, source, toolCalls: 0, thinking: 0 };
        }
      }
      continue;
    }

    const blocks = blocksOf(line);
    const turn = open ?? idle;
    if (turn === undefined) {
      // No prompt to attach to: a reply that would be invisible is counted, never silently dropped.
      if (textBlocks(blocks).length > 0) notes.push({ at: start });
      continue;
    }
    for (const b of blocks) {
      if (b["type"] === "tool_use") turn.toolCalls += 1;
      else if (b["type"] === "thinking" && typeof b["thinking"] === "string") turn.thinking += b["thinking"].length;
    }
    if (textBlocks(blocks).length > 0) {
      turn.last = { line, toolCalls: turn.toolCalls, thinking: turn.thinking };
      if (open === undefined) {
        open = turn;
        idle = undefined;
      }
    }
  }

  const tailLen = data.length - pos;
  if (tailLen > MAX_LINE_BYTES) {
    closeOpen(); // see "Oversize tail" above
    return oversizeTail(data, turns, notes, 1);
  }

  let consumed = pos;
  if (open !== undefined && opts?.closeOpenTurn === true && open.last !== undefined) closeOpen();
  const pending = open ?? idle;
  if (pending !== undefined) consumed = pending.promptRel;
  return build(data, baseOffset, turns, notes, consumed, 0, pending);
}

function build(
  data: Buffer,
  baseOffset: number,
  turns: readonly Turn[],
  notes: readonly { readonly at: number; readonly why?: string }[],
  consumed: number,
  extraIgnored: number,
  pending: OpenTurn | undefined,
): SplitResult {
  const counted = notes.filter((n) => n.at < consumed);
  const cantReadWhy = counted.find((n) => n.why !== undefined)?.why;
  return {
    turns,
    carry: Buffer.from(data.subarray(consumed)),
    ignoredLines: counted.filter((n) => n.why === undefined).length + extraIgnored,
    cantRead: cantReadWhy !== undefined,
    ...(cantReadWhy !== undefined ? { cantReadWhy } : {}),
    consumedBytes: consumed,
    ...(pending !== undefined
      ? { openTurnStart: baseOffset + pending.promptRel, openTurnSource: pending.source }
      : {}),
  };
}

/** Keep only the last MAX_LINE_BYTES + 1 bytes (contiguous with whatever follows) as the marker carry. */
function oversizeTail(
  data: Buffer,
  turns: readonly Turn[],
  notes: readonly { readonly at: number; readonly why?: string }[],
  extraIgnored: number,
): SplitResult {
  return build(data, 0, turns, notes, data.length - (MAX_LINE_BYTES + 1), extraIgnored, undefined);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// `**TL;DR:**` and `**TL;DR**` (and `**TL;DR**:`) all occur in real replies. The whitespace after the colon is
// reachable only through the colon (final review I1): `\s*:?\s*` let two runs split one whitespace stretch every
// way, quadratic on `**TL;DR` + whitespace with no closing `**`; this form matches the same language in linear time.
// F2 widened it: one parenthetical (`**TL;DR (plain English):**`) and an unbolded or heading marker at line start
// (`TL;DR:`, `## TL;DR`, `### TL;DR —`). The parenthetical is capped at 40 chars and the line form's runs at 8, so
// no unbounded whitespace run sits next to another optional one.
const TLDR_MARKER_BOLD = /\*\*\s*TL;DR(?:\s*\([^)\n]{0,40}\))?\s*(?::\s*)?\*\*\s*:?/gi;
const TLDR_MARKER_LINE = /^[ \t]{0,8}(?:#{1,6}[ \t]{1,8})?TL;DR\b[ \t]{0,8}(?:[:\u2014-][ \t]{0,8})?/gim;

/**
 * The text after the last TL;DR marker to the end of its paragraph; else the first `fallbackChars`
 * (default 280) chars of the collapsed text. `Number.POSITIVE_INFINITY` returns the whole collapsed text
 * uncut, so a caller that masks afterwards can make its own cut the last step (Task 6 fix round 3).
 */
export function extractTldr(replyText: string, opts?: { readonly fallbackChars?: number }): string {
  let after: number | undefined;
  for (const re of [TLDR_MARKER_BOLD, TLDR_MARKER_LINE]) {
    for (const m of replyText.matchAll(re)) {
      const end = m.index + m[0].length;
      if (after === undefined || end > after) after = end;
    }
  }
  if (after !== undefined) {
    // A heading marker leaves the paragraph after a blank line; skip leading whitespace so it is not read as empty.
    const rest = replyText.slice(after).replace(/^\s+/, "");
    const blank = rest.search(/\r?\n[ \t]*\r?\n/);
    const body = collapse(blank === -1 ? rest : rest.slice(0, blank));
    if (body !== "") return body;
  }
  const fallbackChars = opts?.fallbackChars ?? TLDR_FALLBACK_CHARS;
  const all = collapse(replyText);
  return fallbackChars === Number.POSITIVE_INFINITY ? all : all.slice(0, fallbackChars);
}
