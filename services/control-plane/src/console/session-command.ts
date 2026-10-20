/**
 * Maestro Console new-session flow — the two remote commands behind the console's New Session and New Project
 * controls (spec §14.1, plan Task 8; TM-020 remote-command surface): the folder list of a machine's projects root
 * and the creation of one detached tmux session running `claude`, in an existing folder or in one the script makes
 * first. The routes (`http/routes/console-sessions.ts`) mint both here, run them over the existing key-only SSH
 * path and read their records with the two parsers.
 *
 * Security:
 * - Both commands are {@link RemoteCommand}s minted by `mintScript` (probe-command.ts): the same absolute-path PATH
 *   prefix and the same QUOTED heredoc into `/bin/sh`, so the login shell expands nothing in the body. Every value
 *   passes its allow-list BEFORE any command text exists — a folder name {@link PROJECT_NAME_RE} (no slash, no
 *   leading dot, no quote: spec §14.1.4), a directory `remoteDirProblem` (tmux.ts: absolute, ≤ 512 bytes, no `'`,
 *   no `#` — tmux expands formats in `-c` (ruling T11-5) — no C0/C1 control, lone surrogate or bidi control, no
 *   `..` segment), a tmux session name `TMUX_SESSION_NAME_RE` — and is then
 *   single-quoted. Refusals name the rule, never the value. An EXISTING project folder is admitted by exactly one
 *   rule, {@link admissiblePath} (ruling T8-7), applied by the list route to every path the machine reported
 *   (`trusted:false`) and by the create route to a requested folder, so what is listed is what can be started.
 * - The create script sets no locale (ruling T8-6): when no tmux server is running, `new-session -d` copies the
 *   script's environment into the new server's global environment, which every later window would inherit.
 * - The list reads only: `find` on the root (depth-1 directories, depth-2 directories holding a `.git` entry,
 *   hidden names skipped) and each path travels base64 behind the sentinel, printed by the per-path shell that
 *   `find -exec … {} +` hands the paths to — no `read` loop, so a newline in a name can neither split nor forge a
 *   record. The create script writes exactly what it says: one `mkdir` (never `-p`, never `git init`) when the plan
 *   asks for a new folder, then `tmux new-session -d`; nothing else is written and nothing under `~/.claude` is
 *   touched.
 * - Ruling T8-3: the create script prepends `$HOME/.local/bin` (where the native installer puts `claude`) to the
 *   minted PATH and resolves `claude` with `command -v`; the same PATH is handed to the new session
 *   (`new-session -e`, tmux ≥ 3.2), because a session joining a RUNNING tmux server inherits the server's
 *   environment, not the script's. Every outcome is a labelled record — `claude not found`, `folder exists`,
 *   `mkdir failed`, `folder missing`, `session already exists` (the `has-session` miss: ruling T8-2's race guard
 *   behind the route's suffixing) and `tmux new-session failed` — so the parser never depends on an exit code alone.
 * - POSIX `sh` only (bash-3.2-safe; BSD and GNU userland). A missing `base64` / `tmux` exits 126 before anything
 *   is read or written.
 *
 * Record grammars (one record per stdout line; foreign lines around them — login banners, direnv — are ignored):
 *   PANTHEON_PROJECTS:<path_b64>        one per folder; the script exits 0 after the listing, 2 when the root is
 *                                       not a directory (the route labels it); unreadable subfolders are skipped
 *   PANTHEON_SESSION:created:<name>     exactly one line; the script exits 0 after writing it
 *   PANTHEON_SESSION:failed:<detail>    `detail` is one of this module's literals; the parser withholds anything else
 */

import { posix } from "node:path";
import { type RemoteCommand } from "../devmachine/connection.js";
import { remoteDirProblem, TMUX_SESSION_NAME_MAX, TMUX_SESSION_NAME_RE } from "../devmachine/tmux.js";
import { BASE64_GUARD, ProbeError, mintScript } from "./probe-command.js";

/** Every project record starts with this, so shell-profile chatter on stdout is recognisable. */
export const PROJECTS_SENTINEL = "PANTHEON_PROJECTS:";
/** The create script's single result record starts with this. */
export const SESSION_SENTINEL = "PANTHEON_SESSION:";
/** Output cap of the project list (spec §14.1): room for ~2 000 base64 paths; the create script keeps the 64 KiB default. */
export const LIST_PROJECTS_MAX_OUTPUT_BYTES = 256 * 1024;
/**
 * Allow-list for a project folder name (spec §14.1.4): 1–64 letters, digits, spaces, `.`, `_` or `-`, starting with a
 * letter or digit — no slash, no leading dot, no quote, no control character.
 */
export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export interface ProjectEntry {
  /** The folder's basename. */
  readonly name: string;
  /** The folder's absolute path on the machine. */
  readonly path: string;
}

