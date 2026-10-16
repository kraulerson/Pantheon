# UAT Session 5 — completeness, consolidation, triage (2026-10-16)

**Submission:** `submissions/test-session-5-v1-results.md` — tester was an **agent** (Fable, max
effort) driving Karl's signed-in Chrome at his request, relayed by the Maestro session. Three runs
08:30–09:27 MDT against build `8cd3ce5` (verified by header, asset query and on-page stamp). The
HTML template could not be exported because the browser extension refuses `file://` URLs, so the
results live in the Markdown file. Text evidence (tmux lists before/after each run, scratch-pane
history) is in `submissions/evidence/`; the two recording GIFs (4.8 MB + 7.0 MB) are **not** in the
repository — they sit in the Maestro session's scratchpad folder `uat5/` and in `~/Downloads`.

## Completeness (verified here, 2026-10-16)

| Verdict | Count | Scenarios |
|---|---|---|
| PASS | 10 | 1, 2, 3, 4, 5, 11, 12, 15, 17, 18 |
| FAIL | 1 | 10 |
| SKIP (Karl's ruling) | 2 | 6 (no registered-but-unprovisioned machine to show), 13 (Alden approval store not wired — `PANTHEON_APPROVAL_SOURCES` unset on VM 1093, confirmed by ssh) |
| NOT RUN (Karl chose **finish**) | 5 | 7 (narrow-window scroll pass), 8 (typing feel), 9 (Option-drag + ⌘C), 14 (admin-host leg of the keycard door; the harness-host leg and the unauthenticated curl legs passed), 16 (chat sign-in, then New Session → Start) |

Agent results on file: `agent-results/automated-suite.md`, `agent-results/adversarial-probe.md`
(2026-08-31). Suite re-run 2026-10-16: 671 pass / 5 skip, `tsc` + `eslint` clean at `ab4f24b`.

Tester conduct checked: one throwaway tmux session (`uat5-scratch`) created through the harness and
ended with `exit`; one keycard minted (`uat5-card-5`, approvals:read, 1 day) and revoked; the six
live tmux sessions and their attach counts identical before and after all three runs; no approvals,
machines or settings created; nothing committed.

## Investigation (read-only, 2026-10-16)

**#10 — a copy made inside tmux never reaches the Mac clipboard.** Reproduced by the tester five
ways (keyboard copy-mode in the harness, tmux mouse-drag copy, CLI `copy-selection-and-cancel` ×2,
`copy-pipe-and-cancel`, `tmux set-buffer -w`): tmux's buffer held the marker, the Mac clipboard did
not change. Control: a shell-emitted `\e]52;c;<base64>\a` reached the clipboard at once; `\e]52;s;…`
and `\e]52;;…` (empty selection field) were ignored.

Root cause **read in the pinned code, not inferred**: `@xterm/addon-clipboard` 0.2.0,
`src/ClipboardAddon.ts:80-84` —

```ts
public async writeText(selection, text) {
  if (selection !== 'c') { return Promise.resolve(); }
  return navigator.clipboard.writeText(text);
}
```

tmux sends its own copies through the terminfo `Ms` capability with an **empty** selection field,
so every tmux copy arrives as `52;;<base64>` and the stock provider discards it. The harness loads
the addon with no provider of its own (`src/http/terminal-client.ts`, `pantheonLoadAddons`), so it
inherited that behaviour. BUGS #46 recorded this path as "confirmed fixed 2026-08-31"; why it
appeared to work then is **not known** — the pinned addon version has not changed. Treated as a
defect that was never actually fixed.

**Observation (not a scenario):** after the page reload in scenario 4, the harness's first attach
process for `uat5-scratch` stayed attached beside the new one until the session ended ("attached
elsewhere" in the sidebar). This is the documented M1 task-1 design: a dropped socket detaches
only; the SSH session and tmux client are torn down by an explicit close frame, which a reload
never sends. Logged, not fixed.

## Consolidated defects

- **#48 (new, SEV-2):** tmux copies never reach the system clipboard through the harness — the
  clipboard addon's stock provider drops OSC 52 writes whose selection field is not `c`, and tmux
  emits an empty field. Acceptance of UAT-5 #10 (and the 2026-08-31 claim on #46) not met.
- **#49 (new, SEV-4):** a browser reload leaves the previous attach process connected to the tmux
  session until it ends; the sidebar shows the session as "attached elsewhere". Design limitation
  from M1 task 1, cleanup candidate.

## Triage — Karl's dispositions (2026-10-16)

- **#48 — Fix Now, option B1 (harness-side):** give the clipboard addon a Pantheon provider that
  treats an empty selection field as the system clipboard (and keeps `c`), instead of a per-machine
  tmux `terminal-overrides` line (option B2, rejected: outside the repo, repeated on every machine).
  Test-first against the **real** pinned addon class. Same change closes the OSC 52 *read* path
  (a program asking for the clipboard gets nothing back) — the stock provider would have answered
  a `c;?` query with the operator's clipboard, which can hold a token, into the PTY of a dev
  machine.
- **#49 — Deferred (SEV-4):** known design; revisit with the waker stage-2 session-lifecycle work.
- **6, 13 — Skip (ruling):** 6 has no test subject; 13 waits on the Alden approval-source token
  (still owed by the Alden infra session, `docs/handoffs/2026-08-28-prompt-for-alden-infra-approval-source.md`).
- **7, 8, 9, 14, 16 — not run (ruling: finish):** carried to UAT-6 unchanged; 9 and 10 to be re-run
  by hand after the #48 fix is deployed.
- **Tool updates (Semgrep, Snyk, Lighthouse, license-checker):** not answered this session; skipped.

## Security note on the #48 change (self-audit, single reviewer — change is client-side, operator-only)

- Write path unchanged in reach: OSC 52 content still only lands on the operator's own clipboard
  via `navigator.clipboard.writeText` (fallback `execCommand('copy')`), both already used by the
  ⌘C path. A remote program could already write the clipboard with `52;c;…`; honouring `52;;…`
  adds tmux's form, nothing else (`p` and other fields stay ignored).
- Read path **closed**: `readText` returns an empty string for every selection, so the addon's
  reply to a `?` query carries no data. Previously `navigator.clipboard.readText()` was reachable
  behind the browser's permission prompt.
- No server change, no new asset, no new dependency; the addon version stays 0.2.0 exact-pinned.

## Closure (2026-10-16)

- Results filed `a12a797`; #48 fixed `9348a52` and hardened after the independent adversarial
  review `e2c8e9b` (verdict SHIP; one new SEV-4 fixed, one pre-existing SEV-4 reworded; see
  `docs/security-audits/bugs-48-tmux-clipboard-osc52-security-audit.md`).
- Checklist 9/9 (`gate_passed` on the automated re-test against the real pinned addon); feature
  counter reset by Karl in his terminal (`scripts/test-gate.sh --reset-counter`, 2026-10-16);
  `scripts/test-gate.sh --check-batch` → "Clear to continue (2 features until next testing session)".
- The commit gate required a Build Loop for the source commits; it was opened as
  `bugs-48-tmux-clipboard-osc52` with the five performed steps marked and `feature_recorded`
  deliberately left unmarked (a bug fix must not count toward the test gate). Karl clears it with
  `scripts/process-checklist.sh --reset build_loop` before the next real feature starts.
- Carried to UAT-6: scenarios 7, 8, 9, 14, 16 (not run), 6 and 13 (skipped by ruling), plus the
  live hand check of #48 (Ctrl-b `[`, select, copy, paste outside the browser) after deploy.
- Phase 2 initialization checklist verified 7/7 on Karl's ruling A1 (APPROVAL_LOG 2026-10-16).
