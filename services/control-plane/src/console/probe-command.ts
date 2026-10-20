/**
 * Maestro Console probe — the read-only remote commands the console runs on a dev machine (spec §5, plan
 * Task 3; TM-020 remote-command surface). Everything a card is built from comes back through
 * `buildProbeCommand`, once per machine per poll: the tmux panes, each `~/.claude/sessions/*.json`
 * (allow-listed fields only, never `*.key`), the transcript bytes after each stored offset, the
 * `capture-pane` tail of each pane of interest and each session's `pending-approval.json` sentinel.
 * `buildExpandCommand` fetches one byte range of one transcript for the on-demand expand view, and
 * `buildPaneTailCommand` one pane's `capture-pane` tail for a commit approval's second step (F2 Task 12,
 * spec §6.4) — R1: nothing of either is stored.
 *
 * Security:
 * - Every command is the branded {@link RemoteCommand}, minted by {@link mintScript} here (the F2 delivery
 *   script in `deliver-command.ts` reuses it) and in `tmux.ts` only. Every value that reaches the text passes
 *   its allow-list first ({@link SESSION_ID_RE}, {@link PANE_ID_RE}, bounded integers) and is then
 *   single-quoted; a plan with more than 64 slices or 256 panes is refused.
 *   Refusals name the rule, never the offending value.
 * - The script is POSIX `sh` (bash-3.2-safe; BSD and GNU userland) and is handed to `/bin/sh` through a
 *   QUOTED heredoc after the same absolute-path PATH prefix `tmux.ts` uses. sshd runs a remote command
 *   under the account's login shell — zsh on macOS, whose default `nomatch` aborts a script on an
 *   unmatched `*.json` glob, while Review Focus 5 needs an empty machine to answer `end` with exit 0 —
 *   and the quoted delimiter means that shell expands nothing in the body: the inner `sh` sees it as
 *   written, so the single-quoted values are literal under sh, bash and zsh alike (BUGS #32).
 * - Read-only by construction: tmux is only asked to list-panes / display-message / capture-pane; no
 *   `send-keys`, `paste-buffer`, `load-buffer` or `kill-…` (the liveness test is `kill -0`, which delivers
 *   no signal); nothing under `~/.claude` is written. The only redirections are: `>/dev/null 2>&1` (the
 *   base64 guard's `command -v`), `2>/dev/null` (tmux, `kill -0`, `find`), `>&2` (the guard's message), the
 *   `< "$f"` input of `wc -c` and of `tail -c`, and the quoted heredoc that feeds the script to `/bin/sh` —
 *   no output redirection names a file. The tests assert these over the generated text.
 * - Only the allow-listed session-file keys cross the wire: `grep -o` on the machine extracts them, so
 *   `bridgeSessionId` / `messagingSocketPath` never leave it. Free text travels base64 with newlines
 *   stripped on the machine (`| tr -d '\n'` — macOS `base64` has no `-w0`).
 *
 * Record grammar (one record per stdout line, every free-text field base64; `probe.ts` parses it):
 *   PANTHEON_PROBE:pane:<session_name_b64>:<window_id>:<pane_id>:<pane_pid>:<pane_current_command_b64>
 *   PANTHEON_PROBE:session:<basename>:<alive 0|1>:<fields_b64>      fields = the grep -o matches, one per line
 *   PANTHEON_PROBE:slice:<sessionId>:<offset>:<size>:<truncated 0|1>:<found 0|1>:<b64>
 *   PANTHEON_PROBE:tail:<pane_id>:<b64>
 *   PANTHEON_PROBE:sentinel:<sessionId>:<b64>                        <cwd>/.claude/pending-approval.json, ≤ 16 KiB
 *   PANTHEON_PROBE:end                                               always last; absent → the report was cut
 * A missing tmux server emits no pane/tail payloads and a missing sessions directory no session records;
 * both still end in `end` with exit 0 (Review Focus 5). When a transcript is shorter than the stored
 * offset the slice is emitted from offset 0 (record `offset` = 0, real `size`); resetting the STORED
 * offset is the poller's job (ruling R-pre-1).
 */

import { type RemoteCommand } from "../devmachine/connection.js";

/** Every record starts with this, so shell-profile chatter on stdout is recognisable and counted. */
export const PROBE_SENTINEL = "PANTHEON_PROBE:";

