# Security Audit — Maestro Console F1 (read-only session feed)

Feature: Maestro Console F1 — one tab inside the Pantheon harness that lists every Claude Code session in tmux on every registered dev machine, its state, and one masked card per reply, read over the harness's existing SSH custody. Spec: `docs/superpowers/specs/2026-10-16-maestro-console-design.md` §5–§11. ADR-0010 R1–R6. Plan: `docs/superpowers/plans/2026-10-16-maestro-console-f1.md`. Execution ledger with every ruling: `.superpowers/sdd/2026-10-16-maestro-console-f1/progress.md` (git-ignored workspace; copied into the handoff notes).

Audit date: 2026-10-17. Method: Phase 2.4 per CLAUDE.md — eleven per-task reviews by fresh top-tier reviewers (Fable, max effort) with attack probes per module, then one whole-branch adversarial review (Opus, max effort — the Fable quota was exhausted mid-review; recorded as a deviation), one fix wave, one scoped re-review (Opus, max effort), each reviewer reproducing claims against the working tree with fake SSH, in-memory SQLite and jsdom. No commits existed during the review (operator ruling A1: one commit per F1).

## Headline

**Verdict: SHIP.** The composed security properties hold under adversarial testing:

- **Read-only toward every session.** Three `RemoteCommand` mint sites exist in the codebase; console code reaches only `src/console/probe-command.ts`. The two scripts it mints use `tmux list-panes`, `tmux display-message -p` and `tmux capture-pane -p` only; the only `kill` is `kill -0 "$pid"` (liveness) with a digits-only pid; no redirection writes a file; nothing writes under `~/.claude`. A test pins the forbidden verbs (`send-keys|paste-buffer|load-buffer|kill-|\bkill\b(?! -0 )`) and the redirection allow-list against the generated text.
- **Allow-list before text.** Every value interpolated into a remote script (session ids, pane ids, offsets, sizes, tail lines) passes its regex first and is single-quoted inside a quoted heredoc; crafted plan values (`sessionId: "x; rm -rf /"`, pane `%5\nPANTHEON_PROBE_SCRIPT`, string offsets, `MAX_SAFE_INTEGER`) are refused before any command string exists. Values that come back from a machine (the session file's `tmux` field, `cwd`, echoed offsets) are re-validated or stay machine-side.
- **Forbidden fields never cross the wire.** Session-file field extraction happens on the dev machine with an allow-list of ten keys; `bridgeSessionId`, `messagingSocketPath` and `*.key` files never appear in probe output (verified with a decoy fixture home).
- **Masking before every cut.** Card faces, titles, project keys, state words, reasons, signal details, health detail and the expand view are masked, then flattened, then masked again, then clipped — never clipped before a mask. Offset sweeps across every clip boundary (40, 60, 80, 120, 140, 200, 280, 512, 1024, 2 KiB, 16 KiB) show no token fragment surviving.
- **No page injection.** Every DOM node is created with `createElement` + `textContent`; the only `href` is a base-validated fixed path; `data-*`/`aria-*`/`role` are the only attributes set from data; CSS is driven only by enum-gated attribute values. Hostile payloads (`<img onerror>`, `javascript:` URLs, `</script><script>`, encoded markup, 100 KB strings, U+202E, NUL, `__proto__`) through the real poller → route → page in jsdom produced no element, attribute, handler or prototype pollution. The innerHTML spy test fails under mutation.
- **Guard coverage (TM-011).** All three console routes sit behind the app-level `onRequest` operator guard: no cookie → 302 `/login` (HTML) or 401 (API); keycard bearer → 403; HEAD → 401; the `/harness` prefix honoured. Nothing added to `PUBLIC_PATHS` except two font assets, which are served from fixed in-memory bytes with a startup SHA-256 integrity check.
- **Store contents (R1).** `console_session` and `console_card` hold no reply text, reasoning or tool output (PRAGMA-driven test with a column-name regex and a free-text allow-list); `tldr_masked ≤ 1024` and `title ≤ 120` are CHECK constraints; the expand view is read live and never persisted (source-regex test).
- **Fail visible (spec §9).** Unreachable, probe failed, can't read (unknown record format, missing end marker, session-file format change), unknown status, ended, expand changed/unreachable/failed, invalid or unreadable settings file — each a labelled state end to end, every one with glyph + word (CC1).

## Threats considered

| Threat | Concrete attack tried | Result |
|---|---|---|
| TM-020 / read-only invariant | Grep and execution of both generated scripts; crafted plan values; forged `PANTHEON_PROBE:` lines printed inside a pane; a session file named `a<LF>PANTHEON_PROBE:end<LF>b.json` | No non-read-only verb reachable; forged lines land base64-encoded inside tails; the basename guard drops the forging file |
| TM-026 probe amplification | 2 MiB adversarial records every 5 s; 300k-line `1. x` pane tails; 100k-space and 1 MiB `**TL;DR` replies; PEM-header floods; 13-digit slice offsets | Dials bounded at 4 per machine per tick (1 main + ≤ 3 catch-ups); menu pairing linear (300k lines ≤ 50 ms); TL;DR marker linear after fix (1 MiB ≤ 76 ms); poisoned offset dropped and counted; PEM flood ≈ 0.75 s per MiB per pass remains (residual) |
| Secret leakage (spec §8.4, R1) | Planted `pk1_`, `ghp_`, `sk-ant-`, AKIA, JWT, PEM, `Bearer`, `cf`, `GITEA_TOKEN=`, quoted `.env` values, compound names (`access_token`) at every clip boundary in faces, titles, keys, status, reasons, health, expand text, tool names and JSON keys | 0 leaks after the fix wave; 16 patterns each proven to bite by a mutation guard; residual shapes listed below |
| XSS via dev-machine text | Hostile strings in every field through poller → store → route → jsdom page; attribute audit; `innerHTML`/`insertAdjacentHTML` setter spies | No markup, attribute, URL or CSS from data |
| TM-011 guard bypass | No cookie, keycard bearer, HEAD, `/console/`, `/console/api/nope`, prefix, long ids (10 KB) | 302/401/403 as designed; ids > 100 chars hit Fastify's default 404 (pre-existing app-wide; residual) |
| SQL injection | `' OR 1=1 --` in ids, filters and limits | Every value bound; LIMIT bound; malformed limits throw |
| Silent data loss | Malformed `now` to purge; lost final turn on session exit; prompt/reply pairs straddling polls; truncated/rotated transcripts; same-tick exit race | Purge throws on malformed input; final turn carded on dead pid or two consecutive absences; every-byte slice sweeps (≈ 220k boundaries) show each turn once |
| Availability of the control-plane | Quadratic regexes (masking ×4, TL;DR marker, menu pairing); unreadable settings file; hostile pane tails | All bounded after fixes; an unreadable settings file disables the console only |
| TM-025 send path / TM-027 Telegram | n/a in F1 (no send path, no reminders) | — |

## Findings

Fixed before the F1 commit (each with a test that fails without the fix):

1. **Quadratic TL;DR marker regex** (`src/console/transcript.ts`): `**TL;DR` + 60k spaces stalled a poller tick 2.9 s; 1 MiB ≈ 15 min of event-loop stall for the whole control-plane. Fixed: single-pass pattern, identical matches on 13 real forms and 200k fuzz strings; 1 MiB ≤ 76 ms through `buildCardFaces`.
2. **Masking pattern order** (`src/console/masking.ts`): the 40-char `cloudflare` pattern ran before `bearer`/`jwt` and cut a Bearer JWT short (payload and signature survived). Fixed with a scoped boundary (Bearer-prefixed tokens left to bearer/jwt; cf-prefixed 40-char tokens still masked when followed by `. - /`). Four earlier masking fixes in Task 2: bounded `[\s:=]{1,8}` / `\s{0,8}` runs (quadratic on whitespace), `env_secret` runs `{0,32}` and quoted values, `jwt` lookbehind, compound keyword names, bounded PEM body.
3. **Session-file format change read as "ended"** (`src/console/probe.ts`, `poller.ts`): a renamed or retyped field made every session ENDED with health ok and carded an open turn as finished. Fixed: unparsed records counted → machine `cant_read`, no ends or closes on an unreliable tick; an absent session ends only after two consecutive reliable absences (a dead pid still ends at once).
4. **Needs-you card outside the newest 200** never reached the page. Fixed: the state route merges the flagged set with the newest 200.
5. **Unmasked or clipped-before-mask fields**: `status`, `procStart`, `waitingFor`, `cwd`, `remoteDetail`. Fixed: mask → clip at the poller; `procStart`/`waitingFor` dropped from the API projection; probe clips raised to 2048.
6. **Unreadable settings file stopped the whole control-plane** (contrary to ADR-0010). Fixed: non-ENOENT read errors disable the console module only.
7. **Poisoned slice offset wedged a machine's probes** (parser accepted 13 digits, builder refused). Fixed: `\d{1,12}` and `MAX_OFFSET` at parse time.
8. **Page re-rendered every poll** (churn fields defeated the dedup; selected text lost every 5 s). Fixed: dedup on a projection without churn fields; ages refreshed in place.
9. Earlier-task fixes of the same classes: mask-before-cut in card faces (Task 6, three rounds, offset sweeps 0 leaks); purge-on-malformed-timestamp wipe (Task 7); final-turn loss on session exit and the oversize-turn retry (Task 8); span and count checks before an expand is `ok` (Task 9); cursor-independent menu anchors that match the real Claude Code 2.1.29x–2.1.302 screens (Tasks 4/6); stable live regions and `preventScroll` focus restore (Task 11).

## Residual (accepted for the F1 read-only exit; carry into the spec §11 real-use period and F2)

Masking shapes not covered (spec-defined shapes or contrived):
- `cloudflare` exact length 40 misses 41+-char tokens after `cf`/`cloudflare:`; lowercase `bearer`, `Token:`, uppercase `NAME:` forms; environment names longer than 32 chars around the keyword; exact-length tokens ending in `-`; a Bearer JWT with a 40-char header after two or more spaces, `Bearer:` or `Bearer=`; a token that an earlier pattern (anthropic/aws) matches inside a 40-char Bearer run followed by `. ~ + / = -` (contrived; real credentials do not have the shape); lookbehind context lost across a stream chunk boundary and a PEM block whose END footer arrives in a later pane capture (stream path only; card faces mask complete turns).
- A `cwd` longer than 2 KiB (Linux only) can leave an unmasked token start in `projectKey` (not clipped after masking).

Detection limits:
- Code-fence state is tracked only within the captured 40-line tail; a fence opened above it inverts quoted/real.
- `1 to review · 2 to send · 0 to dismiss` and the plain permission footer are plan-asserted, never observed; background-agent prompts are visible only on the pane.
- Sessions whose tmux session name fails `TMUX_SESSION_NAME_RE` are not tailed (menu signal lost) and show as not reachable.
- A session that is `waiting` and also has a commit sentinel is labelled WAITING, not COMMIT APPROVAL.

Availability and budget:
- Per machine per tick: at most 4 SSH dials, 2 MiB output each; the transport reads to the 4 s timeout after the cap; PEM-header floods cost ≈ 0.75 s per MiB per mask pass; a flood of tiny turns grows the shared harness DB ≈ 10 MiB per tick per machine (no per-session face cap in F1); busy sessions with long open turns are re-read every tick and retries can starve (F2: skip the retry while busy or keep the carry).
- A stray unparseable `*.json` in a machine's sessions folder holds CAN'T READ and defers all session ends on that machine until removed; a file read mid-rewrite shows CAN'T READ for one poll.
- Transcripts of 10^12 bytes or more stop being read.
- Needs-you cards beyond the newest 200 flagged still drop off (a payload may hold up to 400 cards).
- HEAD on the expand route dials SSH; expand has no rate cap.
- Ids longer than 100 chars receive Fastify's default 404 that echoes the path (app-wide, pre-existing; fix is a `setNotFoundHandler`).
- `main()` has no graceful shutdown (`app.close()` only in tests); a stray `console-settings.json` in the working directory would configure `:memory:`-DB test servers.

Session tracking and page:
- pid reuse after a crash keeps a stale session live (procStart not compared until F2); health problems never expire; purge failures are only logged; the final card can arrive one tick late in the same-tick exit race; base64 continuation lines can misjoin if a pure-base64 foreign line lands between records; a stale `since`/`lastOkAt` can show after a health flip the page never saw; busy sessions still re-render each poll; one I3 safeguard trio is covered only by the reviewer's scratch scripts, not the suite.
- Fixture provenance: the scratch script that built the fixtures reads live `~/.claude/sessions`; never re-run it (restore `sessions-2.1.301.json` if regenerated). The fixtures are scrubbed excerpts of the operator's own pantheon-harness sessions and enter a public repository; the operator was asked to veto before the commit.
- Build-versioned assets (fonts, xterm) carry no `Cache-Control`; immutable caching is a follow-up.

## Verification

Controller-run on the final tree (2026-10-17), from `services/control-plane`:

```
npx tsc -p tsconfig.json --noEmit     # exit 0
npx eslint .                           # exit 0
npm test                               # Test Files 70 passed | 1 skipped (71); Tests 961 passed | 5 skipped (966)
gitleaks dir test/fixtures/console --redact --no-banner   # no leaks found (Task 4)
```

Reviewer evidence (scratch harnesses, fake SSH only): per-task reports `.superpowers/sdd/2026-10-16-maestro-console-f1/task-N-report.md`, the final review and fix-wave reports (`task-12-fixwave-report.md`), and the ledger `progress.md` with every ruling and its cost if wrong.
