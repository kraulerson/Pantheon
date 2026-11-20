# Security Audit: BUGS #88 (red dependency audit in both services)

Finding: CI's `npm audit --audit-level=high` step failed in `services/control-plane` (20 advisories: 13 moderate, 5 high,
2 critical) and `services/obsidian-mcp` (19: 13 moderate, 4 high, 2 critical), so each run stopped before the license,
lockfile-integrity and governance steps. The critical and high ones were in development tooling (tinypool under vitest,
vite, undici, brace-expansion, js-yaml, source-map-js). Production carried 2 moderate in each service: `hono` and
`@hono/node-server` (GHSA-rmxm-3fg6-px4f, GHSA-jpvv-r467-5p4w), both under `@modelcontextprotocol/sdk` 1.32.1. Karl's
rulings: fix it next, before the next feature (A1, 2026-11-18); full scope, aiming for zero advisories (A2, 2026-11-19).

Base commit af516ac. One adversarial review (fresh agent, top-tier model, 2026-11-19), which worked in its own copy.

## Headline

**Verdict: SHIP, with the residuals below.** `npm audit` reports 0 in both services. No production advisory was
reachable before the fix. The fix moves `@hono/node-server` to a new major version in obsidian-mcp's production tree; 118
raw-socket probes found two harmless behaviour changes. **This change alone is not expected to turn CI green:** the review's
emulation shows the newly reached "Governance - Phase gate check" step failing for a reason unrelated to dependencies
(residual 1). That is not confirmed on a real runner.

## Fix