export interface ProjectListing {
  /** Sorted by name (case-insensitively, then exactly), then by path. */
  readonly projects: readonly ProjectEntry[];
  /** Sentinel records that were not a usable folder: a name outside {@link PROJECT_NAME_RE}, a path outside the remote-directory rule, bad base64. */
  readonly dropped: number;
}

export interface CreateSessionPlan {
  /** The tmux session to create: already suffixed against the live list by the route. */
  readonly tmuxName: string;
  /** The session's working directory (absolute, under the projects root). */
  readonly cwd: string;
  /** True for New Project: the script makes `cwd` first (plain `mkdir`) and refuses when anything is already there. */
  readonly mkdir: boolean;
}

export type CreateSessionReport =
  | { readonly outcome: "created"; readonly tmuxName: string }
  /** `detail` is first-party text only: this module's literals or the parser's own messages — never machine output. */
  | { readonly outcome: "failed"; readonly detail: string }
  /** Ruling T11-18: no record came back, so the session may or may not have been started. */
  | { readonly outcome: "unconfirmed"; readonly detail: "no_record" };

/** The failure details the create script writes (first-party; the parser admits exactly these). */
const CLAUDE_NOT_FOUND = "claude not found";
const FOLDER_EXISTS = "folder exists";
const MKDIR_FAILED = "mkdir failed";
const FOLDER_MISSING = "folder missing";
const SESSION_EXISTS = "session already exists";
const NEW_SESSION_FAILED = "tmux new-session failed";
const KNOWN_DETAILS: ReadonlySet<string> = new Set([CLAUDE_NOT_FOUND, FOLDER_EXISTS, MKDIR_FAILED, FOLDER_MISSING, SESSION_EXISTS, NEW_SESSION_FAILED]);
/** The parser's detail for a record outside the grammar — the route reuses it for a `created` name that is not the plan's. */
export const MALFORMED_RECORD_DETAIL = "the session script reported a malformed record";

/** Standard alphabet with canonical padding; a round trip through `Buffer` then rejects non-canonical trailing bits. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Every code point a tmux session name cannot carry (one `-` per code point, not per UTF-16 unit). */
const NOT_TMUX_SAFE_RE = /[^A-Za-z0-9_-]/gu;
/** The machine-shell namespace (Task 7's `sh-<logicalName>`): a project session must never land in it. */
const SHELL_NAMESPACE_PREFIX = "sh-";

/** The name itself, or a {@link ProbeError} naming the rule (never the value). */
export function assertProjectName(v: unknown): string {
  if (typeof v !== "string" || !PROJECT_NAME_RE.test(v)) {
    throw new ProbeError("invalid project name — expected 1–64 letters, digits, spaces, '.', '_' or '-', starting with a letter or digit");
  }
  return v;
}

/** The remote-directory allow-list of tmux.ts, refused as a {@link ProbeError} like every other value here. */
function assertDirectory(value: unknown, what: string): string {
  if (typeof value !== "string") throw new ProbeError(`invalid ${what} — expected a string`);
  const problem = remoteDirProblem(value);
  if (problem !== undefined) throw new ProbeError(`invalid ${what} — ${problem}`);
  return value;
}

function assertTmuxName(value: unknown): string {
  if (typeof value !== "string" || !TMUX_SESSION_NAME_RE.test(value)) {
    throw new ProbeError("invalid tmux session name — expected 1–64 letters, digits, '_' or '-' (not starting with '-')");
  }
  return value;
}

/**
 * The tmux session name for a folder: its basename with every code point outside `[A-Za-z0-9_-]` turned into `-`, a
 * leading `-` into `_`, a name starting with `sh-` prefixed `p-` (ruling T8-5: `sh-*` sessions are machine shells —
 * never project tabs, never Submit targets — so a project named `sh-foo` would otherwise vanish from the console),
 * then cut to {@link TMUX_SESSION_NAME_MAX}. Collisions with live sessions are the route's job (suffix `-2`, `-3`, …
 * against the live list).
 */
export function tmuxNameForFolder(folder: string): string {
  const mapped = posix.basename(folder).replace(NOT_TMUX_SAFE_RE, "-").replace(/^-/, "_");
  return (mapped.startsWith(SHELL_NAMESPACE_PREFIX) ? `p-${mapped}` : mapped).slice(0, TMUX_SESSION_NAME_MAX);
}

/**
 * The segments of `path` below `root` (both resolved with `posix.resolve`, so `.`/`..`/`//` cannot fool the prefix
 * check), or undefined when the path is not STRICTLY under the root — the root itself, a sibling such as
 * `<root>-other/x`, an absolute path elsewhere, a `..` escape. Both must be absolute: `posix.resolve` would place a
 * relative one under the server process's own working directory, which says nothing about the machine. Lexical
 * only: a symlink inside the root may point outside it (recorded residual).
 */
