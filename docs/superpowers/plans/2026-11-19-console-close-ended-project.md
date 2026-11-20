# Console: Close an Ended Project's Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "✕ Close" control removes an ended project's tab and cards from the Maestro console in every browser, deleting nothing.

**Architecture:** A nullable `closed_at` column on `console_session` marks ended sessions as closed. The state route lists only open sessions and their cards. One guarded POST route sets the mark; the page shows the control when every session of a project has ended.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3, vitest 4 with jsdom. All paths below are under `services/control-plane/`.

**Spec:** `docs/superpowers/specs/2026-11-19-console-close-ended-project-design.md`

## Global Constraints

- Nothing is deleted: no `DELETE` on `console_session` or `console_card`.
- A session is closed only while `ended_at` and `closed_at` are both non-null. `upsertSession` never writes `closed_at`.
- Schema change is additive, through `ensureColumn`; the `CREATE TABLE` text stays as written.
- Route guard is the same as Dismiss: operator sign-in, `preValidation: jsonOnly`, `exposeHeadRoute: false`, `Cache-Control: no-store`, no step-up.
- Log lines carry class and code of an error only, never its message (D13).
- The console page's client script and stylesheet are TypeScript template literals: no backtick and no `${` inside them, comments included.
- No colour-only meaning: the control reads "✕ Close" in words.
- One Build Loop for the whole feature (`scripts/process-checklist.sh --start-feature "console-close-ended-project"`), started only after BUGS #88 is committed. The pre-commit check refuses a `feat:` commit until every loop step is marked, so there is one commit at the end, with Karl's approval, not one per task.

## Review Focus

1. A session is seen alive again between the page drawing the control and the POST → the route answers 409, the tab stays, the reason is shown. (Task 2 and Task 3 tests.)
2. A needs-you card belongs to a closed session → it is absent from `cards`, so the header count and the page title count drop. (Task 2 test.)
3. A project key with spaces, `@` or non-ASCII (`scratch dir@Linux-Dev`) → closes correctly; the key is never placed in a URL. (Task 2 and Task 3 tests.)
4. The same project is closed twice, or from two browsers → second answer is 200 with `closed: 0`, no error shown. (Task 1 and Task 2 tests.)
5. Another browser has the closed project selected → on its next poll the selection falls back to "All projects" and the page does not show an empty project. (Task 3 test.)

---

### Task 1: Store — the `closed_at` mark and the open listings

**Files:**
- Modify: `src/console/store.ts`
- Test: `test/console-store.test.ts`

**Interfaces:**
- Produces: `ConsoleSessionRow.closedAt: string | null`
- Produces: `closeProject(machine: string, projectKey: string, now: string): { readonly outcome: "closed"; readonly sessions: number } | { readonly outcome: "live" } | { readonly outcome: "unknown" }`
- Produces: `listOpenSessions(): ConsoleSessionRow[]` — as `listSessions()` without sessions that are ended and closed
- Produces: `listCards(filter, limit)` gains `filter.openOnly?: boolean` — when true, leaves out cards whose session is ended and closed

- [ ] **Step 1: Write the failing tests** in a new `describe("closing an ended project")`:
  - `adds closed_at to a database created without it`: create a file database with the pre-change `console_session` DDL through `better-sqlite3` directly, open it with `SqliteConsoleStore`, expect `PRAGMA table_info(console_session)` to list `closed_at` and a second open not to throw.
  - `marks only the ended sessions of that machine and project`: sessions A (proj, ended), B (proj, ended), C (other project, ended), D (same project key on another machine, ended); `closeProject("Mac-Mini", "proj", T2)` equals `{ outcome: "closed", sessions: 2 }`; `closedAt` is `T2` on A and B and `null` on C and D.
  - `refuses while a session of the project is live`: A ended, B live → `{ outcome: "live" }` and A's `closedAt` stays `null`.
  - `answers unknown for a machine and project with no session` → `{ outcome: "unknown" }`.
  - `a second close marks nothing` → `{ outcome: "closed", sessions: 0 }` and the first `closedAt` is unchanged.
  - `listOpenSessions leaves out closed sessions and keeps a live one in the same project`.
  - `a closed session upserted alive again is listed again`: after the close, `upsertSession({...A, endedAt: null}, T2)` → A is in `listOpenSessions()`.
  - `listCards with openOnly leaves out a closed session's cards, including a needs-you card, and does not spend the limit on them`: 3 cards on the closed session, 2 on a live one, `listCards({ openOnly: true }, 2)` returns the live session's 2.
