/**
 * Maestro Console probe report (plan Task 3): parses the sentinel-framed records the probe script in
 * `probe-command.ts` emits and runs one probe as a labeled result.
 *
 * Trust boundary: everything the machine sends back is `trusted:false`. Only `PANTHEON_PROBE:` records
 * are read; foreign stdout lines (shell-profile banners, direnv) and malformed records are counted, not
 * fatal; every id is re-validated against the same allow-lists the builder used; free-text fields are
 * clipped (pane text at 512 chars; session fields and the stderr line at 2048, so the poller can mask a whole
 * value before it makes its own, shorter cut — final review M1); a missing `end` marks the report as cut
 * short. `runProbe` never throws: each outcome is a labeled state (CC1) whose first-party `message` names the
 * machine's logicalName only — never user@host, never raw exception text — while the machine's own stderr
 * travels in a SEPARATE `remoteDetail` field the page labels as machine-supplied (the `tmux.ts` audit rules).
 *
 * Base64 payloads are the LAST field of every record. A `base64` that wraps at 76 columns would split
 * one record over several lines, so a line made only of base64 characters that directly follows a
 * record is re-joined to it; any other non-record line closes the record and is counted as foreign.
 */

import { SshConnectionError, type RemoteCommand } from "../devmachine/connection.js";
import { type SshTarget } from "../devmachine/provisioning.js";
import { type RemoteCommandResult, type RemoteExec } from "../devmachine/tmux.js";
import { PANE_ID_RE, PROBE_SENTINEL, ProbeError, SESSION_ID_RE, buildProbeCommand, type ProbePlan } from "./probe-command.js";

export interface ProbePane {
  /** tmux session name (free text from the machine, clipped). */
  readonly session: string;
  readonly windowId: string;
  readonly paneId: string;
  readonly panePid: number;
  readonly currentCommand: string;
}

/** The allow-listed fields of one `~/.claude/sessions/<basename>.json`, plus whether its pid is alive. */
export interface ProbeSessionFile {
  readonly pid: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly name?: string;
  /** Empty when the file carries no `status` — shown as UNKNOWN STATUS downstream, never as idle. */
  readonly status: string;
  readonly waitingFor?: string;
  readonly tmux?: string;
  readonly procStart?: string;
  readonly version?: string;
  readonly kind?: string;
  /** `kill -0 <pid>` succeeded on the machine (Review Focus 2: a stale file beside a live one). */
  readonly alive: boolean;
}

export interface ProbeSliceResult {
  readonly sessionId: string;
  /** The offset the bytes start at — 0 when the machine found the file shorter than the asked offset. */
  readonly offset: number;
  /** The transcript's size on the machine at probe time. */
  readonly size: number;
  readonly bytes: Buffer;
  /** More bytes remained beyond the per-slice cap (probe) / the file is shorter than the range (expand). */
  readonly truncated: boolean;
  readonly found: boolean;
}

export interface ProbeReport {
  readonly panes: readonly ProbePane[];
  readonly sessions: readonly ProbeSessionFile[];
  readonly slices: readonly ProbeSliceResult[];
  /** pane id → decoded `capture-pane` tail. */
  readonly tails: ReadonlyMap<string, string>;
  /** sessionId → decoded `<cwd>/.claude/pending-approval.json`. */
  readonly sentinels: ReadonlyMap<string, string>;
  /** Foreign stdout lines, malformed records and dropped session files. */
  readonly ignoredLines: number;
  /**
   * Session records that arrived whole but whose fields lack a valid `pid` (a bare number: the machine reads
   * liveness from that form only) or `sessionId` (a lowercase UUID); also counted in `ignoredLines`. Non-zero means
   * the session-file format is not the one this parser knows (a Claude Code update renamed a key or quoted the
   * pid), so `sessions` cannot be trusted to list every session, nor its dead ones (final review I3).
   */
  readonly sessionsUnparsed: number;
  /** False when the `end` marker is missing: the output was cut (capture cap, interruption). */
  readonly ended: boolean;
}

