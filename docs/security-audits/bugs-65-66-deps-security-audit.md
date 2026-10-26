# Security Audit: BUGS #65 and #66 (body-parser GHSA-27r3-jxmh-p828, zod GHSA-mrhx-c7xc-m3w5)

Finding: two advisories published after the #55/#57 fixes flagged the production dependencies of both services: body-parser
GHSA-27r3-jxmh-p828 (high, published 2026-10-23: a crash via trailing bytes after a compressed request body; fixed in
1.20.9 and 2.4.0) and zod GHSA-mrhx-c7xc-m3w5 (high: memory exhaustion validating oversized constrained collections; fixed
in 4.6.6). Karl's rulings (2026-10-25/26, A1): fix both in one change before UAT-6; in-range updates in both services; in
obsidian-mcp also the major zod 3 → 4 upgrade, exact-pinned; log anything the upgrade does not close as its own row.

Base commit 186c8b1. Ledger: `.superpowers/sdd/2026-10-26-bugs-65-66-deps/progress.md` (git-ignored).

## Headline

**Verdict: SHIP, with #68 open.** The body-parser advisory was real in obsidian-mcp and is closed and test-pinned. The zod
upgrade is safe but does not close the zod-class memory amplification on obsidian-mcp's unbounded `clientInfo.icons`; that
stays open as BUGS #68 (SEV-3, fix before obsidian-mcp is ever deployed; it runs nowhere today). control-plane reaches
neither advisory. `npm audit --omit=dev` reports 0 in both services.

## Fix

| Service | Package | Before | After |
|---|---|---|---|
| control-plane | body-parser (under the SDK's express 5) | 2.3.0 | 2.4.0 |
| control-plane | zod (under the SDK) | 4.4.3 | 4.6.7 |
| obsidian-mcp | body-parser (express 4.22.3) | 1.20.8 | 1.20.9 |
| obsidian-mcp | body-parser (the SDK's express 5) | 2.3.0 | 2.4.0 |
| obsidian-mcp | zod (direct, exact pin; deduped for the SDK and zod-to-json-schema) | 3.25.76 | 4.6.7 |
| both | iconv-lite (under body-parser 2.4.0) | 0.7.2 | 0.7.3 |

control-plane's `package.json` is unchanged (lockfile only). In obsidian-mcp only the `zod` line of `package.json` changed;
`src/server.ts` needed no change (its five tool schemas use only `z.string()`, `z.boolean().optional()` and
`z.enum([...]).optional()`). SDK 1.32.1 accepts `zod` `^3.25 || ^4.0`.

## Applicability

- **control-plane (#65): not reached.** A resolve trace of a real `dist/server.js` startup loads 564 modules and none under
  body-parser, zod, express, the SDK, iconv-lite or raw-body; a positive control (importing the SDK client alone) does pull
  zod and SDK modules, so the tracer sees them. The bridge client (`src/bridge/client.ts`, the only zod/SDK edge) still
  type-checks and behaves byte-identically against a fake bridge on both zod versions.
- **obsidian-mcp body-parser (#66): reached and observable.** `app.use(express.json())` (`src/server.ts:120`) inflates gzip
  bodies before routing, unauthenticated. On 1.20.8 one gzip frame, a 0x00 and 100 KB of trailing bytes made the server exit
  1 (`incorrect header check`); the tail must arrive in a later socket read (about 65 KB is the threshold).
- **obsidian-mcp zod (#66 → #68): reached, not closed by the upgrade.** zod's fix (commit a0ebf97) only short-circuits a
  collection whose leading check is an upper bound (`.max`, `.length`, `.size`); the SDK's `clientInfo.icons` is unbounded.
  A 99 KB invalid-icons body yields 33,000 issues and a 5.2 MB error on both zod versions; 20 concurrent requests peak at
  about 400 MB (was about 470 MB). The check runs for any method, and the session path re-runs it per message.

## Tests

`services/obsidian-mcp/test/dependency-advisories.test.ts` gains one case: a session-less gzip body plus 0x00 plus 100 KB of
trailing bytes must answer 400, the server must still be alive one second later, and a following batch must answer 200.
On the base lockfile it fails (`expected 'exited code=1 signal=null' to be 'alive'`), on the new lockfile it passes; the
review ran it 30 + 30 times straight plus shuffled on Node 22.23.4, 24.22.1 and 25, with no flips. A body-parser-only
update also passes, so the fix is attributable to body-parser. No zod test: the upgrade does not change the measured
behaviour, so no assertion distinguishes the versions.

## Behaviour changes

- Tool input-validation errors read differently under zod 4 (for example "Invalid input: expected string, received
  number"). Nothing in `services/`, `scripts/`, the tests or `deploy/` depends on the old text.
- `tools/list` JSON Schema no longer carries `additionalProperties: false` (the SDK emits schemas with a different
  converter on zod 4). `type`, `properties`, `required` and `enum` are unchanged; the server validates against the zod
  schema, not the emitted JSON Schema, and Peta gates by tool name.

## Supply chain

Every changed lockfile entry resolves from registry.npmjs.org with an integrity hash matching `npm view`; no dev or optional
flag changed; signatures verify (obsidian-mcp 363, control-plane 460). Provenance: body-parser 1.20.9 and 2.4.0 and zod
4.6.7 (main b500a2e) carry SLSA attestations; iconv-lite 0.7.3 has a registry signature but no provenance, as its earlier
versions. zod disclosed malicious commits pushed to its `main` (not published); the review rebuilt zod 4.6.7 from the tagged
source with its pinned toolchain and found all 124 emitted `.js` files byte-identical to the npm tarball. body-parser and
iconv-lite installed JS match their tagged sources.

## Verification

- obsidian-mcp: `npm ci`, lint, `eslint src test`, tsc and build exit 0; `npm test` `Test Files 2 passed (2)`,
  `Tests 27 passed (27)`; `npm audit --omit=dev --audit-level=high` "found 0 vulnerabilities". Live drive: initialize 200,
  `tools/list` 4 tools, every tool works once, wrong input rejected with -32602, path traversal rejected.
- control-plane: `npm ci`, lint, tsc and build exit 0; `npm test` `Test Files 75 passed | 1 skipped (76)`,
  `Tests 1380 passed | 5 skipped | 1 todo (1386)`; audit 0.
- Controller reproduced both audits (exit 0) and obsidian-mcp's 27 passing tests.
- gitleaks on the staged change: no leaks found.

## Residual

- **#68** (SEV-3): the zod-class amplification through any session-less or session POST. Fix with a method-agnostic cap on
  JSON elements in the whole body, before parsing (prototyped by the review); a smaller byte limit does not work.
- control-plane carries 9 dev-only advisories (outside `--omit=dev`; the deferred dev-tool upgrade).
- A SIGINT in the middle of the obsidian-mcp test run can orphan the spawned server (generic to spawning in `beforeAll`).