/** Allow-list for a Claude session id (the transcript's file stem): a lowercase UUID, nothing else. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Allow-list for a tmux pane id as `#{pane_id}` prints it. */
export const PANE_ID_RE = /^%\d{1,6}$/;

/** Capture cap for the probe only (spec §5); every other remote command keeps the 64 KiB default. */
export const PROBE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface ProbeSlice {
  readonly sessionId: string;
  /** Transcript bytes already consumed; 0 ≤ offset ≤ 10^12. */
  readonly offset: number;
}

export interface ProbePlan {
  readonly slices: readonly ProbeSlice[];
  /** Pane ids whose `capture-pane` tail is wanted. */
  readonly panes: readonly string[];
  /** Per-slice byte cap (1 … {@link PROBE_MAX_OUTPUT_BYTES}); a longer remainder sets `truncated`. */
  readonly maxBytesPerSlice: number;
  /** History lines included above the visible pane in each tail (`capture-pane -S -N`: visible rows + N), 1 … 1000. */
  readonly tailLines: number;
}

/** A plan value outside its allow-list. The message names the rule, never the value. */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

const MAX_SLICES = 64;
const MAX_PANES = 256;
const MAX_OFFSET = 1_000_000_000_000;
const MAX_TAIL_LINES = 1000;
/** History lines above the visible pane for the commit approval's pane view (F2 Task 12). */
const MAX_PANE_VIEW_LINES = 200;

/** Keep byte-identical to `TMUX_PATH_PREFIX` in tmux.ts (not exported there); the test compares them. */
const PROBE_PATH_PREFIX = 'PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"';

/** Heredoc delimiter; quoted, so the login shell performs no expansion on the body. */
const HEREDOC_TAG = "PANTHEON_PROBE_SCRIPT";

/** Without base64 every payload would be silently empty — fail loud instead (exit 126 → `failed`). Shared with `deliver-command.ts`. */
export const BASE64_GUARD = String.raw`command -v base64 >/dev/null 2>&1 || { echo "probe: base64 not found" >&2; exit 126; }`;

const END_LINE = String.raw`printf 'PANTHEON_PROBE:end\n'`;

/** Base64 without line wrapping (macOS `base64` has no `-w0`): every record's payload is one line. */
const B64_FUNCTION = String.raw`b64() { base64 | tr -d '\n'; }`;

/**
 * Script head: panes, then session files (+ their sentinels). `String.raw` keeps the shell's own
 * backslashes (`\(`, `\|`, `'\n'`) intact; the only `${…}` substitutions are the builder's.
 * - `pane_current_command` is captured with `$(…)` first, so the newline `display-message -p` appends
 *   is stripped before the base64 (the parser trims one too, as defense in depth).
 * - A session file's basename is emitted unencoded as a record field, so it is allow-listed on the
 *   machine (`[A-Za-z0-9._-]` only): a filename carrying a newline or a `:` cannot forge a record.
 * - Session files are read through a 64 KiB cap and the pending-approval sentinel through a 16 KiB cap;
 *   a sentinel that is itself a symlink is skipped (`[ ! -L ]` tests the final path component only — a
 *   symlinked `.claude` directory is not detected) and `cwd` must be an absolute path.
 * - `kill -0` sends no signal: it only asks whether the pid still exists for this user.
 */
