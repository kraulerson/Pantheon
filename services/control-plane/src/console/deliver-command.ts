/**
 * Maestro Console delivery — the one remote command that pastes Karl's reply into a live Claude Code
 * pane (spec §6.6.4, plan Task 5; TM-020 remote-command surface). The Submit route (Task 6) builds a
 * {@link DeliverPlan} from the card's stored session row, mints the command here, runs it once over the
 * existing key-only SSH path and reads the single result record with {@link parseDeliverOutput}.
 *
 * Security:
 * - The command is a {@link RemoteCommand} minted by `mintScript` (probe-command.ts): the same absolute-path
 *   PATH prefix and the same QUOTED heredoc into `/bin/sh`, so the login shell expands nothing in the body.
 *   Every plan value passes its allow-list BEFORE any command text exists and is then single-quoted (the
 *   buffer id, `console-` + 8 hex, stays bare: its allow-list leaves nothing for a shell to interpret).
 *   Refusals name the rule, never the value.
 * - The reply text exists in the command ONLY as base64 inside the heredoc (`printf '%s' '<b64>' | base64 -d |
 *   tmux load-buffer … -`): it is never interpolated into shell syntax and reaches tmux through stdin, so tmux
 *   key names, `/`, `!`, `#`, `@` and shell syntax are pasted as literal text (Review Focus 2).
 * - The target is re-verified on the machine at send time, in this order: session file present; the file's
 *   `sessionId`, `procStart` and `pid` equal the card's (the RAW `procStart` string, byte-equal to the stored
 *   one — the recorded plan deviation from §6.6.4a's "epoch seconds": no date parsing in sh); `kill -0 <pid>`
 *   (sends no signal); the pane's `pane_pid` is the pid or one of its ancestors within 6 hops; `status` is
 *   `idle` or `busy`; no MENU_ANCHORS entry starts a line of the pane tail (≤ 3 columns of indent allowed —
 *   the real permission and trust prompts are drawn one column in, and the trust prompt's non-highlighted
 *   option three columns in, under the ` ❯ ` cursor slot: menu-fixtures.ts); the pane is in no mode
 *   (`#{pane_in_mode}` is `0` — copy mode would swallow the paste and the Enter: triage 19). Any failure writes
 *   a refusal record and the text is never pasted.
 * - Writes: `tmux load-buffer`, `paste-buffer -p -d` (bracketed paste, buffer deleted; `delete-buffer` when the
 *   paste fails, so the reply never lingers in the tmux buffer list) and `send-keys Enter` on the verified pane
 *   only; no file is written, nothing under `~/.claude` is touched, `*.key` is never named.
 * - POSIX `sh` only (bash-3.2-safe; BSD and GNU userland): `base64 -d`, `sha256sum` with the `shasum -a 256`
 *   fallback, `ps -A -o pid=,ppid=` (POSIX, documented by both BSD and procps-ng `ps`; procps-ng's SysV
 *   parser refuses `-x` behind a dash unless a personality is set, so `ps -ax` is not relied on). A missing
 *   tool exits 126 before anything is read. POSIX sh has no `pipefail`, so the payload is decoded once as a
 *   dry run whose exit status is checked before the real `base64 -d | tmux load-buffer` pipeline runs, and a
 *   failed `capture-pane` refuses instead of passing the menu check on an empty tail. The menu check matches
 *   each anchor with a quoted `case` prefix pattern instead of `grep -E`, so the anchors need no regex
 *   escaping and appear verbatim in the script (`?` and `.` would otherwise be metacharacters).
 *
 * Record grammar (exactly one line; the script exits 0 after writing it; the parser takes the first):
 *   PANTHEON_DELIVER:result:<outcome>:<status>:<hash_before>:<hash_after>:<detail>
 * `status` is the session file's `status` ([A-Za-z0-9_-], ≤ 32 bytes, else `invalid`); the hashes are the
 * first 16 hex digits of SHA-256 over the `capture-pane -p -J -S -<tailLines>` tail before the paste and
 * ~500 ms after it (empty when the script refused before that step); `detail` is one of this module's
 * literals, `status <token>` or a MENU_ANCHORS entry — the parser withholds anything else.
 */

