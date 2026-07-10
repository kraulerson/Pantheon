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

## The mechanism — Claude Code "channels" (VERIFIED real, with caveats)

The naive idea — the harness *types a nudge into the terminal's input* — is **not a
supported Claude Code mechanism** (an external process cannot safely inject into a
running interactive session). But Claude Code has a native, purpose-built mechanism:

**Channels** (verified 2026-07-09 against the official docs, `code.claude.com/docs/en/channels`):
> "A channel is an MCP server that pushes events into your running Claude Code session,
> so Claude can react to things that happen while you're not at the terminal. Channels
> can be two-way: Claude reads the event and replies back through the same channel."

Shipped **Claude Code v2.1.80, 2026-03-20, as a research preview**. A channel is a local
MCP server; inbound arrives as a `<channel source="...">` event; two-way replies go back
through it. Official plugins: Telegram/Discord/iMessage + a `fakechat` localhost demo;
custom channels are supported (`/en/channels-reference`). Note: my model training cutoff
(Jan 2026) predates this feature, so it is NOT knowable from model memory — it was
confirmed only by fetching live docs. This is the context7/verify-tooling rule in action.

- **Primary mechanism: a custom "Alden-bridge channel" plugin.** A small MCP-server
  plugin runs alongside Claude Code on the dev box; it watches the comms bridge and
  **pushes** a new inbound message (addressed to the Claude-Code identity) into the live
  session as a channel event; Claude reacts and replies back through the channel, which
  writes to the bridge. No PTY injection. Enabled per session with
  `claude --channels plugin:alden-bridge`.
- **Fallback (if the preview changes/breaks): orchestrator-driven session.** Harness runs
  the session persistently and drives it via the Agent SDK, or a **Stop hook** re-checks
  the mailbox each turn and feeds new messages into the next prompt (`additionalContext`).

**Caveats that gate a build decision (from the docs):**
- **Research preview** — "the `--channels` flag syntax and protocol contract may change."
  Building hard on it now is building on shifting ground; keep the fallback live.
- **Custom-channel allowlist:** during preview `--channels` only accepts Anthropic-
  allowlisted plugins; a channel we build needs `--dangerously-load-development-channels`
  (acceptable on a trusted LAN homelab) until it's GA or org-allowlisted.
- **Requires Anthropic auth** (claude.ai / Console key — Karl has this). Not on
  Bedrock/Vertex/Foundry.
- **Persistence:** "Events only arrive while the session is open" → run Claude in a
  persistent/background session (the terminal is already brokered server-side; keeping it
  alive headless is the new bit).
- **Unattended permission prompts:** if Claude hits a permission prompt while Karl's away
  the session pauses, unless the channel declares permission-relay or a skip-permissions
  mode is used in a trusted env → **Opus 4.8 security lane**.

Trust rule regardless of mechanism: prefer pushing a **notification** and letting Claude
pull the message body through its existing (gated) bridge tool over injecting raw content;
if the channel event carries body text, that inbound is untrusted and its handling is an
Opus 4.8 security-review item (tainted content into a shell-capable session).

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

1. ~~Confirm the native push-channel mechanism exists~~ — CONFIRMED (Claude Code
   channels, v2.1.80+, research preview). Open: is the research-preview stable enough to
   build on, or start on the SDK-loop/Stop-hook fallback until channels reach GA?
2. Judge thresholds (arm-at count, re-check cadence, trailing-window size) — tune live.
3. The judge prompt/criteria for "progress vs loop" (and "stalled" as a distinct pause).
4. Absolute-backstop values (message ceiling and/or wall-clock).
5. Multi-party threads (≥3 identities): detector keys on the thread, not just a pair.
6. Security: pushing a wake into a shell-capable session, and tainted inbound content →
   Opus 4.8 security review owns the rules; this note only fixes the "wake-word not
   body" foundation.
7. **Multi-session, same-identity dispatch (Karl, 2026-07-09).** Several live CLI
   sessions can share one identity (multiple Alden sessions, multiple claude-code
   sessions, …). Channels are **per-session processes** — every session spawns its own
   stdio channel instance — but the mailbox is **per-identity**, so N sessions configured
   as the same identity would ALL wake on the same message and could ALL reply
   (duplicate/competing answers). The spike does not solve this; nothing in the bus
   differentiates sessions. Interim rule until the dispatcher exists: **at most ONE
   channel-enabled session per identity at a time** (extra sessions of that identity run
   channel-off or wake-only); the tmux attach-or-create convention makes this structural
   per dev machine, and provisioning must enforce it across machines (only one DevMachine
   carries a given identity's channel config). Product answer: the **Autonomy Driver as
   the single dispatcher** — it alone watches the queue, keeps a registry of live
   sessions per identity, and assigns each message/thread to exactly one session
   (claim/lease + thread affinity). That also fixes a loop-detector blind spot: with two
   same-identity sessions, per-process detectors each see only half of a two-session
   ping-pong; a single dispatcher sees the whole thread. Verify at build time whether the
   bridge exposes thread ids (governance records cite "bus thread 5e4d8496", but
   `alden_mailbox_list` returns no thread field) — thread affinity needs one.

   **Household review outcome (bus thread 3f34ecad, 2026-07-10) — Q7 upgraded:**
   - The interim rule is now **fail-closed and harness-enforced**, not convention: the
     harness must refuse to enable a second channel for an identity that already has one
     (Cloud Alden's objection, seconded by Alden-1: "if the harness can't enforce it,
     the rule doesn't exist"). Two same-identity utterances that can disagree are an
     identity-coherence break, not noise.
   - It is also a **correctness requirement**, not just wake hygiene (alden-infra
     session, msg 1105): Alden Phase 0.2 mailbox cursors are keyed (consumer=identity
     slug, channel), so N same-identity sessions share ONE cursor and the second
     session's mail silently vanishes. Never relax the rule before the dispatcher lands.
   - The collision is **already live**: bus msgs 1095/1098/1099 (alden-infra session)
     and 1101 (this session) are all `sender=claude-code` — indistinguishable on the bus.
   - Thread ids: a real `thread_id` column + mailbox-tool exposure ships with Alden
     Phase 0.2 on **2026-07-12** — the dispatcher can assume it; build no workaround.
   - **WAKE-NOT-BODY is now a named invariant** (endorsed hard by both Aldens): the wake
     event never carries body content, even as a convenience — one exception and the
     taint pipeline has a bypass.
   - **Terminology (msg 1105 §6):** Alden D16 "channels" (conversation lanes over the
     mailbox) and this design's CLI "channel" (per-session wake mechanism) now collide.
     In household-facing docs call ours the **session wake relay** (implemented on the
     Claude Code channels API — the platform feature name is Anthropic's, not ours).

## References
- ADR-0005 (terminal modality), `docs/integration/alden-bridge.md` (mailbox),
  future-state Autonomy Driver + Oscillator, amendment A1, principle P7,
  `docs/2026-07-09-turnstone-bifrost-eval.md` (T2 idle-nudge borrow).
