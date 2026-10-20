/**
 * tmux-aware launcher (M1 task 1 — `docs/handoffs/2026-08-20-M1-build-plan.md` §M1.1; ruled design:
 * LIVE-list from the machine, not a per-machine field). Lists the tmux sessions on a provisioned
 * DevMachine over the existing key-only SSH path and builds the attach / attach-or-create command a
 * terminal tab runs instead of a bare login shell (topology doc §4: `tmux new-session -A -s <name>`
 * is the ruled attach-or-create line; an existing session is attached EXACTLY, `-t =<name>`, so a
 * session that died between list and click fails visibly instead of silently becoming a new one).
 *
 * Security (TM-020 remote-command surface): a session name is interpolated into a remote command
 * ONLY after passing {@link TMUX_SESSION_NAME_RE}, and a working directory (a machine shell's
 * projects root, F2 Task 7) ONLY after passing {@link assertRemoteDir}; anything else is refused
 * before any SSH dial (CC2). Commands are the branded {@link RemoteCommand} type, minted only here.
 * `tmux` on macOS lives in `/opt/homebrew/bin`, which the non-login shell sshd uses for a remote
 * command does not put on PATH — the commands carry an absolute-path PATH prefix instead of relying
 * on the remote profile. Every failure is a LABELED result the page renders in text (CC1); nothing here throws
 * toward the browser, and no message ever carries key material or user@host.
 *
 * Trust boundary (audit 2026-08-25): everything the machine sends back is `trusted:false` — records
 * carry a sentinel so shell-profile chatter on stdout is ignored + counted instead of wiping the
 * list; names are never trimmed before validation, are length-capped, and the count is capped;
 * remote stderr travels in a SEPARATE `remoteDetail` field (the page labels it as machine-supplied)
 * and never inside first-party `message` text. `createTmuxLister` coalesces concurrent dials per
 * machine, caches results briefly and caps concurrency, so page loads and a mashed Refresh cannot
 * turn into an SSH-handshake flood against the dev machine.
 */

import { SshConnectionError, type RemoteCommand } from "./connection.js";
import { type SshTarget } from "./provisioning.js";

/** The longest session name the allow-list admits (one leading character plus up to 63 more). */
export const TMUX_SESSION_NAME_MAX = 64;

/** Allow-list for a session name that may be interpolated into a remote command — at most {@link TMUX_SESSION_NAME_MAX} characters. */
export const TMUX_SESSION_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** Every list record starts with this, so foreign stdout lines (banners, direnv) are recognisable. */
export const TMUX_LIST_SENTINEL = "PANTHEON_TMUX:";

/** Absolute-path probe: Homebrew (Apple Silicon), Homebrew (Intel) / manual installs, system. */
const TMUX_PATH_PREFIX = 'PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"';

/** Numbers first, name LAST — a separator inside the name can never shift the numeric fields. */
const LIST_FORMAT = `${TMUX_LIST_SENTINEL}#{session_windows}:#{session_attached}:#{session_created}:#{session_name}`;

/** Bounded digit runs: an epoch of ≤ 12 digits keeps `new Date(n * 1000)` inside its valid range. */
const RECORD_RE = /^(\d{1,9}):(\d{1,9}):(\d{1,12}):(.*)$/;

const MAX_SESSIONS = 100;
const MAX_NAME_CHARS = TMUX_SESSION_NAME_MAX;
const MAX_DETAIL_CHARS = 140;

/** tmux-launcher failures (bad session name). Carries no key material. */
export class TmuxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmuxError";
  }
}

export function isSafeTmuxSessionName(name: unknown): name is string {
  return typeof name === "string" && TMUX_SESSION_NAME_RE.test(name);
}

export function assertTmuxSessionName(name: unknown): string {
  if (!isSafeTmuxSessionName(name)) {
    throw new TmuxError("invalid tmux session name — use 1–64 letters, digits, '_' or '-' (not starting with '-')");
  }
  return name;
}

/** A remote working directory (`tmux new-session -c`) may be at most this many UTF-8 bytes. */
const MAX_REMOTE_DIR_BYTES = 512;

/**
 * The rule a remote working directory breaks, or undefined when it passes the allow-list: absolute, at most
 * {@link MAX_REMOTE_DIR_BYTES}, no single quote (the interpolation is single-quoted), no `#` (ruling T11-5: tmux
 * expands formats in `new-session -c` — `#S`, `##`, `#{…}`, and `#(…)` runs a shell command), no control character
 * (C0 `\0`–`\x1f`, `\x7f`, C1 U+0080–U+009F), no lone surrogate (no UTF-8 form), no bidi control (U+202A–U+202E,
 * U+2066–U+2069), no `..` path segment (`/a/../b` is refused; `/a/..b` is a plain name). The scan is by code point,
 * so a well-formed surrogate pair is one astral character and a lone half is caught. Spaces are allowed. The rule
 * text never carries the value.
 */
