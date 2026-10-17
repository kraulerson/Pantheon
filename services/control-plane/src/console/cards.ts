/**
 * Maestro Console card builder (plan Task 6): a session's state (spec §6.2), its needs-you signals
 * (§6.3), the masked card faces built from its turns, its project key and the live/ended split of
 * session files.
 *
 * Everything read here came from the machine (`trusted:false`): free text that reaches a card or a state
 * word is masked and clipped; a malformed sentinel is counted in `problems`, never thrown. A card face
 * carries only the masked TL;DR and a masked short title — never the reply or prompt text.
 */

import { posix } from "node:path";
import { TMUX_SESSION_NAME_RE } from "../devmachine/tmux.js";
import { maskSecrets } from "./masking.js";
import { menuOnScreen } from "./menu-fixtures.js";
import { PANE_ID_RE } from "./probe-command.js";
import type { ProbePane, ProbeSessionFile } from "./probe.js";
import { extractTldr, type Turn } from "./transcript.js";

export type SessionState = "needs_you" | "working" | "idle" | "shell" | "unknown";

export interface StateView {
  readonly state: SessionState;
  readonly glyph: "!" | "⟳" | "✓" | "$" | "?";
  readonly word: string;
  readonly reason?: string;
}

const MAX_DETAIL_CHARS = 200;
const MAX_STATUS_CHARS = 40;
const MAX_TLDR_CHARS = 1024;
const MAX_HUMAN_TITLE_CHARS = 80;
const MAX_TRIGGER_TITLE_CHARS = 60;

/** Runs of whitespace and C0/C1 control characters (newlines included) become one space; trimmed. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const oneLine = (s: string): string => s.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim();

/**
 * Mask the WHOLE text, flatten, mask again, then clip. Clipping first could cut a token short of its
 * pattern and leak its prefix; the second mask catches context patterns that only match once a run of
 * whitespace is collapsed (`Bearer␠␠<token>`). The masker is idempotent, so re-masking is safe.
 */
const maskClip = (s: string, max: number, mask: (t: string) => string = maskSecrets): string => mask(oneLine(mask(s))).slice(0, max);

/**
 * "waiting" → NEEDS YOU (reason = waitingFor); "busy" → WORKING; "idle" → IDLE; "shell" → IN SHELL;
 * "" → UNKNOWN STATUS (missing); anything else → UNKNOWN STATUS <value>. Never idle for an unknown value.
 * `needsYou` (a menu on screen or a sentinel) forces NEEDS YOU whatever the status says.
 */
export function stateFor(status: string, waitingFor: string | undefined, needsYou: boolean): StateView {
  if (status === "waiting" || needsYou) {
    const reason = waitingFor !== undefined && waitingFor !== "" ? maskClip(waitingFor, MAX_DETAIL_CHARS) : undefined;
    return { state: "needs_you", glyph: "!", word: "NEEDS YOU", ...(reason !== undefined ? { reason } : {}) };
  }
  switch (status) {
    case "busy":
      return { state: "working", glyph: "⟳", word: "WORKING" };
    case "idle":
      return { state: "idle", glyph: "✓", word: "IDLE" };
    case "shell":
      return { state: "shell", glyph: "$", word: "IN SHELL" };
    case "":
      return { state: "unknown", glyph: "?", word: "UNKNOWN STATUS (missing)" };
    default:
      return { state: "unknown", glyph: "?", word: `UNKNOWN STATUS ${maskClip(status, MAX_STATUS_CHARS)}` };
  }
}

export type NeedsKind = "waiting" | "menu_on_screen" | "sentinel";

export interface NeedsYou {
  readonly kind: NeedsKind;
  /** Masked, ≤ 200 chars. */
  readonly detail: string;
  /** Set on a schema-2 sentinel that offers an option with `approves: "commit"` (drives `kindFor`). */
  readonly approvesCommit?: true;
}