import { type RemoteCommand } from "../devmachine/connection.js";
import { MENU_ANCHORS } from "./menu-fixtures.js";
import { BASE64_GUARD, PANE_ID_RE, ProbeError, SESSION_ID_RE, mintScript } from "./probe-command.js";
import { SUBMIT_MAX_BYTES, type SubmitOutcome } from "./submit.js";

/** The result record starts with this, so shell-profile chatter on stdout is recognisable. */
export const DELIVER_SENTINEL = "PANTHEON_DELIVER:";

export interface DeliverPlan {
  /** `<pid>.json` under `~/.claude/sessions/` — must name the plan's own `pid`. */
  readonly sessionFile: string;
  readonly sessionId: string;
  /** The card's stored `procStart`, compared RAW (byte equality) with the file's value on the machine. */
  readonly procStart: string;
  readonly pid: number;
  readonly paneId: string;
  /** Canonical base64 of the reply text: at most {@link SUBMIT_MAX_BYTES} decoded bytes. */
  readonly textB64: string;
  /** `console-` + 8 lowercase hex digits: the tmux buffer name (`paste-buffer -d` deletes it). */
  readonly bufferId: string;
  /** History lines above the visible pane in each capture (`capture-pane -S -N`), 1 … 1000. */
  readonly tailLines: number;
}

export interface DeliverReport {
  readonly outcome: SubmitOutcome;
  /** The session file's `status` as the script read it; "" when the script did not report back. */
  readonly statusAtSend: string;
  /** First-party text only: this module's literals, `status <token>` or a MENU_ANCHORS entry — never machine output. */
  readonly detail: string;
  readonly tailHashBefore?: string;
  readonly tailHashAfter?: string;
}

/** `<pid>.json`; the pid bound matches the probe parser's `PID_RE` (9 digits). */
const SESSION_FILE_RE = /^[1-9]\d{0,8}\.json$/;
const MAX_PID = 999_999_999;
/** The raw `procStart` of a session file (`Fri Oct 16 19:19:38 2026`, or an ISO stamp): no quote, `\`, `$` or `;`. */
const PROC_START_RE = /^[A-Za-z0-9][A-Za-z0-9 :+.-]{0,63}$/;
const BUFFER_ID_RE = /^console-[0-9a-f]{8}$/;
/** Standard alphabet with canonical padding; a round trip through `Buffer` then rejects non-canonical trailing bits. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_TAIL_LINES = 1000;
/** A menu anchor is single-quoted into the script and emitted as a record field: no `'`, `\`, `:` or control character. */
const ANCHOR_RE = /^[^'\\:\p{Cc}]{1,64}$/u;

/** The refusal and failure details the script writes (first-party; the parser admits exactly these). */
const FILE_GONE = "session file gone";
const SESSION_ID_CHANGED = "sessionId changed";
const PROC_START_CHANGED = "procStart changed";
const PID_CHANGED = "pid changed";
const PROCESS_GONE = "process gone";
const PANE_CHANGED = "pane no longer holds the session";
/** Triage 19 (F-3): the pane is in a mode (copy mode), which would swallow the paste and the Enter. */
export const PANE_IN_COPY_MODE = "pane in copy mode";
const DECODE_FAILED = "base64 decode failed";
const tmuxStep = (n: 1 | 2 | 3): string => `tmux step ${n}`;
const KNOWN_DETAILS: ReadonlySet<string> = new Set([
  "",
  FILE_GONE,
  SESSION_ID_CHANGED,
  PROC_START_CHANGED,
  PID_CHANGED,
  PROCESS_GONE,
  PANE_CHANGED,
  PANE_IN_COPY_MODE,
  DECODE_FAILED,
  tmuxStep(1),
  tmuxStep(2),
  tmuxStep(3),
  ...MENU_ANCHORS
]);
/** `status <token>` — the file's status after the script's own allow-list (`missing` when the field is absent). */
const STATUS_DETAIL_RE = /^status [A-Za-z0-9_-]{1,32}$/;

const RESULT_PREFIX = `${DELIVER_SENTINEL}result:`;
const OUTCOMES: ReadonlySet<string> = new Set<SubmitOutcome>(["sent", "refused_target_changed", "refused_menu_visible", "failed"]);
const STATUS_RE = /^[A-Za-z0-9_-]{0,32}$/;
const HASH_RE = /^(?:[0-9a-f]{16})?$/;

function assertString(value: unknown, re: RegExp, rule: string): string {
  if (typeof value !== "string" || !re.test(value)) throw new ProbeError(`invalid ${rule}`);
  return value;
}

function assertInteger(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ProbeError(`invalid ${what} — expected an integer between ${min} and ${max}`);
  }
  return value;
}

