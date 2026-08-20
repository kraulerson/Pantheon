# Automated Suite — UAT Session 2

**Agent:** automated-suite test agent
**Date:** 2026-08-20
**Repo:** `/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness`
**HEAD:** `27f5f4b36da36951dc4a42ff532b0b6aa0a1d687` (2026-08-19 12:37:40 -0600) — `build: skeleton step 2 — Peta owner + identity bootstrapped, hardening verified`
**Branch:** `main`
**Mode:** read-only. No source file edited, no commit, no push, no `npm audit fix`, no formatter, no VM connection.

---

## 1. Commands run, verbatim

| # | Working dir | Command | Exit |
|---|---|---|---|
| 1 | `services/control-plane` | `npx tsc --noEmit` | 0 |
| 2 | `services/control-plane` | `npx eslint src test` | 0 |
| 3 | `services/control-plane` | `npx vitest run` | 0 |
| 4 | `services/control-plane` | `npm audit --omit=dev` | 0 |
| 5 | `services/control-plane` | `npm audit` | 0 |
| 6 | `services/obsidian-mcp` | `npx tsc --noEmit` | 0 |
| 7 | `services/obsidian-mcp` | `npx eslint src test` | 0 |
| 8 | `services/obsidian-mcp` | `npx vitest run` | 0 |
| 9 | `services/obsidian-mcp` | `npm audit --omit=dev` | 0 |
| 10 | `services/obsidian-mcp` | `npm audit` | 0 |
| 11 | `prototypes/cli-channel-loop` | `npm test` | 0 |
| 12 | repo root | `git status --porcelain` | 0 |

Supporting read-only diagnostics (not part of the mandated suite): `nslookup gitea.ferrumcorde.com`, `host gitea.ferrumcorde.com`, key-presence scan of `services/control-plane/.env.local` (names and lengths only — no values read or recorded).

---

## 2. Raw totals

### services/control-plane

```
npx tsc --noEmit      → exit 0, no diagnostics emitted
npx eslint src test   → exit 0, no errors, no warnings

npx vitest run        → exit 0
 Test Files  44 passed | 1 skipped (45)
      Tests  332 passed | 4 skipped (336)
   Duration  3.61s
```

Run twice; byte-identical totals both times (332 passed / 4 skipped, exit 0). No flake observed.

### services/obsidian-mcp

```
npx tsc --noEmit      → exit 0, no diagnostics emitted
npx eslint src test   → exit 0, no errors, no warnings

npx vitest run        → exit 0
 Test Files  1 passed (1)
      Tests  24 passed (24)
   Duration  295ms
```

**Correction to the brief:** obsidian-mcp *has* been built and *is* runnable. `dist/` is present, `node_modules` is installed, `tsc --noEmit` is clean, and its 24 tests pass. The premise that it "has never been built" does not hold as of this HEAD. All four commands ran normally; nothing was skipped for setup reasons.

### prototypes/cli-channel-loop

```
npm test  (pretest → tsc build, then vitest run)  → exit 0
 Test Files  3 passed (3)
      Tests  21 passed (21)
   Duration  2.87s
```

**The 21 tests still pass.** Breakdown: `llm-mini-judge.test.ts` (3), `loop-detector.test.ts` (13), `echo-channel.e2e.test.ts` (5). The spike still compiles against TypeScript 5.7.2 and its e2e echo-channel round-trip works.

### Combined

**377 tests green** (332 + 24 + 21), **0 failures**, **0 type errors**, **0 lint findings**, **4 counted skips**, **1 uncounted soft-skip** (see §3).

---

## 3. Failures and skips

**Zero failures across all three packages.** Every entry below is a skip.