/**
 * The signals plus the sentinel problems counted on the way. Deviation from the brief (controller ruling,
 * Task 6 fix 1): the brief returns `readonly NeedsYou[]`; ruling 4 also needs `problems` returned, so the
 * result is a plain object rather than an array carrying an extra property.
 */
export interface NeedsYouResult {
  readonly signals: readonly NeedsYou[];
  readonly problems: readonly string[];
}

export const SENTINEL_V1_DETAIL = "cannot be answered until the session rewrites it as schema 2";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One sentinel → at most one signal; a bad file is a problem (the raw text is never echoed). */
function parseSentinel(json: string, problems: string[]): NeedsYou | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    problems.push("sentinel: invalid JSON");
    return undefined;
  }
  if (!isRecord(doc) || !Array.isArray(doc["options"]) || doc["options"].length === 0) {
    problems.push("sentinel: unrecognised shape");
    return undefined;
  }
  const options = doc["options"] as unknown[];
  if (doc["schema"] === undefined && options.every((o) => typeof o === "string")) {
    return { kind: "sentinel", detail: SENTINEL_V1_DETAIL };
  }
  if (doc["schema"] === 2 && options.every(isRecord) && typeof doc["question"] === "string") {
    const detail = maskClip(doc["question"], MAX_DETAIL_CHARS);
    const commit = options.some((o) => o["approves"] === "commit");
    return { kind: "sentinel", detail, ...(commit ? { approvesCommit: true as const } : {}) };
  }
  problems.push("sentinel: unrecognised shape");
  return undefined;
}

/**
 * Signals in the order waiting (status), menu_on_screen (detail = fixture name), sentinel. A schema-2
 * sentinel raises a signal whether or not it offers a commit option (`approvesCommit` only when it does);
 * a v1 sentinel raises the not-answerable signal; invalid JSON or any other shape is a problem, no signal.
 */
export function detectNeedsYou(args: {
  readonly status: string;
  readonly waitingFor?: string;
  readonly paneTail: string;
  readonly sentinelJson?: string;
}): NeedsYouResult {
  const signals: NeedsYou[] = [];
  const problems: string[] = [];
  if (args.status === "waiting") {
    const why = args.waitingFor !== undefined && args.waitingFor !== "" ? args.waitingFor : "waiting";
    signals.push({ kind: "waiting", detail: maskClip(why, MAX_DETAIL_CHARS) });
  }
  const menu = menuOnScreen(args.paneTail);
  if (menu !== undefined) signals.push({ kind: "menu_on_screen", detail: maskClip(menu, MAX_DETAIL_CHARS) });
  if (args.sentinelJson !== undefined) {
    const s = parseSentinel(args.sentinelJson, problems);
    if (s) signals.push(s);
  }
  return { signals, problems };
}

export interface CardFace {
  readonly turnUuid: string;
  readonly sessionId: string;
  readonly machine: string;
  readonly projectKey: string;
  readonly createdAt: string;
  readonly kind: "reply" | "commit_approval" | "menu";
  readonly title: string;
  readonly tldrMasked: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly toolCallCount: number;
  readonly thinkingChars: number;
}

/** Commit-approving sentinel → "commit_approval", else a menu on screen → "menu", else "reply". */
export function kindFor(needs: readonly NeedsYou[]): CardFace["kind"] {
  if (needs.some((n) => n.kind === "sentinel" && n.approvesCommit === true)) return "commit_approval";
  if (needs.some((n) => n.kind === "menu_on_screen")) return "menu";
  return "reply";
}

function titleFor(turn: Turn, mask: (t: string) => string): string {
  const clip = (max: number): string => {
    const t = maskClip(turn.promptText, max, mask);
    return t === "" ? "(no prompt text)" : t;
  };
  switch (turn.promptSource) {
    case "human":
      return clip(MAX_HUMAN_TITLE_CHARS);
    case "system":
      return `after background task: ${clip(MAX_TRIGGER_TITLE_CHARS)}`;
    case "meta":
      return `after hook message: ${clip(MAX_TRIGGER_TITLE_CHARS)}`;
    case "tool":
      return "after tool result";
  }
}

