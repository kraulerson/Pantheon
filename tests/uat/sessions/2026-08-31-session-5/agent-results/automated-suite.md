# Automated Suite — UAT Session 5

**Date:** 2026-08-31 · **Commit under test:** `8cd3ce5` (main; both remotes; VM 1093) · **Features:** 12 machines sidebar, 13 session-waker guardrails, plus the terminal fixes (#39 fit, #43 affordances, #44 build stamp, #45 scroll, #46 copy, #47 renderer).

## 1. Commands run, verbatim (services/control-plane)

```
$ npx vitest run | tail -6
$ npx tsc -p tsconfig.json --noEmit && echo "tsc: clean"
$ npx eslint . && echo "eslint: clean"
```

## 2. Output, verbatim

```

 Test Files  57 passed | 1 skipped (58)
      Tests  671 passed | 5 skipped (676)
   Start at  19:30:31
   Duration  1.89s (transform 873ms, setup 0ms, collect 3.80s, tests 4.62s, environment 590ms, prepare 1.89s)


--- tsc ---
tsc: clean
--- eslint ---
eslint: clean
```

## 3. What the suite covers for what is under test

- **Feature 12 sidebar:** `harness-shell.test.ts` — native `<details>`/`<summary>` per machine and their default open state, remembered fold state across reloads (via the `toggle` event), whole-sidebar fold + memory, Chat entry, sidebar persists with a tab open, empty state, no dial for a collapsed group + load on first unfold, dotted machine names, fit on sidebar toggle; `harness-frame.test.ts` — the sidebar holds the shortcuts and tmux controls (BUGS #22 invariant).
- **Feature 13 waker guardrails:** `session-waker.test.ts` — 16 tests: XC-6 refusal, empty/directional/case/malformed allowlist, mixed-batch refusal, per-pair window boundary + cooldown + isolation, the no-body canary, the light-briefing budget under a 200-sender flood, hold-while-busy, flush-when-idle, coalescing with the earliest since_id, rate limiting with cooldown, send-failure hold.
- **Terminal fixes:** `terminal-tab.test.ts` + `harness-shell.test.ts` — no `convertEol`, selection options, ⌘C / Ctrl+Shift+C copy, copy-on-select, plain Ctrl+C passthrough, clipboard + WebGL addons with the no-WebGL fallback and the software-rendering notice; `mount-prefix.test.ts` — build stamp, `X-Pantheon-Build`, build-versioned asset URLs, `no-store` on every console page.

## 4. Verdict

Green: 671 passed / 5 honest skips, `tsc` clean, `eslint` clean. NOT covered by the suite and therefore the point of this human session: everything visual and everything involving a real browser, a real tmux, a real clipboard, and the household's real approval store.