| # | Test | Counted by vitest? | Reason emitted | Verdict |
|---|---|---|---|---|
| 1 | `test/gitea-live.integration.test.ts` | Yes (1) | `[gitea-live] SKIP: no GITEA_TOKEN or https://gitea.ferrumcorde.com/api/v1/version unreachable` | **(b) environmental — masking a live (a) defect.** See §4. |
| 2 | `test/peta-live.integration.test.ts` | Yes (1) | `[peta-live] SKIP: Peta not reachable at http://localhost:3002 or no ownerToken` | **(b) environmental.** Peta is not running on this workstation. Guard is correct. |
| 3 | `test/preprocessor-live.integration.test.ts` → "Peta approvals proxy" | Yes (1) | guard `reachable("http://127.0.0.1:3002/")` false | **(b) environmental.** Same missing local Peta. Note the *sibling* test in this file **passed live** — it reached Alden-1 at `192.168.1.89:8080` in 1264ms, so that host is genuinely up and exercised. |
| 4 | `test/devmachine-ssh.live.integration.test.ts` | Yes (1, whole file `↓`) | gated on `PANTHEON_LIVE_SSH_HOST`, which is unset | **(c) deliberate guard.** Opt-in live SSH test; env var intentionally absent in `.env.local`. Correct behaviour. |
| 5 | `test/mcp-registration.test.ts` → "performs a real round-trip if Peta is up, else skips" | **No — counted as PASSED** | `[skip] Peta not reachable at http://localhost:3002/health — skipping live MCP registration test` | **(a) real defect — false green.** See §5. |

### Skip accounting

Vitest reports **4 skipped**. The true number of tests that did not exercise their subject is **5**. Item 5 printed a skip message to stderr yet was tallied inside the 332 "passed". The headline number overstates real coverage by one.

---

## 4. BUGS #14 — `test/gitea-live.integration.test.ts` (confirmed Open, guard still wrong)

**Logged claim** (BUGS.md line 30, ID 14, SEV-4, Open): the test *fails* rather than skips since the 2026-08-17 token rotation — the new minimal-scope token is `write:repository,read:user` but the test needs `write:user`, yielding `Gitea API 403`. Fix should be to make the guard scope-aware, not to widen the token.

**Observed behaviour today: it SKIPS, it does not fail.** That is *not* evidence the bug is fixed. Evidence:

1. **The token is present.** `services/control-plane/.env.local` sets `GITEA_TOKEN` (40 chars) and `GITEA_BASE_URL` (29 chars). Both are non-empty, so the `if (!BASE || !TOKEN) return false` arm of the guard was **not** what fired.
2. **The host is unroutable from this workstation.** `gitea.ferrumcorde.com` resolves to `10.100.23.52` — a private LAN address. The file's runtime was **2505ms**, matching the guard's 2500ms `AbortController` timeout almost exactly. The `fetch` aborted; `versionReachable()` returned false via its `catch`.
3. **Therefore the skip is a network accident, not a guard improvement.** The suite is green here only because this machine is off the LAN that hosts Gitea.

**The guard defect is unchanged.** `versionReachable()` gates solely on `!BASE || !TOKEN` plus `r.ok` from `GET {BASE}/api/v1/version`. That endpoint is scope-insensitive — any valid token satisfies it. The guard never inspects token scope. Meanwhile the test body calls:

- `client.createRepo({ name })` → `POST /user/repos`
- `client.listRepos()` → `GET /user/repos`

Both are `/user/*` routes, i.e. exactly the routes the minimal-scope token lacks `write:user` for. So on **any** machine with LAN routing to `10.100.23.52` carrying the current correctly-scoped-down token, the guard passes, the test runs, and it goes red at `createRepo` with a 403 — precisely as BUGS #14 describes.

**Conclusion: BUGS #14 must stay Open.** A green run here is topology-dependent and non-portable; the same commit will produce a red suite on-LAN (including on the deployment VM or any CI runner with LAN reach). The fix recorded in BUGS.md — make the guard assert scope rather than mere reachability — is still the right one, and the token must **not** be widened to make the test go green, as that would reverse the minimal-scope decision from the 2026-08-17 remediation.

---

## 5. `test/mcp-registration.test.ts` — false green (a), new finding

Not previously logged. The live case reads:

```ts
it("performs a real round-trip if Peta is up, else skips", async () => {
  if (!(await petaReachable())) {
    console.warn(`[skip] Peta not reachable at ${PETA_HEALTH} — skipping live MCP registration test`);
    return;
  }
  // Live path intentionally minimal; presence of ADMIN token required.
  expect(true).toBe(true);
});
```

Two distinct defects:

1. **Bare `return` instead of `ctx.skip()`.** Every sibling live test in this repo (`gitea-live`, `peta-live`, `preprocessor-live`) correctly calls `ctx.skip()`. This one returns, so vitest tallies it as **passed**. It is invisible in the skip count and reads as coverage that does not exist.
2. **The test has no body.** Even on the happy path where Peta *is* reachable, the assertion is `expect(true).toBe(true)` — a tautology. It never registers, never lists, never removes. The name promises a `register → list → remove` round-trip that is not implemented at any code path.

