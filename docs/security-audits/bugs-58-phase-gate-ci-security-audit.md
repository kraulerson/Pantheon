# Security Audit: BUGS #58, the phase gate check on a CI runner

Finding: with the dependency audit fixed (BUGS #88), CI run 44951445237 (`4b2b114`) reached
"Governance - Phase gate check" for the first time and failed there. `scripts/check-phase-gate.sh` listed Semgrep,
Snyk CLI, Claude Code and Lighthouse as needed, reached `read -rp "Install now? [Y/n]"`, and `read` at end of file
exits 1 under `set -e`. Had it got past the question, `issues=$((issues + 1))` would still have failed the run.
Karl's ruling (A1, 2026-11-21): bring over both of the generator's behaviours; every other phase gate check still
blocks; an install command never runs unattended.

Base commit 4b2b114. Changed: `scripts/check-phase-gate.sh`, new `tests/test-check-phase-gate-noninteractive.sh`. One
adversarial review (fresh agent, top-tier model, 2026-11-21), in scratch copies, under /bin/bash 3.2.57. Its verdict
was "major concerns"; the major and four of the minors are fixed below.

## Headline

**Verdict: SHIP, with the residuals below.** In a local re-creation of the runner (real tool resolver, tools hidden,
`CI=true`, input at end of file) the script prints "Phase gates consistent." and exits 0, installs nothing and writes
nothing. The real proof is the next CI run. BUGS #58 stays open: the changelog and session-state check scripts do not
exist in this project.

## What changed

- `prompt_yes_no`: both questions (install the tools; start a Qdrant container) go through it. It asks nothing and
  answers no when standard input is not a terminal, when `$CI` is set to anything, or when `SOIF_NONINTERACTIVE` is set.
- After the tool list, the count of one inconsistency is skipped when `CI=true`, and a note says why.

## The review's major finding, fixed

The first port took a question that got no answer as yes. `read` had moved inside a function called from `if`, where
`set -e` does not apply; when `read` failed at a terminal (the input ended, a `TMOUT` read timeout, Ctrl-D, the terminal
gone with SIGHUP ignored), `reply` stayed empty and "not n" meant yes. The base script exited 1 in each of those cases.
Reproduced by the review under `script(1)` and a pty harness, with a stub install command that left a marker, and by the
controller with the new case T7 before the fix. Fix: `read … reply || return 1`.

It did no damage, by accident: this project's real resolver emits `install_cmd` while the script evaluates
`.install_command`, so the yes-branch has nothing to run, and Qdrant MCP is not a required tool. The guard is therefore
the only designed control, which is why it had to hold.

## Narrower than the generator, on purpose

- The count is skipped only for `CI=true` (what GitHub sets). The generator accepts any non-empty `$CI`; the review
  showed `CI=false` and `CI=0` then excused the missing tools on a workstation.
- A question with no answer means no (above). Pressing Enter still means yes, as in the base script; the generator now
  treats Enter as no. Left as it was: the ruling was about unattended runs.

## What CI=true can and cannot excuse

Reviewed with 13 deliberately broken copies (approval log missing, a gate entry undated, a placeholder approver, a gate
date missing, the bible missing or with placeholders, the manifesto missing, an open question, phase 0 with a dated
gate, phase 3 without a gate date, phase 3 with an open SEV-1, phase 3 dated without a log entry, phase 4): all exit 1
with and without `CI=true`; the outputs differ only by the note and a count exactly one lower. With nothing missing, the
changed and base scripts are byte-identical in output and exit code for all 13. `CI` appears in two places in the script.

## What now runs on a runner for the first time

Everything after the old question. Reviewed by reading and by simulation: no further prompt, no hang, docker called
with `--version` only, no file created (the two snapshot folders are tracked). The two CI steps after this one call
scripts that do not exist and end in `|| true`.

## Tests

`tests/test-check-phase-gate-noninteractive.sh`, nine cases, on /bin/bash 3.2. It copies the tracked governance files to
a throwaway folder, stubs the resolver, and stubs docker, uvx and claude so a regression cannot reach the real ones.

- First version: 6 checks failed on the base script, then all passed.
- After the review: T6 (`CI=false`) and T7 (terminal, no answer) failed first; then all pass.
- Proven to bite: with "CI excuses every counted inconsistency" T5 and T6 fail (4 checks); with the `read` fix removed
  T7 fails. The review's other mutants that the first version missed (the guard ignoring `$CI` or
  `SOIF_NONINTERACTIVE`, a workstation always counting, the Qdrant question never reached) are covered by T8, T9, T4
  and T3.
- T7 to T9 need `script(1)`; where it cannot be driven they print "skip" and do not fail.

## Verification

- `/bin/bash tests/test-check-phase-gate-noninteractive.sh`: "all cases passed", exit 0.
- Real resolver, runner-like PATH, `CI=true`: "Phase gates consistent.", exit 0. The same without `CI`:
  "1 inconsistency(ies) found — blocking.", exit 1.
- On this Mac, tools installed: "Phase gates consistent.", exit 0.
- Not verified: a real GitHub runner; any bash newer than 3.2; Linux `script(1)` (T7 to T9 may skip there).

## Residual

1. **No CI step runs the test.** It is run by hand. Adding a step changes `ci.yml`, which is its own decision.
2. The exit-0 cases depend on this project's live governance files; the test goes red at a real gate inconsistency.
3. BUGS #58's other parts: `scripts/check-changelog.sh` and `scripts/check-session-state.sh` are missing, so their CI
   steps pass while doing nothing; the "integer expression expected" message at line 315.
4. The script is a hand-patched copy of an old generator version (662 lines then; the generator's is about 3,800). The
   lasting cure is a Solo Orchestrator upgrade of this project. The generator also ships a test of the same file name,
   which an upgrade may overwrite.
5. Inside the guarded yes-branch, untouched: this copy still publishes Qdrant on all interfaces
   (`-p 6333:6333 -p 6334:6334`; the generator binds 127.0.0.1). Unreachable while Qdrant MCP is not required.
6. `CI=` (empty) at a terminal asks the question and waits, as before.