export function segmentsUnderRoot(root: string, path: string): readonly string[] | undefined {
  if (!root.startsWith("/") || !path.startsWith("/")) return undefined;
  const base = posix.resolve(root);
  const prefix = base === "/" ? base : `${base}/`;
  const resolved = posix.resolve(path);
  // Triage 70: the root itself is never under the root (for "/" it would otherwise read as one empty segment).
  if (resolved === base) return undefined;
  return resolved.startsWith(prefix) ? resolved.slice(prefix.length).split("/") : undefined;
}

/**
 * The ONE admissibility rule for an EXISTING project folder (ruling T8-7): strictly under the root
 * ({@link segmentsUnderRoot}); no segment below the root starts with `.`; the remote-directory rule
 * (`remoteDirProblem`) holds for the path as given; the basename matches {@link PROJECT_NAME_RE}. Parent segments
 * are NOT held to `PROJECT_NAME_RE` — `Parent & Co/child` is admissible — because only the folder being started is
 * named; the quote and control-character bans come from the remote-directory rule for the whole path. A NEW
 * project is a different rule: a single `PROJECT_NAME_RE` name placed directly under the root (the route's job).
 */
export function admissiblePath(root: string, path: string): boolean {
  const segments = segmentsUnderRoot(root, path);
  if (segments === undefined || segments.some((segment) => segment.startsWith("."))) return false;
  if (remoteDirProblem(path) !== undefined) return false;
  return PROJECT_NAME_RE.test(segments[segments.length - 1] ?? "");
}

/**
 * One record per path: the sentinel, then the path base64 on one line. Double quotes only — the loop is
 * single-quoted into `find -exec sh -c`, whose `$d` is a positional argument, never interpolated into syntax.
 */
const EMIT_RECORD = String.raw`printf "${PROJECTS_SENTINEL}%s\n" "$(printf "%s" "$d" | base64 | tr -d "\n")"`;
const EMIT_DEPTH_1 = `for d; do ${EMIT_RECORD}; done`;
/** `$0` is the root: a directory under a hidden depth-1 parent is skipped; a depth-2 directory counts only with a `.git` entry (a file for a worktree). */
const EMIT_DEPTH_2 = String.raw`for d; do case $d in "$0"/.*) continue ;; esac; if [ -e "$d/.git" ]; then ${EMIT_RECORD}; fi; done`;

/**
 * The listing script over a validated root. `find` errors (an unreadable subfolder) only drop that entry — stderr is
 * never read and the script ends with `exit 0` — while a root that is not a directory is exit 2 before any `find`.
 */
function listProjectsScript(root: string): string {
  return String.raw`export LC_ALL=C
${BASE64_GUARD}
[ -d '${root}' ] || { echo "projects: root is not a directory" >&2; exit 2; }
find '${root}' -mindepth 1 -maxdepth 1 -type d ! -name '.*' -exec sh -c '${EMIT_DEPTH_1}' sh {} + 2>/dev/null
find '${root}' -mindepth 2 -maxdepth 2 -type d ! -name '.*' -exec sh -c '${EMIT_DEPTH_2}' '${root}' {} + 2>/dev/null
exit 0`;
}

/**
 * The project list of one machine. Throws {@link ProbeError} when the root fails the remote-directory rule — before
 * any command text exists (the settings loader applied the same rule, so a throw here is a defect).
 */
export function buildListProjectsCommand(root: string): RemoteCommand {
  return mintScript(listProjectsScript(assertDirectory(root, "projects root")));
}

/**
 * Triage 18 (IV-6): fatal, so a path that is not well-formed UTF-8 (a stray byte, CESU-8, an overlong form) is
 * dropped and counted instead of being listed with U+FFFD, which `[ -d ]` on the machine could never find. A BOM is
 * kept as data (`ignoreBOM`), so the decoded path is exactly the bytes the machine reported.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The decoded path of one record, or undefined for anything but canonical base64 of well-formed UTF-8. */
function decodePath(b64: string): string | undefined {
  if (b64 === "" || !BASE64_RE.test(b64)) return undefined;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.toString("base64") !== b64) return undefined;
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Case-insensitive by name, then exact name, then path — plain code-unit comparisons, so the order is the same everywhere. */
function byName(a: ProjectEntry, b: ProjectEntry): number {
  const al = a.name.toLowerCase();
  const bl = b.name.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Never throws. Every `PANTHEON_PROJECTS:` line of stdout is one folder; a record whose path is not canonical base64,
 * fails the remote-directory rule or whose basename fails {@link PROJECT_NAME_RE} is dropped and counted. The parser
 * has no root: containment and hidden segments are {@link admissiblePath}'s, which the list route applies to every
 * path returned here and counts into `dropped` as well. Foreign lines are ignored silently.
 */
export function parseListProjectsOutput(stdout: string): ProjectListing {
  const projects: ProjectEntry[] = [];
  let dropped = 0;
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith(PROJECTS_SENTINEL)) continue;
    const path = decodePath(line.slice(PROJECTS_SENTINEL.length));
    const name = path === undefined ? undefined : posix.basename(path);
    if (path === undefined || name === undefined || remoteDirProblem(path) !== undefined || !PROJECT_NAME_RE.test(name)) {
      dropped++;
      continue;
    }
    projects.push({ name, path });
  }
  projects.sort(byName);
  return { projects, dropped };
}