| Service | Package | Before | After |
|---|---|---|---|
| both | vitest, `@vitest/coverage-v8` (direct, exact pins) | 3.2.7 | 4.1.12 |
| both | typescript-eslint, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser` (direct, exact pins) | 8.46.0 | 8.73.0 |
| both | `@hono/node-server` (production, under the SDK; its range is `^1.19.9 \|\| ^2.0.5`) | 1.19.17 | 2.1.9 |
| both | hono (production, under the SDK) | 4.13.13 | 4.13.19 |
| both | brace-expansion, js-yaml, source-map-js, vite (8.3.8 under vitest 4); undici in control-plane | in range | fixed |
| both | tinypool, test-exclude, glob 10 | present | no longer installed |

The vitest 3 line has no fixed release (3.2.7 is its newest). vitest 5.1.1 was not used: it requires Node
`^22.12.0 || ^24.0.0 || >=26.0.0` and the development Mac runs 25.9.0. The only non-development lockfile entries that
changed are the hono pair, in both services. No source, test or configuration file needed a change for the upgrades.

## Applicability

- **control-plane: not reached.** A resolve trace over all 94 built modules loads no hono file, before or after. It uses
  only the SDK's client transport (`src/bridge/client.ts`).
- **obsidian-mcp, GHSA-jpvv-r467-5p4w (backslash as a path separator): not reached.** `/mcp\`, `/mcp\..\x`, `/x\..\mcp`
  and the absolute-form backslash path all get express's 404 in both versions and never reach the adapter; the SDK
  transport does not route on the path.
- **obsidian-mcp, GHSA-rmxm-3fg6-px4f (`serveStatic`): not reached.** serve-static is loaded in neither version.
- **obsidian-mcp, hono's own five advisories (`mount()`, RegExpRouter, the `css` helper, `csrf()`, `validator('form')`):
  not reached.** Before the fix the built server loaded no hono file at all (one `@hono/node-server` file only).
- obsidian-mcp does load the adapter: `StreamableHTTPServerTransport` (`src/server.ts:128`) imports `getRequestListener`
  from `@hono/node-server`. After the fix one `hono` file is also loaded at runtime (`hono/dist/helper/websocket/index.js`,
  pulled in by the 2.x adapter). The statement "Not loaded: hono" in `bugs-57-obsidian-mcp-deps-security-audit.md` was
  true for its date and no longer holds.

## Behaviour changes (obsidian-mcp, from `@hono/node-server` 2.1.9)

Of 118 raw-socket probes against both built servers, 101 answered identically and 14 differed for real, in two classes:

- A 202 for a notification, a 200 for DELETE and a 400 for a bad Host no longer carry `content-type: text/plain; charset=UTF-8`.
- `Host: LOCALHOST:<port>`, `LocalHost:<port>`, `127.1:<port>` and `0x7f.0.0.1:<port>` answered 400 and now answer 200. The
  old 400 came from the 1.x adapter rejecting a Host that did not round-trip through URL parsing (its
  "Invalid host header" check, `dist/index.mjs` lines 196-198 in 1.19.17); obsidian-mcp configures no
  host allow-list of its own (`src/server.ts` has none), so no access rule was relaxed.

Identical before and after: SSE framing, a 3 MB read, 30 parallel 3 MB reads, a 90 KB body, 413 over 100 kb, an aborted
POST, a client that never reads, a half-sent body, the GET stream reopened after an abort, a second GET (409), DELETE,
batches, chunked bodies, keep-alive, HTTP/1.0, and the SDK's own client round-trip.

## Tests

`test/dependency-floors.test.ts` (the same file in both services) reads `package-lock.json` and fails while any locked
copy of a package named in the audit sits inside its vulnerable range. It is offline and does not replace CI's audit step.
On the base lockfiles it fails (control-plane 19 cases, obsidian-mcp 18; for example
`expected [ 'node_modules/vitest@3.2.7' ] to deeply equal []`); on the new ones it passes. The review found four lockfile
shapes it let through; all four are closed and pinned by cases that failed first: a listed package installed under an
alias is matched by the entry's own name, a pre-release or build-tagged version of a listed package fails outright (npm's
audit counts a pre-release of the first fixed version as vulnerable), and `test-exclude` has a row from 7.0.0.

**vitest 3 → 4 weakened no test.** `vi.restoreAllMocks` no longer resets `vi.fn` state in vitest 4 (the review confirmed
the difference with a control test). No test depends on it: across 2180 mocks none is created at module scope and no
call-matcher reads a mock from an earlier test; 234 source mutants gave identical failing-test sets under 3.2.7 and 4.1.12
(201 killed, 33 survived, in both); the four files that call `restoreAllMocks` fail identically under mutation.

## Supply chain

All 453 unique name@version entries match the registry's `dist.integrity`. No git, http or file sources. No preinstall,
install or postinstall script among the 90 changed or added entries (esbuild's is gone). `npm audit signatures` verifies
401 (control-plane) and 303 (obsidian-mcp). `npx license-checker` with CI's deny list exits 0. lightningcss 1.33.0 and its
platform binary (MPL-2.0, development only, through vite 8) are new; reviewed here as acceptable: build-time tooling,
unmodified, never shipped to the VM's runtime.

## Verification

- Review, clean copies: `npm ci`, build, lint and `npm test` exit 0 in both services on Node 20.20.2, 22.23.5, 24.22.3,
  25.9.0 and 26.13.1 (today's `lts/*`); `npm audit --audit-level=high` exits 0 with "found 0 vulnerabilities" on npm
  10.8.2, 10.9.9, 11.12.1, 11.19.1 and 11.20.0. The base lockfiles fail `npm ci` on npm 10; the new ones install.
- Controller, working tree, after the test fixes: control-plane `Test Files 79 passed | 1 skipped (80)`,
  `Tests 1546 passed | 5 skipped | 1 todo (1552)`; obsidian-mcp `Test Files 3 passed (3)`, `Tests 52 passed (52)`; build,
  lint and audit exit 0 in both. On this Mac `services/control-plane/.env.local` enables the two read-only live bridge
  tests; a clean copy skips them (7 skipped instead of 5).
- Coverage thresholds (90%) hold under `@vitest/coverage-v8` 4.1.12: control-plane lines 98.23%, branches 92.2%;
  obsidian-mcp lines 98.11%, branches 96.96%. The 3.x → 4.x difference is closing braces after `return` or `throw` that
  3.x counted; no uncovered code is hidden. CI does not run coverage.
- Lint: `eslint --print-config` gives the same 88 rules (66 enabled) under 8.46.0 and 8.73.0; a file of deliberate
  violations gives the same 36 messages.

## Residual

1. **CI is expected to stay red at "Governance - Phase gate check"** once the audit step passes. `scripts/check-phase-gate.sh`
   lists Semgrep, gitleaks, Snyk CLI, Claude Code and Lighthouse as needed for Phase 2 and exits 1 when they are not on
   PATH; no retained run has ever reached this step (102 of 102 failed earlier). Shown by emulation only. To be confirmed
   by the first run after this change is pushed, then logged as its own BUGS row for Karl's ruling. The script has a warn
   mode; no downgrade is proposed here.
2. obsidian-mcp's two response differences above are not exercised against Peta. One live round-trip through Peta after
   the next obsidian-mcp deploy, before #88 is marked verified. Whether obsidian-mcp is deployed anywhere today was not
   checked.
3. `@types/node` 20.17.6 does not satisfy vite's optional peer range (`^20.19.0 || >=22.12.0`); unchanged by this fix
   (`npm ls` exits 1 before and after; install, build, lint and test are unaffected).
4. Development tooling now needs Node `^20.19.0 || ^22.13.0 || >=24` (eslint-visitor-keys 5.0.1; rolldown and vite as
   before). The services' own `engines: >=20` overstates what a developer machine can use.
5. `PROJECT_BIBLE.md` line 328 (the dated 2026-07-09 list of as-built pins) still names vitest 3.2.7; other pins on that
   line were already out of date. Not changed here.
6. Not verified: a Linux x64 install (registry integrity of the Linux packages was checked instead); Node 24.19 exactly
   (24.22.3 ran; the engines ranges cover 24.19.0).
