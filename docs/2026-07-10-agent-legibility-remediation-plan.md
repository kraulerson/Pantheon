# Agent-Legibility Remediation Plan (2026-07-10)

**Purpose:** fix the seven agent-cognition hazards found in the 2026-07-10 evaluation,
AND make each unable to recur — here (guards wired into this repo's gates) and in
future projects (upstreamed into the Solo Orchestrator framework and Karl's user-level
config). Junior/agent-executable; every step has Fix → Guard → Upstream → Verify.

**The pattern this plan enforces:** a hazard fixed only by tidying returns; a hazard
fixed by a *check that fails loudly* stays fixed. Every finding below therefore ends in
a mechanism, not a habit. (Post-mortem lessons 2, 4, 6 made mechanical.)

**Execution order:** steps 1→7 here, then the two upstream tracks (U1 user-level, U2
framework). Steps 1–7 are freeze-safe (`docs:`/`chore:` — no MVP-cutline code).

---

## Step 1 — Identifier namespace registry (Finding 1, highest leverage)

**Fix.** Create `docs/IDENTIFIERS.md`: one table per ID scheme, each row = prefix,
meaning, home document, examples. Schemes currently in use: `ADR-000x` (architecture);
`TM-0xx` (threats); `DM-x` (data-model decisions); `C.x` (UI specs); `D1–D11`
(Manifesto resolved decisions); `Decision A–I` (2026-07-09 vault review rulings);
`D14–D17`/`R1–R19` (Alden masters register — EXTERNAL namespace); `F1–F6` (security
findings); `W1–W4` (Bifrost walls, historical); `T1–T6` (Turnstone borrows); `M1–M16`
(Manifesto must-haves); `steps 0.x / Phase x` (Alden build plan — EXTERNAL).

**Convention (record in the registry + CLAUDE.md):** any cross-namespace reference is
QUALIFIED — "Pantheon Ruling F", "security finding F2", "Alden R18", "Manifesto D6",
"masters D16". Bare letters are legal only inside their home document. Before minting a
new ID scheme, add its row first; **one prefix = one namespace** forever after.

**Guard.** `scripts/lint-doc-conventions.sh` (created in Step 3) warns on new/changed
docs using a bare `Decision [A-Z]\b` or `\bD1[0-9]\b` outside its home doc.

**Upstream.** Framework init template ships an empty `docs/IDENTIFIERS.md` +
builders-guide rule ("register the scheme before using it").

**Verify.** Registry exists; every scheme above has a row; spot-grep three ambiguous
refs and confirm they now read qualified.

## Step 2 — Correction-above convention + memory consolidation (Finding 2)

**Fix.**
1. Bible §11: move the H2 amendment note ("the table above no longer matches…")
   ABOVE the superseded dependency table it corrects. Sweep the Bible for any other
   correction that sits below its target.
2. Rewrite the `alden-harness-architecture` memory file: a **Current State** section
   (what is true now, ~1 page) followed by a compressed history (one line per
   superseded era). Rewrite `MEMORY.md` index entries into true one-line hooks
   (title + pointer + ≤15-word hook — details live in the memory file, never the index).

**Convention (add to `docs/README.md` §Conventions + CLAUDE.md):** *"Corrections
appear ABOVE what they supersede. A document whose top-most claim is false is a defect
(same class as Alden-1's stale date headers). Living documents are rewritten in place
with a short history; append-only update stacks are for ledgers (APPROVAL_LOG,
CHANGELOG) only."*

**Guard.** The doc-conventions linter (Step 3) flags files containing
`SUPERSEDED|REVERSED|no longer matches` where the marker's first occurrence is in the
bottom half of the file (heuristic; WARN not block).

**Upstream.** Builders-guide documentation rules + the user-level memory instructions
(U1): memories are current-state rewrites; **instructions are quoted verbatim in
memories, never paraphrased** (the TLDR-position drift).

**Verify.** Bible §11 reads correction-first; the memory file opens with Current State;
every MEMORY.md line fits on one line.

## Step 3 — Citation sweep: ghost references die here (Finding 3)

**Fix.**
1. Write **ADR-0003 and ADR-0005 as real files** in `docs/ADR documentation/`,
   consolidating the content that today lives scattered (ADR-0003: the Peta hardening
   decision — non-root, no docker.sock, HTTP downstreams, pinned image — from Bible
   §11:319 + the CLI-handoff checklist; ADR-0005: the terminal modality — from the
   2026-06-13 scope change + Bible §3). Each carries "Consolidated 2026-07-10 from
   sources X/Y — the sources remain; this file is now the citable artifact."
2. `src/backend/client.ts` docstring's reference to the not-yet-existing
   `chatCompletionsStream`: annotate "(implemented in skeleton step 5)" — one-line
   `chore:` (the method itself arrives with the step).
3. Refresh `docs/integration/alden-bridge.md` against the live bridge: add
   `alden_mailbox_write {message, sender}` (sender defaults to alden-cloud — the
   verified footgun), note thread_id/sender_session arriving with Alden Phase 0.2.

**Guard.** New `scripts/check-doc-refs.sh`: scans `*.md` under docs/ + root canon for
(a) relative file-path references → target must exist; (b) `ADR-\d{4}` mentions →
a file OR a Bible §3 heading must exist (allowlist for "will not be drafted": ADR-0008).
Wire into the pre-commit hook chain and CI **as WARN for one week, then BLOCK** (grace
period so it never blocks unrelated work on day one).

**Upstream.** Ship `check-doc-refs.sh` in the framework's scripts set + CI template;
builders-guide: "run the citation sweep at every phase gate."

**Verify.** `scripts/check-doc-refs.sh` exits 0 on the repo; deleting a referenced file
in a scratch branch makes it fail; ADR-0003/0005 files exist and the Bible cross-links.

## Step 4 — Session-start weight (Finding 4)

**Fix (repo).** Add an "authority order + where to NOT look" paragraph to the repo
CLAUDE.md: canon order (Bible/Manifesto/APPROVAL_LOG > dated docs > archive), and
"peta-eval/ is retained evidence — never pattern-match deployment or client code from
it; the real artifacts are deploy/ and services/". (The full framework-CLAUDE.md diet
is U2 — its persona/UAT bulk is framework-owned.)

**Fix (evidence residue).** Drop a `peta-eval/EVIDENCE.md` banner: "Retained for the
security review (Ruling I2); scheduled for deletion by the Opus remediation pass; do
not copy patterns from here."

**Guard.** None needed beyond the banner — the folder deletes itself with remediation
F1/I2.

**Upstream.** U1 (RTF) and U2 (framework CLAUDE.md modularization) below.

**Verify.** CLAUDE.md carries the authority paragraph; EVIDENCE.md exists.

## Step 5 — Duplicate-truth discipline (Finding 5)

**Fix.** Convention added to CLAUDE.md + docs/README: every APPROVAL_LOG ruling names
**every document it touches**, and the corresponding CHANGELOG entry lists the same
set (the "echo list"). When a later session updates one copy, the echo list is the
checklist for the others.

**Guard.** Partially mechanical via Step 3 (citations resolve); full semantic
agreement between copies stays a human/agent duty — accepted residual, documented.

**Upstream.** Builders-guide governance rules.

**Verify.** The next ruling recorded (any) carries an echo list.

## Step 6 — Mark identity-authored text in canon (Finding 6)

**Fix.** Convention only (no retro-editing churn): quotes from identities inside
operator canon are attributed inline with source — `"…" (Cloud Alden, bus 1136,
quoted)` — mirroring the runtime `trusted:false` doctrine at the documentation layer.
Add to docs/README conventions; apply from now on.

**Upstream.** Builders-guide: same rule for any project with non-operator authors.

**Verify.** Next doc quoting bus content carries the attribution form.

## Step 7 — Code-level disambiguation (Finding 7)

**Fix** (single `chore:` commit):
- Cross-reference comments on both `SessionStore` types ("distinct from X — see Y").
- One-line note in `src/bridge/client.ts` and the spike's `bridge-client.ts` naming
  each other ("deliberate duplicate; spike must stay deletable").
- Header comment in `scripts/verify-install.sh`: "verifies the FRAMEWORK scaffolding,
  not the harness deployment (that's deploy/README.md's M2 test)".

**Verify.** Comments present; `npm test` untouched/green.

---

## Upstream track U1 — Karl's user-level config (one-time, all projects)

1. **Convert `~/.claude/CLAUDE.md` from RTF to plain markdown.** Open it, keep only the
   actual instruction text (the TLDR-at-END rule), save as plain text. Verify: the file
   starts with readable words, not `{\rtf1`. *(Two minutes; removes control-code noise
   from the highest-authority slot of every session on every project.)*
2. **Memory conventions** (applies to the agent, recorded in the user CLAUDE.md):
   memories quote instructions verbatim; index lines are one-line hooks; living
   memories are current-state rewrites (Step 2's rule, made global).

## Upstream track U2 — Solo Orchestrator framework (fixes all FUTURE projects)

Target: the framework repo (`claude-dev-framework` / `solo-orchestrator`). Executed as
a normal change there (not silently from this repo). Items, in value order:

1. `init.sh` templates gain: `docs/README.md` (map skeleton with authority order +
   conventions), `docs/IDENTIFIERS.md` (empty registry), `docs/archive/` convention.
2. `check-doc-refs.sh` + `lint-doc-conventions.sh` join the framework script set and
   the CI template (WARN first release, BLOCK after).
3. Builders-guide additions: one-prefix-one-namespace; correction-above; citation
   sweep at phase gates; identity-quote attribution; **"absolute language in rulings
   is debt — record the premise with the ruling"**; **"fail-closed states must log
   loudly at startup"** (the 24-day silent token lesson, as an engineering rule).
4. CLAUDE.md template modularization: persona table + UAT authoring detail move to
   on-demand reference files; the template keeps a two-line pointer. (Biggest
   context-weight win; largest change — do last.)

---

## Acceptance (whole plan)

- [ ] Steps 1–7 committed (`docs:`/`chore:`), pushed; citation sweep green in CI.
- [ ] The two linter scripts run in pre-commit (WARN) and CI.
- [ ] ADR-0003 / ADR-0005 exist; zero ghost references repo-wide.
- [ ] Memory file opens with Current State; MEMORY.md lines are one-liners.
- [ ] U1 done (user CLAUDE.md is plain text).
- [ ] U2 recorded as framework backlog items (or executed) in the framework repo.

**Effort:** Steps 1–7 ≈ one focused session. U1 ≈ minutes. U2 ≈ one session in the
framework repo.