/** Every outcome is labeled (CC1) — the page renders `state` + `message` as text, never a colour. */
export type ProbeResult =
  | { readonly state: "ok"; readonly report: ProbeReport }
  | { readonly state: "unreachable"; readonly message: string }
  | {
      readonly state: "failed";
      /** First-party text only. */
      readonly message: string;
      /**
       * The machine's first stderr line, sanitized and capped at 2048 chars — `trusted:false`, NOT masked: the
       * poller masks it, then clips it to 140 for the page (final review M1), and the page labels it.
       */
      readonly remoteDetail?: string;
    }
  | { readonly state: "cant_read"; readonly message: string };

/** Record shapes. Ids are bounded digit runs; base64 fields are validated to the alphabet before decoding. */
const PANE_RE = /^([A-Za-z0-9+/=]*):(@\d{1,9}):(%\d{1,6}):(\d{1,9}):([A-Za-z0-9+/=]*)$/;
const SESSION_RE = /^([A-Za-z0-9._-]{1,128}):([^:]*):([A-Za-z0-9+/=]*)$/;
const SLICE_RE = /^([0-9a-f-]{36}):(\d{1,12}):(\d{1,12}):([01]):([01]):([A-Za-z0-9+/=]*)$/;
const TAIL_RE = /^(%\d{1,6}):([A-Za-z0-9+/=]*)$/;
const SENTINEL_RE = /^([0-9a-f-]{36}):([A-Za-z0-9+/=]*)$/;
const B64_CONTINUATION_RE = /^[A-Za-z0-9+/=]+$/;
/** One `grep -o` match as the machine emitted it: the allow-listed key and a quoted string or a number. */
const FIELD_LINE_RE = /^"(pid|sessionId|cwd|name|status|waitingFor|tmux|procStart|version|kind)" *: *("[^"]*"|[0-9.][0-9.]*)$/;
const PID_RE = /^\d{1,9}$/;

const MAX_TEXT_CHARS = 512;
/**
 * Session-file fields and the stderr line (final review M1): long enough that the poller masks the whole value
 * and only then makes its own cut — a cut here first could leave a token short of its pattern, and its prefix
 * would be stored and shown unmasked.
 */
const MAX_FIELD_CHARS = 2048;
/**
 * Keep equal to `MAX_OFFSET` in probe-command.ts (not exported there): the builder refuses any offset above it,
 * and its test and the parse test pin both sides. A slice whose offset, size or end lies beyond it is dropped
 * (final review M5): the poller's next offset is `offset + consumed bytes`, and one offset the builder refuses
 * would wedge every later probe of the machine ("probe plan refused", nothing dialled).
 */
const MAX_OFFSET = 1_000_000_000_000;

const decode = (b64: string): Buffer => Buffer.from(b64, "base64");
const clip = (s: string, max = MAX_TEXT_CHARS): string => (s.length > max ? s.slice(0, max) : s);
const text = (b64: string): string => clip(decode(b64).toString("utf8"));

function parsePane(rest: string): ProbePane | undefined {
  const m = PANE_RE.exec(rest);
  if (!m) return undefined;
  const [, sessionB64 = "", windowId = "", paneId = "", pid = "", commandB64 = ""] = m;
  // `tmux display-message -p` appends a newline; the script strips it, and so does this (defense in depth).
  return { session: text(sessionB64), windowId, paneId, panePid: Number(pid), currentCommand: text(commandB64).replace(/\r?\n$/, "") };
}

/**
 * The remote `grep -o` cuts a string value at its first `"`, so a value whose last character was an
 * escaping backslash is not valid JSON; its raw inner text is kept (display data, `trusted:false`).
 */
function unquote(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "string") return v;
  } catch {
    /* fall through to the raw inner text */
  }
  return raw.slice(1, -1);
}

interface Fields {
  readonly values: ReadonlyMap<string, string>;
  /** Keys whose (first) value was a JSON string rather than a bare number. */
  readonly quoted: ReadonlySet<string>;
}

