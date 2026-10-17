# ADR-0010: Maestro Console inside the harness — read-only feed first, step-up Submit, no bulk copy of session content

**Status:** Accepted
**Date:** 2026-10-16
**Phase:** Phase 2 — new MVP scope by Orchestrator ruling (PRODUCT_MANIFESTO §5 amendment 2026-10-16); Track 1 of two
**Spec:** `docs/superpowers/specs/2026-10-16-maestro-console-design.md` (v2, approved 2026-10-16 after one adversarial review and rulings R1–R6)
**Relates to:** ADR-0001 (UI plane — the chat-pane pivot is parked, see Consequences), ADR-0005 (terminal tabs), ADR-0008 (keycards; TM-011), ADR-0009 (waker dispatcher, XC-6); rulings A-1 / TP-7 (terminal recording), TP-4 (task board); Bible §7 C.6 (operator I/O), D6 (step-up), D8 (append-only audit)

## Context

Karl runs three to six Claude Code sessions at once (up to eighteen), one tmux session per project, on more than one dev machine, and coordinates them through a Maestro session in a terminal. He loses track across projects, misses items that wait on him, and decides from detail-free TL;DRs. The wanted outcome is one page inside the Pantheon harness that shows every session on every machine, surfaces what needs him, shows the full detail behind any summary, and lets him answer — without opening a terminal unless he wants to.

Constraints that shaped the decision: the operator's browser and clipboard are not trusted to programs on dev machines (TM-020); session transcripts contain secrets (the 2026-10-09 leaked tokens are in them); ruling A-1 / TP-7 forbids a durable copy of terminal content without redaction, encryption, access control and retention; D8 requires append-only audit of privileged acts; D6 requires a step-up for tier-3 privileged acts and is still a stub (BUGS #36); Pantheon already has sign-in, SSH custody, the DevMachine registry, tmux terminal tabs, the approvals inbox and a colourblind-safe theme; a second application able to command every Claude session would be a second high-value target.

## Options Evaluated

