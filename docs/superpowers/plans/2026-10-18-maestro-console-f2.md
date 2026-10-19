# Maestro Console F2 (answer from the page) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Karl answers a Claude Code session from the console page — reply box + Submit behind a passphrase step-up, answer buttons for reply-borne decisions, one audited bracketed paste into the exact tmux pane — plus the settled machine-shell drawer, the in-page Claude-session view, and the new-session flow.

**Architecture:** F2 adds to the F1 `src/console/` module: a reply-question detector (O1) and a widened TL;DR marker in the card builder; a passphrase step-up window on the operator session; a Submit route that validates, writes an `attempted` audit row, runs ONE allow-listed remote delivery script (re-verify target → refuse if a menu shows → base64 → `tmux load-buffer` + `paste-buffer -p` + `send-keys Enter` → re-capture) and appends the result row; two more allow-listed scripts (list projects, create a Claude session); and the page grows a reply box, buttons, a fold-to-title card, the bottom drawer (xterm attached to `sh-<machine>`) and a per-project "Cards | Claude session" view switch that reuses the existing terminal WebSocket broker.

**Tech Stack:** Node 24 / strict TypeScript 5 / Fastify 5 / better-sqlite3 (exact-pinned, **no new dependency**); server-rendered HTML + plain browser JS as template-literal strings; xterm.js (already vendored) over the existing `/terminal/:logicalName` WebSocket; vitest (node + jsdom); POSIX `sh` + `tmux` + `base64` + `ps` on the dev machines (no Node or jq assumed there).

**Spec:** `docs/superpowers/specs/2026-10-16-maestro-console-design.md` — rows F2 (§11), §6.3 signal 3 (O1, fixed 2026-10-18), §6.4 cards, §6.6 send path, §7 `console_submit_log`, §8 security, §9 failure handling, §10 F2 tests, §14.1 new-session flow, §14.2 drawer (decision 18 revised). Governance: ADR-0010 (R4 step-up = first D6 consumer), TM-025, BUGS #36 (extended), APPROVAL_LOG 2026-10-18 (F1 approved, O1 approved). F1 plan and its "Execution deviations": `docs/superpowers/plans/2026-10-16-maestro-console-f1.md`. F1 ledger carries: `.superpowers/sdd/2026-10-16-maestro-console-f1/progress.md` ("O1 SURVEY", "TRIAL FINDINGS DAY 1").

## Global Constraints

- Build Loop per feature: `scripts/process-checklist.sh --start-feature "maestro-console-f2"` before Task 1; mark `build_loop:tests_written` + `tests_verified_failing` after the first RED (Task 1), `implemented` after Task 10, `security_audit` and `documentation_updated` in Task 11, `feature_recorded` with `scripts/test-gate.sh --record-feature "maestro-console-f2"`. F2 is the second feature since UAT-5: `--check-batch` will demand **UAT-6** after it (spec §11).
- Commits: as F1 (ruling A1, 2026-10-16) — `--check-commit-ready` blocks any `.ts` commit until the first five Build Loop steps are marked, so Tasks 1–10 end in reviewed checkpoint patches under `.superpowers/sdd/2026-10-18-maestro-console-f2/checkpoints/` (mirrored to `~/Documents/Claude Projects/Pantheon/f2-checkpoints/`) and **one commit lands in Task 11**, unless Karl rules a different cadence when he approves this plan. The CDF stop hook's "Uncommitted source changes" during the feature is the ruled state, never a reason to commit early or to mark an unperformed step.
- Strict TS (`exactOptionalPropertyTypes` style: spread optionals as `...(x ? { x } : {})`), `eslint` clean, `tsc` clean, suite green (`npm test`, `npm run lint`, `npm run build` in `services/control-plane`). Built on `main` in the main tree (direct-push workflow), no worktree.
- **Every remote command is minted by an allow-listed builder** (`probe-command.ts`, `deliver-command.ts`, `session-command.ts`, `tmux.ts`); user text travels **only base64-encoded inside a quoted heredoc** and is never interpolated into shell syntax. Names (tmux session, folder) pass an allow-list before any command text exists. `connection.ts` line 20's comment names every mint site.
- **Submit is the first D6 consumer (R4):** no Submit, New Session or New Project without an elevated window on the operator **cookie** session (passphrase re-entered; 15 min = `900_000` ms). Admin-bearer callers are refused (`step_up_cookie_only`). The window is server-side state, never a client cookie flag.
- **Validation refuses, never strips** (spec §6.6.2): any C0/C1 control other than `\n`/`\t`, any ESC (`\x1b`), lone surrogates, or more than **4096 bytes** (UTF-8) → 400 with a labelled reason; the text stays in the box.
- **Audit is append-only (R6):** `console_submit_log` has INSERT only — the store module must contain no UPDATE or DELETE statement for that table (a test greps the source). Write-ahead `attempted` row before any dial; a result row after; a replayed idempotency key returns the stored outcome without a dial.
- **Target re-verified on the machine at send time** (spec §6.6.4): session file exists, `sessionId` equal, `procStart` equal as epoch seconds, `kill -0 <pid>`, pane process chain contains the pid, `status ∈ {idle, busy}`, no menu anchor at line start in the pane tail. Any failure → a refusal outcome; the text is never pasted.
- **Nothing a session wrote is sent back into a session** (TM-020): reply-question buttons copy a single letter/id into the visible box; sentinel buttons send only the option id; commit approvals have no buttons (D5); menu cards have no Submit (R5).
- Card faces stay masked and ≤ 1 KiB; `options_json` holds ids/letters only (≤ 12 entries, each ≤ 8 chars). No full text persisted (R1). `console_submit_log.text_masked` is the masked submitted text (≤ 4 KiB), Karl's own words, kept forever (R6).
- Every state shown as colour **+ glyph + word** (CC1); fail visible (spec §9): refused target / menu visible / send failed / step-up expired / machine unreachable are labelled on the card, never silent.
- All new routes sit behind the operator guard (nothing joins `PUBLIC_PATHS`); JSON responses `Cache-Control: no-store`; `exposeHeadRoute: false` on every console API route (F1 carry). The app-level Sec-Fetch-Site rule already refuses cross-site POSTs; tests assert it for the new routes.
- Settings: F1's file stays valid unchanged. New optional root key `machines` → `{ "<logicalName>": { "projectsRoot": "/abs/path" } }`; a machine without an entry has no drawer shell and no new-session flow (labelled "no projects root configured", never an error).
- Desktop only for the drawer and view switch (D11); phone decision view is F5.
- `sh-<logicalName>` tmux sessions are machine shells: never a project tab (F1 already files them as not reachable), never a Submit target, excluded from the new-session project list.

## Review Focus

Inputs the spec implies but no F2 row tests by name — each pinned to its owning task:

1. **A TL;DR whose "waiting on you" clause is followed by a negation after a comma** (`Waiting on you: nothing now, but reply A1 later`) — the eight-word negation window says not-needs-you; and the opposite, `Waiting on you: no commands, just reply A1` — also not (the rule reads the first words only; documented in §6.3). → Task 2 pins both.
2. **Submit text that is pure tmux key syntax or starts with `/`, `!`, `#`, `@`** (`C-c`, `/clear`, `!ls`) — delivered as literal text by the bracketed paste, never interpreted by tmux, because the text reaches tmux only through `load-buffer` from stdin; the unit test asserts the text is absent from the command line and present only as base64 inside the heredoc. What Claude Code does with a pasted `/clear` is proven in UAT-6, not unit tests. → Task 5.
3. **The exec throws after the `attempted` row** (SSH timeout mid-paste) — a `failed` result row must still be appended, the replayed key must return `failed`, and the card must say so with the text kept. → Task 6.
4. **Two browser tabs on one operator session** — one step-up elevates both (window is per session id); the same idempotency key from both tabs yields one dial and two identical responses. → Task 3 and Task 6.
5. **Reload with the drawer open and a project in Claude-session view** — both terminals re-attach through the existing `?session=<id>` reconnect (ids kept in `sessionStorage` per machine/view); a stale id yields a fresh attach, never a blank panel; `sh-*` never appears as a project tab even after the shell is renamed inside tmux (the name check runs on every poll). → Task 9.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/console/transcript.ts` | widened `TLDR_MARKER` (parenthetical, unbolded/heading line-start forms), linear-time shape kept |
| `src/console/cards.ts` | O1 `detectReplyQuestion`, `NeedsKind` + `"reply_question"`, options on `NeedsYou`, `MENU_ANCHORS` export |
| `src/console/store.ts` | `console_card` + `asks_you`, `options_json`, `answered_at` (additive); `console_submit_log` (INSERT only); `markAnswered`, `markDismissed`, `appendSubmitLog`, `findSubmitResult`, `listSubmitLog` |
| `src/console/poller.ts` | reply-question flag on the session's latest card; `procStart` compared when matching a live session (F1 carry: pid reuse); skip the re-read of a busy session whose size is unchanged (F1 carry) |
| `src/console/settings.ts` | optional root key `machines[<logicalName>].projectsRoot`; `projectsRootFor(settings, name)` |
| `src/http/auth/step-up.ts` | `StepUpWindow` (session id → elevated-until), `requireElevated` guard |
| `src/console/submit.ts` | `validateSubmitText`, `idempotencyKeyOk`, `SubmitOutcome` type, `maskSubmitText` |
| `src/console/deliver-command.ts` | `buildDeliverCommand` (the §6.6.4 script), `parseDeliverOutput`, `DELIVER_SENTINEL` — a `RemoteCommand` mint site |
| `src/console/session-command.ts` | `buildListProjectsCommand`, `parseListProjectsOutput`, `buildCreateSessionCommand` (mkdir + `tmux new-session -d … claude`) — a mint site; `tmuxNameForFolder`, `assertProjectName`, `assertRemoteDir` |
| `src/devmachine/tmux.ts` | `buildTmuxAttachCommand(name, { create?, cwd? })` for the machine shell; `assertRemoteDir` shared |
| `src/http/routes/console.ts` | new guarded routes: `POST /console/api/step-up`, `GET /console/api/step-up`, `POST /console/api/cards/:id/submit`, `POST /console/api/cards/:id/dismiss`, `GET /console/api/machines/:name/projects`, `POST /console/api/machines/:name/sessions` |
| `src/http/routes/terminal.ts` | `?shell=1` → attach-or-create `sh-<logicalName>` in that machine's `projectsRoot` |
| `src/http/console-page.ts` | fold-to-title cards, reply box + Submit + buttons + Dismiss, step-up dialog, drawer, view switch, new-session dialog, `CONSOLE_CLIENT_JS` |
| `src/http/app.ts` | step-up window + operator password threaded into the console wiring; `setNotFoundHandler` with a fixed body (F1 carry) |
| `src/server.ts` | construct `StepUpWindow`; pass `operatorPassword` to the console |
| `test/console-transcript.test.ts`, `test/console-cards.test.ts`, `test/console-store.test.ts`, `test/console-poller.test.ts`, `test/console-settings.test.ts` | extended |
| `test/console-step-up.test.ts`, `test/console-submit.test.ts`, `test/console-deliver-command.test.ts`, `test/console-session-command.test.ts` | new |
| `test/console-routes.test.ts`, `test/console-page.test.ts`, `test/devmachine-tmux.test.ts`, `test/terminal-route.test.ts`, `test/harness-frame.test.ts` | extended |
| `test/fixtures/console/` | `pane-trust-prompt-new-folder.txt` (captured in Task 8), `deliver-*.txt` script outputs |
| `docs/security-audits/maestro-console-f2-security-audit.md` | Phase 2.4 audit artefact (gate requires it) |
| `FEATURES.md` (Feature 16), `CHANGELOG.md`, `PROJECT_BIBLE.md` §5/§7/§9, `BUGS.md` #36, `docs/user-guide.html`, `deploy/README.md`, `docs/ADR documentation/ADR-0010-…md` follow-up | documentation |

---

### Task 1: Widened TL;DR marker

**Files:**
- Modify: `src/console/transcript.ts` (`TLDR_MARKER`, `extractTldr`)
- Test: `test/console-transcript.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `extractTldr(replyText, opts?)` unchanged in signature; it now also finds `**TL;DR (plain English):**`, `**TL;DR:**` with any single parenthetical before the closing bold, and an unbolded or heading marker at line start (`TL;DR:`, `TL;DR`, `## TL;DR`, `### TL;DR —`), taking the LAST of any form.

- [ ] **Step 1: Write the failing tests**

```ts
it("extracts the TL;DR after a parenthetical marker", () => {
  const t = "Body.\n\n**TL;DR (plain English):** The push landed.\n\nTrailer.";
  expect(extractTldr(t)).toBe("The push landed.");
});
it("extracts an unbolded line-start marker and a heading marker", () => {
  expect(extractTldr("Body.\n\nTL;DR: one line\n")).toBe("one line");
  expect(extractTldr("Body.\n\n## TL;DR\n\nParagraph after.\n\nMore.")).toBe("Paragraph after.");
});
it("ignores TL;DR mentioned mid-sentence", () => {
  expect(extractTldr("I will add a TL;DR later. Done.")).toBe("I will add a TL;DR later. Done.");
});
it("takes the last marker of any form", () => {
  const t = "**TL;DR:** first\n\nTL;DR: second\n";
  expect(extractTldr(t)).toBe("second");
});
it("stays linear on a hostile marker flood", () => {
  const hostile = "**TL;DR (" + " ".repeat(100_000) + "\n" + "**TL;DR".repeat(20_000);
  const t0 = performance.now(); extractTldr(hostile);
  expect(performance.now() - t0).toBeLessThan(200);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/console-transcript.test.ts -t "TL;DR"`
Expected: the first four FAIL (the whole text or the wrong block comes back); the timing test may pass.

- [ ] **Step 3: Implement**

In `transcript.ts` replace the single regex with two, both bounded: `TLDR_MARKER_BOLD = /\*\*\s*TL;DR(?:\s*\([^)\n]{0,40}\))?\s*(?::\s*)?\*\*\s*:?/gi` and `TLDR_MARKER_LINE = /^[ \t]{0,8}(?:#{1,6}[ \t]{1,8})?TL;DR\b[ \t]{0,8}(?:[:—-][ \t]{0,8})?/gim`; `extractTldr` takes the greatest match end across both. Keep the F1 comment's reasoning on quadratic shapes: no unbounded `\s*` run adjacent to another optional whitespace run.

- [ ] **Step 4: Run the transcript suite and the F1 fixtures**