- [ ] **Step 2: Run** `npm test -- test/console-store.test.ts` from `services/control-plane`. Expected: the new cases fail (`closeProject is not a function`, missing `closedAt`).
- [ ] **Step 3: Implement.** Add a `SESSION_F3_COLUMNS` list with `{ column: "closed_at", ddl: "TEXT" }` applied by `ensureColumn("console_session", …)` beside the card columns; add `closed_at` to `SESSION_COLUMNS`, `SessionDbRow` and `toSession`. `closeProject` runs in one `db.transaction`: count rows for the machine and project (0 → `unknown`), count those with `ended_at IS NULL` (>0 → `live`), then `UPDATE … SET closed_at = ?, version = version + 1, updated_at = ? WHERE machine = ? AND project_key = ? AND ended_at IS NOT NULL AND closed_at IS NULL` and return `changes`. The open filter is `NOT (ended_at IS NOT NULL AND closed_at IS NOT NULL)`; for cards it is a `NOT EXISTS` on `console_session` joined by `machine` and `session_id`.
- [ ] **Step 4: Run** the same command. Expected: all cases in the file pass.

### Task 2: Route — close, log line, and the state payload

**Files:**
- Modify: `src/http/routes/console.ts`
- Test: `test/console-routes.test.ts`

**Interfaces:**
- Consumes: `closeProject`, `listOpenSessions`, `listCards({ openOnly: true })` from Task 1.
- Produces: `POST /console/api/machines/:name/close-project`, body `{"projectKey": string}`. 200 `{ "closed": number }`; 400 `{ "error": "unexpected machine name" }` or `{ "error": "unexpected project key" }`; 404 `{ "error": "no such project" }`; 409 `{ "error": "a session in this project is still running" }`.
- Produces: `ApiSession.closedAt` is not added; closed sessions are simply absent from `GET /console/api/state`.

- [ ] **Step 1: Write the failing tests** in a new `describe("POST /console/api/machines/:name/close-project")`, using `makeApp`, `sessionRow` and `faceOf`:
  - no sign-in → the same refusal status the Dismiss guard test expects.
  - a form-encoded body → the status `jsonOnly` gives Dismiss.
  - machine name `bad name!` → 400 `unexpected machine name`.
  - `projectKey` missing, a number, empty, 201 characters, or containing `\n` → 400 `unexpected project key` (`it.each`).
  - unknown machine and project → 404.
  - one live session in the project → 409, and state still lists the project's sessions.
  - two ended sessions → 200 `{ closed: 2 }`; exactly one log line with `event: "console.project_closed"`, `machine`, `projectKey`, `sessions: 2` and a `correlationId`; the response has `cache-control: no-store`.
  - after that close, `GET /console/api/state` has none of the project's sessions and none of its cards, a needs-you card included.
  - project key `scratch dir@Linux-Dev` closes with 200.
  - a second close → 200 `{ closed: 0 }` and a second log line with `sessions: 0`.
  - `HEAD` on the route → 404.
- [ ] **Step 2: Run** `npm test -- test/console-routes.test.ts`. Expected: the new cases fail with 404 for the unknown route.
- [ ] **Step 3: Implement.** Register the route after Dismiss. Import or share `MACHINE_NAME_RE` from `console-sessions.ts` rather than copying it. Project key rule: `typeof === "string"`, length 1 to 200, no character below U+0020 and no U+007F. Map `closeProject` outcomes to 200 / 409 / 404. Log with the existing `logEvent("info", …)`. Change the state route to `deps.store.listOpenSessions()` and both `listCards` calls to pass `openOnly: true`.
- [ ] **Step 4: Run** the same command, then `npm test`. Expected: all pass.