const PROBE_SCRIPT_HEAD = String.raw`export LC_ALL=C
${BASE64_GUARD}
${B64_FUNCTION}
tmux list-panes -a -F '#{pane_id} #{window_id} #{pane_pid} #{session_name}' 2>/dev/null | while read -r p w pid s; do
  c=$(tmux display-message -p -t "$p" '#{pane_current_command}' 2>/dev/null)
  printf 'PANTHEON_PROBE:pane:%s:%s:%s:%s:%s\n' "$(printf '%s' "$s" | b64)" "$w" "$p" "$pid" "$(printf '%s' "$c" | b64)"
done
for f in "$HOME"/.claude/sessions/*.json; do
  [ -f "$f" ] || continue
  b=$(basename "$f")
  case $b in *[!A-Za-z0-9._-]*) continue ;; esac
  fields=$(head -c 65536 "$f" | tr -d '\n' | grep -o '"\(pid\|sessionId\|cwd\|name\|status\|waitingFor\|tmux\|procStart\|version\|kind\)" *: *\("[^"]*"\|[0-9.][0-9.]*\)')
  pid=$(printf '%s\n' "$fields" | grep -o '^"pid" *: *[0-9][0-9]*' | head -1 | grep -o '[0-9][0-9]*$')
  alive=0
  if [ -n "$pid" ] && [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null; then alive=1; fi
  printf 'PANTHEON_PROBE:session:%s:%s:%s\n' "$b" "$alive" "$(printf '%s' "$fields" | b64)"
  sid=$(printf '%s\n' "$fields" | grep -o '^"sessionId" *: *"[^"]*"' | head -1 | sed 's/^"sessionId" *: *"//; s/"$//')
  cwd=$(printf '%s\n' "$fields" | grep -o '^"cwd" *: *"[^"]*"' | head -1 | sed 's/^"cwd" *: *"//; s/"$//')
  case $cwd in /*) ;; *) cwd= ;; esac
  sentinel="$cwd/.claude/pending-approval.json"
  if [ -n "$sid" ] && [ -n "$cwd" ] && [ -f "$sentinel" ] && [ ! -L "$sentinel" ]; then
    printf 'PANTHEON_PROBE:sentinel:%s:%s\n' "$sid" "$(head -c 16384 "$sentinel" | b64)"
  fi
done`;

/**
 * `slice '<sessionId>' '<offset>'`: the transcript is the one `<sessionId>.jsonl` under
 * `~/.claude/projects/<project>/`; bytes `[offset, offset + max)` via `tail -c +(offset+1) | head -c max`.
 * `size < offset` → the file was rotated or replaced: emit from 0 (ruling R-pre-1). Not found → found 0.
 */
const sliceFunction = (max: number): string => String.raw`slice() {
  f=$(find "$HOME/.claude/projects" -maxdepth 2 -type f -name "$1.jsonl" 2>/dev/null | head -1)
  if [ -z "$f" ]; then printf 'PANTHEON_PROBE:slice:%s:%s:0:0:0:\n' "$1" "$2"; return 0; fi
  size=$(wc -c < "$f" | tr -d ' ')
  case $size in ''|*[!0-9]*) size=0 ;; esac
  off=$2
  if [ "$size" -lt "$off" ]; then off=0; fi
  trunc=0
  if [ $((size - off)) -gt ${max} ]; then trunc=1; fi
  printf 'PANTHEON_PROBE:slice:%s:%s:%s:%s:1:' "$1" "$off" "$size" "$trunc"
  < "$f" tail -c +$((off + 1)) | head -c ${max} | b64
  printf '\n'
}`;

/**
 * `tail_of '<pane_id>'`: `capture-pane -S -N` yields the WHOLE visible pane plus `lines` lines of history
 * above it (not `lines` lines in total), wrapped lines joined. A dead pane → empty payload.
 */
const tailFunction = (lines: number): string => String.raw`tail_of() {
  printf 'PANTHEON_PROBE:tail:%s:' "$1"
  tmux capture-pane -p -J -S -${lines} -t "$1" 2>/dev/null | b64
  printf '\n'
}`;

function assertSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID_RE.test(value)) {
    throw new ProbeError("invalid sessionId — expected a lowercase UUID");
  }
  return value;
}

function assertPaneId(value: unknown): string {
  if (typeof value !== "string" || !PANE_ID_RE.test(value)) {
    throw new ProbeError("invalid pane id — expected '%' followed by 1–6 digits");
  }
  return value;
}