Run: `npx vitest run test/console-transcript.test.ts test/console-cards.test.ts`
Expected: PASS, including every existing F1 TL;DR case.

- [ ] **Step 5: Checkpoint** — `git diff > .superpowers/sdd/2026-10-18-maestro-console-f2/checkpoints/task-01.patch`; mark `build_loop:tests_written` and `build_loop:tests_verified_failing`.

---

### Task 2: O1 reply-question detector and the `reply_question` signal

**Files:**
- Modify: `src/console/cards.ts` (`NeedsKind`, `NeedsYou`, `detectNeedsYou`, new `detectReplyQuestion`); `src/console/menu-fixtures.ts` (export `MENU_ANCHORS`: the literal line-start strings behind the `askuserquestion`, `permission` and `review-send` fixture regexes, so Task 5's script greps the same anchors `menuOnScreen` matches)
- Test: `test/console-cards.test.ts`

**Interfaces:**
- Consumes: `extractTldr` (Task 1), `maskClip` (F1).
- Produces:
  - `export type NeedsKind = "waiting" | "menu_on_screen" | "sentinel" | "reply_question"`
  - `export interface ReplyQuestion { readonly waiting: string /* masked ≤ 200 */; readonly options: readonly string[] /* lettered ids, ≤ 12 */ }`
  - `export function detectReplyQuestion(replyText: string, mask: (t: string) => string): ReplyQuestion | undefined`
  - `NeedsYou` gains `readonly options?: readonly string[]` (set only for `reply_question`).
  - `detectNeedsYou(args)` gains `readonly replyText?: string`; a reply question is appended LAST and only when no `waiting`/`menu_on_screen`/`sentinel` signal was found (a sentinel wins, spec §6.3).
  - `export const MENU_ANCHORS: readonly string[]` — the exact line-start anchors of signal 1 (`❯ 1. `, `Enter to select`, `Do you want to proceed?`, `Esc to cancel · Tab to amend`, `1 to review · 2 to send · 0 to dismiss`) for Task 5's script.
  - `export const NEGATION_RE = /^\W*(?:nothing|none|no\b|not\b|only your|your usual)/i` and `WAIT_CLAUSE_RE = /\bwaiting on (?:you|karl)\b\s*:?\s*((?:\S+\s*){0,8})/gi` (eight words after the clause).
  - `export const LETTERED_OPTION_RE` — line-start `A1`/`A2`, `Option A`/`B`, `(A)`/`(B)` with an optional parenthetical, optional bold, then a separator; numbered lists excluded.

- [ ] **Step 1: Write the failing tests** (values from the spec's O1 text and the survey)

```ts
const ask = (tldr: string, body = "") => detectReplyQuestion(`${body}\n\n**TL;DR:** ${tldr}`, (t) => t);
it("fires on a non-negated waiting clause", () => {
  expect(ask("Waiting on you: reply A1 to save them, or A2 to wait.")?.waiting).toMatch(/reply A1/);
});
it("does not fire when the clause is negated in its first words", () => {
  for (const t of ["Nothing is waiting on you.", "Waiting on you: nothing.", "Waiting on you: no commands are needed.",
                   "Waiting on you: only your glance at the console.", "Waiting on you: your usual upload."]) {
    expect(ask(t)).toBeUndefined();
  }
});
it("Review Focus 1: negation after a comma is still the first words of the clause", () => {
  expect(ask("Waiting on you: nothing now, but reply A1 later.")).toBeUndefined();
  expect(ask("Waiting on you: no commands, just reply A1.")).toBeUndefined();
});
it("collects lettered option ids from the body, never numbered lists", () => {
  const body = "- **A1 (recommended):** commit\n- **A2:** hold\n1. first finding\n2. second finding";
  expect(ask("Waiting on you: one answer.", body)?.options).toEqual(["A1", "A2"]);
  expect(ask("Waiting on you: one answer.", "1. a\n2. b")?.options).toEqual([]);
});
it("reads the whole reply when there is no marker", () => {
  expect(detectReplyQuestion("Waiting on you: say go.", (t) => t)?.waiting).toBe("say go.");
});
it("a trailing question mark alone is not a signal", () => {
  expect(ask("All done. Shall I continue?")).toBeUndefined();
});
it("detectNeedsYou appends reply_question only when no other signal fired", () => {
  const r1 = detectNeedsYou({ status: "idle", paneTail: "", replyText: "**TL;DR:** Waiting on you: reply A1." });
  expect(r1.signals.map((s) => s.kind)).toEqual(["reply_question"]);
  const r2 = detectNeedsYou({ status: "idle", paneTail: "", sentinelJson: SCHEMA2, replyText: "**TL;DR:** Waiting on you: reply A1." });
  expect(r2.signals.map((s) => s.kind)).toEqual(["sentinel"]);
});
it("masks the waiting clause", () => {
  expect(ask("Waiting on you: paste ghp_" + "a".repeat(36) + " here.")?.waiting).not.toContain("ghp_a");
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run test/console-cards.test.ts -t "reply"` → FAIL (`detectReplyQuestion` is not exported).

- [ ] **Step 3: Implement** `detectReplyQuestion` in `cards.ts`: TL;DR block via `extractTldr(replyText, { fallbackChars: Number.POSITIVE_INFINITY })`; first non-negated `WAIT_CLAUSE_RE` hit → `waiting = maskClip(clause, 200)`; options = unique `LETTERED_OPTION_RE` ids in body order, first 12. Extend `detectNeedsYou` and `NeedsKind`; export `MENU_ANCHORS`. Hostile-input timing test on `WAIT_CLAUSE_RE` and `LETTERED_OPTION_RE` (100 kB of `waiting on you ` repeats, 20k option lines) under 200 ms, in the same test file.

- [ ] **Step 4: Run** `npx vitest run test/console-cards.test.ts test/console-menu-fixtures.test.ts` → PASS.

- [ ] **Step 5: Checkpoint** `task-02.patch`.

---

### Task 3: Passphrase step-up window (R4, first D6 consumer)

**Files:**
- Create: `src/http/auth/step-up.ts`
- Modify: `src/http/routes/console.ts` (two routes), `src/http/app.ts` (`ConsoleRoutesDeps` gains `stepUp` and `operatorPassword`), `src/server.ts`
- Test: `test/console-step-up.test.ts`

**Interfaces:**
- Consumes: `parseSessionCookie` and the timing-safe compare pattern from `src/http/auth/operator-auth.ts`; `SessionStore.validate(id)`.
- Produces:
  - `export const STEP_UP_TTL_MS = 900_000`
  - `export class StepUpWindow { constructor(now: () => number = Date.now, ttlMs = STEP_UP_TTL_MS); elevate(sessionId: string): string /* ISO until */; elevatedUntil(sessionId: string): string | undefined; isElevated(sessionId: string): boolean; revoke(sessionId: string): void }` — in-memory `Map`; an entry past its `until` reads as not elevated and is dropped.
  - `export function requireElevated(req: FastifyRequest, sessions: SessionStore, window: StepUpWindow): { ok: true; sessionId: string } | { ok: false; status: 403; reason: "step_up_required" | "step_up_cookie_only" }` — bearer-only requests get `step_up_cookie_only`.
  - Routes: `POST /console/api/step-up` body `{ passphrase: string }` → 200 `{ elevatedUntil }` on a timing-safe match with `operatorPassword`; 403 `{ error: "step_up_refused" }` otherwise (no detail; same 300 ms minimum response time on refusal as `/login`); `GET /console/api/step-up` → `{ elevatedUntil: string | null }`. Both `exposeHeadRoute: false`, no-store.
  - `ConsoleRoutesDeps` gains `readonly stepUp: StepUpWindow; readonly sessions?: SessionStore; readonly operatorPassword?: string` (page says "step-up unavailable — login is disabled" when either is missing: no silent fallback, Submit disabled).

- [ ] **Step 1: Write the failing tests** — `StepUpWindow` unit: elevate → `isElevated` true; at `now + 900_000` false; `revoke` drops. Route tests with the F1 `buildApp` harness: POST with the right passphrase on a cookie session → 200 with `elevatedUntil` ≈ now + 15 min; wrong passphrase → 403 `step_up_refused`; bearer-only POST → 403 `step_up_cookie_only`; GET without elevation → `{ elevatedUntil: null }`; Review Focus 4: two cookies for the SAME session id share the window. Cross-site POST → 403 `cross_origin_rejected` (app rule).

- [ ] **Step 2: Run** `npx vitest run test/console-step-up.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `step-up.ts` and the routes; thread `stepUp`, `sessions`, `operatorPassword` from `app.ts` (`opts.sessions`, `opts.operatorPassword`) into `registerConsoleRoutes`; `server.ts` constructs one `StepUpWindow`. Update `BUGS.md` #36 wording later (Task 11), not here.

- [ ] **Step 4: Run** `npx vitest run test/console-step-up.test.ts test/console-routes.test.ts test/browser-auth.test.ts` → PASS.

- [ ] **Step 5: Checkpoint** `task-03.patch`.

---

### Task 4: Submit validation and the append-only submit log

**Files:**
- Create: `src/console/submit.ts`
- Modify: `src/console/store.ts` (DDL + methods; `console_card` additive columns), `src/console/poller.ts` is NOT touched here
- Test: `test/console-submit.test.ts`, `test/console-store.test.ts`

**Interfaces:**
- Produces (`submit.ts`):
  - `export const SUBMIT_MAX_BYTES = 4096`
  - `export type SubmitRefusal = "not_text" | "too_long" | "control_char" | "escape" | "invalid_utf8"`
  - `export function validateSubmitText(text: unknown): { ok: true; text: string; bytes: number } | { ok: false; reason: SubmitRefusal }`
  - `export const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`
  - `export type SubmitOutcome = "sent" | "refused_target_changed" | "refused_menu_visible" | "failed"`
- Produces (`store.ts`):
  - `console_card` gains `asks_you INTEGER NOT NULL DEFAULT 0`, `options_json TEXT NOT NULL DEFAULT '[]'`, `answered_at TEXT` via `ALTER TABLE … ADD COLUMN` guarded by `PRAGMA table_info` (ruling A, additive). `ConsoleCardRow` gains `asksYou: boolean`, `options: readonly string[]`, `answeredAt: string | null`.
  - `upsertCard(face, needs: { needsYou; needsKind; asksYou?: boolean; options?: readonly string[] }, retentionDays, now)`; `setCardNeeds(id, { needsYou; needsKind; kind; options? }, now)`; `markAnswered(id, now): ConsoleCardRow | undefined` (sets `answered_at`, `needs_you = 0`); `markDismissed(id, now)` (sets `dismissed_at`; `needs_you = 0` only when `needs_kind = 'reply_question'`).
  - `console_submit_log` per spec §7: `id TEXT PRIMARY KEY` (uuid), `at`, `idempotency_key`, `row_kind` (`attempted` | `result`), `outcome` (NULL on attempted, else `SubmitOutcome` or `created_session` | `created_project` | `created_shell` | `refused_name` | `refused_root`), `reason`, `machine`, `tmux_session`, `pane_id`, `claude_pid`, `session_id`, `proc_start`, `status_at_send`, `card_id` (NULL for session creation), `text_masked`, `pane_tail_hash`, `version`, `created_at`, `updated_at`; index on `idempotency_key` and on `card_id`.
  - `appendSubmitLog(row: SubmitLogInsert): SubmitLogRow`; `findSubmitResult(idempotencyKey: string): SubmitLogRow | undefined` (the `result` row); `listSubmitLog(cardId: string, limit = 20): SubmitLogRow[]` (newest first).

- [ ] **Step 1: Write the failing tests**

```ts
// submit.test.ts
it.each([["hello\nworld\tx", true], ["a\x07b", false], ["\x1b[31m", false], ["x".repeat(4097), false], ["é".repeat(2048), true], ["é".repeat(2049), false]])(
  "validateSubmitText(%j) ok=%s", (text, ok) => expect(validateSubmitText(text).ok).toBe(ok));
it("refuses a lone surrogate as invalid_utf8", () => expect(validateSubmitText("a\ud800b")).toEqual({ ok: false, reason: "invalid_utf8" }));
it("refuses non-strings", () => expect(validateSubmitText(42)).toEqual({ ok: false, reason: "not_text" }));
// store.test.ts
it("submit log is INSERT-only in source", () => {
  const src = readFileSync(join(__dirname, "..", "src", "console", "store.ts"), "utf8");
  expect(src).not.toMatch(/UPDATE\s+console_submit_log/i);
  expect(src).not.toMatch(/DELETE\s+FROM\s+console_submit_log/i);
});
it("attempted then result rows are both kept and replay finds the result", () => { /* append attempted, append result sent; listSubmitLog(card).length === 2; findSubmitResult(key).outcome === "sent" */ });
it("an F1 database gains the new card columns without data loss", () => { /* open an F1-shaped DB file from a fixture SQL, construct the store, getCard still returns the F1 row with asksYou false, options [] */ });
it("markAnswered clears needs_you and sets answered_at; markDismissed clears needs_you only for reply_question", () => {});
```

- [ ] **Step 2: Run** `npx vitest run test/console-submit.test.ts test/console-store.test.ts` → FAIL.

- [ ] **Step 3: Implement** `submit.ts` (byte length via `Buffer.byteLength`; control scan over code points; lone-surrogate check via `isWellFormed()`); extend the store's `SCHEMA` and the column migration helper `ensureColumn(table, column, ddl)`; the five methods.

- [ ] **Step 4: Run** the two files plus `test/console-poller.test.ts` (unchanged behaviour) → PASS.

- [ ] **Step 5: Checkpoint** `task-04.patch`.

---

### Task 5: Delivery script builder and parser (spec §6.6.4)

**Files:**
- Create: `src/console/deliver-command.ts`
- Modify: `src/devmachine/connection.ts` (line 20 comment: new mint site)
- Test: `test/console-deliver-command.test.ts`

**Interfaces:**
- Consumes: `PROBE_PATH_PREFIX`, `BASE64_GUARD`, `HEREDOC_TAG`, `mint` pattern from `probe-command.ts` (export `mintScript(script: string): RemoteCommand` from there and reuse it); `SESSION_ID_RE`, `PANE_ID_RE`; `MENU_ANCHORS` (Task 2).
- Produces:
  - `export const DELIVER_SENTINEL = "PANTHEON_DELIVER:"`
  - `export interface DeliverPlan { readonly sessionFile: string /* "<pid>.json", allow-listed */; readonly sessionId: string; readonly procStart: string /* epoch seconds, digits only */; readonly pid: number; readonly paneId: string; readonly textB64: string /* base64 of ≤ 4096 bytes */; readonly bufferId: string /* "console-" + 8 hex */; readonly tailLines: number /* 40 */ }`
  - `export function buildDeliverCommand(plan: DeliverPlan): RemoteCommand` — throws `ProbeError` on any value outside its allow-list.
  - `export interface DeliverReport { readonly outcome: SubmitOutcome; readonly statusAtSend: string; readonly detail: string; readonly tailHashBefore?: string; readonly tailHashAfter?: string }`
  - `export function parseDeliverOutput(stdout: string, code: number): DeliverReport` — missing sentinel or non-zero exit → `failed` with a first-party detail (never stderr text).

  The script (all values are builder-validated literals; the text exists only as base64 in the heredoc):
  1. `f="$HOME/.claude/sessions/<sessionFile>"`; `[ -f "$f" ] || result refused_target_changed "session file gone"`.
  2. Read `sessionId`, `procStart`, `status`, `pid` with the probe's `grep -o` field extraction; `procStart` compared as epoch seconds: the file's value is ISO UTC → `date -u -j -f` on macOS / `date -u -d` on Linux both exist as `date`, but differ; **do not parse dates in sh**: the builder passes the card's `procStart` already as epoch seconds AND the probe (F1) already records the file's raw `procStart`; the script compares the RAW string from the file with the raw string the card stored (byte equality). Deviation from §6.6.4a's epoch wording, recorded in the plan: raw equality is stricter and needs no date parsing on the machine.
  3. `kill -0 <pid>` else `refused_target_changed "process gone"`.
  4. Pane chain: `tmux display-message -p -t <paneId> '#{pane_pid}'`, then walk `ps -ax -o pid=,ppid=` upward from `<pid>` to see `pane_pid` within 6 hops, else `refused_target_changed "pane no longer holds the session"`.
  5. `status` not `idle`/`busy` → `refused_menu_visible "status <status>"`.
  6. `tmux capture-pane -p -J -S -<tailLines> -t <paneId>` → `before=$(… | sha256sum | cut -c1-16)` (`shasum -a 256` fallback) and `grep -q -F -e '<anchor>'…` at line start (`^` anchors via `grep -E` on the escaped literal) → `refused_menu_visible "<anchor>"`.
  7. `printf %s '<textB64>' | base64 -d | tmux load-buffer -b <bufferId> -` → `tmux paste-buffer -p -d -b <bufferId> -t <paneId>` → `tmux send-keys -t <paneId> Enter`; any non-zero → `failed "tmux step N"`.
  8. `sleep 0.5`; `after=$(capture … | sha256sum | cut -c1-16)`.
  9. `printf 'PANTHEON_DELIVER:result:%s:%s:%s:%s:%s\n' sent "$status" "$before" "$after" ""`.

- [ ] **Step 1: Write the failing tests**

```ts
it("the text never appears outside the base64 payload", () => {
  const text = "C-c /clear !ls $(id) `id` ; | ' \"";
  const cmd = buildDeliverCommand(plan({ textB64: Buffer.from(text).toString("base64") }));
  expect(cmd).not.toContain("/clear"); expect(cmd).not.toContain("$(id)");
  expect(cmd).toContain(Buffer.from(text).toString("base64"));
  expect(cmd).toMatch(/base64 -d \| tmux load-buffer -b console-[0-9a-f]{8} -/);
});
it("refuses every out-of-allow-list value before any command exists", () => {
  for (const bad of [{ sessionFile: "../x.json" }, { paneId: "%x" }, { procStart: "2026-10-17T00:00:00Z;rm" }, { bufferId: "console-zz" }, { textB64: "not*base64" }, { pid: -1 }])
    expect(() => buildDeliverCommand(plan(bad))).toThrow(ProbeError);
});
it("the heredoc cannot be terminated by the payload", () => { /* a base64 line equal to HEREDOC_TAG cannot occur (charset) — assert the structural guard throws on a crafted script */ });
it.each([["sent"], ["refused_target_changed"], ["refused_menu_visible"], ["failed"]])("parses a %s record", (o) => {
  expect(parseDeliverOutput(`login banner\nPANTHEON_DELIVER:result:${o}:idle:abcd1234abcd1234:ffff0000ffff0000:detail\n`, 0).outcome).toBe(o);
});
it("missing sentinel or non-zero exit is failed with a first-party detail", () => {
  expect(parseDeliverOutput("Permission denied (publickey)", 255)).toEqual({ outcome: "failed", statusAtSend: "", detail: "the delivery script did not report back" });
});
it("embeds every MENU_ANCHORS entry as a literal grep", () => { for (const a of MENU_ANCHORS) expect(buildDeliverCommand(plan())).toContain(a); });
```

- [ ] **Step 2: Run** `npx vitest run test/console-deliver-command.test.ts` → FAIL.

- [ ] **Step 3: Implement** `deliver-command.ts`; export `mintScript` from `probe-command.ts` (rename of its private `mint`, same body) and update its comment; `connection.ts` line 20 lists the new mint sites.

- [ ] **Step 4: Run** `npx vitest run test/console-deliver-command.test.ts test/console-probe-command.test.ts` → PASS. Then, on Mac-Mini against a throwaway tmux session (`tmux new-session -d -s f2-deliver-test 'cat'`), run the minted script once by hand through `runRemoteCommand` (a one-off script in the scratchpad, not in the repo) and record the `PANTHEON_DELIVER:result:sent:…` line in the ledger; `cat` shows the pasted text verbatim. Kill the test session afterwards.

- [ ] **Step 5: Checkpoint** `task-05.patch`.

---

### Task 6: Submit and Dismiss routes

**Files:**
- Modify: `src/http/routes/console.ts`, `src/console/poller.ts` (expose `latestLiveSession(machine, sessionId)` is not needed — the route reads the store), `src/http/app.ts`
- Test: `test/console-routes.test.ts`

**Interfaces:**
- Consumes: Task 3 `requireElevated`; Task 4 `validateSubmitText`, `IDEMPOTENCY_KEY_RE`, store methods; Task 5 builder + parser; `resolveConnectableMachine`, `ConsoleRemoteRun` (F1).
- Produces:
  - `POST /console/api/cards/:id/submit` body `{ text: string; key: string }`:
    - 403 step-up (Task 3); 400 `{ error: "unexpected card id" }`; 404 no such card; 400 `{ error: "<SubmitRefusal>" }` with the text NOT echoed; 400 `invalid_key`;
    - replay: `findSubmitResult(key)` → 200 the stored `{ outcome, at, message }` without a dial;
    - 409 `{ error: "not_reachable" }` when the card's session row is missing, `reachable` false, `endedAt` set, or the tmux session starts with `sh-`; 409 `menu_card` when `card.kind === "menu"`;
    - write-ahead `attempted` row (`text_masked = mask(text)`, `status_at_send` = the session row's status); then `buildDeliverCommand` with `sessionFile = \`${claudePid}.json\``, `procStart` = the row's raw value, `bufferId = "console-" + id.slice(0, 8)`, `tailLines = 40`; exec with `{ timeoutMs: 6000, maxOutputBytes: 65536 }`; an exec throw → result `failed` (Review Focus 3);
    - result row appended; on `sent`: `markAnswered(id)` when `card.needsKind === "reply_question"`; response 200 `{ outcome: "sent", at, message: "answered by you" | "sent — waiting for the session" | "queued — the session is busy" }` (queued when `statusAtSend === "busy"`), or 200 with the refusal outcome and the §9 message (`"The session this card came from has ended or was cleared"`, `"This session is showing a prompt — open its Claude session"`, `"Send failed — the text is still in the box"`). HTTP 200 for every reported outcome: the outcome is the result, not a transport error.
  - `POST /console/api/cards/:id/dismiss` → step-up NOT required (no session is touched) → `markDismissed`; 200 `{ dismissedAt }`.
  - Both routes `exposeHeadRoute: false`, no-store.

- [ ] **Step 1: Write the failing tests** (fake exec records the command; the F1 harness pattern): happy path writes exactly two log rows in order (`attempted`, `result sent`) and the response says `answered by you` for a reply_question card; replay with the same key makes no second exec call and returns the same body; Review Focus 3 (exec rejects with `SshConnectionError("timed out")` → rows `attempted` + `result failed`, response outcome `failed`, message keeps-the-text wording); refusal outcomes map to the §9 messages; 403 without step-up; 400 for ESC text and the body does not contain the text; 409 for a not-reachable session and for `sh-` tmux names; menu card 409; cross-site 403; HEAD → 404.

- [ ] **Step 2: Run** `npx vitest run test/console-routes.test.ts -t "submit"` → FAIL.

- [ ] **Step 3: Implement** the two routes in `registerConsoleRoutes` (deps gain `stepUp`, `sessions`, `operatorPassword` from Task 3). The route never logs the text; the structured log event `console.submit` carries `{ cardId, machine, outcome, bytes, correlationId }` only.

- [ ] **Step 4: Run** `npx vitest run test/console-routes.test.ts` → PASS.

- [ ] **Step 5: Checkpoint** `task-06.patch`.

---

### Task 7: Machine shells — settings `machines.projectsRoot` and the `?shell=1` terminal attach

**Files:**
- Modify: `src/console/settings.ts`, `src/devmachine/tmux.ts`, `src/http/routes/terminal.ts`, `src/http/app.ts` (terminal route deps gain `projectsRootFor`)
- Test: `test/console-settings.test.ts`, `test/devmachine-tmux.test.ts`, the terminal route test file

**Interfaces:**
- Produces (`settings.ts`): `ConsoleSettings` gains `readonly machines: Readonly<Record<string, { readonly projectsRoot: string }>>` (default `{}`); key must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, `projectsRoot` must pass `assertRemoteDir`; `export function projectsRootFor(settings: ConsoleSettings, logicalName: string): string | undefined`.
- Produces (`tmux.ts`): `export function assertRemoteDir(path: unknown): string` — absolute, ≤ 512 bytes, no `'`, no `\0`–`\x1f`, no `\x7f`, no `..` segment, spaces allowed; `buildTmuxAttachCommand(name, { create?: boolean; cwd?: string })` → with `create` and `cwd`: `tmux new-session -A -s '<name>' -c '<cwd>'` (single-quoted; the allow-list admits no `'`).
- Produces (`terminal.ts`): query `shell=1` (mutually exclusive with `tmux`) → name `sh-<logicalName>` (checked by `assertTmuxSessionName`), cwd = `projectsRootFor(settings, logicalName)`; no root → the socket's first frame is `{ t: "e", m: "no projects root configured for <machine> — add machines.<machine>.projectsRoot to the console settings file" }` and closes (labelled, never a bare 500). An audit row `created_shell` is appended to `console_submit_log` the first time the shell is created in this process (a per-machine `Set`), with `machine`, `tmux_session`, `card_id` NULL.

- [ ] **Step 1: Write the failing tests** — settings: `machines` accepted with two entries; bad key / relative root / root with `'` / `..` → `{ ok: false, entry: "machines[\"Mac-Mini\"].projectsRoot" }`; F1 file (no `machines`) still ok with `{}`. tmux: `assertRemoteDir("/Users/karl/Documents/Claude Projects")` ok (space kept); the command string is `… tmux new-session -A -s 'sh-Mac-Mini' -c '/Users/karl/Documents/Claude Projects'`. terminal route: `?shell=1` builds that command; `?shell=1&tmux=x` → 400; a machine without a root → the labelled `e` frame.

- [ ] **Step 2: Run** the three files → FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `npx vitest run test/console-settings.test.ts test/devmachine-tmux.test.ts test/terminal*.test.ts` → PASS.

- [ ] **Step 5: Checkpoint** `task-07.patch`.

---

### Task 8: New-session flow — list projects, create a Claude session (spec §14.1)

**Files:**
- Create: `src/console/session-command.ts`
- Modify: `src/http/routes/console.ts`
- Test: `test/console-session-command.test.ts`, `test/console-routes.test.ts`
- Fixture: `test/fixtures/console/pane-trust-prompt-new-folder.txt` (captured on Mac-Mini by starting `claude` in an empty folder inside tmux, scrubbed as the F1 README describes; prove it matches the F1 trust-prompt fixture rule in `test/console-menu-fixtures.test.ts`).

**Interfaces:**
- Produces (`session-command.ts`):
  - `export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/` (no slash, no leading dot — spec §14.1.4); `export function assertProjectName(v: unknown): string`.
  - `export function tmuxNameForFolder(folder: string): string` — the basename with every char outside `[A-Za-z0-9_-]` → `-`, leading `-` → `_`, cut to 64; collisions handled by the route (suffix `-2`, `-3` … against the live tmux list).
  - `export function buildListProjectsCommand(root: string): RemoteCommand` — `find '<root>' -mindepth 1 -maxdepth 1 -type d` plus depth-2 directories that contain `.git`, names base64, sentinel `PANTHEON_PROJECTS:`; output cap 256 KiB.
  - `export function parseListProjectsOutput(stdout: string): readonly { readonly name: string; readonly path: string }[]` — a name failing `PROJECT_NAME_RE` is dropped and counted; sorted by name.
  - `export function buildCreateSessionCommand(plan: { readonly tmuxName: string; readonly cwd: string; readonly mkdir: boolean }): RemoteCommand` — when `mkdir`: `[ -e '<cwd>' ] && exit 3; mkdir '<cwd>'` (never `-p`, never git init); then `tmux has-session -t '=<name>' 2>/dev/null && exit 4; tmux new-session -d -s '<name>' -c '<cwd>' claude`; prints `PANTHEON_SESSION:created:<name>`.
- Produces (routes):
  - `GET /console/api/machines/:name/projects` → `{ root, projects: [{ name, path, running: string | null /* projectKey of a live session whose cwd equals path */ }], dropped: number }`; 409 `no_projects_root` without a root; unreachable → 502 labelled.
  - `POST /console/api/machines/:name/sessions` body `{ folder: string } | { newProject: string }` → step-up required; path resolved under the root (`path.posix.resolve` + prefix check with the root + `/`); tmux name from `tmuxNameForFolder` with suffixing against `listTmuxSessions`; audit `attempted` row then `created_session` / `created_project` / `refused_name` / `refused_root` / `failed`; 200 `{ tmuxSession, path, outcome }`. The page inserts the tab at once (Task 9).

- [ ] **Step 1: Write the failing tests** — name allow-list (`../x`, `.hidden`, `a/b`, 65 chars refused; `My App 2` ok); `tmuxNameForFolder("Claude Projects")` → `Claude-Projects`; the create command carries the folder only single-quoted and refuses a folder with `'`; list parser drops a bad name and counts it; route: `newProject` outside the root (`..`) → 400 `refused_root` with an audit row; collision suffix `-2` when the live list already has the name; step-up required; `running` set when a `console_session` row's cwd equals the path.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Capture the fixture on Mac-Mini in a throwaway folder under the scratchpad path on that machine, then delete the folder (change card for the deletion).

- [ ] **Step 4: Run** `npx vitest run test/console-session-command.test.ts test/console-routes.test.ts test/console-menu-fixtures.test.ts` → PASS.

- [ ] **Step 5: Checkpoint** `task-08.patch`.

---

### Task 9: Console page — fold, reply box, buttons, step-up dialog, drawer, view switch, new session

**Files:**
- Modify: `src/http/console-page.ts` (markup, CSS, `CONSOLE_CLIENT_JS`), `src/http/terminal-client.ts` (export a `pantheonOpenTerminal(host, wsUrl, hooks)` factory extracted from `harness-frame.ts`'s `openTerminalTab` body so the drawer and the view reuse one bootstrap; `harness-frame.ts` calls it too — no behaviour change there, its tests stay green)
- Test: `test/console-page.test.ts` (jsdom), `test/harness-frame*.test.ts` unchanged

**Interfaces:**
- Consumes: the F1 client (`renderCard`, `applyCardUi`, `uiFor`, `SECTIONS`, `wsUrl` pattern), the routes of Tasks 3, 6, 7, 8.
- Produces (client functions, all inside `CONSOLE_CLIENT_JS`):
  - **Fold (trial finding 4):** each card renders the title line + a `▸ TL;DR` toggle; the TL;DR `div` is `hidden` unless open. Default open: cards with `needsYou`; everything else folded. The per-card fold state lives in `localStorage` key `console.fold.<id>` (try/catch; absent = default). A "Fold all / Expand all" control in the cards header (label reflects the next action, as the machines sidebar does).
  - **Reply box:** `renderReplyBox(art, c)` on every card whose session is reachable and not `sh-`, not `kind === "menu"`: a `textarea` (`maxlength` 4096 chars, a byte counter `N / 4096 bytes`, Enter inserts a newline), a **Submit** button, and the status line. Disabled with the reason text for not-reachable / shell / ended sessions.
  - **Buttons:** `reply_question` cards → one button per `c.options` entry that appends the letter/id to the box (`copyLetter(id)`), never sends; sentinel cards (kind `reply` with `needsKind === "sentinel"`) → buttons that send only the option id (`submit(c.id, optionId)`) after step-up; `commit_approval` → no buttons, the box only (D5); `menu` → options read-only + **Open Claude session** (R5) and no box.
  - **Dismiss** on `reply_question` cards → `POST …/dismiss`, card leaves the needs-you group.
  - **Step-up dialog:** `ensureElevated(then)` — `GET /console/api/step-up`; if not elevated, a modal with one password field → `POST`; on 200 run `then`; the header shows `elevated until HH:MM` and a `Drop elevation` control (calls `POST /console/api/step-up` with `{ revoke: true }` — add that branch to Task 3's route: 204, `revoke`).
  - **Submit flow:** `submit(cardId, text)` → key = `crypto.randomUUID()` kept on the card UI until a non-`failed` outcome; status line per outcome: `answered by you, HH:MM` / `sent — waiting for the session` / `queued — the session is busy` / the §9 refusal messages; the text stays in the box on refusal or failure; the box clears on `sent`.
  - **Drawer (§14.2):** `drawer.open(machine)` attaches xterm to `wsUrl(machine, { shell: true })` (terminal-client factory); one drawer instance per machine, kept alive when switching tabs (panels hidden, not destroyed); bar `Shell · <machine> · <cwd from the PTY title if present>`; minimise/restore via the bar button, `Ctrl+\`` (also inside xterm through `attachCustomKeyEventHandler`, next to the clipboard keys), and `Esc` **inside the shell when the drawer has focus** (not forwarded — documented as the one swallowed key; a reviewer confirms Karl accepts it or the task drops Esc and documents the exception, spec §14.2.6 allows either); height from `localStorage` key `console.drawer.height` (default 241 px), drag on the top edge and `ArrowUp`/`ArrowDown` on the focused grip (16 px steps).
  - **View switch:** each project tab carries `Cards | Claude session`; `Claude session` fills the main area with xterm attached to `wsUrl(machine, { session: project.tmux })`; the cards poll keeps running underneath; `Open Claude session` on any card switches to that project's tab and view in place; reconnect ids from the `ready` frame stored in `sessionStorage` (`console.term.<machine>.<view>`) and passed back as `?session=` on reload (Review Focus 5).
  - **New session:** `+ New session` on the machine row → dialog: project list from `GET …/projects` (`running — open it` rows switch to the Claude-session view instead), `New project` name field (`PROJECT_NAME_RE` mirrored client-side for the hint only; the server decides) → `POST …/sessions` after step-up → insert the project tab immediately with the returned `tmuxSession` and open its Claude-session view.
  - The trust prompt in a brand-new folder surfaces as a `menu` card via the F1 signal (Task 8 fixture); the dialog's status says "the new session is asking you to trust the folder — answer it in the Claude session".

- [ ] **Step 1: Write the failing tests (jsdom)** — fold: a needs-you card renders its TL;DR visible, a plain card hidden with `▸ TL;DR`; the toggle flips `hidden` and writes `localStorage`; reply box present only on reachable non-menu cards; a `reply_question` card with options `["A1","A2"]` renders two buttons and clicking `A1` appends `A1` to the textarea without a fetch; a sentinel card's button fetches `/submit` with body `{ text: "A1", key: <uuid> }` only after the step-up dialog resolved (fetch mock sequence: GET step-up → 403-shaped null → POST step-up → POST submit); a `commit_approval` card has no buttons; a `menu` card has no textarea and an `Open Claude session` button that switches the view (`[data-view="claude"]` pressed); outcome messages map to the §9 strings; the box keeps its text on `refused_menu_visible` and clears on `sent`; drawer: `Ctrl+\`` toggles `[data-drawer][data-minimised]`; `ArrowUp` on the grip grows the height by 16 and persists it; switching project tabs on the same machine keeps the same drawer element; switching machines shows a different one; `sh-` tmux names never render a project tab.

- [ ] **Step 2: Run** `npx vitest run test/console-page.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Extract `pantheonOpenTerminal` first and keep `test/harness-frame*.test.ts` green before touching the console page.

- [ ] **Step 4: Run** `npx vitest run test/console-page.test.ts test/harness-frame*.test.ts test/console-routes.test.ts` → PASS; `npm run lint` clean.

- [ ] **Step 5: Checkpoint** `task-09.patch`.

---

### Task 10: F1 carries and the poller's reply-question flag

**Files:**
- Modify: `src/console/poller.ts`, `src/http/app.ts`, `src/http/routes/console.ts`
- Test: `test/console-poller.test.ts`, `test/console-routes.test.ts`

**Interfaces:**
- Poller: when building faces for a session, `detectNeedsYou` receives `replyText` of the LAST turn only; the latest card is upserted with `asksYou` + `options` from a `reply_question` signal; on later ticks with no new faces, `setCardNeeds` keeps `reply_question` (sticky) unless the card is answered/dismissed or a stronger signal appears (then that signal's kind/needsKind win; when it disappears, `reply_question` returns if still unanswered). A newer turn supersedes: `clearNeedsYou` on new faces already does this.
- `procStart` compared when `pickLiveSession` matches a stored row: a different `procStart` for the same pid ends the old row (`markEnded`) and starts a new one (F1 carry: pid reuse).
- Busy session whose transcript size is unchanged since the previous poll: skip the slice read this tick (F1 carry: retry starvation), still tail the pane.
- `app.ts`: `app.setNotFoundHandler` returning `{ error: "not_found" }` (JSON) or a one-line HTML page — never echoing the path (F1 carry; BUGS row to add in Task 11).
- Every console API route registered with `{ exposeHeadRoute: false }`; test: `HEAD /console/api/cards/<id>/expand` → 404 and no exec call.

- [ ] **Step 1: Write the failing tests** — poller: a transcript whose last reply says `Waiting on you: reply A1` flags the latest card `needsKind "reply_question"`, `options ["A1"]`; next tick with no new bytes keeps it; `markAnswered` then next tick → not flagged; a sentinel appearing → `sentinel` wins, disappearing → `reply_question` again; pid reuse with a new `procStart` → two rows, the old `endedAt` set; busy + unchanged size → exec called once (tail only) not twice. Routes: HEAD → 404; `GET /nope` → body without the path.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` (whole suite) → PASS; mark `build_loop:implemented`. **Step 5: Checkpoint** `task-10.patch`.

---

### Task 11: Security audit, documentation, record, commit, deploy

**Files:**
- Create: `docs/security-audits/maestro-console-f2-security-audit.md`
- Modify: `FEATURES.md` (Feature 16: Maestro Console F2), `CHANGELOG.md` (Security, Data Model, Added, Changed, Fixed, Documentation), `PROJECT_BIBLE.md` §5 (`console_submit_log`, the three card columns), §7 (tier-3 step-up as built), §9 C.9 (F2 controls), §4 TM-025 status, `BUGS.md` #36 (Submit enforces the step-up; keycard mint/revoke next) + a new row for the app-wide 404 path echo (fixed here), `docs/user-guide.html` Console section (reply box, buttons, step-up, Dismiss, drawer, view switch, new session, what is never sent), `deploy/README.md` (settings `machines` key with both roots; the Submit audit table), `docs/ADR documentation/ADR-0010-maestro-console-inside-the-harness.md` follow-up (O1 as built, step-up as built, raw-`procStart` deviation), `.env.local.example` (nothing new — say so), the spec's §6.6.4a wording (raw `procStart` equality) with a dated note.

- [ ] **Step 1: Security audit** (Senior Security Engineer persona, five parallel audit agents per CLAUDE.md: SAST, threat model TM-025/TM-020, data isolation, input validation, logging) over the F2 diff: the send path end to end, the step-up window, the three new mint sites, the new-session root containment, the drawer's shell access. Every finding fixed or recorded as a residual with its reachability. Mark `build_loop:security_audit`.
- [ ] **Step 2: Documentation** as listed; mark `build_loop:documentation_updated`.
- [ ] **Step 3: Whole-branch adversarial review** (fresh top-tier reviewer, max effort; falls back to the next tier only on quota, recorded) → one fix wave → scoped re-review → SHIP.
- [ ] **Step 4: Verify** `npm test`, `npm run lint`, `npm run build` → quote the tallies; `git status --short` → only F2 files.
- [ ] **Step 5: Record and commit** — `scripts/test-gate.sh --record-feature "maestro-console-f2"`; stage every F2 file by explicit path; schema-2 sentinel; lone `git commit -m "feat(console): Maestro Console F2 - answer from the page: O1 reply questions, step-up Submit, audited delivery, drawer, Claude-session view, new-session flow (ADR-0010, F2)"`; Karl pushes to GitHub.
- [ ] **Step 6: Deploy to VM 1093** — change card; stop → DB backup (`db` + `-wal` + `-shm` together while stopped, `data/backup-pre-<sha>/`) → pull → `npm ci` only if the lockfile changed → build → `PANTHEON_BUILD=<sha>` → start; add `machines` with both `projectsRoot` values to `data/console-settings.json` (v3; keep v2 beside it) → restart → verify `x-pantheon-build`, `console.routes_mounted settingsOk true`, `GET /console/api/step-up` 401 unauthenticated, and one real Submit into a throwaway tmux session on Mac-Mini (recorded in the ledger with its two audit rows). Then `scripts/test-gate.sh --check-batch` → UAT-6 is due.

---

## Self-review notes (done while writing)

- **Spec coverage:** §6.3 signal 3 → Task 2 + Task 10; §6.4 cards (buttons, Dismiss, box) → Task 9; §6.6 steps 1–6 → Tasks 3, 4, 5, 6; §7 `console_submit_log` → Task 4; §8.2 (step-up, Sec-Fetch-Site, idempotency, refuse-not-strip, target re-verify, menu refusal, base64 paste, no buttons on commit approvals) → Tasks 3–6, 9; §9 rows "target changed / menu visible / send failed" → Task 6 messages + Task 9 display; §10 F2 test list → each item named in Tasks 5, 6, 9, 10 except "commit-approval two-step flow end to end against CDF 4.4.5 in a test project" and "prove what Claude Code does with each pasted token", which are UAT-6 scenarios (live sessions), noted in Task 5 Step 4 and Task 11 Step 6; §14.1 → Tasks 7, 8, 9; §14.2 → Tasks 7, 9; F1 carries → Task 10 (procStart, busy re-read, HEAD, 404 handler) and the Global Constraints (per-session face cap and pino consolidation are NOT in F2 — left in the ledger as deferred, small and unrelated to answering).
- **Deviation recorded:** §6.6.4a compares `procStart` "as epoch seconds"; this plan compares the raw stored string for byte equality (stricter, no date parsing in `sh`); the spec gets a dated note in Task 11.
- **Type consistency:** `NeedsKind` extended in Task 2 and consumed in Tasks 4, 6, 9, 10 by the same literal `"reply_question"`; `SubmitOutcome` defined in Task 4, produced by Task 5's parser, stored by Task 6; `ConsoleRoutesDeps` additions (`stepUp`, `sessions`, `operatorPassword`) introduced in Task 3 and used in Tasks 6 and 8; `projectsRootFor` from Task 7 used by Tasks 7 (terminal) and 8 (routes); `pantheonOpenTerminal` from Task 9 used by the drawer and the view only.
- **Review Focus:** five lines, each pinned (Tasks 2, 5, 6, 3+6, 9).
- **Proportion:** 11 tasks for a spec section set of roughly 120 lines; code blocks are test assertions and one script outline (the delivery script's steps are the plan's decisions — the exact tmux lines come from the spec).
- **Open choice for Karl at plan review:** Task 9's `Esc` minimises the drawer and is not forwarded to the shell (spec §14.2.2 names Esc; §14.2.6 allows documenting an exception). Say "forward Esc" to drop that key from the toggle set.
