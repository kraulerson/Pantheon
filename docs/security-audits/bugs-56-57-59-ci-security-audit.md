# Security Audit: CI repair — BUGS #56 (Semgrep fail-open), #57 (obsidian-mcp in CI), #59 (gitleaks fixture)

Finding: CI's Semgrep step used the archived `semgrep/semgrep-action`, whose image runs semgrep 1.36.0; it could not parse
today's rule packs and exited 0, so a green Semgrep step meant nothing was scanned (#56, confirmed in run 39611900810:
`ValueError: invalid rule severity value: MEDIUM`). `services/obsidian-mcp` was never built, tested or audited by CI (#57).
CI's gitleaks (8.24.3) failed on a synthetic `ghp_` fixture (#59). Karl's rulings (A1 each, 2026-10-20/21): replace the
action with Semgrep's own container pinned by digest, pin every `uses:` to a commit SHA, add obsidian-mcp to CI, fix the
fixture; the vitest-4 dev-tool upgrade stays deferred.

Base commit ea7ae9d. Ledger: `.superpowers/sdd/2026-10-21-ci-56-57-59/progress.md` (git-ignored).

## Headline

**Verdict: SHIP.** The scanners now fail when they should. Reproduced in look-alike GitHub runner containers: every step
before `npm audit --audit-level=high` passes in both jobs; Semgrep exits 1 on two planted findings and 0 on the clean tree;
gitleaks catches a realistic fake token and no longer trips on the fixture. CI is still expected to fail at the dependency
audit (deferred dev-tool upgrade and the new advisories in #65/#66) and then at the governance steps (#58).

## Changes

- `.github/workflows/ci.yml`: the Semgrep step is
  `docker run --rm -v "$GITHUB_WORKSPACE:/src" -w /src semgrep/semgrep:1.181.0@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b semgrep scan --config p/owasp-top-ten --config p/security-audit --error --metrics=off`
  at the repository root; `actions/checkout` pinned to 11d5960a326750d5838078e36cf38b85af677262 (v4.4.0) and
  `actions/setup-node` to 49933ea5288caeca8642d1e84afbd3f7d6820020 (v4.4.0); gitleaks-action (already at
  ff98106e4c7b2bc287b24eaf42907196329070c7, v2.3.9) gets `GITLEAKS_VERSION: "8.30.1"`; a separate `obsidian-mcp` job runs
  `npm ci`, build, lint, test, `npm audit --audit-level=high` and `npm audit signatures` in `services/obsidian-mcp`.
- `.github/workflows/release.yml`: the same checkout and setup-node pins; `softprops/action-gh-release` pinned to
  3bb12739c298aeb8a4eeaf626c5b8d85266b0e65 (v2.6.2).
- `services/obsidian-mcp/eslint.config.js`: Node globals (`AbortSignal`, `Buffer`, `TextEncoder`, `URL`, `console`,
  `fetch`, `process`, `setTimeout`) declared readonly for `scripts/**/*.mjs`; `no-undef` stays an error.
- `services/control-plane/test/console-deliver-command.test.ts`: the hostile-input fixture builds its fake token at run time
  (`"ghp_" + "a".repeat(36)`); the assertions are unchanged.

## Verification

- **Semgrep, exact CI command.** Negative control (a `URLSearchParams` value passed to `eval` in a scratch copy): exit 1,
  `detect-eval-with-expression`. Second control (HEAD's unpinned workflows): exit 1 with 5 `github-actions-mutable-action-tag`
  findings. Rule-pack fetch failure (`--network none`): exit 2. Clean tree: exit 0, 373 files (366 in the runner emulation),
  0 findings. Runner emulation with the workspace owned by uid 1001 and the container as root: same results; the image's
  `safe.directory = /src` applies. Digest = the 1.181.0 tag, an OCI index with linux/amd64 and linux/arm64.
  A plain `eval(userInput)` is not flagged by these packs (the rule is a taint rule with browser URL sources).
- **gitleaks.** 8.24.3 on the old fixture: exit 1 (`github-pat`, line 326); on the new file: exit 0. 8.30.1 (the pinned
  linux-x64 asset, checksum-verified, run with the action's arguments): no leaks; positive control with a random `ghp_` token:
  flagged. The action reads `process.env.GITLEAKS_VERSION || "8.24.3"` at the pinned SHA.
- **Pins.** Each SHA equals its stated tag in the official repository (`gh api …/git/ref/tags/<tag>`); no mutable `uses:`
  remain. actionlint 1.7.7 and 1.7.12: exit 0. Both workflows parse.
- **obsidian-mcp job** (node 24.22.1, linux/amd64): `npm ci`, build, lint (25 errors before, 0 after), test 26/26,
  `npm audit signatures` all exit 0; `npm audit --audit-level=high` exits 1 as expected.
- **control-plane** (macOS): the edited test 17/17; full suite `Tests 1380 passed | 5 skipped | 1 todo (1386)`. A mutation
  that echoes the detail fails the edited test.

## Residual

- `node-version: 'lts/*'` will move to Node 26; both services pass on node 26.12.1 today. Optional: pin `24.x`.
- `persist-credentials` defaults to true, so the read-only checkout token sits in the workspace the Semgrep container mounts
  read-write; the token is read-only and the image pinned. Optional: `persist-credentials: false` and a `:ro` mount (checked
  harmless).
- Still mutable at run time: `npx license-checker` (ci.yml), `npx @cyclonedx/cyclonedx-npm` and the `zaproxy/zap-stable`
  image (release.yml); release.yml also runs `npm ci` at the root, which has no lockfile (#67).
- Semgrep rule packs are fetched live, so a pack update can add findings without a code change (fails closed).
- obsidian-mcp's job has no license check.
- New production advisories found during this change: #65 (control-plane, not reached) and #66 (obsidian-mcp, reached in
  code; the service does not run anywhere).
