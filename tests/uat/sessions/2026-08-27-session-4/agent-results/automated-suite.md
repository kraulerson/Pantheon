# Automated Suite — UAT Session 4

**Date:** 2026-08-27 · **Commit under test:** `e0140d7` (main; both remotes; VM 1093) · **Features:** 10 Pending-Approvals inbox, 11 harness under the chat address + LibreChat theme, fix BUGS #39 terminal fit.

## 1. Commands run, verbatim (services/control-plane)

```
$ npx vitest run | tail -6
$ npx tsc -p tsconfig.json --noEmit && echo "tsc: clean"
$ npx eslint . && echo "eslint: clean"
```

## 2. Output, verbatim

```

 Test Files  55 passed | 1 skipped (56)
      Tests  617 passed | 5 skipped (622)
   Start at  10:42:49
   Duration  2.03s (transform 769ms, setup 0ms, collect 4.48s, tests 4.88s, environment 1.19s, prepare 1.98s)

--- tsc ---
tsc: clean
--- eslint ---
eslint: clean
```

## 3. What the suite covers for the features under test

- **Feature 10 inbox:** `approvals-projection.test.ts` (closed allow-list, caps, Peta 1.2.x shape, PENDING page walk, dedupe, whole-walk timeout, spoof-char strip, numeric createdAt), `approvals-inbox.test.ts` (guard incl. keycard/identity-header/browser tiers, aggregation, D8 canary, ages, empty state, resolved-hidden count, unidentified count, more/cap, attribute-context escaping, headers, 503/502 labels, no decide affordance, nav link).
- **Feature 11 chat address + theme:** `base-path.test.ts`, `theme.test.ts` (LibreChat token values, color-theme boot incl. quoted form, storage events, dark terminals), `mount-prefix.test.ts` (every page/form/asset/redirect/login round-trip under the prefix; root mount unchanged; unclean header fails closed; cookie Path per mount; frame-ancestors 'self' + bust; WS same-site refusal; chatUrl; 17-pattern static invariant), `harness-shell.test.ts` (socket + tmux fetch under the base; Chat tab iframe vs link).
- **Fix #39:** `harness-shell.test.ts` (fit on open/ready/switch/resize; hidden tabs never fitted; missing addon fails closed), `terminal-tab.test.ts`, `http-app.test.ts` (fit addon asset).

## 4. Verdict

Green: 617 passed / 5 honest skips (live-integration suites without credentials), `tsc` clean, `eslint` clean. Not covered by the suite and therefore in the human session: Caddy path split behaviour (verified live 2026-08-27 through the household edge), LibreChat footer links, the embedded Chat tab in a real browser, theme following, terminal fit in a real browser, a REAL pending approval from Peta (queue was empty at every probe).