function assertInteger(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ProbeError(`invalid ${what} — expected an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Wrap a validated script body: PATH prefix as in tmux.ts, then `/bin/sh` fed by a quoted heredoc. The
 * mint for every console script — the probe, expand and pane-tail commands here, the delivery script in
 * `deliver-command.ts`; callers pass allow-listed values only.
 */
export function mintScript(script: string): RemoteCommand {
  // Structural guard: no body line may close the heredoc early. Allow-listed values cannot contain the
  // tag, so this only trips on a template edit.
  if (script.split("\n").includes(HEREDOC_TAG)) throw new ProbeError("probe script would terminate its own heredoc");
  return `${PROBE_PATH_PREFIX} /bin/sh <<'${HEREDOC_TAG}'\n${script}\n${HEREDOC_TAG}\n` as RemoteCommand;
}

/**
 * The per-poll probe for one machine. Throws {@link ProbeError} on any value outside its allow-list —
 * before any command text exists. `runProbe` turns that into a labeled `failed` result.
 */
export function buildProbeCommand(plan: ProbePlan): RemoteCommand {
  if (plan.slices.length > MAX_SLICES) throw new ProbeError(`too many slices in one probe (max ${MAX_SLICES})`);
  if (plan.panes.length > MAX_PANES) throw new ProbeError(`too many panes in one probe (max ${MAX_PANES})`);
  const max = assertInteger(plan.maxBytesPerSlice, "maxBytesPerSlice", 1, PROBE_MAX_OUTPUT_BYTES);
  const lines = assertInteger(plan.tailLines, "tailLines", 1, MAX_TAIL_LINES);
  const slices = plan.slices.map((s) => `slice '${assertSessionId(s.sessionId)}' '${assertInteger(s.offset, "offset", 0, MAX_OFFSET)}'`);
  const tails = plan.panes.map((p) => `tail_of '${assertPaneId(p)}'`);
  return mintScript([PROBE_SCRIPT_HEAD, sliceFunction(max), ...slices, tailFunction(lines), ...tails, END_LINE].join("\n"));
}

/**
 * Bytes `[offsetStart, offsetEnd)` of one transcript, as a single `slice` record followed by `end`
 * (parse it with `parseProbeOutput`; the result is `slices[0]`). `offset` is `offsetStart`; `size` is
 * the file's current length; `truncated` is 1 when the file is now shorter than `offsetEnd` (the range
 * could not be served whole — the transcript changed); `found` 0 when the transcript is gone.
 */
export function buildExpandCommand(sessionId: string, offsetStart: number, offsetEnd: number): RemoteCommand {
  const sid = assertSessionId(sessionId);
  const start = assertInteger(offsetStart, "offsetStart", 0, MAX_OFFSET);
  const end = assertInteger(offsetEnd, "offsetEnd", 0, MAX_OFFSET);
  if (end <= start) throw new ProbeError("invalid byte range — offsetEnd must be greater than offsetStart");
  const script = String.raw`export LC_ALL=C
${BASE64_GUARD}
f=$(find "$HOME/.claude/projects" -maxdepth 2 -type f -name '${sid}.jsonl' 2>/dev/null | head -1)
if [ -n "$f" ]; then
  size=$(wc -c < "$f" | tr -d ' ')
  case $size in ''|*[!0-9]*) size=0 ;; esac
  trunc=0
  if [ "$size" -lt ${end} ]; then trunc=1; fi
  printf 'PANTHEON_PROBE:slice:%s:%s:%s:%s:1:' '${sid}' '${start}' "$size" "$trunc"
  < "$f" tail -c +${start + 1} | head -c ${end - start} | base64 | tr -d '\n'
  printf '\n'
else
  printf 'PANTHEON_PROBE:slice:%s:%s:0:0:0:\n' '${sid}' '${start}'
fi
${END_LINE}`;
  return mintScript(script);
}

/**
 * One pane's screen for a commit approval's second step (F2 Task 12, spec §6.4): the probe's own `tail_of` function
 * and record over ONE pane — `capture-pane -S -<lines>`, i.e. the whole visible pane plus `lines` lines of history —
 * then `end`. Parse it with `parseProbeOutput`: the text is `tails.get(paneId)`, trusted only when `ended`. Read-only:
 * tmux is only asked to capture-pane. Throws {@link ProbeError} for a pane id outside {@link PANE_ID_RE} or `lines`
 * outside 1 … 200 — before any command text exists; the pane id reaches the text single-quoted, nowhere else.
 */
export function buildPaneTailCommand(paneId: string, lines: number): RemoteCommand {
  const pane = assertPaneId(paneId);
  const history = assertInteger(lines, "lines", 1, MAX_PANE_VIEW_LINES);
  return mintScript(["export LC_ALL=C", BASE64_GUARD, B64_FUNCTION, tailFunction(history), `tail_of '${pane}'`, END_LINE].join("\n"));
}