/**
 * One face per turn: masked title + masked TL;DR (≤ 1024 chars, clipped after masking) and counts only.
 * `kind` is always "reply" here; the poller applies `kindFor` to the session's latest card.
 * `createdAt` is the turn's `endedAt` — the moment the reply finished (controller ruling, Task 6 fix 1).
 */
export function buildCardFaces(
  turns: readonly Turn[],
  ctx: { readonly machine: string; readonly projectKey: string; readonly sessionId: string },
  mask: (t: string) => string,
): readonly CardFace[] {
  return turns.map((turn) => ({
    turnUuid: turn.turnUuid,
    sessionId: ctx.sessionId,
    machine: ctx.machine,
    projectKey: ctx.projectKey,
    createdAt: turn.endedAt,
    kind: "reply",
    title: titleFor(turn, mask),
    // Mask, extract with NO fallback cut, flatten, mask again (`Bearer␠␠<token>` only matches once
    // collapsed), then clip: the only cut comes after the last mask, so no token is cut between passes.
    tldrMasked: mask(oneLine(extractTldr(mask(turn.replyText), { fallbackChars: Number.POSITIVE_INFINITY }))).slice(0, MAX_TLDR_CHARS),
    byteStart: turn.byteStart,
    byteEnd: turn.byteEnd,
    toolCallCount: turn.toolCallCount,
    thinkingChars: turn.thinkingChars,
  }));
}

/** `<session>:@<window>.%<pane>` as Claude Code writes it into the session file. */
const TMUX_FIELD_RE = /^([^:]+):@\d{1,9}\.(%\d+)$/;

/** The tmux session and pane id named by a session file's `tmux` field, or undefined when absent or invalid. */
export function tmuxTarget(file: ProbeSessionFile): { readonly session: string; readonly paneId: string } | undefined {
  const m = file.tmux === undefined ? null : TMUX_FIELD_RE.exec(file.tmux);
  if (!m) return undefined;
  const session = m[1]!;
  const paneId = m[2]!;
  if (!TMUX_SESSION_NAME_RE.test(session) || !PANE_ID_RE.test(paneId)) return undefined;
  return { session, paneId };
}

/**
 * When a probed pane carries the `tmux` field's pane id (reachable): that pane's session name if valid,
 * else the field's. Otherwise `<cwd basename>@<machine>` (masked, one line; `(unknown)` for an empty or
 * `/` cwd), unreachable. The probe reports no process tree, so there is no panePid
 * fallback, and `ProbePane.currentCommand` (a Claude version string on macOS) is never used as a key.
 */
export function projectKeyFor(
  sessionFile: ProbeSessionFile,
  panes: readonly ProbePane[],
  machine: string,
): { readonly key: string; readonly reachable: boolean } {
  const target = tmuxTarget(sessionFile);
  const pane = target ? panes.find((p) => p.paneId === target.paneId) : undefined;
  if (target && pane) {
    // The probed pane's session name is current truth (after a rename-session); the file's may be stale.
    return { key: TMUX_SESSION_NAME_RE.test(pane.session) ? pane.session : target.session, reachable: true };
  }
  const base = posix.basename(sessionFile.cwd);
  return { key: maskSecrets(oneLine(maskSecrets(`${base === "" ? "(unknown)" : base}@${machine}`))), reachable: false };
}

/**
 * Splits session files into the ones to show (`live`: pid alive) and the ones to mark ENDED (`ended`:
 * pid dead), keeping input order. Two files naming one pane (a stale file beside the live one, Review
 * Focus 2) therefore resolve to the live one; a dead file is ENDED whether or not it shares a pane.
 * Returned as an object because one array cannot carry both halves.
 */
export function pickLiveSession(files: readonly ProbeSessionFile[]): {
  readonly live: readonly ProbeSessionFile[];
  readonly ended: readonly ProbeSessionFile[];
} {
  return { live: files.filter((f) => f.alive), ended: files.filter((f) => !f.alive) };
}
