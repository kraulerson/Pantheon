# Automated Suite — UAT Session 3

**Agent:** automated-suite (run inline by the session executor)
**Date:** 2026-08-25
**Repo:** `/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness`
**HEAD:** `383b9d9c6787358d1502018722c004e331a136d4` (Tue Aug 25 12:24:15 2026 -0600)
**Branch:** `main`
**Mode:** read-only. No source file edited by this run; results captured verbatim from the commands below.

## 1. Commands run, verbatim

| # | Working dir | Command | Exit / result |
|---|---|---|---|
| 1 | `services/control-plane` | `npx tsc --noEmit` | exit 0 |
| 2 | `services/control-plane` | `npx eslint src test` | exit 0 |
| 3 | `services/control-plane` | `npx vitest run` | Test Files  50 passed | 1 skipped (51);Tests  547 passed | 5 skipped (552); |
| 4 | `services/control-plane` | `npm audit --omit=dev` | found 0 vulnerabilities |
| 5 | `services/control-plane` | `npm audit` | found 0 vulnerabilities |
| 6 | `services/obsidian-mcp` | `npx tsc --noEmit` | exit 0 |
| 7 | `services/obsidian-mcp` | `npx vitest run` | Tests  24 passed (24) |

## 2. What the suite covers for the two features under test

- **Feature 8 tmux-aware launcher:** `devmachine-tmux.test.ts`, `devmachine-connection.test.ts`, `terminal-route.test.ts`, `harness-tmux-route.test.ts`, `harness-frame.test.ts`, `harness-shell.test.ts` (jsdom) — allow-list, sentinel parsing, coalescing/caching lister, attach/create commands (single-quoted for zsh), explicit close frame, labeled states.
- **Feature 9 session keycards:** `keycard-service.test.ts`, `keycard-routes.test.ts`, `config-page-keycards.test.ts`, `config-page-interactivity.test.ts`, `server.test.ts`, `session-store.test.ts` — auth-domain separation both ways, scope matrix, D8 projection, PRG one-shot token page, CSRF check, counters, pre-auth budget, revoke/expiry fail-closed, Peta wiring.
- Honest skips (5): live-integration tests that need credentials/endpoints not present on this runner (gitea-live, peta-live, preprocessor-live, mcp-registration live, devmachine-ssh live).

## 3. Verdict

All gates green at HEAD above; nothing blocks the human session.