| Option | Description | Pros | Cons |
|--------|------------|------|------|
| **Where it lives** | | | |
| A | Separate web application | Independent release cadence | Second sign-in, second SSH custody, second high-value target; duplicates the harness shell |
| B | Fold into the hand-built chat-pane pivot (2026-09-01 assessment) | One UI rewrite | The pivot has no design input (sheet unchanged at rev 0 on 2026-10-16) and is a far larger build; blocks the console on it |
| **C (chosen, D1)** | New tab inside pantheon-harness | Reuses sign-in, SSH custody, registry, theme, build stamp; one target to defend | Adds scope to a Phase 2 project; UAT-5 had to close first (done 2026-10-16) |
| **How it reads sessions** | | | |
| D | Per-session push hooks reporting to the VM | Low poll cost | A hook and a keycard on every session and machine; silent when a session dies |
| E | Maestro as the relay hub | No new reader | Bottleneck; tokens spent on every card |
| **F (chosen, D9)** | Pantheon pulls transcripts, `sessions/*.json` and pane tails over its existing SSH access, one allow-listed script per machine per poll | Nothing installed on dev machines; no new credentials; a blocked session is visible from the pane | Undocumented `sessions/*.json` (O5); pane fixtures may be brittle (O6) |
| **What is stored** | | | |
| G | Store full transcripts / tool output on the VM | Instant expand, search | A durable bulk copy of session content on the VM — violates A-1 / TP-7 unless encrypted, access-controlled and purged; a second place secrets can leak |
| **H (chosen, R1)** | Store only the masked card face (TL;DR + pointers); fetch full text / why / what-it-did live over SSH on expand, never persist | A-1 satisfied by not storing content; a masking miss is limited to the face and the live view | Expand needs the machine reachable; no cross-card search (D14) |
| **How Submit is authorised** | | | |
| I | Operator session cookie alone | No friction | A stolen session or CSRF types into a live Claude session — tier-3 act without a step-up (BUGS #36) |
| **J (chosen, R4)** | Passphrase re-entered on Submit, 15-minute elevated window; Submit is the first D6 consumer | Matches D6; bounded window | Friction once per quarter-hour |
| **Terminal menus** | | | |
| K | Answer permission / trust / `AskUserQuestion` menus from the page | Fully terminal-free | A misread menu or a race sends a keystroke to the wrong prompt; needs a compare-and-select protocol |
| **L (chosen, R5)** | Show menus read-only with their options and "Open terminal"; answer in the terminal in v1 | Zero risk of answering the wrong menu | Terminal still needed for menus |
| **Relays to Maestro** | | | |
| M | Type directly into Maestro's pane | Simple | Bypasses the only inbound gate the harness has |
| **N (chosen, R2)** | Karl's typed Submit = operator I/O (C.6); "Check this" / "Ask Maestro" go through the ADR-0009 dispatcher as fixed strings (XC-6 allowlist + rate cap + negative test) | Reuses the audited gate; fail closed when the allowlist is empty | Dispatcher stage 2 must land first (F5) |
| **Audit retention** | | | |
| O | Purge Submit audit after one year (S3) | Smaller table | Loses the record of what was typed into which session (D8) |
| **P (chosen, R6)** | Append-only, never deleted | D8 kept; forensics intact | Table grows (≤ 1 KiB per row) |
| **Task board** | | | |
| Q | Console replaces the TP-4 task board | One surface | Loses durable cross-project tasks (ruling A-2) |
| **R (chosen, R3)** | Console complements TP-4; TP-4 stays planned | Both rulings stand | Two surfaces to build |
| **Cheat-sheet tagging** | | | |
| S | Tags in each skill's frontmatter | Lives with the skill | Plugin skills cannot be edited; two places |
| T | Model-guessed tags | No config | Can be wrong; tokens on every card |
| **U (chosen, D8)** | One console settings file mapping skills → areas and projects → areas; untagged skills shown everywhere, labelled | One place; nothing silently disappears | A settings file to keep current |

## Decision

Build the Maestro Console as a new tab inside pantheon-harness (C), reading sessions by pull over existing SSH access (F), storing only masked card faces (H), with Submit behind a passphrase step-up (J), terminal menus read-only in v1 (L), relays through the ADR-0009 dispatcher (N), an append-only Submit audit (P), the TP-4 board kept and complemented (R), and cheat-sheet filtering from one settings file (U). Build order is Track 1 F1–F5 of the spec §11, **F1 read-only first** with a real-use period before anything can act on a session (D16), one Build Loop per feature, UAT every two features.

**Settings-file failure behaviour (recorded deviation from M15/D10's "fail the whole surface").** A malformed console settings file disables the **console module only**, with a banner naming the offending entry; terminals, approvals and the rest of the harness keep running. Justification: the console is an observer with no authority over the trust core; failing closed per module keeps the operator's working surface (terminals, approvals) available while the observer is unavailable, which is the safer state for a single operator. The malformed state is loud (banner, fail-visible table in spec §9), never silent.

**Masking is mandatory before storage, display and Telegram** (spec §8.4); the probe reads allow-listed `sessions/*.json` fields only and never `*.key`, `bridgeSessionId` or `messagingSocketPath`.

## Rejected Alternatives

- **A separate application:** a second sign-in, a second SSH custody and a second high-value target for no gain the harness does not already provide.
- **Folding into the chat-pane pivot:** the pivot is parked (no design input since 2026-09-01); tying the console to it would block the console indefinitely.
- **Per-session push hooks / Maestro as hub:** installation on every machine, or a bottleneck that costs tokens per card; both silent when a session dies.
- **Storing full transcripts:** a durable bulk copy of session content on the VM is exactly what ruling A-1 / TP-7 forbids without a control set this feature does not need.
- **Submit on the session cookie alone:** typing into a live Claude session is a tier-3 act; D6 exists for this.
- **Answering terminal menus from the page in v1:** a wrong keystroke into a permission prompt is unrecoverable; deferred to a compare-and-select design (O7).
- **Direct typing into Maestro's pane for relays:** bypasses the XC-6 gate.
- **One-year audit purge:** D8 says append-only.
- **Tags in skill frontmatter / model-guessed tags:** plugin skills are read-only; guesses are wrong and cost tokens.

## Consequences

- **New MVP scope** (PRODUCT_MANIFESTO §5 amendment 2026-10-16): F1–F5 above the cutline as Track 1; TP-4 stays above the line and is complemented, not replaced (R3).
- **Chat-pane pivot parked** (APPROVAL_LOG 2026-10-16; Bible §3 note under ADR-0001): LibreChat remains the chat modality; residual TM-024 stays accepted; the design sheet and its artifact remain available; un-parking needs a new ruling.
- **Data model:** four additive SQLite tables (`console_session`, `console_card`, `console_submit_log`, `console_reminder`) under ruling A (Bible §5 P3); no full text, reasoning or tool output stored (R1); `console_submit_log` is append-only (R6).
- **Threat model:** TM-025 (send path), TM-026 (machine probe), TM-027 (Telegram) added to Bible §4; residuals: a sub-second race between the menu check and the paste; prompts raised by background agents not reflected in `status`; an unrecognised secret format can reach a card face.
- **Step-up:** Submit is the first route that must enforce the D6 step-up (BUGS #36 extended 2026-10-16); keycard mint/revoke remain the next consumers.
- **Secrets custody:** a dedicated Telegram bot key provisioned into the same file-custody class as the SSH key, rotation added to `docs/token-rotation-runbook.md`.
- **Process:** each feature runs the Build Loop (tests first, RED verified, implement, security audit, docs, record); one adversarial review per PR at max effort; UAT sessions 6–8 as scheduled in spec §11; after every deploy the build header is checked against the commit.
- **Later:** after F1 proves the feed, the "send your TL;DR to @Maestro" lines in `CLAUDE.md` files become redundant (D15) — removing them is Karl's call. Track 2 (hooks in the karl-workflow plugin) is a separate spec and repository.

## Follow-up 2026-10-17

The decisions above and rulings R1–R6 are unchanged. Two things changed while F1 was built.

1. **State palette and console look** (Karl's choice in the Console Style Lab, relayed by Maestro on
   2026-10-17; applied in plan Task 11).
   - **States:** spec §6.2's red / yellow / blue top edges became needs-you **orange `#ff9f40`, solid
     edge** · working **grey `#a8a8a8`, dashed edge** · idle **blue `#5aa9ff`, solid edge**. The
     edge is 6 px, and the style difference is a second, non-colour cue. Every state is still a glyph +
     a word (`!` NEEDS YOU, `⟳` WORKING, `✓` IDLE …), never colour alone (CC1).
   - **Deep navy tokens:** background `#152035`, surface `#1b2943`, surface2 `#233350`, border
     `#435a80`, text `#e9f0f8`, secondary `#bfcde0`.
   - **Type:** Lexend 18 px / 1.45, **self-hosted**. Two WOFF2 files are vendored unmodified,
     SIL OFL 1.1, with text and SHA-256 digests in `THIRD_PARTY_NOTICES.md`. The control-plane checks
     the digests at startup, and the browser never requests Google Fonts. The code face is the
     harness mono stack (Roboto Mono → Menlo/Consolas).
   - **Scope:** the change applies to the console only; the rest of the harness keeps the LibreChat
     theme.
2. **One commit for all of F1** (Karl ruling A1, 2026-10-16). F1 lands as a single commit after its
   security audit and documentation, not one commit per task. Tasks 1–11 each ended in a reviewed
   checkpoint patch instead. This is because the framework's commit check blocks a commit that stages
   source until the first five Build Loop steps are marked. The plan's "Execution deviations" section
   lists every ruling that changed the plan's text.
