# UAT-6 — automated suite (controller, 2026-10-26)

Tree: `d2c3b99` (main = origin/main). Deployed on VM 1093: `6594566` (Maestro Console F2; later commits change only
dependencies, CI, docs and the framework — none of them is deployed yet). Run on macOS, Node 25.9.0.

| Service | lint | tsc --noEmit | build | npm test | npm audit --omit=dev --audit-level=high |
|---|---|---|---|---|---|
| control-plane | rc=0 | rc=0 | rc=0 | rc=0 — `Test Files 75 passed \| 1 skipped (76)`, `Tests 1380 passed \| 5 skipped \| 1 todo (1386)` | rc=0 |
| obsidian-mcp | rc=0 | rc=0 | rc=0 | rc=0 — `Test Files 2 passed (2)`, `Tests 27 passed (27)` | rc=0 |

GitHub CI run 40336045785 on `d2c3b99`: both jobs pass install, build, lint and test; Semgrep (pinned container, `--error`)
0 findings over 367 files; gitleaks 8.30.1 clean; the Dependency audit step fails on dev-only advisories (control-plane 9,
obsidian-mcp 8; the deferred vitest-4 / typescript-eslint upgrade) — expected.

Not covered by the automated suite (human scenarios in the session template): what a pasted reply does inside a real
Claude Code session, the passphrase step-up in a real browser, the commit-approval screen against a real CDF prompt, the
machine shell drawer, New Session / New Project on the real machines, the Linux-Dev prerequisites.