export function remoteDirProblem(path: string): string | undefined {
  if (!path.startsWith("/")) return "must be an absolute path (starting with '/')";
  if (Buffer.byteLength(path, "utf8") > MAX_REMOTE_DIR_BYTES) return `must be at most ${MAX_REMOTE_DIR_BYTES} bytes`;
  if (path.includes("'")) return "must not contain a single quote";
  if (path.includes("#")) return "must not contain '#'";
  for (const ch of path) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return "must not contain control characters";
    if (cp >= 0xd800 && cp <= 0xdfff) return "must be well-formed Unicode (no lone surrogate)";
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return "must not contain bidirectional control characters";
  }
  if (path.split("/").includes("..")) return "must not contain a '..' path segment";
  return undefined;
}

/** The directory itself, or a {@link TmuxError} naming the broken rule (never the value): the allow-list for `-c`. */
export function assertRemoteDir(path: unknown): string {
  if (typeof path !== "string") throw new TmuxError("invalid remote directory — must be a string");
  const problem = remoteDirProblem(path);
  if (problem !== undefined) throw new TmuxError(`invalid remote directory — ${problem}`);
  return path;
}

export function buildTmuxListCommand(): RemoteCommand {
  return `${TMUX_PATH_PREFIX} tmux list-sessions -F '${LIST_FORMAT}'` as RemoteCommand;
}

/**
 * The remote command for a terminal tab. Default: attach to the EXACT existing session. `create`:
 * the ruled attach-or-create line (new session under that name, or attach if it already exists);
 * with `cwd` (a machine shell, F2 Task 7) the new session starts in that directory — `cwd` passes
 * {@link assertRemoteDir} and is single-quoted like the name. `cwd` without `create` is refused:
 * a plain attach never changes a directory here.
 */
export function buildTmuxAttachCommand(name: string, opts: { readonly create?: boolean; readonly cwd?: string } = {}): RemoteCommand {
  const safe = assertTmuxSessionName(name);
  if (opts.cwd !== undefined && !opts.create) throw new TmuxError("a working directory applies only to attach-or-create");
  const cwd = opts.cwd === undefined ? "" : ` -c '${assertRemoteDir(opts.cwd)}'`;
  // Single-quoted on purpose (BUGS #32): sshd runs the line through the user's login shell, and zsh
  // expands an unquoted `=word` to "the path of command word" ("zsh:1: 0 not found"). The allow-lists
  // admit no quote characters, so the quoted forms are literal under sh, bash and zsh alike.
  return (
    opts.create
      ? `${TMUX_PATH_PREFIX} tmux new-session -A -s '${safe}'${cwd}`
      : `${TMUX_PATH_PREFIX} tmux attach-session -t '=${safe}'`
  ) as RemoteCommand;
}

export interface TmuxSession {
  /** Display name — capped at 64 characters (with an ellipsis); never trimmed. */
  readonly name: string;
  readonly windows: number;
  /** True when at least one client is attached (the session is being viewed somewhere else too). */
  readonly attached: boolean;
  readonly createdAt: string;
  /** False when the name fails the allow-list: listed for honesty, never offered as an attach target. */
  readonly attachable: boolean;
}

export interface TmuxListing {
  readonly sessions: TmuxSession[];
  /** stdout lines that were not sentinel records (shell-profile chatter, malformed records). */
  readonly ignoredLines: number;
  /** True when more than {@link MAX_SESSIONS} records arrived and the rest were dropped. */
  readonly truncated: boolean;
}

/** Never throws: foreign / malformed lines are ignored + counted; caps are applied. */
export function parseTmuxListOutput(stdout: string): TmuxListing {
  const sessions: TmuxSession[] = [];
  let ignoredLines = 0;
  let truncated = false;
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    if (!line.startsWith(TMUX_LIST_SENTINEL)) {
      ignoredLines++;
      continue;
    }
    const m = RECORD_RE.exec(line.slice(TMUX_LIST_SENTINEL.length));
    if (!m) {
      ignoredLines++;
      continue;
    }
    if (sessions.length >= MAX_SESSIONS) {
      truncated = true;
      continue;
    }
    const [, windows = "0", attached = "0", created = "0", rawName = ""] = m;
    const tooLong = rawName.length > MAX_NAME_CHARS;
    sessions.push({
      name: tooLong ? `${rawName.slice(0, MAX_NAME_CHARS)}…` : rawName,
      windows: Number(windows),
      attached: Number(attached) > 0,
      createdAt: new Date(Number(created) * 1000).toISOString(),
      attachable: !tooLong && isSafeTmuxSessionName(rawName)
    });
  }
  return { sessions, ignoredLines, truncated };
}

/** Every outcome is labeled (CC1) — the page renders `state` + `message` as text, never a colour. */
export type TmuxListResult =
  | { readonly state: "ok"; readonly sessions: readonly TmuxSession[]; readonly ignoredLines: number; readonly truncated: boolean }
  | { readonly state: "unreachable"; readonly message: string }
  | { readonly state: "tmux_missing"; readonly message: string }
  | {
      readonly state: "failed";
      /** First-party text only. */
      readonly message: string;
      /** The machine's first stderr line, sanitized + capped — `trusted:false`; the page labels it. */
      readonly remoteDetail?: string;
    };

