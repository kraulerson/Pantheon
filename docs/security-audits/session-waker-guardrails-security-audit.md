# Security Audit — Session waker: deterministic guardrails (M1 task 4, stage 1)

**Feature:** `session-waker-guardrails` — the decision layer of the session waker as product
(`services/control-plane/src/waker/{allowlist,rate-cap,wake,dispatcher}.ts`), implementing TP-1
(deterministic rate cap + deny-by-default allowlist), the adopted half of TP-5 (light-context wake)
and XC-6 (fail-closed inbound adapter). ADR-0009.
**Date:** 2026-08-31
**Persona:** Senior Security Engineer (Phase 2.4), single-auditor review of a pure, dependency-free
module set with no network, filesystem, HTTP or process surface. **Method note:** parallel
independent auditors were not spawned for this one — the code is ~200 lines of pure decision logic
whose entire behaviour is pinned by 16 tests written before it, and it is not yet reachable from any
running surface (stage 2 wires the runner). That reduced scrutiny is recorded here rather than
implied, and stage 2 — which brings a research-preview protocol and a live bridge token — gets the
full parallel treatment.
**Scope refs:** ADR-0009; capability rulings TP-1 / TP-5 / XC-6 (APPROVAL_LOG 2026-08-20);
WAKE-NOT-BODY (household invariant, bus 1101–1107); CC2 (fail closed), CC3 (enforce at the gateway,
never trust the model); D8; PROJECT_BIBLE §7 (XC-6 sentence added by this feature).

## Headline

**The gate is fail-closed at every step and no admissibility decision touches a model.** The one
finding of substance was a design question rather than a defect — whether a refused wake should
consume rate budget — and it is answered in the code and pinned by a test (it must not). 0 SEV-1,
0 SEV-2, 2 SEV-3 (both fixed in the design before implementation), 3 SEV-4 (2 fixed, 1 accepted).
Suite 671 passed / 5 skips (+16), `tsc` + `eslint` clean.

## Threats considered

| # | Threat | Control | Verdict |
|---|---|---|---|
| 1 | **A missing config reads as "allow everything"** — the classic inbound-adapter failure XC-6 exists to prevent. | `dispatch` throws `WakerNotConfiguredError` while `allowlist.isConfigured` is false; `isConfigured` is false for an empty list. Negative test asserts the throw AND that nothing was sent. | **PASS** |
| 2 | **Allowlist laundering** — reversed direction, case folding, whitespace, a malformed entry silently widening or narrowing the gate. | Pairs are matched exactly on `sender + " " + recipient`; slugs must match `^[a-z0-9][a-z0-9._-]{0,63}$`; a malformed entry throws at construction. Tests cover direction, case, and three malformed shapes. | **PASS** |
| 3 | **A mixed batch smuggling a non-allowlisted sender** behind an allowlisted one. | The batch is refused whole if ANY message's sender is not allowlisted, and the refusal names the offending pair. | **PASS** |
| 4 | **Rate-cap starvation across pairs** — one chatty pair silencing another. | Windows are per pair; test asserts a pair at its limit does not affect another. | **PASS** |
| 5 | **A refused wake deepening its own hole** (a denied take consuming budget would let a spammer keep a pair permanently muted). | A denied take is not recorded. **SEV-3, fixed in design**; pinned by the boundary/cooldown tests. | **FIXED** |
| 6 | **Wake carrying a message body** (WAKE-NOT-BODY; D8). | `buildWake` reads only `id` and `sender` off each message — a body cannot reach the payload even if present on the object. Canary test asserts four distinct secret strings never appear in content or meta. | **PASS** |
| 7 | **Wake as a context-flood vector** — a huge batch or hostile sender list ballooning the briefing. | Senders capped at five names then "and N more"; the whole briefing capped at `MAX_WAKE_CHARS` (400) with truncation as a backstop; test floods 200 senders with 500-character bodies and asserts the cap holds and the id range survives. | **PASS** |
| 8 | **Mid-turn delivery** breaking turn integrity / busting the prompt cache. | Delivery only when `isIdle()`; otherwise held. Tests: held while busy, delivered on flush when idle. | **PASS** |
| 9 | **Lost wakes** — a dropped batch on a busy session or a broken channel. | Held batches survive both; a failed `send` leaves the batch held (`pending` still 1) for the next flush. | **PASS** |
| 10 | **Interruption storm** — twenty messages becoming twenty turns. | Everything held in one busy turn coalesces into ONE wake; the held `sinceId` keeps the EARLIEST value so the session's own fetch still covers the whole run. **SEV-3 (an off-by-one here would silently skip mail), fixed in design**, pinned by the coalescing test. | **FIXED** |
| 11 | **A model talking its way past the gate** (CC3). | No model call participates: the allowlist is a set lookup, the cap is timestamp arithmetic, idleness is a caller-supplied predicate. The spike's llm-mini loop judge is NOT part of this layer. | **PASS** |
| 12 | **Reachability of unfinished code.** | Nothing imports `src/waker/` yet; stage 2 wires the runner. No HTTP route, no service wiring, no config parsing added by this feature. | **PASS** |

## Findings

- **SEV-3 (fixed):** a denied rate-cap take must not be counted — otherwise a spammer holds a pair
  down indefinitely. Implemented and tested.
- **SEV-3 (fixed):** coalescing must keep the earliest `sinceId`, or a held run of mail would be
  skipped by the session's fetch. Implemented and tested.
- **SEV-4 (fixed):** pair labels are ASCII (`a->b`) rather than a Unicode arrow, so they survive
  logs, tests and shells unmangled.
- **SEV-4 (fixed):** `SlidingWindowCap` validates `limit`/`windowMs` at construction — a zero or
  fractional window would have made the cap meaningless rather than loud.
- **SEV-4 (accepted):** the cap keeps timestamps in memory per pair with no eviction of idle pairs.
  Bounded in practice by the household's identity count (single digits) and by the runner's lifetime;
  revisit if the waker ever serves an open set of senders.

## Residual for stage 2 (not this feature)

The runner brings what this layer deliberately excludes: a **research-preview** channel protocol
that may change, a live bridge token, the `--dangerously-load-development-channels` flag (LAN-only,
already recorded in the design doc), and the loop-safety judge. Those get the full parallel audit,
a live smoke test, and their own acceptance — this audit does not cover them.
