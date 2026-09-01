# ADR-0009 — Session waker: promotion to product, behind deterministic guardrails

**Status:** Accepted · 2026-08-31 (M1 task 4; implements TP-1 HIGH and the adopted half of TP-5,
ruled 2026-08-20). Supersedes nothing; the spike it promotes was built under the Ruling-C freeze
exception of 2026-07-09.

## Context

`prototypes/cli-channel-loop` proved end to end that a Claude Code **channel** (an MCP stdio server
the session spawns) can push an event into a running session, so an identity reacts to household
mail with nobody at the terminal. The spike is explicitly not product: no Build Loop, no cutline
item, promotion "requires its own ADR plus a recorded decision" (its README, and the APPROVAL_LOG
entry of 2026-07-09). The capability-gap rulings of 2026-08-20 then decided *how* it may become
product: **TP-1** (deterministic wake/relay guardrails — rate cap + deny-by-default allowlist),
**TP-5 partial** (light-context wake; the cadence-backoff lever REJECTED — "wake when needed,
period"), and **XC-6** (a fail-closed inbound-adapter allowlist, written into the Bible with a
negative test per adapter).

Two household invariants constrain the design and are not ours to relax: **WAKE-NOT-BODY** (a wake
carries sender names and ids, never message bodies — ratified by both full identities) and
**idle-only delivery** (a wake is delivered between turns, never mid-turn: it would break turn
integrity and bust the session's prompt cache).

## Decision

**1. The waker becomes product in stages, and this ADR records both.**

- **Stage 1 (this Build Loop, `session-waker-guardrails`):** the *decision layer* ships as product
  modules under `services/control-plane/src/waker/` — `allowlist.ts`, `rate-cap.ts`, `wake.ts`,
  `dispatcher.ts` — with the four behaviours the M1 plan names covered by tests written first.
  Nothing in stage 1 talks to Claude Code or the bridge: it is pure, deterministic and unit-testable.
- **Stage 2 (next loop):** the *runner* — the MCP channel server and the bridge mailbox poll from the
  spike — moves in and adopts these modules as its only path to dispatch. It is staged separately on
  purpose: the channel protocol is a **research preview** that "may change" (verified 2026-07-09) and
  the runner needs a live bridge token, so its acceptance is a live smoke test, not a unit test.
  Until stage 2 lands, `prototypes/cli-channel-loop` stays a spike and stays unused.

**2. Every wake passes one gate, in this order: configured → allowlisted → rate cap → idle.**

- **Configured (XC-6).** `WakeDispatcher.dispatch` throws `WakerNotConfiguredError` when no
  allowlist is configured. A missing config can never read as "allow everything"; the absence of a
  decision is not a permission.
- **Allowlisted (deny by default).** Pairs are explicit and **directional** — `a -> b` never implies
  `b -> a` — matched exactly, with no case folding. An empty list denies everything. A malformed
  entry throws at construction rather than being dropped, because a silently dropped entry changes
  the gate in a direction nobody chose. A batch containing any non-allowlisted sender is refused
  whole.
- **Rate cap (deterministic).** A per-pair sliding window of timestamps. No model call takes part in
  the decision — CC3: enforce at the gateway, never trust the model. A *denied* take is not counted,
  so a refused wake never deepens the hole it was refused from.
- **Idle.** An allowed wake that arrives mid-turn is **held**, not dropped, and delivered on the next
  flush when the session is idle. Everything held during one busy turn coalesces into a **single**
  wake: a burst of mail is one interruption, not twenty. A send failure leaves the batch held — a
  wake is never lost to a broken channel.

**3. The wake payload is a light briefing and nothing more (WAKE-NOT-BODY, TP-5).** It carries the
count, the sender names (capped at five, then "and N more"), the id range, and an instruction to
fetch the messages through the session's own gated mailbox tool with `since_id`, treating their
content as untrusted. It is capped at 400 characters. Bodies stay behind the governed tool, where
they are logged and taint-labelled.

**4. Cadence-backoff-on-subscription is NOT implemented** (TP-5 ruling). The rate cap is the only
throttle; it is deterministic and per-pair.

## Consequences

- The guardrails are testable without a session, a bridge, or a network: 16 tests cover the window
  boundary and cooldown, per-pair isolation, empty-allowlist denial, direction, malformed config,
  the no-body canary, the light-briefing budget, hold/flush/coalesce, rate limiting, and the
  send-failure hold.
- The runner cannot be built "just a bit differently": stage 2 has exactly one way to dispatch.
- XC-6 becomes a Bible sentence (§7) with this dispatcher as its first negative test, so the next
  inbound adapter inherits the rule rather than re-deciding it.
- The spike stays on disk, unused and labelled, until stage 2 consumes it.

## Alternatives considered

- **Promote the spike wholesale now.** Rejected: it would ship a research-preview protocol and a
  live-bridge dependency in the same step as the safety rules, with no unit-testable core — the
  guardrails would be validated only by a live run.
- **Let the model decide whether a wake is warranted.** Rejected by CC3 and by TP-1's wording
  ("deterministic"): an admissibility decision that can be argued with is not a control.
- **Drop mid-turn wakes instead of holding them.** Rejected: silent loss is worse than a delayed
  nudge, and holding is what makes coalescing possible.
