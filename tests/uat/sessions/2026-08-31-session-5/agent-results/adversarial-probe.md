# Adversarial / Exploratory Probe — UAT Session 5

**Date:** 2026-08-31 · **Commit under test:** `8cd3ce5` · **Sources:** the audits filed this cycle —
`docs/security-audits/machines-sidebar-security-audit.md`, `.../session-waker-guardrails-security-audit.md`
(both single-auditor, recorded as such), plus the live probes and measurements taken while chasing
BUGS #43–#47.

**Verdict in one line: no SEV-1 or SEV-2 open anywhere; the two features under test are either pure
decision logic pinned by tests written first (waker) or native browser behaviour with our JS reduced
to memory-keeping (sidebar) — the remaining risk is entirely in what only a human at a browser can
see.**

## What was probed and what happened

| Probe | Result |
|---|---|
| Machine names in sidebar markup (`data-machine-group`, storage keys) | Registry allows only `^[A-Za-z0-9_][A-Za-z0-9._-]*$` and every interpolation is escaped; dotted names verified to get their own group and remembered state. |
| Collapsed machines dialling SSH at page load | Fixed before shipping: remembered state applies BEFORE the first dial, hidden groups are skipped, a group loads once on first unfold. |
| Waker: no allowlist configured | `WakerNotConfiguredError` thrown, nothing sent (XC-6 negative test). |
| Waker: reversed / mis-cased / malformed pairs | Denied or thrown at construction; no silent widening. |
| Waker: message body reaching a wake | Structurally impossible (`buildWake` reads only `id` and `sender`); canary test with four secret strings. |
| Waker: 200 senders × 500-character bodies | Briefing stays ≤ 400 chars, id range preserved. |
| Waker: mid-turn wake, burst of mail, failed send | Held; coalesced into ONE wake keeping the earliest `since_id`; a failed send stays held (`pending` = 1). |
| Terminal data path latency (measured live, VM → Mac-Mini) | 2 ms keystroke→echo; 5,000 lines = 173 frames / 29 KB in 35 ms. The server is not a bottleneck; the stutter was client-side rendering, fixed by the GPU renderer. |
| Deploy visibility | Every response carries `X-Pantheon-Build`; console HTML is `no-store`; asset URLs are build-versioned — a stale page can no longer masquerade as a failed deploy. |

## Open items for the human session to keep in mind

- **The Approvals inbox has still never seen a real ticket.** Alden's tickets live in the capability
  gateway's own Peta; the token that lets the inbox read it has not been handed over yet
  (`docs/handoffs/2026-08-28-prompt-for-alden-infra-approval-source.md`). If it is still not wired,
  Skip that scenario and say so — the inbox will simply say "Checked: Pantheon".
- UAT-4 #16/#19 were **not defects** — a `308` on those URLs only happens over `http://`. This
  session re-runs them over `https://` to close them properly.
- Feature 13 has **no user-visible surface**: it is stage 1 (decision logic). Nothing to click; its
  acceptance is the test suite plus ADR-0009. Stage 2 (the channel runner) gets its own UAT.
- Tracked, not regressions: BUGS #17, #24–#30, #34–#38, #40, #41.