export interface RemoteCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The SSH exec-capture port (real: `runRemoteCommand` bound to custody). */
export type RemoteExec = (target: SshTarget, handle: string, command: RemoteCommand) => Promise<RemoteCommandResult>;

/**
 * Per-line, anchored: tmux ≥ 3 says "no server running on <socket>"; older builds say
 * "error connecting to <socket> (No such file …)". A line that merely CONTAINS the phrase does not count.
 */
const NO_SERVER_LINE_RE = /^(?:tmux: )?(?:no server running\b|error connecting to \S+ \(No such file)/;

function isNoServerRunning(stderr: string): boolean {
  return stderr.split("\n").some((l) => NO_SERVER_LINE_RE.test(l.trim()));
}

const ESC = String.fromCharCode(27);
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/** First non-empty line, ANSI + control characters stripped, capped — safe to show as text. */
function oneLine(text: string, max: number): string {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const printable = Array.from(first.replace(ANSI_CSI_RE, ""))
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c >= 32 && c !== 127;
    })
    .join("");
  return printable.trim().slice(0, max);
}

export function classifyTmuxListResult(r: RemoteCommandResult): TmuxListResult {
  if (r.code === 0) {
    const { sessions, ignoredLines, truncated } = parseTmuxListOutput(r.stdout);
    return { state: "ok", sessions, ignoredLines, truncated };
  }
  if (isNoServerRunning(r.stderr)) return { state: "ok", sessions: [], ignoredLines: 0, truncated: false };
  if (r.code === 127) {
    return {
      state: "tmux_missing",
      message: "tmux is not installed on this machine (looked in /opt/homebrew/bin, /usr/local/bin, /usr/bin, /bin)"
    };
  }
  const message = `tmux list-sessions failed (exit ${r.code})`;
  const remoteDetail = oneLine(r.stderr, MAX_DETAIL_CHARS);
  return remoteDetail ? { state: "failed", message, remoteDetail } : { state: "failed", message };
}

/**
 * List the live tmux sessions on `target`. Never throws: an unreachable machine (connect failure,
 * timeout) becomes a labeled `unreachable` result with FIRST-PARTY wording only — the machine's
 * logicalName, never user@host, never raw exception text.
 */
export async function listTmuxSessions(target: SshTarget, handle: string, exec: RemoteExec): Promise<TmuxListResult> {
  let result: RemoteCommandResult;
  try {
    result = await exec(target, handle, buildTmuxListCommand());
  } catch (err) {
    const ssh = err instanceof SshConnectionError;
    const why = ssh && /timed out/.test(err.message) ? "timed out waiting for the machine" : ssh ? "SSH connection failed" : "could not run tmux over SSH";
    return { state: "unreachable", message: `${target.logicalName} unreachable — ${why}` };
  }
  return classifyTmuxListResult(result);
}

/** Lists live tmux sessions on a machine (what the harness route consumes). */
export interface TmuxLister {
  list(target: SshTarget, handle: string): Promise<TmuxListResult>;
}

export interface TmuxListerOptions {
  /** How long a result is served from cache (default 3 s). Failures are cached too. */
  readonly ttlMs?: number;
  /** Cap on concurrent SSH dials across all machines (default 4); beyond it → labeled `failed`, no dial. */
  readonly maxConcurrent?: number;
  /** Clock (tests). */
  readonly now?: () => number;
}

/**
 * Wrap a raw lister so that (a) concurrent calls for one machine share ONE dial, (b) a result is
 * reused for `ttlMs`, and (c) at most `maxConcurrent` dials are in flight — the fix for the
 * "unmetered SSH-dial amplifier" audit finding. Never rejects.
 */
export function createTmuxLister(list: TmuxLister["list"], opts: TmuxListerOptions = {}): TmuxLister {
  const ttlMs = opts.ttlMs ?? 3000;
  const maxConcurrent = opts.maxConcurrent ?? 4;
  const now = opts.now ?? Date.now;
  const inflight = new Map<string, Promise<TmuxListResult>>();
  const cache = new Map<string, { at: number; result: TmuxListResult }>();
  return {
    list(target, handle) {
      const key = target.logicalName;
      const running = inflight.get(key);
      if (running) return running;
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return Promise.resolve(hit.result);
      if (inflight.size >= maxConcurrent) {
        return Promise.resolve({
          state: "failed",
          message: `too many tmux listings in flight (${maxConcurrent}) — try again in a moment`
        });
      }
      const p = list(target, handle)
        .catch((): TmuxListResult => ({ state: "failed", message: `listing tmux sessions on ${key} failed` }))
        .then((result) => {
          cache.set(key, { at: now(), result });
          return result;
        })
        .finally(() => {
          inflight.delete(key);
        });
      inflight.set(key, p);
      return p;
    }
  };
}