This is a genuine code defect (a), independent of environment. Recommend logging it as a new BUGS entry. It is lower severity than #14 in blast radius but higher in deceptiveness: #14 will at least announce itself loudly on-LAN, whereas this one is permanently and silently green.

---

## 6. `npm audit` results

| Package | `npm audit --omit=dev` | `npm audit` (incl. dev) |
|---|---|---|
| `services/control-plane` | **found 0 vulnerabilities** | **found 0 vulnerabilities** |
| `services/obsidian-mcp` | **found 0 vulnerabilities** | **found 0 vulnerabilities** |

Zero at every severity — critical 0, high 0, moderate 0, low 0, info 0 — in both production-only and full dependency graphs, for both services. This holds the clean state achieved in the 2026-08-17/18 remediation (vitest 3.2.7 upgrade, BUGS #8). No `npm audit fix` was run and no lockfile was modified.

`prototypes/cli-channel-loop` was not audited — the brief scoped it to `npm test` only.

---

## 7. `git status --porcelain`

```
 M .claude/process-state.json
?? .claude/bypass-audit.json
?? .claude/pending-approval.json
?? tests/uat/sessions/2026-08-20-session-2/
```

Notes:

- **`docs/research/` is clean.** Both `dsh-pattern-map.md` and `dsh-decision-proposals.md` are committed and unmodified. Contrary to the brief, there is no in-progress research doc there. Directory was not touched.
- **`tests/uat/sessions/2026-08-20-session-2/`** is the untracked UAT session directory — the other agents' in-progress work. At scan time it held only `templates/test-session-2-v1.html`; `agent-results/` and `submissions/` were empty. Left untouched apart from writing this one file into `agent-results/`.
- **The three `.claude/` entries are harness state, not source.** `bypass-audit.json` and `pending-approval.json` record the test-gate escalation timestamped `2026-08-20T13:53:16Z` that triggered this very UAT session ("Test gate blocks the tmux-launcher feature: a UAT session is required (2 features since last test)"). They are expected artefacts of the gate, not stray edits.
- No source file is modified. The working tree is clean with respect to `src/`, `test/`, and all tracked docs.

---

## 8. Coverage gap worth recording (not a failure)

`services/obsidian-mcp` has **24/24 green from a single test file, `test/vault.test.ts`**. Its `src/` contains two files:

- `src/vault.ts` — covered
- `src/server.ts` — **zero tests**

`server.ts` is the StreamableHTTP transport: the network-facing surface where vault confinement is actually enforced against a remote caller. The 24 green tests certify the pure vault core only. This is not a suite failure and nothing is red, but the obsidian-mcp green light should not be read as evidence that the wire-level confinement boundary works.

---

## 9. Bottom line

### Gate verdict: **PASS** — with three reservations that must be carried forward.

The gate criteria are met without qualification on the hard signals: **0 failures, 0 type errors, 0 lint findings, 0 vulnerabilities at any severity**, across two services and the channel spike, 377 tests green, reproducible across repeat runs. Nothing is red and nothing blocks.

The reservations, stated plainly because a green suite here certifies less than the number suggests:

1. **BUGS #14 is masked, not fixed.** Today's skip is caused by this workstation lacking a route to `10.100.23.52`. The guard still gates on reachability rather than token scope, and `createRepo`/`listRepos` still hit the `/user/*` routes the minimal-scope token cannot reach. The identical commit will produce a **failing** suite on any LAN-connected runner. Keep #14 Open; fix the guard, do not widen the token.
2. **`mcp-registration.test.ts` is a false green** — it returns instead of skipping, and its live path asserts only `expect(true).toBe(true)`. One of the 332 "passes" is empty. New defect; recommend a BUGS entry.
3. **Every live-integration path is dark.** Five tests (four counted, one hidden) did not exercise their subject: Gitea round-trip, Peta admin, Peta approvals proxy, live SSH, MCP registration. Of the live surfaces, only Alden-1 at `192.168.1.89:8080` was genuinely reached and verified this run. The automated suite therefore validates the **pure-logic layer** well and the **integration layer** barely at all — it is not evidence that the deployed system works, and the manual UAT lanes should not treat it as such.

**Read the pass as: the code compiles clean, lints clean, has no known-vulnerable dependencies, and its unit/logic layer is solid. It is not a statement about live infrastructure.**