### Task 3: Page — the Close control

**Files:**
- Modify: `src/http/console-page.ts` (client script and stylesheet)
- Test: `test/console-page.test.ts`

**Interfaces:**
- Consumes: the route and answers from Task 2.
- Produces: a `button[data-close-project]` carrying `data-machine` and `data-project`, a sibling of the project's `button[data-project-tab]`, never its descendant.

- [ ] **Step 1: Write the failing tests** in a new `describe("closing an ended project")`, using `fleet`, `session`, `serve` and `boot`:
  - the control is present for a project whose sessions all have `endedAt`, absent for a project with one live and one ended session, absent on a pending tab, and present for an ended project in the unreachable group.
  - it is not inside `[data-project-tab]`, its text is `✕ Close`, and its accessible name is `Close ‹display› on ‹machine›`.
  - pressing it sends `POST /console/api/machines/Linux-Dev/close-project` with `content-type: application/json` and the body `{"projectKey":"scratch dir@Linux-Dev"}`; the machine name in the path is `encodeURIComponent`-encoded.
  - on 200 the tab is gone before the next poll and, when that project was selected, "All projects" is pressed.
  - on 409 the tab stays and the text `a session in this project is still running` is shown beside it; on a network failure the tab stays and a reason in words is shown.
  - a state payload that no longer carries the selected project (closed from another browser) → the selection falls back to "All projects".
  - it is in the tab row's keyboard order: focus moves to it with the same keys that move between tabs, and Enter activates it.
- [ ] **Step 2: Run** `npm test -- test/console-page.test.ts`. Expected: the new cases fail; if the file reports "no tests", a backtick or `${` has entered the page script.
- [ ] **Step 3: Implement.** In `renderProjectTabs`, when `p.sessions.length > 0 && p.live === 0 && !p.pending`, append the control after `projectTab(p)`. Keep closed keys for this page load in an in-memory map (as the card code does; no `localStorage`) so the tab stays hidden until a poll stops sending it. Reuse the page's existing POST helper and its error-in-words pattern.
- [ ] **Step 4: Run** the same command, then `npm test`, `npm run lint`, `npm run build`. Expected: all exit 0.
- [ ] **Step 5: Real-browser check.** Against a localhost fixture (the real page, a fake state endpoint that logs requests), in Chrome at 1440 px and 900 px: the control does not push the tab row onto a second line for five ended tabs, it has a visible focus ring, and Tab / arrow keys reach it. Record what was seen in the audit file.

### Task 4: Audit, documents and the commit

**Files:**
- Create: `docs/security-audits/console-close-ended-project-security-audit.md`
- Modify: `CHANGELOG.md`, `FEATURES.md`, `PROJECT_BIBLE.md` (console data model: `closed_at`), `docs/api and interfaces/` (the new route), `docs/superpowers/specs/2026-10-16-maestro-console-design.md` (§9 row "Session ended": point to this design)

- [ ] **Step 1:** One adversarial review by a fresh agent on the top-tier model (guard on the route, the SQL, the 409 race, hidden needs-you cards, the page's handling of a hostile project key). Fix what is reachable; record the rest as residuals in the audit file.
- [ ] **Step 2:** Update the documents listed above and mark `build_loop:security_audit` and `build_loop:documentation_updated`.
- [ ] **Step 3:** `/self-review-diff`, stage each file by name, ask Karl to approve one `feat(console):` commit, then `scripts/test-gate.sh --record-feature "console-close-ended-project"` in its own approved `chore:` commit.
- [ ] **Step 4:** After Karl pushes: deploy to VM 1093 under a change card (the database gains a column on first start; back up `data/control-plane.db` first), then Karl checks the control on the live console in Zen.
