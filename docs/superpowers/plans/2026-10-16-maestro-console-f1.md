# Maestro Console F1 (read-only feed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tab inside the Pantheon harness that shows every Claude Code session in tmux on every registered dev machine, its state (NEEDS YOU / WORKING / IDLE / IN SHELL / UNKNOWN), one card per reply with a masked TL;DR, and the full text / why / what-it-did fetched live on expand — reading everything over the harness's existing SSH access, storing only masked card faces, and never acting on a session.

**Architecture:** A new `src/console/` module inside the control-plane: a poller runs ONE allow-listed remote probe script per machine per 5 s over `runRemoteCommand`; the probe reports tmux panes, `~/.claude/sessions/*.json` (allow-listed fields only), transcript bytes after a stored offset, pane tails and the pending-approval sentinel; a card builder splits transcript turns, masks secrets and writes card faces to two additive SQLite tables; a guarded page (`/console`) with two tab rows and cards reads them and fetches expand content live. Everything is a labeled state; nothing throws toward the browser; nothing a session wrote is ever sent back to a session.

**Tech Stack:** Node 24 / strict TypeScript 5 / Fastify 5 / better-sqlite3 (exact-pinned, no new dependencies); server-rendered HTML + plain browser JS shipped as template-literal strings; vitest (node + jsdom); POSIX `sh` + `tmux` + `base64` on the dev machines (no Node or jq assumed there).

**Spec:** `docs/superpowers/specs/2026-10-16-maestro-console-design.md` §4–§11 (F1 rows), ADR-0010, PRODUCT_MANIFESTO §5 amendment 2026-10-16.

**Amendment 2026-10-16 (Karl, ruling A1):** F1 is committed **once**, in Task 12, after the audit and the documentation. Tasks 1–11 end in a reviewed checkpoint, not a commit — see Global Constraints.

## Global Constraints

- Build Loop per feature: `scripts/process-checklist.sh --start-feature "maestro-console-f1"` before Task 1 (Karl first clears the lingering `bugs-48-tmux-clipboard-osc52` loop — Orchestrator-only reset); mark `build_loop:tests_written` and `tests_verified_failing` after the first RED (Task 1), `implemented` after Task 11 (full suite green), `security_audit` (needs `docs/security-audits/maestro-console-f1-security-audit.md`) and `documentation_updated` in Task 12, then `scripts/test-gate.sh --record-feature "maestro-console-f1"` (gate goes 1/2).
- Commits (ruling A1, 2026-10-16): **one commit for all of F1**, made in Task 12 after the audit and the documentation. `scripts/process-checklist.sh --check-commit-ready` blocks any commit that stages a `.ts`, `src/` or loose `.txt` file until the first five Build Loop steps are marked (`scripts/process-checklist.sh:152-180`, `:838-911`), so tasks 1–11 **do not commit**. Each ends in a checkpoint: the task's reviewer verdict in the task notes, then `git add -N <each new file of the task>` (intent-to-add, explicit paths, never a directory) and `git diff HEAD > "$F1_CHECKPOINTS/task-NN-<slug>.patch"`, with `F1_CHECKPOINTS="$HOME/Documents/Claude Projects/Pantheon/f1-checkpoints"` — outside the repo, so it survives `/clear` and a reboot, which the session scratchpad under `/private/tmp` does not. The final commit stages files by explicit path only, records the approval question in `.claude/pending-approval.json` (schema 2) and stops — Karl replies with the option id — then a lone `git commit -m "…"` in its own Bash call (approval design B). Never `git push main` from the agent; Karl pushes both remotes.
- Expected side effect of the ruling: while F1 is in progress the CDF stop hook reports "Uncommitted source changes" once per session (then stays silent for the same set). That is the ruled state — never a reason to commit early, to mark a Build Loop step that was not performed, or to delete work.
- Strict TS (`exactOptionalPropertyTypes` style: spread optionals as `...(x ? { x } : {})`), `eslint` clean, `tsc` clean, suite green (`npm test` in `services/control-plane`). Exact-pinned deps only; **no new dependency**.
- F1 **acts on no session**: no `send-keys`, no `paste-buffer`, no `load-buffer`, no `kill`, no writes under `~/.claude` on any dev machine. The only remote commands are the two minted here (probe, expand) and both are read-only.
- One SSH dial per machine per poll, at most one probe in flight per machine; `maxOutputBytes` 2 MiB for the probe only (spec §5); default 64 KiB everywhere else.
- Store **only** the masked card face (`tldr_masked` ≤ 1 KiB) and pointers; no full text, reasoning or tool output is ever written to SQLite (R1). Masking runs before storage, before display, over complete lines only.
- Probe reads only `~/.claude/sessions/*.json` (never `*.key`), and of those only `pid, sessionId, cwd, name, status, waitingFor, tmux, procStart, version, kind`; never `bridgeSessionId` or `messagingSocketPath`.
- Every state shown as colour **+ glyph + word** (CC1): `!` NEEDS YOU · `⟳` WORKING · `✓` IDLE · `$` IN SHELL · `?` UNKNOWN STATUS ‹value› · `✕` UNREACHABLE · `⚠` CAN'T READ · `○` ENDED. Unknown `status` is never mapped to IDLE.
- Fail visible (spec §9): machine unreachable, format changed, unknown status, session ended, expand fetch failed, settings invalid — each a labeled state in the UI; a malformed settings file disables the console module only, with a banner naming the entry; the rest of the harness keeps running.
- All console routes sit behind the existing operator guard; none is added to `PUBLIC_PATHS`; keycards cannot reach them (TM-011). JSON responses carry `Cache-Control: no-store`.
- Settings file path from env `PANTHEON_CONSOLE_SETTINGS` (default `data/console-settings.json` beside the DB); poll 5 s; cards retention 90 days; areas list and project map as in spec §7.
- Transcript fixtures under `test/fixtures/console/` are **scrubbed copies** (masked with the Task 2 masker before being committed; a `fixtures/README.md` says where each came from and that it was scrubbed). No real token, path of the form `/Users/<name>` other than `/Users/karl`, or hostname that is not already in the repo.

## Review Focus

Inputs the spec implies but no F1 row tests by name — each pinned to its owning task below:

1. **A transcript line of 10 MB (one giant tool result) in the slice** — the builder must cap per-line parsing and count the line as "ignored (too long)" instead of stalling the poll. → Task 5.
2. **Two Claude sessions whose `tmux` field names the same pane** (a stale `sessions/*.json` from a dead process beside the live one) — the live pid (`kill -0` in the probe) wins; the stale one is listed as ENDED, never merged. → Task 3 (probe reports liveness) and Task 6 (card builder picks the live one).
3. **Transcript rotated or deleted between polls** (`/clear` starts a new `sessionId`) — stored offset larger than the file: the probe reports `size < offset`, the builder resets the offset to 0 and marks the session's cards as belonging to the previous `sessionId`; no exception. → Task 3 and Task 6.
4. **Pane tail containing the literal text of a menu fixture inside a code block the user pasted** (false NEEDS YOU) — fixtures anchor on the menu's own line start (`❯ 1. ` at column 0, `Enter to select` on its own line); a quoted copy indented inside a fence does not match. → Task 6.
5. **A machine that answers SSH but has no tmux server and no `~/.claude/sessions`** — the probe must exit 0 with an empty report (not `tmux: no server running` as a failure), shown as a machine with zero projects, not UNREACHABLE. → Task 3.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/console/settings.ts` | parse + validate the JSON settings file; defaults; `{ok:false, entry, message}` on a bad entry (never throws) |
| `src/console/masking.ts` | `maskSecrets` — the §8.4 patterns, complete-line masking |
| `src/console/probe-command.ts` | allow-listed builders for the two remote scripts (`buildProbeCommand`, `buildExpandCommand`) — new `RemoteCommand` mint sites |
| `src/console/probe.ts` | run a probe over `RemoteExec`, parse sentinel-framed records into a `ProbeReport`, labeled failure states |
| `src/console/transcript.ts` | JSONL → turns (§6.4), TL;DR extraction, partial-line carry-over, line-type counting |
| `src/console/cards.ts` | session state (§6.2), needs-you signals 0–2 (§6.3) with menu fixtures, card faces |
| `src/console/store.ts` | `SqliteConsoleStore`: `console_session`, `console_card` (additive DDL, ruling A) |
| `src/console/poller.ts` | the 5 s loop: per-machine probe, builder, store; start/stop; non-overlapping ticks; unref |
| `src/console/expand.ts` | on-demand live read of one turn (R1) via `buildExpandCommand`; renders full text / why / what-it-did; persists nothing |
| `src/http/console-page.ts` | server-rendered `/console` page + `CONSOLE_CLIENT_JS` (two tab rows, cards, expand, banners) |
| `src/http/routes/console.ts` | guarded routes: page, `GET /console/api/state`, `GET /console/api/cards/:id/expand` |
| `src/http/app.ts` | `AppOptions.console?`; mount the routes; harness header link |
| `src/http/harness-frame.ts` | header link `data-nav="console"` |
| `src/server.ts` | load settings, build store + poller, start on listen, stop on close; `PANTHEON_CONSOLE_SETTINGS` |
| `src/devmachine/connection.ts` | comment at line 20: the brand is minted by `tmux.ts` **and** `console/probe-command.ts` |
| `test/fixtures/console/` | scrubbed transcripts, `sessions/*.json` per Claude version, pane captures, a schema-2 and a v1 sentinel |
| `docs/security-audits/maestro-console-f1-security-audit.md` | Phase 2.4 audit artefact (gate requires it) |
| `FEATURES.md`, `CHANGELOG.md`, `PROJECT_BIBLE.md` §5/§9, `docs/user-guide.html`, `.env.local.example`, `deploy/README.md` | documentation |

---

### Task 1: Console settings file

**Files:**
- Create: `src/console/settings.ts`
- Test: `test/console-settings.test.ts`
- Modify: `.env.local.example` (add `PANTHEON_CONSOLE_SETTINGS=` with a comment)

**Interfaces:**
- Produces:
  ```ts
  export interface ProjectSettings { readonly display: string; readonly glyph: string; readonly border: string; readonly areas: readonly string[]; readonly hidden: boolean; }
  export interface ConsoleSettings {
    readonly pollSeconds: number;                       // default 5, allowed 2..60
    readonly retention: { readonly cardsDays: number }; // default 90, allowed 1..3650
    readonly areas: readonly string[];                  // default = spec §7 list (7 entries)
    readonly projects: Readonly<Record<string, ProjectSettings>>; // key = tmux session name, TMUX_SESSION_NAME_RE
    readonly allTabAreas: readonly string[];            // default ["fleet-sessions","general"]
    readonly skills: Readonly<Record<string, readonly string[]>>; // skill name → areas
  }
  export type ConsoleSettingsResult = { readonly ok: true; readonly settings: ConsoleSettings } | { readonly ok: false; readonly entry: string; readonly message: string };
  export const DEFAULT_CONSOLE_SETTINGS: ConsoleSettings;
  export function consoleSettingsFrom(raw: string | undefined): ConsoleSettingsResult;   // undefined / "" → ok with defaults
  export function loadConsoleSettings(path: string, readFile: (p: string) => string | undefined): ConsoleSettingsResult; // missing file → defaults
  ```
  `entry` is a JSON-pointer-like path (`projects.lancache.glyph`, `pollSeconds`); `message` never contains the offending value — only the entry name and the rule (same hygiene as `approvalSourcesFrom` in `src/approvals/sources.ts`). Reminder and Telegram keys from spec §7 are accepted and ignored in F1 (F3 reads them).

- [ ] **Step 1: Write the failing tests** in `test/console-settings.test.ts`:
  - `"an absent file yields the defaults (poll 5 s, 90 days, seven areas, no projects)"` — `loadConsoleSettings("/nope", () => undefined)` → `ok: true`, `settings.pollSeconds === 5`, `settings.retention.cardsDays === 90`, `settings.areas.length === 7`, `Object.keys(settings.projects).length === 0`.
  - `"the spec §7 example parses, with Dogfood hidden and lancache in four areas"` — paste the spec's JSON; `projects.Dogfood.hidden === true`, `projects.lancache.areas` deep-equals `["gate-safety","delivery","homelab-ops","general"]`.
  - `"a bad entry names the entry and the rule, never the value"` — `{"projects":{"solo":{"glyph":"<script>"}}}` → `ok: false`, `entry === "projects.solo.glyph"`, `message` does not contain `"<script>"`, message matches `/one to two visible characters/`.
  - `"an unknown area on a project is refused"` — `{"projects":{"solo":{"areas":["nope"]}}}` → `ok:false`, `entry === "projects.solo.areas[0]"`.
  - `"pollSeconds outside 2..60 is refused"` — `{"pollSeconds": 1}` → `ok:false`, `entry === "pollSeconds"`.
  - `"a project key that is not a tmux session name is refused"` — key `"bad name"` → `ok:false`, `entry === "projects[\"bad name\"]"`.
  - `"not-JSON is refused without echoing the text"` — `"{nope"` → `ok:false`, `entry === "(file)"`, message does not contain `"nope"`.
  - `"unknown top-level keys (reminders, telegram) are accepted and ignored"` — `ok: true`.
- [ ] **Step 2: Run to verify RED** — `npx vitest run test/console-settings.test.ts` → FAIL: cannot find module `../src/console/settings.js`.
- [ ] **Step 3: Implement** `src/console/settings.ts` with the signatures above. Glyph rule: `Array.from(glyph).length` between 1 and 2; `display` 1–40 chars matching `/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/`; `border` in `["solid","dashed","double","dotted","thick-left"]`; project key must pass `TMUX_SESSION_NAME_RE` (import from `../devmachine/tmux.js`); `hidden` defaults false; a project with only `hidden: true` is valid (display defaults to the key, glyph `"·"`, border `"solid"`, areas `[]`).
- [ ] **Step 4: Run to verify GREEN** — same command → all pass; then `npx tsc -p tsconfig.json --noEmit` and `npx eslint .` exit 0.
- [ ] **Step 5: Mark** `scripts/process-checklist.sh --complete-step build_loop:tests_written` and `…:tests_verified_failing` (first RED of the feature), then **checkpoint (no commit)**: reviewer verdict in the task notes; `git add -N src/console/settings.ts test/console-settings.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-01-settings.patch"`. Files of this task: `src/console/settings.ts test/console-settings.test.ts .env.local.example`.

### Task 2: Secret masking

**Files:**
- Create: `src/console/masking.ts`
- Test: `test/console-masking.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MASK = "[masked]";
  export interface MaskPattern { readonly name: string; readonly re: RegExp; }   // every re has the g flag
  export const MASK_PATTERNS: readonly MaskPattern[];
  export function maskSecrets(text: string): string;        // applies every pattern; idempotent
  export function maskCompleteLines(text: string): { readonly masked: string; readonly carry: string }; // last unterminated line is returned as carry, unmasked and NOT included in masked
  ```
  Patterns (names → regex source, all with `g`): `netbird` `nbp_[A-Za-z0-9_-]{20,}`; `github` `gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}`; `cloudflare` `(?<=\b(?:Bearer|cf|cloudflare|CF_API_TOKEN)[\s:=]+)[A-Za-z0-9_-]{40}\b`; `pantheon_keycard` `pk1_[0-9a-f]{64}`; `anthropic` `sk-ant-[A-Za-z0-9_-]{20,}`; `aws` `AKIA[0-9A-Z]{16}`; `private_key_block` `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`; `bearer` `(?<=\bBearer\s)[A-Za-z0-9._~+/=-]{16,}`; `telegram_bot` `\b\d{8,10}:[A-Za-z0-9_-]{35}\b`; `jwt` `\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`; `proxmox` `(?<=PVEAPIToken=)[^\s'"]+`; `tailscale` `tskey-[A-Za-z0-9_-]{10,}`; `gitea_hex` `(?<=\b(?:token|GITEA_TOKEN|Authorization)[\s:=]+(?:token\s)?)[0-9a-f]{40}\b`; `url_credentials` `(?<=://)[^\s/:@]+:[^\s/@]+(?=@)`; `env_secret` `(?<=\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|PRIVATE_KEY)[A-Z0-9_]*=)[^\s'"]{8,}`; `high_entropy_in_context` `(?<=\b(?:key|token|secret|password)\b[^\n]{0,20}?[:=]\s*["']?)[A-Za-z0-9+/_=-]{32,}`.

- [ ] **Step 1: Write the failing tests** in `test/console-masking.test.ts`:
  - one `it` per pattern name, e.g. `"masks a Pantheon keycard pk1_<64 hex>"` — input `"card: pk1_" + "a".repeat(64)` → output `"card: [masked]"`; use synthetic values for every pattern (never a real token).
  - `"leaves ordinary prose, hashes in commit lines and short words alone"` — `"fix 9348a52 tmux copy"` unchanged; `"the token count was 12"` unchanged.
  - `"is idempotent"` — `maskSecrets(maskSecrets(x)) === maskSecrets(x)`.
  - `"masks complete lines only and carries the unterminated tail"` — `"a pk1_<64hex>\nb sk-ant-abcdefghijklmnopqrstu"` → `masked === "a [masked]\n"`, `carry === "b sk-ant-abcdefghijklmnopqrstu"`.
  - **Mutation guard** `"every pattern bites: removing any one pattern lets its sample through"` — for each `p` in `MASK_PATTERNS`, build a masker from `MASK_PATTERNS.filter(q => q !== p)` and assert the sample for `p` is NOT fully masked (export a `maskWith(patterns, text)` helper to make this testable).
- [ ] **Step 2: Run to verify RED** — `npx vitest run test/console-masking.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/console/masking.ts` (`maskWith(patterns, text)` applies each `re` with `replace(re, MASK)`; `maskSecrets = (t) => maskWith(MASK_PATTERNS, t)`).
- [ ] **Step 4: Run to verify GREEN**; `tsc`, `eslint` exit 0.
- [ ] **Step 5: Checkpoint (no commit)** — reviewer verdict; `git add -N src/console/masking.ts test/console-masking.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-02-masking.patch"`.

### Task 3: Probe command builder and report parser

**Files:**
- Create: `src/console/probe-command.ts`, `src/console/probe.ts`
- Modify: `src/devmachine/connection.ts:20-22` (comment: brand minted by `tmux.ts` and `console/probe-command.ts`)
- Test: `test/console-probe-command.test.ts`, `test/console-probe-parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // probe-command.ts
  export const PROBE_SENTINEL = "PANTHEON_PROBE:";
  export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  export const PANE_ID_RE = /^%\d{1,6}$/;
  export interface ProbeSlice { readonly sessionId: string; readonly offset: number; }   // offset ≥ 0, ≤ 10^12
  export interface ProbePlan { readonly slices: readonly ProbeSlice[]; readonly panes: readonly string[]; readonly maxBytesPerSlice: number; readonly tailLines: number; }
  export function buildProbeCommand(plan: ProbePlan): RemoteCommand;        // throws ProbeError on any value outside its allow-list
  export function buildExpandCommand(sessionId: string, offsetStart: number, offsetEnd: number): RemoteCommand; // bytes [start,end) of the transcript, base64
  export class ProbeError extends Error {}
  export const PROBE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
  // probe.ts
  export interface ProbePane { readonly session: string; readonly windowId: string; readonly paneId: string; readonly panePid: number; readonly currentCommand: string; }
  export interface ProbeSessionFile { readonly pid: number; readonly sessionId: string; readonly cwd: string; readonly name?: string; readonly status: string; readonly waitingFor?: string; readonly tmux?: string; readonly procStart?: string; readonly version?: string; readonly kind?: string; readonly alive: boolean; }
  export interface ProbeSliceResult { readonly sessionId: string; readonly offset: number; readonly size: number; readonly bytes: Buffer; readonly truncated: boolean; readonly found: boolean; }
  export interface ProbeReport { readonly panes: readonly ProbePane[]; readonly sessions: readonly ProbeSessionFile[]; readonly slices: readonly ProbeSliceResult[]; readonly tails: ReadonlyMap<string, string>; readonly sentinels: ReadonlyMap<string, string>; readonly ignoredLines: number; readonly ended: boolean; }
  export type ProbeResult = { readonly state: "ok"; readonly report: ProbeReport } | { readonly state: "unreachable"; readonly message: string } | { readonly state: "failed"; readonly message: string; readonly remoteDetail?: string } | { readonly state: "cant_read"; readonly message: string };
  export function parseProbeOutput(stdout: string): ProbeReport;            // sentinel-prefixed lines only; others counted
  export async function runProbe(target: SshTarget, handle: string, exec: RemoteExec, plan: ProbePlan): Promise<ProbeResult>; // never throws
  ```
  The remote script (a constant in `probe-command.ts`, POSIX `sh`, bash-3.2-safe, `PATH` prefixed as in `tmux.ts`) emits, one record per line, `PANTHEON_PROBE:<kind>:<fields...>` where every free-text field is base64 (`base64` with newlines stripped server-side):
  - `pane:<session_name_b64>:<window_id>:<pane_id>:<pane_pid>:<pane_current_command_b64>` from `tmux list-panes -a -F …`; a missing tmux server emits nothing for panes and still exits 0 (Review Focus 5);
  - `session:<basename>:<alive 0|1>:<fields_b64>` for each `~/.claude/sessions/*.json` (never `*.key`) — fields extracted on the machine with `tr -d '\n' | grep -o '"\(pid\|sessionId\|cwd\|name\|status\|waitingFor\|tmux\|procStart\|version\|kind\)" *: *\("[^"]*"\|[0-9.][0-9.]*\)'` so only allow-listed keys cross the wire; `alive` = `kill -0 <pid>`;
  - `slice:<sessionId>:<offset>:<size>:<truncated 0|1>:<found 0|1>:<b64>` — transcript located by `find "$HOME/.claude/projects" -maxdepth 2 -name '<sessionId>.jsonl' | head -1`; bytes `tail -c +$((offset+1)) | head -c <max>`; `size` from `wc -c <`; when `size < offset` the slice is reported with `offset = 0` content and the stored offset is reset by Task 6 (Review Focus 3);
  - `tail:<pane_id>:<b64>` — `tmux capture-pane -p -J -S -<tailLines> -t '<pane_id>'`;
  - `sentinel:<sessionId>:<b64>` — `<cwd>/.claude/pending-approval.json` if it exists, capped 16 KiB;
  - `end` as the last line (absent → `ended: false`, the report is treated as truncated).
  Every interpolated value passes its regex first (`SESSION_ID_RE`, `PANE_ID_RE`, digits for offsets/pids) and is single-quoted; a plan with > 64 slices or > 256 panes throws `ProbeError`.

- [ ] **Step 1: Write the failing tests**:
  - `test/console-probe-command.test.ts`: `"the probe command starts with the PATH prefix and names only allow-listed values"` (contains `tmux list-panes -a`, `/.claude/sessions/*.json`, each sessionId and pane id from the plan, `head -c 1048576`); `"a sessionId that is not a UUID is refused before any command exists"` (`buildProbeCommand({slices:[{sessionId:"x; rm -rf /",offset:0}],…})` throws `ProbeError`); `"a pane id outside %digits is refused"`; `"an offset above 10^12 or negative is refused"`; `"more than 64 slices is refused"`; `"the command never contains send-keys, paste-buffer, load-buffer or kill-"` (regex over the string — the F1 read-only invariant); `"the expand command reads exactly the byte range"` (contains `tail -c +11 | head -c 90` for start 10, end 100); `"key files are never named"` (no `*.key` in the command).
  - `test/console-probe-parse.test.ts`: build a stdout string from records and assert `parseProbeOutput` yields one pane, one session file with `alive === true` and `status === "waiting"`, one slice decoded to the given bytes with `size` and `truncated`, one tail decoded, `ignoredLines` counting two foreign lines (`"direnv: loading"`, a banner), `ended === true`; `"a report without the end marker is marked not ended"`; `"a session file whose extracted fields lack pid or sessionId is dropped and counted"`; `"an alive flag other than 0/1 is read as not alive"`; `"base64 line wrapping (76 cols, macOS) is tolerated"`; and `runProbe` with a fake `RemoteExec`: `"a thrown SshConnectionError becomes unreachable with the logicalName only"` (message contains `"Mac-Mini"`, not `"karl@"`), `"exit 127 becomes failed with a first-party message"`, `"a report without end becomes cant_read"`.
- [ ] **Step 2: Run to verify RED** — both files FAIL (modules missing).
- [ ] **Step 3: Implement** `src/console/probe-command.ts` and `src/console/probe.ts`; update the comment in `src/devmachine/connection.ts` (brand minted by two allow-listing modules).
- [ ] **Step 4: Run to verify GREEN**; `tsc`, `eslint` exit 0.
- [ ] **Step 5: Live smoke (read-only, Karl present):** from a scratch script in the session's scratchpad, run `buildProbeCommand` against Mac-Mini through `runRemoteCommand` with `maxOutputBytes: PROBE_MAX_OUTPUT_BYTES` and print only the record kinds and counts (never the payloads). Expected: ≥ 1 `pane`, ≥ 1 `session`, `end`. Paste the counts into the task notes.
- [ ] **Step 6: Checkpoint (no commit)** — reviewer verdict (including the live-smoke counts from Step 5); `git add -N src/console/probe-command.ts src/console/probe.ts test/console-probe-command.test.ts test/console-probe-parse.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-03-probe.patch"`. Files of this task: those four plus `src/devmachine/connection.ts`.

### Task 4: Fixtures

**Files:**
- Create: `test/fixtures/console/README.md`, `test/fixtures/console/transcript-basic.jsonl`, `transcript-tool-result-user.jsonl`, `transcript-meta-and-system.jsonl`, `transcript-partial-tail.jsonl`, `transcript-empty-thinking.jsonl`, `sessions-2.1.284.json`, `sessions-2.1.292.json`, `sessions-2.1.301.json`, `sessions-unknown-status.json`, `pane-trust-prompt.txt`, `pane-permission-prompt.txt`, `pane-permission-while-busy.txt`, `pane-askuserquestion.txt`, `pane-cdf-render.txt`, `pane-bare-prompt.txt`, `pane-quoted-menu-in-fence.txt`, `sentinel-schema2.json`, `sentinel-v1.json`

- [ ] **Step 1: Capture** from the Mac-Mini (read-only, Karl present): one real transcript turn set per case via `tail -n` of a session's `.jsonl`, one `sessions/<pid>.json` per running Claude version (`jq 'del(.bridgeSessionId, .messagingSocketPath)'` on the Mac), `tmux capture-pane -p -J -S -40` of a trust prompt, a permission prompt, an `AskUserQuestion` menu, a CDF approval render, a bare `❯` prompt; scrub each file with `maskSecrets` (Task 2) via a one-off node script and rewrite any `/Users/<other>` path to `/Users/karl`.
- [ ] **Step 2: Write** `README.md` listing each fixture, its origin (machine, date, Claude version), and the statement "scrubbed with `maskSecrets` on <date>".
- [ ] **Step 3: Verify** `gitleaks git --pre-commit --staged --redact --no-banner` reports no leaks with the fixtures staged.
- [ ] **Step 4: Checkpoint (no commit)** — reviewer verdict (provenance and scrubbing checked against the README, no `/Users/<other>` path, no hostname new to the repo); `git add -N` each fixture file by path (never the directory); `git diff HEAD > "$F1_CHECKPOINTS/task-04-fixtures.patch"`. The gitleaks run of Step 3 is repeated at the F1 commit in Task 12.

### Task 5: Transcript turns and TL;DR

**Files:**
- Create: `src/console/transcript.ts`
- Test: `test/console-transcript.test.ts` (uses Task 4 fixtures)

**Interfaces:**
- Produces:
  ```ts
  export interface TranscriptLine { readonly uuid: string; readonly type: "user" | "assistant"; readonly timestamp: string; readonly raw: Record<string, unknown>; readonly byteStart: number; readonly byteEnd: number; }
  export interface Turn { readonly turnUuid: string; readonly startedAt: string; readonly endedAt: string; readonly byteStart: number; readonly byteEnd: number; readonly promptText: string; readonly replyText: string; readonly toolCallCount: number; readonly thinkingChars: number; }
  export interface SplitResult { readonly turns: readonly Turn[]; readonly carry: Buffer; readonly ignoredLines: number; readonly cantRead: boolean; readonly cantReadWhy?: string; readonly consumedBytes: number; }
  export const MAX_LINE_BYTES = 2 * 1024 * 1024;
  export function splitTurns(bytes: Buffer, baseOffset: number, carry?: Buffer): SplitResult;
  export function extractTldr(replyText: string): string;   // the "**TL;DR:**" block (case-insensitive, to end of paragraph) else first 280 chars; collapses whitespace
  ```
  Turn rule (spec §6.4): a turn starts at a `user` line that is not `isMeta`, whose `message.content` is text (string, or an array with a `text` block and no `tool_result`) and whose `promptSource` is not `"system"`; it ends at the last `assistant` line with a `text` block before the next such user line; `turnUuid` = that final assistant line's `uuid`. A trailing unterminated line is returned as `carry` and `consumedBytes` excludes it. A line longer than `MAX_LINE_BYTES` is skipped and counted (Review Focus 1). A complete line that is not JSON, or a `user`/`assistant` line missing `uuid`, `timestamp` or `message`, sets `cantRead` with a fixed `cantReadWhy` (`"line is not JSON"` / `"user/assistant line lacks uuid, timestamp or message"`); other line types are counted, not failed.

- [ ] **Step 1: Write the failing tests** (`test/console-transcript.test.ts`): `"splits the basic fixture into its turns with the final assistant uuid as turnUuid"`; `"a tool_result user line does not start a turn"`; `"isMeta and promptSource:system user lines do not start a turn"`; `"a partial trailing line is carried, not parsed, and consumedBytes stops before it"`; `"byteStart/byteEnd of a turn address exactly its lines (round-trip: slicing the fixture by them yields the same lines)"`; `"empty thinking blocks count zero thinkingChars"`; `"a non-JSON complete line sets cantRead with the fixed reason"`; `"unknown line types (summary, system) are counted and ignored"`; `"a 3 MB line is skipped and counted"`; `"extractTldr finds the **TL;DR:** block and otherwise takes 280 chars"`.
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** + `tsc` + `eslint`.
- [ ] **Step 5: Checkpoint (no commit)** — reviewer verdict; `git add -N src/console/transcript.ts test/console-transcript.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-05-transcript.patch"`.

### Task 6: Card builder — state, needs-you signals, card faces

**Files:**
- Create: `src/console/cards.ts`, `src/console/menu-fixtures.ts`
- Test: `test/console-cards.test.ts`, `test/console-menu-fixtures.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SessionState = "needs_you" | "working" | "idle" | "shell" | "unknown";
  export interface StateView { readonly state: SessionState; readonly glyph: "!" | "⟳" | "✓" | "$" | "?"; readonly word: string; readonly reason?: string; }
  export function stateFor(status: string, waitingFor: string | undefined, needsYou: boolean): StateView; // "waiting" → needs_you (reason = waitingFor); "busy" → working; "idle" → idle; "shell" → shell; else unknown with word `UNKNOWN STATUS <status>`
  export type NeedsKind = "waiting" | "menu_on_screen" | "sentinel";
  export interface NeedsYou { readonly kind: NeedsKind; readonly detail: string; }   // detail masked, ≤ 200 chars
  export function detectNeedsYou(args: { readonly status: string; readonly waitingFor?: string; readonly paneTail: string; readonly sentinelJson?: string }): readonly NeedsYou[];
  export interface CardFace { readonly turnUuid: string; readonly sessionId: string; readonly machine: string; readonly projectKey: string; readonly createdAt: string; readonly kind: "reply" | "commit_approval" | "menu"; readonly title: string; readonly tldrMasked: string; readonly byteStart: number; readonly byteEnd: number; readonly toolCallCount: number; readonly thinkingChars: number; }
  export function buildCardFaces(turns: readonly Turn[], ctx: { readonly machine: string; readonly projectKey: string; readonly sessionId: string }, mask: (t: string) => string): readonly CardFace[]; // tldrMasked ≤ 1024 chars
  export function projectKeyFor(sessionFile: ProbeSessionFile, panes: readonly ProbePane[], machine: string): { readonly key: string; readonly reachable: boolean }; // tmux session name from the `tmux` field "<session>:@w.%p" (validated), fallback pane whose panePid chain contains the pid, else `<cwd basename>@<machine>` unreachable
  export function pickLiveSession(files: readonly ProbeSessionFile[]): readonly ProbeSessionFile[]; // for files sharing a pane: keep alive ones; dead ones are returned as ended (Review Focus 2)
  // menu-fixtures.ts
  export const MENU_FIXTURES: readonly { readonly name: string; readonly re: RegExp }[];  // multiline, anchored at line start: /^❯ 1\. /m, /^Enter to select · ↑\/↓ to navigate · Esc to cancel$/m, /^Do you want to proceed\?$/m, /^Esc to cancel · Tab to amend$/m, /^1 to review · 2 to send · 0 to dismiss$/m
  export const MENU_NEGATIVE_FIXTURES: readonly { readonly name: string; readonly re: RegExp }[]; // the bare `❯` prompt line and the CDF render ("Reply with the option id again") — must NOT count
  export function menuOnScreen(paneTail: string): string | undefined;   // name of the matching fixture, or undefined; a negative fixture match alone never counts
  ```
  Sentinel parsing: schema 2 with any `options[].approves === "commit"` → `kind: "commit_approval"`; a v1 sentinel (`options` are strings) → `kind: "sentinel_v1"` detail `"cannot be answered until the session rewrites it as schema 2"`.

- [ ] **Step 1: Write the failing tests**:
  - `test/console-menu-fixtures.test.ts`: one `it` per positive fixture file (`pane-trust-prompt.txt` → `"trust"`, permission, permission-while-busy, askuserquestion) and per negative (`pane-cdf-render.txt` → `undefined`, `pane-bare-prompt.txt` → `undefined`, `pane-quoted-menu-in-fence.txt` → `undefined` — Review Focus 4).
  - `test/console-cards.test.ts`: `"status waiting is NEEDS YOU with the waitingFor reason"`; `"status busy with a menu on screen is NEEDS YOU (menu_on_screen)"`; `"an unknown status is UNKNOWN STATUS <value>, never idle"`; `"a sentinel with approves:commit yields a COMMIT APPROVAL kind"`; `"a v1 sentinel is shown as not answerable"`; `"card faces carry the masked TL;DR capped at 1024 chars and no other text"` (assert the face has no `replyText` key and `tldrMasked` does not contain a planted `pk1_` value); `"projectKey comes from the tmux field and falls back to cwd@machine as unreachable"`; `"of two files naming one pane, the dead one is ended and the live one wins"`.
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** + `tsc` + `eslint`.
- [ ] **Step 5: Checkpoint (no commit)** — reviewer verdict; `git add -N src/console/cards.ts src/console/menu-fixtures.ts test/console-cards.test.ts test/console-menu-fixtures.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-06-cards.patch"`.

### Task 7: Console store

**Files:**
- Create: `src/console/store.ts`
- Test: `test/console-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ConsoleSessionRow { readonly machine: string; readonly tmuxSession: string; readonly paneId: string; readonly claudePid: number; readonly sessionId: string; readonly procStart: string; readonly cwd: string; readonly projectKey: string; readonly status: string; readonly waitingFor: string | null; readonly state: SessionState; readonly stateReason: string | null; readonly transcriptOffset: number; readonly lastSeenAt: string; readonly endedAt: string | null; readonly version: number; readonly createdAt: string; readonly updatedAt: string; }
  export interface ConsoleCardRow extends CardFace { readonly id: string; readonly needsYou: boolean; readonly needsKind: NeedsKind | null; readonly dismissedAt: string | null; readonly purgeAfter: string; readonly version: number; readonly updatedAt: string; }
  export class SqliteConsoleStore {
    constructor(filename?: string);                                   // ":memory:" default; WAL; exec(SCHEMA) — CREATE TABLE IF NOT EXISTS console_session, console_card (+ indexes on (machine, project_key), (session_id, turn_uuid UNIQUE), (purge_after))
    upsertSession(row: Omit<ConsoleSessionRow, "version" | "createdAt" | "updatedAt">, now: string): void;
    listSessions(machine?: string): ConsoleSessionRow[];                 // LIMIT 500
    markEnded(machine: string, sessionId: string, now: string): void;
    upsertCard(face: CardFace, needs: { readonly needsYou: boolean; readonly needsKind: NeedsKind | null }, retentionDays: number, now: string): ConsoleCardRow; // unique on (session_id, turn_uuid); id = sha256(session_id + turn_uuid).slice(0, 32)
    listCards(filter: { readonly machine?: string; readonly projectKey?: string; readonly needsYouOnly?: boolean }, limit?: number): ConsoleCardRow[]; // newest first, LIMIT 200 default
    getCard(id: string): ConsoleCardRow | undefined;
    purgeExpired(now: string): number;
  }
  ```
  Columns snake_case, booleans INTEGER 0/1, timestamps ISO TEXT, read-side coercion of counts as in `src/keycard/sqlite-store.ts`.

- [ ] **Step 1: Write the failing tests** (`:memory:`): `"upserting a card twice for one turn keeps one row and bumps version"`; `"listCards returns newest first and honours needsYouOnly"`; `"purgeExpired removes rows past purge_after and returns the count"`; `"a face never stores more than the masked TL;DR (no column holds reply text)"` (introspect `PRAGMA table_info(console_card)` — no column named like `full_text|reply|reasoning|tool_output`); `"version, created_at, updated_at exist on both tables"`; `"markEnded sets ended_at and leaves cards in place"`; `"two stores on one file share the tables (schema is idempotent)"`.
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** + `tsc` + `eslint`.
- [ ] **Step 5: Checkpoint (no commit)** — reviewer verdict; `git add -N src/console/store.ts test/console-store.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-07-store.patch"`.

### Task 8: Poller

**Files:**
- Create: `src/console/poller.ts`
- Test: `test/console-poller.test.ts`

**Interfaces:**
- Consumes: `runProbe`, `parse*`, `splitTurns`, `buildCardFaces`, `detectNeedsYou`, `SqliteConsoleStore`, `resolveConnectableMachine` (`src/devmachine/terminal-gateway.ts:198`), `RegistryService.listDevMachines()`.
- Produces:
  ```ts
  export interface MachineHealth { readonly machine: string; readonly state: "ok" | "unreachable" | "cant_read" | "failed" | "not_connectable"; readonly since: string; readonly message?: string; readonly ignoredLines: number; readonly lastOkAt?: string; }
  export interface ConsolePollerDeps { readonly registry: { listDevMachines(): DevMachine[]; getDevMachineByLogicalName(n: string): DevMachine | undefined }; readonly exec: RemoteExec; readonly store: SqliteConsoleStore; readonly settings: ConsoleSettings; readonly mask?: (t: string) => string; readonly now?: () => number; readonly setTimer?: (fn: () => void, ms: number) => { unref?: () => void }; readonly clearTimer?: (h: unknown) => void; }
  export interface ConsolePoller { start(): void; stop(): void; tick(): Promise<void>; health(): readonly MachineHealth[]; }
  export function createConsolePoller(deps: ConsolePollerDeps): ConsolePoller;
  ```
  Rules: one probe per enabled+provisioned machine per tick, all machines in parallel, each via `exec` with `maxOutputBytes: PROBE_MAX_OUTPUT_BYTES` and `timeoutMs: 4000`; a tick that is still running when the next is due is skipped (counter exposed on health as `skippedTicks`); the plan's slices come from `store.listSessions(machine)` offsets; when a slice is `truncated` the machine is re-probed immediately once (catch-up loop, max 3 per tick); `size < offset` resets the offset (Review Focus 3); `exec` rejection → `unreachable`; missing `end` → `cant_read`; after a successful tick `purgeExpired` runs once per hour. `start()` schedules with `setTimer` and calls `unref` when available; `stop()` clears.

- [ ] **Step 1: Write the failing tests** with a fake `exec` returning canned probe output, a `:memory:` store, injected clock and timers: `"one tick probes each ready machine exactly once"` (two machines → `exec` called twice, distinct targets); `"a disabled or unprovisioned machine is never dialled"`; `"a second tick while one is running is skipped and counted"`; `"an exec rejection marks the machine unreachable and keeps its cards"`; `"a truncated slice triggers one immediate catch-up probe for that machine"`; `"size below the stored offset resets the offset to 0"`; `"a report without end marks the machine cant_read"`; `"start schedules a timer and stop clears it (unref called)"`; `"after a tick the store holds the fixture's turns as card faces with masked TL;DRs"`.
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** + `tsc` + `eslint`.
- [ ] **Step 5: Checkpoint (no commit)** — reviewer verdict; `git add -N src/console/poller.ts test/console-poller.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-08-poller.patch"`.

### Task 9: On-demand expand (R1)

**Files:**
- Create: `src/console/expand.ts`
- Test: `test/console-expand.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ExpandView { readonly fullText: string; readonly why: string; readonly whatItDid: readonly { readonly tool: string; readonly inputSummary: string; readonly outputSummary: string }[]; readonly agentRuns: number; }
  export type ExpandResult = { readonly state: "ok"; readonly view: ExpandView } | { readonly state: "unreachable"; readonly message: string } | { readonly state: "changed"; readonly message: string } | { readonly state: "failed"; readonly message: string };
  export async function expandCard(card: ConsoleCardRow, target: SshTarget, handle: string, exec: RemoteExec, mask: (t: string) => string): Promise<ExpandResult>; // reads bytes [byteStart, byteEnd) via buildExpandCommand, re-splits with splitTurns, requires the turnUuid to match else "changed"; masks every string; outputs truncated to 2 KiB each; persists nothing
  ```
- [ ] **Step 1: Write the failing tests**: `"returns full text, why (reasoning + non-empty thinking) and the tool calls of exactly that turn"` (fixture bytes served by a fake exec); `"a turn whose uuid no longer matches is reported as changed"`; `"a planted secret in the fixture is masked in fullText, why and whatItDid"`; `"an unreachable machine is a labeled state with the logicalName only"`; `"nothing is written to the store"` (store spy: no writes).
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** + `tsc` + `eslint`.
- [ ] **Step 5: Checkpoint (no commit)** — reviewer verdict; `git add -N src/console/expand.ts test/console-expand.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-09-expand.patch"`.

### Task 10: Routes and server wiring

**Files:**
- Create: `src/http/routes/console.ts`
- Modify: `src/http/app.ts` (`AppOptions.console?`, mount), `src/server.ts` (settings load, store, poller, start/stop), `.env.local.example`
- Test: `test/console-routes.test.ts`, extend `test/server.test.ts` (one case)

**Interfaces:**
- Produces:
  ```ts
  export interface ConsoleRoutesDeps { readonly registry: HarnessRoutesDeps["registry"]; readonly store: SqliteConsoleStore; readonly poller: ConsolePoller; readonly settings: ConsoleSettingsResult; readonly exec: RemoteExec; readonly mask: (t: string) => string; readonly loginEnabled: boolean; }
  export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleRoutesDeps): void;
  // GET /console                       → text/html (Task 11 page) — settings not ok → the page with the disabled banner naming deps.settings.entry
  // GET /console/api/state             → { machines: MachineHealth[], sessions: ConsoleSessionRow[] (minus cwd), cards: ConsoleCardRow[] (needs-you first), settings: { projects, allTabAreas, pollSeconds } | { disabled: true, entry } }  Cache-Control: no-store
  // GET /console/api/cards/:id/expand  → ExpandResult; 404 unknown card; 409 machine not connectable; 502 unreachable/failed; id must match /^[0-9a-f]{32}$/ else 400 with a fixed message
  ```
  `AppOptions.console?: ConsoleRoutesDeps`-shaped slice (store, poller, settings, exec, mask); `app.ts` mounts after `registerHarnessRoutes`. `server.ts`: `const consoleSettings = loadConsoleSettings(cfg.consoleSettingsPath, p => existsSync(p) ? readFileSync(p, "utf8") : undefined)`; `cfg.consoleSettingsPath = env.PANTHEON_CONSOLE_SETTINGS ?? resolve("data/console-settings.json")`; store on `cfg.dbPath`; poller started in `main()` after `listen`, and `app.addHook("onClose", () => poller.stop())`; when settings are not ok the poller is **not** started.

- [ ] **Step 1: Write the failing tests** (`test/console-routes.test.ts`, with `buildApp` and a fake exec as other route tests do): `"the console routes are guarded: no cookie → 302 /login for HTML, 401 for the API"`; `"a keycard bearer is refused on /console/api/state (403)"`; `"state lists machines, sessions and cards, needs-you first, with no-store"`; `"expand of an unknown id is 404 and a non-hex id is 400 with a fixed message"`; `"expand returns the view from the fake exec"`; `"with invalid settings the page carries the disabled banner naming the entry and the API answers { disabled: true, entry }"`; in `test/server.test.ts`: `"configFromEnv reads PANTHEON_CONSOLE_SETTINGS and defaults beside the DB"`.
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** + `tsc` + `eslint`; also `test/http-app.test.ts` and `test/mount-prefix.test.ts` still green (the new routes under `/harness` prefix via `requestBase`).
- [ ] **Step 5: Checkpoint (no commit)** — reviewer verdict; `git add -N src/http/routes/console.ts test/console-routes.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-10-routes.patch"`. Files of this task: those two plus `src/http/app.ts src/server.ts .env.local.example test/server.test.ts`.

### Task 11: Console page and client

**Files:**
- Create: `src/http/console-page.ts`
- Modify: `src/http/harness-frame.ts:515-517` (header link `<a href="${withBase(base, "/console")}" data-nav="console">Console</a>`), `src/http/theme.ts` (only if a token is missing — prefer none)
- Test: `test/console-page.test.ts` (jsdom, same boot pattern as `test/harness-shell.test.ts`), extend `test/harness-frame.test.ts` (header link)

**Interfaces:**
- Produces:
  ```ts
  export interface ConsolePageModel { readonly base: string; readonly loginEnabled: boolean; readonly disabled?: { readonly entry: string }; }
  export function renderConsolePage(model: ConsolePageModel): string;   // pageHead(base) + <html data-base> + two tab rows + left panel + cards <main> + banners; the client fetches BASE + '/console/api/state' every settings.pollSeconds and on focus
  export const CONSOLE_CLIENT_JS: string;
  ```
  Client behaviour (ES5-style, `textContent` only, no innerHTML from data): row 1 `◎ All machines` + one tab per machine with worst state + counts (`! 3 NEED YOU · ⟳ 1`); row 2 = selected machine's projects (glyph + display from settings, `new — not set up` when unconfigured, `not reachable — start it in tmux` group for unreachable keys, hidden projects omitted); cards list for the selection, needs-you pinned on top; each card: kind label, title, masked TL;DR, age, `▸ full text · ▸ why · ▸ what it did` buttons that fetch expand once and render as text (Markdown rendered as escaped text in F1 — a sanitised renderer is F2+); machine banners `✕ UNREACHABLE since HH:MM`, `⚠ CAN'T READ — format changed (N lines)`; tab title shows the needs-you count; a 401/403 on fetch shows "signed out — reload to sign in"; `window.__console = { refresh, select, expand }` for tests.

- [ ] **Step 1: Write the failing tests** (`test/console-page.test.ts`): `"renders two tab rows from state: machines with worst state glyph+word, then the selected machine's projects"`; `"a NEEDS YOU project is listed first and the tab title carries the count"`; `"an unknown status renders ? UNKNOWN STATUS <value>, never idle"`; `"expand fetches once per card and renders the three sections as text"`; `"a disabled model renders the banner naming the entry and no fetch happens"`; `"an unreachable machine shows ✕ UNREACHABLE since HH:MM and keeps its cards"`; `"a 403 from the API shows signed out"`; `"no element is created from state text via innerHTML"` (spy on `Element.prototype.innerHTML` setter during a render → not called with state-derived strings); in `test/harness-frame.test.ts`: `"the header links to the Console under the base path"`.
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** + `tsc` + `eslint`; full suite green.
- [ ] **Step 5: Checkpoint (no commit)** — reviewer verdict; `git add -N src/http/console-page.ts test/console-page.test.ts`; `git diff HEAD > "$F1_CHECKPOINTS/task-11-page.patch"`; then, with the full suite, `tsc` and `eslint` green, `scripts/process-checklist.sh --complete-step build_loop:implemented`. Files of this task: those two plus `src/http/harness-frame.ts test/harness-frame.test.ts`.

### Task 12: Security audit, documentation, record, deploy

**Files:**
- Create: `docs/security-audits/maestro-console-f1-security-audit.md`
- Modify: `FEATURES.md` (Feature 15: Maestro Console F1), `CHANGELOG.md` (Added, Data Model, Security, Documentation), `PROJECT_BIBLE.md` §5 (two tables), §9 (C.7 Console page), `docs/user-guide.html` (Console section: what it shows, what it never does in F1, the settings file), `deploy/README.md` (settings file on VM 1093, `PANTHEON_CONSOLE_SETTINGS`), `.env.local.example`

- [ ] **Step 1: Adversarial review** — one fresh reviewer (top tier, max effort; `pr-adversary`) on the whole F1 branch with the spec §8 questions: read-only invariant of both remote commands (grep for forbidden tmux verbs), allow-list completeness, masking misses, injection via `tmux` field / cwd / pane text into the page, probe amplification, store contents (R1), guard coverage, fail-visible states. Fix reachable findings test-first; record the rest as residuals in the audit document.
- [ ] **Step 2: Write** the audit document in the format of `docs/security-audits/session-waker-guardrails-security-audit.md` (headline, threats table, findings, verification), then `scripts/process-checklist.sh --complete-step build_loop:security_audit`.
- [ ] **Step 3: Documentation** as listed; `scripts/process-checklist.sh --complete-step build_loop:documentation_updated`.
- [ ] **Step 4: The F1 commit** (design B; the only commit of F1, Build Loop at 5/6): `gitleaks git --pre-commit --staged --redact --no-banner` clean with everything staged; stage by explicit path every file of tasks 1–12 (the File Structure table, each fixture file, the audit document; never a directory, never `-A`); `git status --short` echoed; record the approval question in `.claude/pending-approval.json` (schema 2) and stop; after Karl's option id, a lone `git commit -m "feat(console): Maestro Console F1 — read-only session feed: settings, masking, probe, transcript, cards, store, poller, expand, routes, page, audit and docs (ADR-0010, F1)"` in its own Bash call.
- [ ] **Step 5: Record and deploy** — `scripts/test-gate.sh --record-feature "maestro-console-f1"` and `scripts/process-checklist.sh --complete-step build_loop:feature_recorded`; Karl pushes both remotes; change card; deploy to VM 1093 with `PANTHEON_CONSOLE_SETTINGS` pointing at a settings file Karl has placed (the spec §7 example with his project map), restart with Karl's approval; verify `x-pantheon-build` and that `/console` lists Mac-Mini's live sessions.
- [ ] **Step 6: Real-use period** (spec §11 exit) — ≥ 3 days read-only; collect the reply-borne-question samples for O1; the F2 plan is written only after Karl approves the O1 rule.

---

## Self-review notes (done while writing)

- Spec coverage F1: §5 probe/builder/store/page/settings (Tasks 1, 3, 6, 7, 8, 10, 11); §6.1 discovery/tabs (6, 11); §6.2 states (6, 11); §6.3 signals 0–2 (6; signal 3 is O1, deferred by spec); §6.4 cards/expand (5, 6, 9, 11); §7 two tables + settings file (1, 7); §8.1, 8.3, 8.4 (10, 11, 2); §9 failure states (3, 8, 10, 11); §10 F1 tests (each task); §11 F1 exit (12). Not in F1 by spec: send path, reminders, suggestions, Maestro bridge, phone view, menu/sentinel answering.
- Deviation to record in the audit: the probe extracts allow-listed `sessions/*.json` fields **on the machine** with `grep -o`, so the forbidden fields never cross the wire; a nested or multi-line JSON value in those files would be missed (read as CAN'T READ, not misread).
- Type names are consistent across tasks (`ProbeSessionFile`, `ProbePane`, `Turn`, `CardFace`, `ConsoleCardRow`, `SessionState`, `NeedsKind`, `ConsoleSettings`, `RemoteExec`).
- Proportion: the plan fixes names, signatures, allow-lists, regexes and test names; bodies are left to the implementer except the remote script's record grammar, which the tests depend on.
