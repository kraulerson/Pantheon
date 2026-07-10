# CLI ↔ Harness Comms Autonomy — Design Note (2026-07-09)

**Status:** design captured, NOT built (Decision C freeze in effect — this is post-skeleton).
**Origin:** Karl wants his Claude Code CLI session (run in the harness SSH terminal tab,
ADR-0005) to converse with the other identities **unattended**. The comms bridge
(Alden Bridge mailbox) already works and Claude Code can already read/write it — the gap
is that Claude Code only *checks* the mailbox when Karl tells it to, so Karl has to relay
every turn ("Alden replied — go check"). This note designs the automation of that nudge,
with a loop-safety mechanism.

Decided this session: Claude Code participates **as its own identity** (its own mailbox
participant), not as "Karl's agent" — keeps the audit trail clean and matches the
"household of distinct minds" model.

## The mechanism (corrected by a Claude Code capability check)

The naive idea — the harness *types a nudge into the terminal's input* — is **not a
supported Claude Code mechanism** (an external process cannot safely inject into a
running interactive session). Two supported paths achieve the same effect; pick at build
time against current docs:

- **Primary (to confirm): native push "channel."** Claude Code reportedly supports an
  MCP-based mechanism where an external source pushes a message straight into a live
  session so it reacts without polling or human typing (per code.claude.com docs on MCP
  channels — **verify against current docs at build time**). If available, the harness
  exposes the comms bridge as such a channel scoped to the Claude-Code identity: a new
  inbound message is pushed in, Claude reacts, replies via its existing bridge tool.
- **Fallback (always available): orchestrator-driven session.** The harness runs the
  Claude Code session persistently (named/resumable) and drives it turn-by-turn via the
  Agent SDK, or uses a **Stop hook** that re-checks the mailbox after each turn and feeds
  any new message into the next prompt (`additionalContext`). More plumbing; fully
  supported today.

Either way: **push only a harness-authored wake/notification, and let Claude pull the
actual message body through its existing (gated) bridge tool** — never inject raw message
content into a shell-capable session. (Trust-boundary specifics → Opus 4.8 security lane.)

Requirement both paths share: the Claude Code session must **persist server-side** while
Karl is away (the terminal is already brokered server-side; "keep it alive headless" is
new).

## Loop safety — Karl's design (why a fixed turn limit is wrong)

A hard turn cap punishes exactly the long, legitimate discussions Karl wants to leave
running — he'd have to intervene just to reset the counter. Instead, **detect looping by
judging progress**, not by counting:

1. **Cheap counter arms the judge.** Let the auto-relay run freely; once a thread passes
   ~25 messages, arm the loop-detector.
2. **Local-model judge, on a rolling window.** The detector takes the trailing ~10
   messages and asks **llm-mini (the local 27B brain — free, fast)**: *is this
   conversation still making progress toward resolving its aim, or repeating itself /
   stalled?* Re-run every few messages after arming (a loop can start after 25).
   Frame the judge on **progress, not mere similarity**, so a deep productive thread
   isn't killed.
3. **On "looping/stalled": pause, don't kill (P7).** Stop the auto-relay, **notify
   Karl**, and preserve the thread so he can read it and choose to redirect or resume.
   Never silently continue; never destroy state.
4. **Absolute backstop (belt-and-suspenders).** The judge is itself an LLM and can be
   wrong, so keep a high hard ceiling (e.g., N total auto-relays or M minutes without a
   human touch) that pauses regardless. High enough never to interrupt normal work, low
   enough to bound a runaway if the judge fails.

This is deliberately the shape of the ratified **A1 Hebbian runaway circuit-breaker**
(pause authority, notify, never silent-continue) and principle **P7** ("fail closed;
instrument, don't freeze; does not run unwatched") — applied to CLI↔identity chatter.

## Where it fits

- **This is the Autonomy Driver in miniature** — "watch the queue, wake a participant"
  is exactly its future-state role. It should reconcile with that component (Alden
  Phase 8 / oscillator) when that's built; this is a concrete first slice.
- **Reference:** Turnstone's idle-nudge/watch pattern (borrow **T2** from the
  `2026-07-09-turnstone-bifrost-eval` ruling) is the working precedent for the watcher.
- **Placement:** new scope, above the MVP cutline → **post-skeleton**; warrants its own
  ADR when built. Not started now (freeze).

## Open questions for build time

1. Confirm the native push-channel mechanism exists/suits us; else choose SDK-loop vs
   Stop-hook fallback.
2. Judge thresholds (arm-at count, re-check cadence, trailing-window size) — tune live.
3. The judge prompt/criteria for "progress vs loop" (and "stalled" as a distinct pause).
4. Absolute-backstop values (message ceiling and/or wall-clock).
5. Multi-party threads (≥3 identities): detector keys on the thread, not just a pair.
6. Security: pushing a wake into a shell-capable session, and tainted inbound content →
   Opus 4.8 security review owns the rules; this note only fixes the "wake-word not
   body" foundation.

## References
- ADR-0005 (terminal modality), `docs/integration/alden-bridge.md` (mailbox),
  future-state Autonomy Driver + Oscillator, amendment A1, principle P7,
  `docs/2026-07-09-turnstone-bifrost-eval.md` (T2 idle-nudge borrow).