/** First occurrence of each allow-listed key wins (a nested object could repeat a key name later). */
function parseFields(fieldsText: string): Fields {
  const values = new Map<string, string>();
  const quoted = new Set<string>();
  for (const line of fieldsText.split("\n")) {
    const m = FIELD_LINE_RE.exec(line);
    if (!m) continue;
    const [, key = "", raw = ""] = m;
    if (values.has(key)) continue;
    const isString = raw.startsWith('"');
    if (isString) quoted.add(key);
    values.set(key, clip(isString ? unquote(raw) : raw, MAX_FIELD_CHARS));
  }
  return { values, quoted };
}

/**
 * `undefined` when the record's shape is wrong; "unparsed" when a whole record's fields lack a valid pid or
 * sessionId. A pid written as a JSON string counts as invalid even when its text is digits (controller ruling): the
 * machine's liveness check reads a bare number only, so such a file would come back as a dead session and be ended.
 */
function parseSessionFile(rest: string): ProbeSessionFile | "unparsed" | undefined {
  const m = SESSION_RE.exec(rest);
  if (!m) return undefined;
  const [, , aliveFlag = "", fieldsB64 = ""] = m;
  const { values: fields, quoted } = parseFields(decode(fieldsB64).toString("utf8"));
  const pid = fields.get("pid");
  const sessionId = fields.get("sessionId");
  const pidValid = pid !== undefined && !quoted.has("pid") && PID_RE.test(pid);
  if (!pidValid || sessionId === undefined || !SESSION_ID_RE.test(sessionId)) return "unparsed";
  const name = fields.get("name");
  const waitingFor = fields.get("waitingFor");
  const tmux = fields.get("tmux");
  const procStart = fields.get("procStart");
  const version = fields.get("version");
  const kind = fields.get("kind");
  return {
    pid: Number(pid),
    sessionId,
    cwd: fields.get("cwd") ?? "",
    status: fields.get("status") ?? "",
    // Anything but the literal "1" is not alive: an odd flag never promotes a dead session.
    alive: aliveFlag === "1",
    ...(name !== undefined ? { name } : {}),
    ...(waitingFor !== undefined ? { waitingFor } : {}),
    ...(tmux !== undefined ? { tmux } : {}),
    ...(procStart !== undefined ? { procStart } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(kind !== undefined ? { kind } : {})
  };
}

function parseSlice(rest: string): ProbeSliceResult | undefined {
  const m = SLICE_RE.exec(rest);
  if (!m) return undefined;
  const [, sessionId = "", offsetText = "0", sizeText = "0", truncated = "0", found = "0", b64 = ""] = m;
  if (!SESSION_ID_RE.test(sessionId)) return undefined;
  const offset = Number(offsetText);
  const size = Number(sizeText);
  const bytes = decode(b64);
  if (offset > MAX_OFFSET || size > MAX_OFFSET || offset + bytes.length > MAX_OFFSET) return undefined;
  return { sessionId, offset, size, bytes, truncated: truncated === "1", found: found === "1" };
}

function parseKeyed(rest: string, re: RegExp, keyRe: RegExp): readonly [string, string] | undefined {
  const m = re.exec(rest);
  if (!m) return undefined;
  const [, key = "", b64 = ""] = m;
  if (!keyRe.test(key)) return undefined;
  return [key, decode(b64).toString("utf8")];
}

/** Never throws: foreign / malformed lines are ignored + counted; ids are re-validated on the way in. */
export function parseProbeOutput(stdout: string): ProbeReport {
  const panes: ProbePane[] = [];
  const sessions: ProbeSessionFile[] = [];
  const slices: ProbeSliceResult[] = [];
  const tails = new Map<string, string>();
  const sentinels = new Map<string, string>();
  let ignoredLines = 0;
  let sessionsUnparsed = 0;
  let ended = false;

  const accept = (record: string): boolean => {
    const sep = record.indexOf(":");
    if (sep < 0) return false;
    const kind = record.slice(0, sep);
    const rest = record.slice(sep + 1);
    switch (kind) {
      case "pane": {
        const pane = parsePane(rest);
        if (pane) panes.push(pane);
        return pane !== undefined;
      }
      case "session": {
        const file = parseSessionFile(rest);
        if (file === "unparsed") {
          sessionsUnparsed++;
          return false; // dropped, and counted in ignoredLines as before
        }
        if (file) sessions.push(file);
        return file !== undefined;
      }
      case "slice": {
        const slice = parseSlice(rest);
        if (slice) slices.push(slice);
        return slice !== undefined;
      }
      case "tail": {
        const tail = parseKeyed(rest, TAIL_RE, PANE_ID_RE);
        if (tail) tails.set(tail[0], tail[1]);
        return tail !== undefined;
      }
      case "sentinel": {
        const sentinel = parseKeyed(rest, SENTINEL_RE, SESSION_ID_RE);
        if (sentinel) sentinels.set(sentinel[0], sentinel[1]);
        return sentinel !== undefined;
      }
      default:
        return false;
    }
  };

  // The record currently being assembled (its base64 tail may continue on following lines).
  let pending: string | undefined;
  const flush = (): void => {
    if (pending === undefined) return;
    if (!accept(pending)) ignoredLines++;
    pending = undefined;
  };

  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    if (line.startsWith(PROBE_SENTINEL)) {
      flush();
      const record = line.slice(PROBE_SENTINEL.length);
      // `end` carries no payload, so nothing can continue it.
      if (record === "end") ended = true;
      else pending = record;
      continue;
    }
    if (pending !== undefined && B64_CONTINUATION_RE.test(line)) {
      pending += line;
      continue;
    }
    flush();
    ignoredLines++;
  }
  flush();
  return { panes, sessions, slices, tails, sentinels, ignoredLines, sessionsUnparsed, ended };
}