/**
 * The create script over validated values. `result` writes the one record and exits 0, so every outcome is data
 * and a non-zero exit means the script could not run. `String.raw` keeps `\n` for the shell's `printf`; the only
 * `${…}` substitutions are the builder's. No `LC_ALL` here (ruling T8-6): nothing in the script needs the C locale,
 * and a fresh tmux server would inherit it for every later window. The `has-session` guard runs before the folder
 * step (ruling T11-18), so "session already exists" never sits over a folder this script has just made.
 */
function createSessionScript(plan: CreateSessionPlan): string {
  const folder = plan.mkdir
    ? String.raw`[ -e '${plan.cwd}' ] && result failed "${FOLDER_EXISTS}"
mkdir '${plan.cwd}' || result failed "${MKDIR_FAILED}"`
    : String.raw`[ -d '${plan.cwd}' ] || result failed "${FOLDER_MISSING}"`;
  return String.raw`PATH="$HOME/.local/bin:$PATH"; export PATH
command -v tmux >/dev/null 2>&1 || { echo "session: tmux not found" >&2; exit 126; }
result() { printf '${SESSION_SENTINEL}%s:%s\n' "$1" "$2"; exit 0; }
command -v claude >/dev/null 2>&1 || result failed "${CLAUDE_NOT_FOUND}"
tmux has-session -t '=${plan.tmuxName}' 2>/dev/null && result failed "${SESSION_EXISTS}"
${folder}
tmux new-session -d -s '${plan.tmuxName}' -c '${plan.cwd}' -e "PATH=$PATH" claude || result failed "${NEW_SESSION_FAILED}"
result created '${plan.tmuxName}'`;
}

/**
 * The creation command for one New Session / New Project. Throws {@link ProbeError} on any value outside its
 * allow-list — before any command text exists; the route turns that into a `failed` outcome.
 */
export function buildCreateSessionCommand(plan: CreateSessionPlan): RemoteCommand {
  const tmuxName = assertTmuxName(plan.tmuxName);
  const cwd = assertDirectory(plan.cwd, "working directory");
  if (typeof plan.mkdir !== "boolean") throw new ProbeError("invalid mkdir flag — expected true or false");
  return mintScript(createSessionScript({ tmuxName, cwd, mkdir: plan.mkdir }));
}

const failed = (detail: string): CreateSessionReport => ({ outcome: "failed", detail });

/** The exits that stop before anything is read or written: 126, a missing tool (the script's guard); 127, no shell. */
const PRE_READ_EXITS: ReadonlySet<number> = new Set([126, 127]);

/**
 * Never throws. The first `PANTHEON_SESSION:` line of stdout is the report; foreign lines around it are ignored.
 * Ruling T11-18: the record is written after `tmux new-session`, so no record at all is `unconfirmed` (the session
 * may exist) — except an exit by the pre-read tool guard (126/127), which is `failed`. A non-zero exit beside a
 * record is `failed` with a first-party detail — stderr is never read, a `created` name outside the tmux allow-list
 * fails the record, and a `failed` detail outside this module's literals is withheld, so machine text never reaches
 * `detail`.
 */
export function parseCreateSessionOutput(stdout: string, code: number): CreateSessionReport {
  const line = stdout
    .split("\n")
    .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
    .find((l) => l.startsWith(SESSION_SENTINEL));
  if (line === undefined) return PRE_READ_EXITS.has(code) ? failed("the session script did not report back") : { outcome: "unconfirmed", detail: "no_record" };
  if (code !== 0) return failed(`the session script exited with code ${code}`);
  const body = line.slice(SESSION_SENTINEL.length);
  const sep = body.indexOf(":");
  if (sep < 0) return failed(MALFORMED_RECORD_DETAIL);
  const outcome = body.slice(0, sep);
  const value = body.slice(sep + 1);
  if (outcome === "created") return TMUX_SESSION_NAME_RE.test(value) ? { outcome: "created", tmuxName: value } : failed(MALFORMED_RECORD_DETAIL);
  if (outcome === "failed") return failed(KNOWN_DETAILS.has(value) ? value : "the session script reported an unrecognised detail");
  return failed(MALFORMED_RECORD_DETAIL);
}