function assertTextB64(value: unknown): string {
  if (typeof value !== "string" || value === "" || !BASE64_RE.test(value)) throw new ProbeError("invalid textB64 — expected canonical base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new ProbeError("invalid textB64 — expected canonical base64");
  if (bytes.length > SUBMIT_MAX_BYTES) throw new ProbeError(`invalid textB64 — expected at most ${SUBMIT_MAX_BYTES} decoded bytes`);
  return value;
}

/**
 * The nine steps of spec §6.6.4 over validated values. `String.raw` keeps the shell's own backslashes
 * (`\(`, `\|`, `'\n'`, `\"`) intact; the only `${…}` substitutions are the builder's. `result` writes the
 * record and exits 0, so every outcome is data and a non-zero exit means the script could not run.
 * - The session file is read exactly as the probe reads it (64 KiB cap, newlines dropped, `grep -o` on the
 *   allow-listed keys); `field` cuts a string value at its first `"`, `fpid` takes a bare number only.
 * - `parent_of` walks one `ps` snapshot, so the chain is read from a single moment.
 * - `menu_at_line_start` runs in a pipeline subshell: `exit 0` there is "found", `exit 1` "not found".
 * - `#{pane_in_mode}` is read with the menu check, before the paste: `0` goes on, `1` (copy mode) refuses as a menu
 *   would, and anything else (no answer — the pane went away) refuses as a changed target: fail closed.
 * - `payload` holds the base64 once; it is decoded twice — a dry run that only checks `base64 -d`'s exit status
 *   (no `pipefail` in POSIX sh), then the real pipeline into `load-buffer`, whose own status is checked.
 */
function deliverScript(plan: DeliverPlan, anchors: string): string {
  return String.raw`export LC_ALL=C
${BASE64_GUARD}
command -v tmux >/dev/null 2>&1 || { echo "deliver: tmux not found" >&2; exit 126; }
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || { echo "deliver: no sha256 tool" >&2; exit 126; }
status= before= after=
result() { printf '${DELIVER_SENTINEL}result:%s:%s:%s:%s:%s\n' "$1" "$status" "$before" "$after" "$2"; exit 0; }
hash16() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c1-16; }
capture() { tmux capture-pane -p -J -S -${plan.tailLines} -t '${plan.paneId}' 2>/dev/null; }
f="$HOME/.claude/sessions/${plan.sessionFile}"
[ -f "$f" ] || result refused_target_changed "${FILE_GONE}"
fields=$(head -c 65536 "$f" | tr -d '\n' | grep -o '"\(pid\|sessionId\|status\|procStart\)" *: *\("[^"]*"\|[0-9.][0-9.]*\)')
field() { printf '%s\n' "$fields" | grep -o "^\"$1\" *: *\"[^\"]*\"" | head -1 | sed "s/^\"$1\" *: *\"//; s/\"\$//"; }
fpid=$(printf '%s\n' "$fields" | grep -o '^"pid" *: *[0-9][0-9]*' | head -1 | grep -o '[0-9][0-9]*$')
status=$(field status | cut -c1-32)
case $status in *[!A-Za-z0-9_-]*) status=invalid ;; esac
[ "$(field sessionId)" = '${plan.sessionId}' ] || result refused_target_changed "${SESSION_ID_CHANGED}"
[ "$(field procStart)" = '${plan.procStart}' ] || result refused_target_changed "${PROC_START_CHANGED}"
[ "$fpid" = '${plan.pid}' ] || result refused_target_changed "${PID_CHANGED}"
kill -0 '${plan.pid}' 2>/dev/null || result refused_target_changed "${PROCESS_GONE}"
pane_pid=$(tmux display-message -p -t '${plan.paneId}' '#{pane_pid}' 2>/dev/null)
case $pane_pid in ''|*[!0-9]*) result refused_target_changed "${PANE_CHANGED}" ;; esac
table=$(ps -A -o pid=,ppid= 2>/dev/null)
parent_of() { printf '%s\n' "$table" | while read -r a b; do if [ "$a" = "$1" ]; then printf '%s\n' "$b"; break; fi; done; }
p='${plan.pid}' hops=0 held=0
while [ "$held" = 0 ]; do
  if [ "$p" = "$pane_pid" ]; then held=1; break; fi
  [ "$hops" -lt 6 ] || break
  p=$(parent_of "$p"); hops=$((hops + 1))
  case $p in ''|0|1|*[!0-9]*) break ;; esac
done
[ "$held" = 1 ] || result refused_target_changed "${PANE_CHANGED}"
case $status in idle|busy) ;; '') result refused_menu_visible "status missing" ;; *) result refused_menu_visible "status $status" ;; esac
tail=$(capture) || result refused_target_changed "${PANE_CHANGED}"
before=$(printf '%s\n' "$tail" | hash16)
menu_at_line_start() { printf '%s\n' "$tail" | { while IFS= read -r l; do case $l in "$1"*|" $1"*|"  $1"*|"   $1"*) exit 0 ;; esac; done; exit 1; }; }
for a in ${anchors}; do
  if menu_at_line_start "$a"; then result refused_menu_visible "$a"; fi
done
mode=$(tmux display-message -p -t '${plan.paneId}' '#{pane_in_mode}' 2>/dev/null)
case $mode in 0) ;; 1) result refused_menu_visible "${PANE_IN_COPY_MODE}" ;; *) result refused_target_changed "${PANE_CHANGED}" ;; esac
payload() { printf '%s' '${plan.textB64}'; }
payload | base64 -d >/dev/null 2>&1 || result failed "${DECODE_FAILED}"
payload | base64 -d | tmux load-buffer -b ${plan.bufferId} - || result failed "${tmuxStep(1)}"
tmux paste-buffer -p -d -b ${plan.bufferId} -t '${plan.paneId}' || { tmux delete-buffer -b ${plan.bufferId} 2>/dev/null; result failed "${tmuxStep(2)}"; }
tmux send-keys -t '${plan.paneId}' Enter || result failed "${tmuxStep(3)}"
sleep 0.5
after=$(printf '%s\n' "$(capture)" | hash16)
result sent ""`;
}

/**
 * The delivery command for one Submit. Throws {@link ProbeError} on any value outside its allow-list —
 * before any command text exists; the Submit route turns that into a `failed` outcome.
 */
export function buildDeliverCommand(plan: DeliverPlan): RemoteCommand {
  const pid = assertInteger(plan.pid, "pid", 1, MAX_PID);
  const sessionFile = assertString(plan.sessionFile, SESSION_FILE_RE, "sessionFile — expected '<pid>.json'");
  if (sessionFile !== `${pid}.json`) throw new ProbeError("invalid sessionFile — expected the plan's own '<pid>.json'");
  const sessionId = assertString(plan.sessionId, SESSION_ID_RE, "sessionId — expected a lowercase UUID");
  const procStart = assertString(plan.procStart, PROC_START_RE, "procStart — expected 1–64 letters, digits, spaces, ':', '+', '.' or '-'");
  const paneId = assertString(plan.paneId, PANE_ID_RE, "pane id — expected '%' followed by 1–6 digits");
  const textB64 = assertTextB64(plan.textB64);
  const bufferId = assertString(plan.bufferId, BUFFER_ID_RE, "bufferId — expected 'console-' followed by 8 lowercase hex digits");
  const tailLines = assertInteger(plan.tailLines, "tailLines", 1, MAX_TAIL_LINES);
  // Template guard, not a plan value: an anchor outside this set would break the quoting or the record.
  const anchors = MENU_ANCHORS.map((a) => `'${assertString(a, ANCHOR_RE, "menu anchor — a template defect")}'`).join(" ");
  return mintScript(deliverScript({ sessionFile, sessionId, procStart, pid, paneId, textB64, bufferId, tailLines }, anchors));
}

const failed = (detail: string): DeliverReport => ({ outcome: "failed", statusAtSend: "", detail });

/**
 * The machine-reportable outcomes only: `unconfirmed` is not among them (ruling T11-18), so a record claiming it is
 * malformed — only this parser decides a send could not be confirmed.
 */
const isOutcome = (value: string): value is SubmitOutcome => OUTCOMES.has(value);

/** The exits that stop before anything is read or written: 126, a missing tool (the script's guards); 127, no shell. */
const PRE_READ_EXITS: ReadonlySet<number> = new Set([126, 127]);

/**
 * Never throws. The first `PANTHEON_DELIVER:result:` line of stdout is the report; foreign lines (login
 * banners, direnv) around it are ignored. Stderr is never read, and a record field outside its shape (outcome,
 * status token, 16-hex hashes, known detail) is withheld or fails the record, so machine text never reaches
 * `detail`. Ruling T11-18: the record is written last, after the paste and Enter, so no record at all is
 * `unconfirmed` (detail `no_record`) — the text may already sit in the pane — except an exit by the pre-read tool
 * guards (126/127), which is `failed`; a `tmux step 3` failure (Enter refused after a successful paste) is
 * `unconfirmed` (detail `tmux_step_3`). A non-zero exit beside a record is `failed` with a first-party detail.
 */
export function parseDeliverOutput(stdout: string, code: number): DeliverReport {
  const line = stdout
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .find((l) => l.startsWith(RESULT_PREFIX));
  if (line === undefined) {
    return PRE_READ_EXITS.has(code) ? failed("the delivery script did not report back") : { outcome: "unconfirmed", statusAtSend: "", detail: "no_record" };
  }
  if (code !== 0) return failed(`the delivery script exited with code ${code}`);
  const fields = line.slice(RESULT_PREFIX.length).split(":");
  if (fields.length !== 5) return failed("the delivery script reported a malformed record");
  const [outcome = "", status = "", before = "", after = "", detail = ""] = fields;
  if (!isOutcome(outcome) || !STATUS_RE.test(status) || !HASH_RE.test(before) || !HASH_RE.test(after)) {
    return failed("the delivery script reported a malformed record");
  }
  const enterLost = outcome === "failed" && detail === tmuxStep(3);
  return {
    outcome: enterLost ? "unconfirmed" : outcome,
    statusAtSend: status,
    detail: enterLost ? "tmux_step_3" : KNOWN_DETAILS.has(detail) || STATUS_DETAIL_RE.test(detail) ? detail : "the delivery script reported an unrecognised detail",
    ...(before !== "" ? { tailHashBefore: before } : {}),
    ...(after !== "" ? { tailHashAfter: after } : {})
  };
}