const ESC = String.fromCharCode(27);
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/** First non-empty line, ANSI + control characters stripped, capped — safe to show as text (as tmux.ts). */
function oneLine(s: string, max: number): string {
  const first = s.split("\n").find((l) => l.trim() !== "") ?? "";
  const printable = Array.from(first.replace(ANSI_CSI_RE, ""))
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 && c !== 127;
    })
    .join("");
  return printable.trim().slice(0, max);
}

function classify(target: SshTarget, r: RemoteCommandResult): ProbeResult {
  if (r.code === 127) {
    return { state: "failed", message: `the probe could not start on ${target.logicalName} (exit 127: the login shell found no /bin/sh)` };
  }
  if (r.code !== 0) {
    const message = `probe on ${target.logicalName} failed (exit ${r.code})`;
    const remoteDetail = oneLine(r.stderr, MAX_FIELD_CHARS);
    return remoteDetail ? { state: "failed", message, remoteDetail } : { state: "failed", message };
  }
  const report = parseProbeOutput(r.stdout);
  if (!report.ended) {
    return { state: "cant_read", message: `probe output from ${target.logicalName} ended early — no end marker (cut at the output cap or interrupted)` };
  }
  return { state: "ok", report };
}

/**
 * Run one probe on `target` through the injected exec (the poller binds it to `runRemoteCommand` with
 * `maxOutputBytes: PROBE_MAX_OUTPUT_BYTES`). Never throws: a refused plan is `failed` (nothing is
 * dialled), an unreachable machine is `unreachable` with first-party wording only, a non-zero exit is
 * `failed` with the machine's stderr kept apart in `remoteDetail`, and a cut report is `cant_read`.
 */
export async function runProbe(target: SshTarget, handle: string, exec: RemoteExec, plan: ProbePlan): Promise<ProbeResult> {
  let command: RemoteCommand;
  try {
    command = buildProbeCommand(plan);
  } catch (err) {
    const why = err instanceof ProbeError ? err.message : "invalid plan";
    return { state: "failed", message: `probe plan for ${target.logicalName} refused — ${why}` };
  }
  let result: RemoteCommandResult;
  try {
    result = await exec(target, handle, command);
  } catch (err) {
    const ssh = err instanceof SshConnectionError;
    const why = ssh && /timed out/.test(err.message) ? "timed out waiting for the machine" : ssh ? "SSH connection failed" : "could not run the probe over SSH";
    return { state: "unreachable", message: `${target.logicalName} unreachable — ${why}` };
  }
  return classify(target, result);
}
