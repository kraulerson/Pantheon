# Harness Capability-Gap Study — OpenClaw · Odysseus · Hermes Agent · dsh residue

> **Status (2026-08-20): STUDY — NOT RATIFIED.** Nothing in this document is adopted.
> Every suggestion is a proposal awaiting Karl's ruling (same protocol as
> `dsh-decision-proposals.md`: each is answerable yes / no / amend). The walking-skeleton
> feature freeze (Ruling C) is in effect; no suggestion here overrides it — items marked
> *skeleton-relevant* are flagged for the ruling, not acted on. Not committed; working
> tree only.

**Commissioned:** operator request, 2026-08-19/20 — evaluate four harnesses for
capabilities Pantheon lacks and should consider adopting, using the ratified four-part
adopt/build test (orthogonal-to-identity · fully-auditable · firewall-able ·
cheaper-to-audit-than-build) from `docs/2026-07-09-turnstone-bifrost-eval.md`.
**Context that shapes every priority:** the operator has re-scoped so the **terminal
plane ships first**. His primary workflow is Claude Code CLI on a **Claude Max 20x
subscription**, over SSH + tmux to dev machines — the one workflow no other harness
preserves. Any suggestion that would force him off the Max subscription, or that only
benefits the chat plane, is discounted accordingly and says so.

**Method (summary; details + could-not-verify at the end):**
- **Pantheon baseline** read directly: `PRODUCT_MANIFESTO.md` §2 (17 MVP requirements,
  CC1–CC3, Will-Not-Have), `PROJECT_BIBLE.md` (ADR-0001/0003/0004/0005/0006/0007, §5,
  §9 C.1–C.8), `docs/2026-07-09-turnstone-bifrost-eval.md`, `docs/research/dsh-pattern-map.md`
  + `dsh-decision-proposals.md` (P1–P9 RATIFIED — not re-litigated), `FEATURES.md`,
  `BUGS.md`, `docs/walking-skeleton-milestone.md`, `docs/user-guide.html`,
  `docs/2026-07-09-cli-comms-autonomy-design.md`, `prototypes/cli-channel-loop/README.md`,
  `docs/2026-07-02-landscape-revalidation.md`, `APPROVAL_LOG.md`.
- **Hermes Agent** explored live on LXC 1094 (`pct exec 1094 … su - hermes`), read-only:
  `hermes --help` for ~30 subcommands, `SECURITY.md` in full, selected module docstrings,
  LOC counts. No config changed, no secrets read, agent never run.
- **OpenClaw** and **Odysseus** researched by dedicated agents against primary sources
  (docs.openclaw.ai incl. sitemap sweep; the actual Odysseus repo cloned and audited at
  commit `b4d1293`). Their citations are reproduced here; I did not independently
  re-fetch every URL — flagged in the verification notes.
- **dsh residue** — the sub-agent tasked with enumerating what the ratified dsh study
  did NOT cover **did not return** before deadline. That section is explicitly marked
  incomplete; it lists what would have been checked. Nothing in it is asserted.

**Current-state correction folded in (2026-08-20):** the Obsidian MCP server **is
built** and passing its 24 tests on the operator's Mac (it is not yet deployed to
VM 1093), so this study treats it as built-but-undeployed. Its `src/server.ts` — the
HTTP transport that enforces vault confinement — currently has **zero test coverage**;
XC-2 below picks that up as a concrete negative-check target.

---

## Executive verdicts (system level)

| System | Verdict as a system | One-line reason | Pattern harvest |
|---|---|---|---|
| **OpenClaw** (MIT, OpenClaw Foundation; 386k★; ~81k commits; **2,299 commits in the last 7 days**; ~304 MB source, 90% TS) | **REJECT as adoption** | Its own threat model: prompt-injection-only chains are out-of-scope for vuln reports, adaptive attackers ">80%" ASR, tokens plaintext on disk, skills/plugins run in-process unsandboxed; velocity alone makes it un-auditable; its agent loop replaces Claude Code | **Richest quarry of the four** — deterministic wake/loop/allowlist/approval mechanics (TP-1/2/5/6, XC-5) |
| **Odysseus** (**AGPL-3.0**, not MIT as briefed; odysseus-dev/odysseus, moved from pewdiepie-archdaemon; 85.8k★; 2,073 commits in <3 months; no releases; FastAPI+SQLite monolith) | **REJECT as adoption** | One Python process is tools + policy + secrets in one trust domain; no sandbox (its own THREAT_MODEL says so); AGPL friction; churn without releases | **Closest independent convergence with Pantheon's core design** (server-side taint-armed approval gate) + 3 concrete borrows (TP-3, XC-1, XC-4) |
| **Hermes Agent** (MIT, Nous Research; measured locally: ~1.33M LOC Python + ~263k LOC TS; v0.18.0 on LXC 1094) | **REJECT as adoption — this study is the four-part test the 2026-07-09 eval left FROZEN** (verdict table below) | SECURITY.md, verbatim: "The only security boundary against an adversarial LLM is the operating system… not the approval gate… not any tool allowlist"; approval gate includes an auxiliary-LLM auto-approver (CC3 inversion); 1.6M LOC fails audit economics decisively | Task board, session search, checkpoints, doctor/insights/prompt-size legibility suite (TP-4, TP-7, XC-2) |
| **deepseek-harness** | Already studied; P1–P9 ratified | — | Residue check **incomplete** (sub-agent did not return; see §dsh residue) |

The 2026-07-02 landscape conclusion **survives all four**: nobody ships Pantheon's
composition (out-of-process durable gateway HITL × taint-by-presence × trust-labeled
inspector × identity-as-security-principal). Odysseus is now the closest anyone has
come to the *taint-armed gate* half — in-process, but genuinely server-side and
model-distrusting. That is validation, not competition.

### Hermes Agent — the frozen four-part test, now executed

`docs/2026-07-09-turnstone-bifrost-eval.md` lists Hermes as candidate #3, FROZEN,
"must pass the same four-part test before any adoption discussion." Executed here
against the live install on LXC 1094:

| Part | Verdict | Evidence |
|---|---|---|
| Orthogonal to identity | **FAIL** | Profiles/personalities/memory are its own identity system (MEMORY.md/USER.md per profile, `/personality`, profile distributions) — overlaps, does not compose with, per-identity Peta users/Qdrant/Gitea |
| Fully auditable | **FAIL** | ~1.33M LOC Python + ~263k LOC TS measured on the box (excl. venv/node_modules); plugin/skill/hook code imports into the agent interpreter with full privileges (SECURITY.md §2.5) |
| Firewall-able | **PARTIAL** | Gateway/dashboard bind loopback and the June-2026 hardening removed the auth bypass; but tools, approvals, and credentials cohabit one process — the thing to firewall is the process itself |
| Cheaper to audit than build | **FAIL** | The features Pantheon would want from it (board, search, notify) are each < 1 week to build in the control plane |

**Recommended ruling: Hermes REJECTED as adoption; FROZEN status closed; registered as
pattern quarry** (entries below). Its SECURITY.md is doctrinally honest — it states the
in-process-heuristics-are-not-boundaries position outright — which makes it the same
class of rejection as Turnstone, at 7× the size.

---

# Suggestions — Terminal plane (highest value now)

### TP-1 — Deterministic wake/relay guardrails for the session waker (HIGH)

1. **What / who has it:** OpenClaw ships three deterministic mechanics around
   agent-to-agent traffic: **bot-loop protection** (sliding-window budget per bot pair —
   20 events / 60 s / 60 s cooldown, "enforced by the core inbound reply runner",
   https://docs.openclaw.ai/channels/bot-loop-protection); **agentToAgent default-closed
   allowlist** ("No agent can message another without enablement and allowlisting — both
   are off by default", https://docs.openclaw.ai/concepts/multi-agent); and **push-based
   child completion with bounded retry** (completion announced to the parent, "retries
   for up to 30 minutes", blocked results kept 7 days,
   https://docs.openclaw.ai/tools/subagents). Hermes independently converges on the
   delivery invariant: background-delegation completions "surface as a NEW turn when the
   agent is idle, never spliced between a tool result and an assistant message …
   never mutate past context" (`tools/async_delegation.py` docstring, LXC 1094).
2. **Why Pantheon might want it:** the session-waker spike (`prototypes/cli-channel-loop`)
   and its promotion ADR are the terminal plane's next comms step
   (`docs/2026-07-09-cli-comms-autonomy-design.md`). Karl's loop-safety design is an
   LLM progress-judge plus absolute backstops; OpenClaw's per-pair sliding-window budget
   is a *deterministic* complement that needs no model call and catches fast ping-pong
   before the judge arms. The allowlist shape matches the waker's existing
   `ALLOWED_SENDERS` (empty = deny all) and should survive promotion as config, not
   convention. The "new turn only when idle" rule protects prompt-cache integrity on the
   Max subscription — cache-busting wakes cost real quota.
3. **Four-part test:** Orthogonal-to-identity **PASS** (wake policy/transport, no
   identity semantics — identities stay bus participants). Fully-auditable **PASS**
   (small pure logic in our own waker/control-plane code). Firewall-able **PASS** (no
   new network surface; lives inside the waker). Cheaper-to-audit-than-build **PASS**
   (borrowed as pattern into code we write; nothing external to audit).
4. **Doctrine conflicts:** none. Note the inverse borrow: OpenClaw's wake **carries the
   message content**; Pantheon's WAKE-NOT-BODY named invariant stands — take the budget
   and allowlist mechanics, never the payload shape.
5. **Effort:** days (loop-detector extension + config + tests), inside the waker
   promotion work. Post-skeleton.
6. **Priority:** HIGH — terminal-plane comms is the operator's declared next want.
7. **TL;DR:** When the auto-relay that lets your terminal AI talk to the other AIs gets
   built for real, add two cheap circuit breakers copied from OpenClaw: a hard cap on
   how fast any two AIs may ping-pong (no judgment needed, it just counts), and a rule
   that nobody can message anybody unless both names are on a list you wrote. Also keep
   deliveries to moments when the AI is between thoughts — it saves real money on your
   subscription.

### TP-2 — Approval-pending push notification (notify-only, never resolve) (HIGH)

1. **What / who has it:** OpenClaw broadcasts `exec.approval.requested` to operator
   clients and forwards prompts into chat channels; expiry (30-min default) "is surfaced
   as a terminal host-command denial" and the session is resumed "with an internal
   followup so the agent observes that the command did not run"
   (https://docs.openclaw.ai/tools/exec-approvals). Hermes prompts approvals
   asynchronously through its messaging gateway (`tools/approval.py` docstring:
   "Approval prompting (CLI interactive + gateway async)", LXC 1094). Odysseus bundles
   **ntfy** for reminder pushes (docker-compose, 127.0.0.1-bound).
2. **Why Pantheon might want it:** D4's out-of-band gate is durable but **silent** — the
   operator must have the admin page open to know a write is waiting. TM-014 (approval
   fatigue/latency) is the named risk. While Karl works in tmux, a pending Peta approval
   should ping him where he already is (household bus → his Telegram, or a LAN ntfy).
   The notification carries a **reference only** ("approval #N pending — identity X,
   tool Y") — no arguments, no diff — and resolution happens exactly where it does
   today, on the D6 step-up admin surface. Second borrow, same entry: on approval
   **expiry**, the session should receive an explicit observable denial event (OpenClaw's
   "the agent observes that the command did not run") rather than a hang — verify Peta's
   `-32602` path surfaces this through the Facade and add the test.
3. **Four-part test:** Orthogonal **PASS** (notification plumbing). Auditable **PASS**
   (a send-only hook on ApprovalRecord creation). Firewall-able **PASS** (outbound one-way
   to an existing LAN channel; no inbound path added). Cheaper-to-audit **PASS**
   (days of our own code; the bridge/`ntfy` transport already exists in the household).
4. **Doctrine conflicts:** none as specified. The conflicting variant — **resolving**
   approvals from chat (OpenClaw's allow-once/always reactions, Hermes' gateway
   approvals) — violates D4 (display-the-proposed-write) and D6 (step-up tier) and is on
   the do-not-adopt list. D8: the push must never carry arguments or recalled content.
5. **Effort:** days. Touches control-plane approval polling + one outbound notifier.
   Post-skeleton (C.3 surface must exist first).
6. **Priority:** HIGH — it makes the write gate livable from the terminal plane, which
   is where the operator actually sits.
7. **TL;DR:** Right now, when the system holds a risky write for your OK, nothing tells
   you it's waiting — you'd have to go look. Add a doorbell: a short message to your
   phone or chat saying "something's waiting for approval," with no details in the
   message itself. You still walk to the same secure page to read the details and press
   Approve or Deny. And if you never answer, the AI is explicitly told "that didn't
   run" instead of being left guessing.

### TP-3 — Scoped machine tokens: a narrow, deny-by-default API door for CLI sessions (HIGH)

1. **What / who has it:** Odysseus ships a Claude Code integration as a skill bundle +
   scoped REST API: tokens minted in the admin UI carry explicit scopes (`chat`,
   `todos:read/write`, `documents:read/write`, `email:read/draft/send`, `calendar:read/write`,
   `memory:read/write`, `cookbook:read/launch`) and "every tool surface is checked
   server-side… even if Claude tries to call a forbidden endpoint, it gets 403 until the
   user enables the matching toggle" (`integrations/claude/README.md`,
   `routes/api_token_routes.py:15-30`, github.com/odysseus-dev/odysseus). OpenClaw has
   the same shape as **operator scopes** (`operator.admin/approvals/pairing/read/…`,
   https://docs.openclaw.ai/gateway/operator-scopes).
2. **Why Pantheon might want it:** the operator's Claude Code sessions are the PRIMARY
   plane, and today the harness offers them nothing: the only machine door is the
   all-powerful admin bearer token. `docs/machine-auth-design.md` (skeleton item 9,
   done) already designs the Facade service principal for the Autonomy Driver; this
   extends the same idea to *operator-side* CLI sessions with read/propose scopes:
   `usage:read` (his R18 ledger totals from inside tmux), `approvals:read` (pending
   list, reference-only), `sessions:read`. Never a config-write scope.
3. **Four-part test:** Orthogonal **PASS** (authn/authz plumbing; identities untouched).
   Auditable **PASS** (a token table + a per-route scope guard in our Fastify code).
   Firewall-able **PASS** (admin-service routes, LAN-only, deny-by-default).
   Cheaper-to-audit **PASS** (pattern lift; ~a week of our code).
4. **Doctrine conflicts:** touches TM-011 ("management never from a session") — resolved
   by construction: no management scope exists; scopes are read/propose only; minting
   happens on the D6 admin surface. A CLI session holding a scoped token remains outside
   the grounding pipeline (ADR-0005), which is fine because the token grants no writes.
5. **Effort:** ~1 week (token store, scope guard, 3 read endpoints, tests). Post-skeleton;
   builds directly on the machine-auth design note.
6. **Priority:** HIGH under terminal-first — it's the first feature that makes the
   harness *useful to* the CLI workflow rather than merely hosting it.
7. **TL;DR:** Give your terminal AI sessions a very limited keycard to the harness: they
   could ask "how much have we spent today?" or "is anything waiting for approval?" —
   and nothing else. Each permission is a separate switch you turn on, everything is
   checked on the server, and there is deliberately no switch that lets a session change
   settings. Odysseus proved this exact shape works with Claude Code.

### TP-4 — Durable cross-project task board (kanban), pattern-build only (MEDIUM)

1. **What / who has it:** Hermes: `hermes kanban --help` on LXC 1094 — durable
   SQLite board shared across profiles; atomic `claim`; task dependencies (`link`);
   `swarm` (parallel workers → verifier → synthesizer); dispatcher; per-task worker
   logs, attempt history (`runs`), heartbeats; `project bind-board` yields "a
   deterministic worktree + branch convention"; single-dispatcher posture documented
   (`docs/kanban/multi-gateway.md`). Spec: hermes-agent.nousresearch.com/docs/user-guide/features/kanban.
   OpenClaw has adjacent surfaces (TaskFlow/Workboard, https://docs.openclaw.ai/automation/taskflow).
2. **Why Pantheon might want it:** the operator runs many projects in tmux with nothing
   tracking cross-session work — which task is claimed by which session, what's blocked,
   what finished. A *small* board in the control plane (admin surface, SQLite,
   text-labeled states) would give the terminal plane a shared work ledger, and its
   claim/lease semantics are the same shape as the ratified P5 residency/lease model —
   the future dispatcher could reuse it. To be plain: **this is new scope above the MVP
   cutline** — it needs an Orchestrator ruling and waits for the freeze to lift.
3. **Four-part test:** Orthogonal **PASS** (coordination data; identities appear only as
   assignee labels). Auditable **PASS if built** (a table + state machine in our stack) /
   **FAIL if adopted** (Hermes is 1.6M LOC). Firewall-able **PASS** (admin surface,
   LAN). Cheaper-to-audit-than-build **FAIL for adoption, PASS as pattern** — the exact
   Turnstone outcome: take the schema, not the system.
4. **Doctrine conflicts:** none doctrinally; scope-discipline conflict only (Manifesto
   rule 2 — needs explicit approval to move above the line).
5. **Effort:** 1–2 weeks for a minimal board (create/claim/complete/block + board page);
   dispatcher integration later with the Autonomy Driver.
6. **Priority:** MEDIUM — genuinely useful to the real workflow, but new scope while
   ratified scope is unshipped.
7. **TL;DR:** A shared to-do board for all your projects, living inside the harness: every
   task shows who (which session) claimed it, what it's waiting on, and what happened.
   Hermes proves the design works; we'd build our own small version rather than import
   their huge system. This is extra scope — it needs your explicit go-ahead and waits
   until the current build milestone is done.

### TP-5 — Wake-cost levers: isolated wake sessions + light context + cadence backoff (MEDIUM)

1. **What / who has it:** OpenClaw heartbeat — default 30-min cadence that "extends to
   1 hour when Anthropic OAuth/token auth is configured" (an explicit
   subscription-quota concession); cost levers `isolatedSession: true` ("~100K tokens
   down to ~2-5K per run") and `lightContext: true`
   (https://docs.openclaw.ai/gateway/heartbeat). Cron jobs run in isolated
   `cron:<jobId>` sessions by default (https://docs.openclaw.ai/automation/cron-jobs).
2. **Why Pantheon might want it:** every unattended wake of a Claude Code session is a
   paid turn drawing Max-plan quota. The R18 ledger already classifies `trigger:
   interactive|wake|quiet_loop|consolidation` — OpenClaw is field evidence for the
   *controls* that belong on top: wake into minimal context where possible, and back off
   cadence on subscription auth. Design input to the waker promotion and Autonomy
   Driver budget governance (R6), not a component.
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS** (config + waker logic).
   Firewall-able **PASS**. Cheaper-to-audit **PASS** (design borrow only).
4. **Doctrine conflicts:** none; it operationalizes the R18/R6 budget doctrine on the
   plane where the budget is subscription quota rather than dollars.
5. **Effort:** days, folded into waker promotion.
6. **Priority:** MEDIUM (rises to HIGH the day unattended wakes go live).
7. **TL;DR:** Every time the system wakes your terminal AI while you're away, it costs
   part of your monthly plan. Copy OpenClaw's tricks: wake it with a small briefing
   instead of the whole conversation history, and wake it less often when it's running
   on your subscription. Your cost tracker already labels these wake-ups; this adds the
   knobs that keep them cheap.

### TP-6 — Claude Max quota visibility in the harness (MEDIUM, feasibility UNKNOWN)

1. **What / who has it:** OpenClaw polls provider quota APIs directly (Anthropic
   OAuth/web sessions among them) and normalizes to "X% left"; it is explicit that
   "Sessions billed through a plan hide per-token dollar estimates"
   (https://docs.openclaw.ai/concepts/usage-tracking).
2. **Why Pantheon might want it:** the terminal plane's real budget is the Max 20x
   quota window, which R18 cannot see (it meters API brains). A small "plan window:
   ~N% left, resets HH:MM" text indicator near the terminal tabs would let the operator
   schedule heavy work sanely. **Honest caveat:** this rides undocumented/unstable
   Anthropic surfaces; Claude Code's own `/status` already shows it in-session. Verify
   feasibility before committing; treat as fragile convenience, never as an enforcement
   input.
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS** (tiny poller).
   Firewall-able **PASS** (outbound-only read). Cheaper-to-audit **UNKNOWN** — the
   upstream surface is unofficial and may churn or break silently.
4. **Doctrine conflicts:** none if read-only and content-free; must not become a second
   accounting authority (P4 — it displays a provider-reported number, it never writes
   the ledger). ToS caution: read-only status polling of the operator's own account is
   low-risk but sits near the subscription-misuse line — do not extend it to routing.
5. **Effort:** days; fragile maintenance tail.
6. **Priority:** MEDIUM — nice on the primary plane, but Claude Code already shows it.
7. **TL;DR:** Show, next to your terminal tabs, roughly how much of your Claude monthly
   allowance is left and when it refills — the same number you can already see by
   typing a command inside Claude. Worth having only if it can be read reliably; it's a
   convenience gauge, never something the system depends on.

### TP-7 — Durable terminal transcripts + search (LOW — real conflicts, listed for completeness)

1. **What / who has it:** Hermes keeps every session in SQLite with an FTS5 index and
   ships a three-mode zero-LLM recall tool (discovery/scroll/browse with ±5-message
   windows and session "bookends") — `hermes sessions --help`,
   `tools/session_search_tool.py` (LXC 1094).
2. **Why Pantheon might want it:** terminal tabs currently keep only bounded scrollback
   (Feature 3); nothing of a CLI session survives for later recall, while every chat
   session is searchable (#4). Post-incident reconstruction of TM-020 (what ran in the
   terminal) has audit value.
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS**. Firewall-able **PASS**.
   Cheaper-to-audit **PASS** (small recorder + FTS in our stack).
4. **Doctrine conflicts:** real ones, stated plainly: (a) D8 — terminal streams can
   carry secrets the operator types or cats; recording them creates a new secret store
   the design promised not to have; (b) ADR-0005 deliberately keeps CLI sessions outside
   the harness's data pipeline; (c) tmux already gives the operator history where he
   works. If ever built: off by default, per-tab opt-in, redaction pass, and its own
   ruling.
5. **Effort:** ~1 week + the redaction problem, which is the actual cost.
6. **Priority:** LOW.
7. **TL;DR:** We could record and index everything that scrolls past in your terminal
   tabs so you could search it later — but terminals routinely display passwords and
   keys, so the recording itself becomes a security risk. tmux already remembers enough
   for daily use. Listed so you know the option exists; recommendation is to skip it.

---

# Suggestions — Chat plane (secondary)

### CH-1 — Group-conversation mechanics for requirement #7 (MEDIUM)

1. **What / who has it:** Odysseus group chat — up to 8 participants, each a persona on
   **its own model + endpoint**; hidden per-participant backend sessions; replies
   cross-injected into the other participants' sessions prefixed `[Name]:`; round-robin
   order re-shuffled per user message; an injected "group etiquette" prompt
   (`static/js/group.js`, `routes/session_routes.py:541`). OpenClaw contributes the
   inbound-gating half: group allowlists, mention gating, and "lurk mode"
   (https://docs.openclaw.ai/channels/groups).
2. **Why Pantheon might want it:** #6/#7 (mailbox + group conversation via proxied
   bridge tools) is above the cutline, and C.8 (channel picker) is ratified
   post-skeleton design. Odysseus supplies working turn-taking/UX mechanics; Pantheon's
   *substrate* stays the append-only bridge mailbox with per-identity provenance —
   stronger than Odysseus's client-side injection, which loses authorship control.
3. **Four-part test:** Orthogonal **PASS** (UX/turn-taking only; identity binding stays
   structural). Auditable **PASS** (design borrow into C.8 build). Firewall-able
   **PASS** (all traffic stays bridge-mediated behind Peta). Cheaper-to-audit **PASS**.
4. **Doctrine conflicts:** adopt the *presentation*, not the topology — Odysseus
   orchestrates group turns in browser JS and injects messages as user-role content;
   in Pantheon every cross-identity utterance must remain a bus message (`trusted:false`
   on recall, send-type = write, D2). Round-robin fairness and etiquette-prompt are
   clean; client-side authority is not.
5. **Effort:** design input now; applies when C.8/group surface builds (M).
6. **Priority:** MEDIUM (chat plane, post-skeleton, but it serves a ratified MVP
   requirement rather than new scope).
7. **TL;DR:** For the planned "several AIs in one conversation" feature, borrow the
   working etiquette from PewDiePie's app: take turns in a shuffled order, address each
   other by name, see each other's replies. But keep our rule that every message travels
   through the household post office (which records who really said what) — not through
   the browser page, where authorship could be faked.

### CH-2 — Context compaction policy for the Facade (MEDIUM)

1. **What / who has it:** OpenClaw auto-compaction: summarize older turns near the
   context limit (and once more on overflow, then retry), "tool-call pairs never
   split," summary persisted to the transcript, `keepRecentTokens` (default 20k),
   optional cheaper `compaction.model`, and a pre-compaction "memory flush"
   (https://docs.openclaw.ai/concepts/compaction). Hermes has `/compress` +
   `trajectory_compressor.py`. (dsh's `surfaceOp`/`sourceEventSeqs` audit shape is
   already ratified as P1.)
2. **Why Pantheon might want it:** local brains have small contexts; long grounded
   sessions will overflow. P1 gives the audit-preserving *log* shape for compaction;
   OpenClaw supplies the operational *policy* (when to trigger, what to never split,
   how much recency to keep).
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS** (control-plane logic +
   P1 events). Firewall-able **PASS**. Cheaper-to-audit **PASS**.
4. **Doctrine conflicts:** one hard requirement, not a conflict: a compaction summary is
   **model-generated content re-entering context → it is `trusted:false` by
   definition** and must be tagged and inspectable like any recalled block (C.2). A
   summary that silently laundered tainted content into a "clean" session would be a
   taint bypass — the D5 sticky-taint rule already prevents this (the session stays
   tainted), keep it that way.
5. **Effort:** 1–2 weeks, post-skeleton, inside the Facade.
6. **Priority:** MEDIUM.
7. **TL;DR:** When a conversation gets too long for a model's memory, the system should
   fold the oldest parts into a short summary and keep going — keeping the newest parts
   word-for-word and never cutting a question off from its answer. One safety rule:
   the summary is machine-written text, so it keeps the same "not fully trusted" label
   as everything else the machine wrote, and you can always open it and read it.

### CH-3 — Usage insights view over the UsageEvent ledger (MEDIUM-LOW; one skeleton-relevant sub-item)

1. **What / who has it:** Hermes `insights` (token usage, costs, tool patterns, trends,
   `--days`, per-platform — LXC 1094); OpenClaw `/usage` footers + cache-token
   accounting (https://docs.openclaw.ai/concepts/usage-tracking); Odysseus shows
   per-message input/output tokens + tok/s client-side.
2. **Why Pantheon might want it:** the R18 ledger (skeleton item 6) is write-only until
   something reads it. A small admin-page view — per-identity, per-brain, per-trigger
   totals over N days — turns the ledger into the operator's cost instrument.
   **Skeleton-relevant sub-item, tiny:** Odysseus's `_normalize_usage_counts()`
   (`src/llm_core.py`) sanitizes provider-reported token fields before use; step-06
   should do the same at the ledger door (type-check, non-negative, missing → null,
   never silently zero) — hours, and it hardens a charter item already being built.
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS** (read-only view over our
   own table). Firewall-able **PASS** (admin surface). Cheaper-to-audit **PASS**.
4. **Doctrine conflicts:** none. P4 preserved — it reads the single ledger, computes
   nothing new authoritative. No content ever displayed (the ledger has none, by
   schema invariant).
5. **Effort:** days (view); hours (sanitizer).
6. **Priority:** MEDIUM-LOW for the view; the sanitizer should ride step-06 now if the
   ruling allows.
7. **TL;DR:** The cost meter being built writes every AI call into a ledger; add the
   page that reads it back — "what did each identity spend this week, and how much of
   it was unattended background activity?" And when the meter is built this week, make
   it double-check the numbers the AI providers report before writing them down, so a
   glitchy provider can't corrupt the books.

### CH-4 — Model comparison: blind A/B and mixture-of-agents (LOW)

1. **What / who has it:** Odysseus Compare — two side-by-side sessions, **blind by
   default with the left/right→model mapping held server-side** so the browser can't
   defeat blinding; owner-scoped endpoint resolution so one user can't spend another's
   key (`routes/compare/compare_routes.py`). Hermes `/moa` fans one prompt across
   configured model slots and synthesizes (`hermes moa --help`).
2. **Why Pantheon might want it:** the household runs multiple brains (122B, 27B,
   future cloud); picking per task is currently vibes. Reads-only, no writes involved.
3. **Four-part test:** Orthogonal **PASS** — with one caveat: comparisons must run as
   *bare/no-identity sessions* or the same identity on both sides; fanning one
   identity's grounded context to a brain it is not bound to would cross #14a.
   Auditable **PASS**. Firewall-able **PASS**. Cheaper-to-audit **PASS** (small
   Facade feature).
4. **Doctrine conflicts:** the #14a caveat above; also below the cutline — new scope
   needing a ruling. Grounded/tainted content must not be sent to a backend the
   identity isn't bound to; simplest rule: Compare only exists for ungrounded bare
   sessions.
5. **Effort:** ~1 week.
6. **Priority:** LOW (chat-plane nice-to-have).
7. **TL;DR:** A "taste test" page: ask one question, see two models answer side by side
   without knowing which is which, then vote. Useful for choosing which local model
   deserves which job. Small, safe (reading only), but strictly a nice-to-have — and it
   must only run in plain sessions, not ones loaded with an identity's private memory.

### CH-5 — Memory auto-consolidation — only ever as a propose-only queue (LOW)

1. **What / who has it:** OpenClaw "Dreaming": nightly three-phase consolidation that
   promotes daily notes into MEMORY.md with **mandatory provenance** ("Source:
   path#Lx-Ly") and saves the prior version (https://docs.openclaw.ai/concepts/dreaming).
   Odysseus: post-turn LLM fact extraction + periodic LLM audit/consolidation
   (`services/memory/memory_extractor.py`). Hermes: background review fork + curator
   (`hermes curator --help`; `tools/write_approval.py` can stage these writes but
   defaults to "write freely").
2. **Why Pantheon might want it:** identity memory quality is a real long-term problem
   the whole household owns (memory tiers, bus-sweep). All three systems converge on
   "background model curates memory."
3. **Four-part test:** Orthogonal **FAIL as shipped** — background memory-writing is
   identity-shaping by a model, the least orthogonal thing possible. As a
   **propose-only queue** (drafts land as pending writes for the operator/identity to
   approve): Orthogonal **PASS**, Auditable **PASS**, Firewall-able **PASS**,
   Cheaper-to-audit **PASS**.
4. **Doctrine conflicts:** as shipped everywhere, it violates D2 (memory_store is a
   `dangerLevel:2` write) and CC3 (model judgment deciding what persists). The
   R4-registered LifeOS four-tier ladder ("propose-only queue") is the only
   doctrine-compatible form, and OpenClaw's mandatory-provenance + prior-version-saved
   mechanics are the right details to keep *inside* that form. Alden-side memory-tier
   design owns the semantics; the harness only ever hosts the approval queue.
5. **Effort:** M–L, post-MVP, Alden-phase-aligned.
6. **Priority:** LOW now.
7. **TL;DR:** All three systems let the AI tidy its own long-term memory overnight.
   Ours must never write memory without a yes — but a version where the AI *drafts*
   tidy-ups and queues them for approval, always citing exactly where each fact came
   from and keeping the old version, fits our rules and is worth doing later.

---

# Suggestions — Cross-cutting

### XC-1 — MCP tool-schema hostile-input hardening (HIGH)

1. **What / who has it:** Odysseus treats MCP tool schemas as untrusted input:
   parameter counts, token lengths, and hint lengths are capped and control characters
   stripped **before schemas are spliced into the prompt** (`src/mcp_manager.py:40-100`,
   hardening issues #2509/#2660). OpenClaw routes MCP tools through the same tool
   policy as native tools ("connecting a server does not bypass your policy",
   https://docs.openclaw.ai/tools/mcp).
2. **Why Pantheon might want it:** #10a authenticates MCP servers at registration, but
   nothing sanitizes what a registered server *says*: tool names, descriptions, and
   JSON-schema text are third-party content that enters every session's prompt — and
   they arrive **outside** the grounding pipeline's `trusted:false` tagging, because
   schemas aren't "recalled content." A compromised or sloppy downstream could carry
   injection text in a tool description. Deterministic caps + stripping at the
   Facade/proxy close a real, cheap gap in CC3's perimeter.
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS** (one pure transform +
   tests). Firewall-able **PASS** (sits in the existing proxy path). Cheaper-to-audit
   **PASS** (days).
4. **Doctrine conflicts:** none — direct extension of "gateway-enforced, never
   model-enforced" to tool metadata. Fail-closed rule: a schema exceeding caps is
   rejected (server's tool unavailable, labeled), never truncated silently.
5. **Effort:** days, in the Facade/tool-proxy path + tests.
6. **Priority:** HIGH — small, deterministic, closes an unmodeled injection channel on
   both planes.
7. **TL;DR:** Every plugged-in tool describes itself in text, and that text goes
   straight into the AI's instructions — a sneaky tool could hide commands there.
   Add a strict gate: descriptions over a size limit or containing funny characters
   are rejected outright. PewDiePie's project already got burned into adding exactly
   this; we can add it before being burned.

### XC-2 — `pantheon doctor`: one-command health + negative-security checks (HIGH)

1. **What / who has it:** Hermes `doctor`/`status`/`dump` (LXC 1094 — component matrix,
   env checks, per-integration status); OpenClaw `doctor` plus `openclaw security audit
   --deep` which live-probes the running gateway (https://docs.openclaw.ai/gateway/security);
   Odysseus health/readiness endpoints + diagnostics.
2. **Why Pantheon might want it:** the assembled system (VM 1093: Caddy, LibreChat+Mongo+
   Meilisearch, two control-plane services, Peta+Postgres, obsidian-mcp) has no single
   truth-teller, and the operator is a non-programmer — BUGS #12/#15/#16 were all
   found by him clicking into silent gaps. One command (and an admin-page mirror)
   printing labeled text per component: service up/down, db perms 0600, bridge
   reachable, disk, cert expiry — **plus negative checks that assert the walls hold**:
   `/admin` and `GET_OWNER` denied (ADR-0003/M2), no public listener, CSP header
   present, and an out-of-vault path refused by obsidian-mcp's HTTP transport — which
   matters doubly because `obsidian-mcp/src/server.ts` (the vault-confinement
   enforcement point) currently has **zero test coverage**.
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS** (read-only probes, our
   code). Firewall-able **PASS** (runs on the VM/admin surface). Cheaper-to-audit
   **PASS** (days).
4. **Doctrine conflicts:** none; it operationalizes CC2's "honest failure states" and
   M2's "verified by config + network test."
5. **Effort:** days; grows a check at a time.
6. **Priority:** HIGH — cheap, serves the skeleton's assembly/debugging phase, and
   directly serves the operator.
7. **TL;DR:** One command that checks the whole machine and reports in plain words:
   what's running, what's broken, and — just as important — that the doors which must
   be locked really are locked (it tries the forbidden doors and confirms they say no).
   Every harness we studied ships this; ours needs it most, because you shouldn't have
   to debug by clicking around.

### XC-3 — Outbound egress allowlisting for the VM stack (MEDIUM)

1. **What / who has it:** Hermes documents Docker internal networks + an explicit egress
   allowlist as "a defense against prompt injection attacks that attempt to exfiltrate
   data via curl/wget… even if a malicious command executes inside the container, it
   cannot reach endpoints outside the explicitly allowlisted set"
   (`docs/security/network-egress-isolation.md`, LXC 1094). OpenClaw's sandbox defaults
   to `network: "none"` and its browser has a "fail-closed SSRF policy object"
   (https://docs.openclaw.ai/gateway/sandboxing, /tools/browser). Odysseus *lacks* it
   and names that its top known gap (THREAT_MODEL.md) — the counterexample.
2. **Why Pantheon might want it:** TM-013's exfiltration arm assumes a tainted session
   can reach the internet if a write gate is ever mis-set. Today the compose services on
   VM 1093 have unrestricted outbound. Internal-only Docker networks plus a single
   egress point with an allowlist (Anthropic API for the future claude-api brain, apt/npm
   mirrors for updates, LAN services) is a deterministic blast-radius reducer that no
   model can talk its way around.
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS** (compose + firewall
   config, negative-testable). Firewall-able **PASS** (it *is* the firewall).
   Cheaper-to-audit **PASS** (config, not code).
4. **Doctrine conflicts:** none — strengthens the LAN-only Will-Not-Have posture.
   Operational risk, not doctrinal: over-tight lists break updates/API calls; ship with
   a documented allowlist and a doctor check (XC-2) that reports egress state.
5. **Effort:** days (compose networks + nftables/proxy rules + two negative tests).
6. **Priority:** MEDIUM (post-skeleton hardening; cheap to fold into deploy work when
   the compose stack is next touched).
7. **TL;DR:** Right now, programs on the harness machine could call out to anywhere on
   the internet. Change that to a short guest list: the few outside services we
   actually use, and nothing else. Then even if something malicious ever runs inside,
   it finds the phone lines cut. This is standard practice in two of the four systems
   we studied — and the one that skipped it lists that as its biggest weakness.

### XC-4 — Tool-effect taxonomy beyond the read/write binary (MEDIUM)

1. **What / who has it:** Odysseus classifies every tool by deterministic effect
   (`READ_PUBLIC` … `EXECUTE_CODE`, `EXTERNAL_SIDE_EFFECT`, `DESTRUCTIVE`) and by
   result integrity (`SYSTEM` / `WORKSPACE_UNTRUSTED` / `EXTERNAL_UNTRUSTED`), feeding a
   server-side gate that arms when untrusted content enters the run
   (`src/tool_capabilities.py`, `src/tool_approvals.py`). LifeOS's classification
   matrix was already registered as a borrow candidate in the 2026-07-02 landscape (R4).
2. **Why Pantheon might want it:** R4 already mandates adding a `tier` column to
   ToolClassification *now* so post-MVP approval-fatigue laddering has evidence.
   Odysseus supplies a concrete, field-tested taxonomy to populate it — including the
   **result-integrity axis**, which Pantheon's D2 (read/write) doesn't capture: a read
   can be safe to execute yet return untrusted content that should taint (Pantheon
   handles that by provenance tagging; the taxonomy makes it explicit per tool).
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS** (data + docs now, no
   behavior change). Firewall-able **PASS**. Cheaper-to-audit **PASS** (S).
4. **Doctrine conflicts:** none while it stays metadata. Any future change to *gating
   semantics* (e.g., ungated low-tier writes) is a separate ruling — MVP semantics
   (all writes gated, sticky taint) unchanged.
5. **Effort:** S — a column, a classification pass over the tool list, doc table.
6. **Priority:** MEDIUM (do it while the tool tables are young; retrofit is the
   expensive path — the household said exactly this about P6).
7. **TL;DR:** Today every tool is either "read" or "write." Add two finer labels while
   the list is short: how dangerous is the action (from harmless lookup to
   destructive), and how trustworthy is what comes back (from our own records to raw
   internet). Nothing changes behavior yet — but when approval fatigue becomes real,
   these labels are what let us relax the safe cases without a rebuild.

### XC-5 — Approval-mechanics harvest: tighten-only, observable expiry, big-payload display (MEDIUM)

1. **What / who has it:** OpenClaw: "approvals can only tighten config-derived
   security/ask, never loosen them"; approved plans are stored and re-used verbatim at
   execution ("the final forwarded system.run call reuses the stored plan instead of
   trusting later caller edits" — anti-TOCTOU); expiry becomes an observable denial
   (https://docs.openclaw.ai/tools/exec-approvals-advanced). Hermes: staged
   write-approvals for large payloads display **metadata + a one-line gist + a `diff`
   escape hatch** because "a 100 KB SKILL.md cannot" be reviewed in a chat bubble
   (`tools/write_approval.py` docstring, LXC 1094). Odysseus: approvals "sealed
   server-side as an exact action"; "Browser-visible fields are display copies, never
   authority" (`src/tool_approvals.py`).
2. **Why Pantheon might want it:** two of these are *independent convergence with
   already-ratified doctrine* — stored-plan-reuse ≡ P4 frozen args / P8
   approval-by-reference; sealed-exact-action ≡ C-12. Record the convergence (three
   systems arriving at Pantheon's mechanics is evidence the mechanics are right). The
   *new* borrows: (a) the **tighten-only invariant** as an explicit written rule for
   Peta policy edits and any future allowlist surface; (b) **large-payload approval
   display** for C.3 — when an approved write is a multi-KB Obsidian note or persona
   diff, show target + size + gist, diff on demand, so D4's display requirement stays
   honest without training the operator to scroll-and-approve.
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS**. Firewall-able **PASS**.
   Cheaper-to-audit **PASS** (S–M, UI + one invariant sentence).
4. **Doctrine conflicts:** none — D4 requires displaying the proposed write; the gist
   pattern must never *replace* the full diff, only stage it behind one labeled click.
5. **Effort:** S–M, lands with the C.3 build.
6. **Priority:** MEDIUM.
7. **TL;DR:** Three findings about approval screens: (1) other systems independently
   invented our rule that what you approve must be byte-for-byte what runs — good
   sign; (2) adopt their rule that a quick approval can only ever make things
   stricter, never looser; (3) for big writes, show a one-line summary with a "show me
   the whole change" button — you always *can* read all of it, but you aren't numbed
   into rubber-stamping walls of text.

### XC-6 — Fail-closed inbound-adapter allowlist as a written invariant (LOW)

1. **What / who has it:** Hermes SECURITY.md §2.6 rule 2: "An allowlist is required for
   every enabled network-exposed adapter. Adapters must refuse to dispatch agent work,
   resolve approvals, or relay output until an allowlist is set. Code paths that fail
   open when no allowlist is configured are code bugs." OpenClaw: DM pairing default,
   groups default-allowlist, mention-gating (https://docs.openclaw.ai/channels/pairing).
2. **Why Pantheon might want it:** the waker spike already implements empty-allowlist =
   deny-all, but as code convention, not canon. When C.8 channels and the waker promote
   to product, this one sentence belongs in the Bible next to CC2 so no future adapter
   can ship open.
3. **Four-part test:** PASS / PASS / PASS / PASS — it's a sentence and a test pattern.
4. **Doctrine conflicts:** none; it *is* CC2, specialized.
5. **Effort:** hours (doc + a negative test per adapter as they appear).
6. **Priority:** LOW (nothing to enforce until adapters multiply — but free).
7. **TL;DR:** Write down one house rule, borrowed word-for-word in spirit from Hermes:
   any door that lets messages in from outside starts locked, and stays locked until
   you've written the guest list. An empty guest list means nobody gets in — never
   everybody.

### XC-7 — Security-CI additions from Odysseus's pipeline (LOW)

1. **What / who has it:** Odysseus (3-month-old hobby project) runs gitleaks, dependency
   review, pip-audit, **hadolint** (Dockerfiles), **Trivy** (images), CodeQL, and
   actionlint+**zizmor** (workflow security) (`docs/security-ci.md`,
   `.github/workflows/`). Hermes ships an on-demand OSV.dev audit covering its venv,
   plugin deps, and pinned MCP servers (`hermes security --help`, LXC 1094).
2. **Why Pantheon might want it:** Pantheon's CI mandate (D9/Appendix B) covers semgrep,
   gitleaks, npm audit. The deploy artifacts are now real (compose files, Dockerfiles,
   pinned images on VM 1093) and un-scanned: hadolint + Trivy close that; an OSV pass
   over the deployed services complements npm audit.
3. **Four-part test:** PASS ×4 (CI config; read-only tooling).
4. **Doctrine conflicts:** none.
5. **Effort:** days.
6. **Priority:** LOW (steady-state hygiene, no new capability).
7. **TL;DR:** Add two free robots to the checks that already run on our code: one that
   lints the recipes we build our containers from, and one that scans the finished
   containers for known vulnerabilities. A teenager-run hobby project has this; we
   should too.

### XC-8 — External secret source at process start (LOW)

1. **What / who has it:** Hermes pulls API keys from Bitwarden Secrets Manager at
   startup "instead of storing them in ~/.hermes/.env" (`hermes secrets --help`);
   OpenClaw integrates 1Password via secretRef conventions
   (https://docs.openclaw.ai/gateway/secrets).
2. **Why Pantheon might want it:** `.env.local`/`deploy/.env` files are the current
   custody for service tokens (Bible §7 flags vault custody as the long-term home).
   If the household already runs Vaultwarden, startup-time pull would centralize
   rotation (the F2 rotation was manual, multi-site, and painful).
3. **Four-part test:** Orthogonal **PASS**. Auditable **PASS** (small startup fetch).
   Firewall-able **PASS** (LAN vault). Cheaper-to-audit **PASS** — but **UNKNOWN**
   whether the household actually runs a secrets manager to integrate with; verify
   before designing.
4. **Doctrine conflicts:** none; complements, does not replace, Peta's vault for
   tool credentials (Peta custody invariant untouched).
5. **Effort:** days, once a target vault exists.
6. **Priority:** LOW.
7. **TL;DR:** Instead of keeping service passwords in files on the machine, the harness
   could fetch them at startup from a household password vault — one place to change
   a password when it rotates. Only worth doing if the household already runs such a
   vault; worth checking.

---

# What Pantheon has that NONE of the four have

Losing any of these is the price of "just use X instead." Verified against all four
inventories:

1. **Out-of-process, durable, out-of-band human write-approval at a separate gateway**
   (Peta: `dangerLevel:2`, survives restarts, first-decision-wins, fail-closed timeout).
   OpenClaw's approvals are TTL'd and SQLite-backed but live in the gateway process and
   are resolvable by chat reaction; Odysseus's gate is genuinely server-side but
   in-process with the tools; Hermes's is an in-process heuristic by its own admission;
   dsh's had no durable pending state at all.
2. **Taint-by-presence with an operator-inspectable assembled prompt** (per-block trust
   labels, per-source toggles, C.2). Odysseus wraps untrusted content and arms a gate —
   closest convergence yet — but nobody renders the assembled prompt for inspection.
   Still first-in-category (consistent with the 2026-07-02 finding).
3. **Identity as a structural security principal:** one identity = one gateway user +
   own token + own Qdrant collection + own Gitea scope + HMAC signing key in vault
   custody, signed *on behalf of* the session, with **immutable identity↔backend
   binding**. All four model identity as prompts/profiles/workspaces (OpenClaw comes
   nearest with per-agent auth profiles and workspaces — still one process, plaintext
   tokens).
4. **Git-mastered config with boot-hash refuse-to-start** (ADR-0006). dsh's layering is
   advisory-staleness; Hermes config is agent-adjacent and hook-consented; OpenClaw's
   Control UI edits config live; Odysseus keeps config in its DB.
5. **A content-free, append-only usage ledger keyed to identity state**
   (`identity_state_hash`, `trigger` classes, rate_version, P6 buckets). OpenClaw
   tracks usage but hides dollar costs on plan auth and stores transcripts; Hermes
   insights reads content-bearing session logs; Odysseus counts tokens only.
6. **WAKE-NOT-BODY as a named invariant.** Every one of the four delivers message
   bodies into the woken agent's context.
7. **Colorblind-safe operation as a hard, severity-classed acceptance criterion** (CC1 —
   a color-only cue is SEV-2). No analogue anywhere.
8. **The terminal modality itself:** the operator's own Claude Code CLI, on his Max
   subscription, in a browser tab, with the SSH key in vault custody and never in
   session context (ADR-0005/TM-020). OpenClaw *drives* Claude Code (ACP/claude-cli
   backend, tools lost or bridged); Odysseus lets Claude Code drive *it*; none of them
   preserves "your terminal, your subscription, their features around it." This is
   still Pantheon's reason to exist, and this study found nothing that removes it.
9. **A household governance trail** — recorded consent rounds, arbitration-grade audit
   ambitions (P1/P7), channel-deletion taxonomy with fail-closed-while-governance-open.
   Nothing comparable exists in any of the four.

---

# Do-not-adopt list (attractive, but fails the test or violates doctrine)

| # | Tempting thing | Where | Why refused |
|---|---|---|---|
| D1 | **Any of the four as a system** | all | Each fails cheaper-to-audit decisively (OpenClaw ~304 MB src / 2,299 commits-week; Hermes ~1.6M LOC; Odysseus AGPL monolith, no releases); each keeps enforcement in-process with its tools; each replaces the Claude Code CLI loop with its own (the exact thing Pantheon exists to avoid) |
| D2 | **Resolving approvals from chat** (reaction = allow-always) | OpenClaw exec-approvals in channels; Hermes gateway async approvals | Violates D4 (must display tool+args/diff at decision time) and D6 (approval is the strongest auth tier; a Telegram reaction is not step-up). Adopt notification only (TP-2) |
| D3 | **Model-judged approval** ("smart approval via auxiliary LLM", exec `auto` reviewer) | Hermes `tools/approval.py`; OpenClaw exec mode `auto` | CC3 verbatim: never a model deciding what a model may do. Same disqualifier as Turnstone's judge |
| D4 | **Cross-backend model failover** | OpenClaw model-failover; Hermes fallback chains | Manifesto §4: "no failover that crosses identity backend binding" (#14a). Pantheon's answer is the honest C.7 busy/offline signal. Same-backend retry is fine |
| D5 | **Subscription-OAuth as a server-side API backend / UA spoofing** | OpenClaw setup-token runtime + claude-max-api-proxy ("not an officially sanctioned path"); Hermes `proxy`; Odysseus `chatgpt_subscription.py` + Kimi UA-spoof (`claude-code/1.0.0`) | Endangers the Max account that is the project's foundation. Even OpenClaw's "Anthropic staff told us … allowed again" page hedges that terms can change "without an OpenClaw release". The Max plan stays exclusively inside interactive Claude Code terminals; harness chat brains use API keys under R18 |
| D6 | **Always-on background model activity as default** (heartbeat, dreaming, curator) | OpenClaw, Hermes | Quiet quota/spend burn with model-judgment writes; Pantheon autonomy is opt-in, R18-metered per `trigger`, budget-governed (R6), and pause-don't-kill (P7). Harvest the *cost levers* (TP-5), not the defaults |
| D7 | **Ungated autonomous memory/skill writes** | OpenClaw dreaming, Odysseus extractor, Hermes background_review (write_approval default "write freely") | D2: memory_store is a gated write. Only the propose-only variant may ever come (CH-5) |
| D8 | **Mid-session `/model`, `/personality` switching** | all three | Will-Not-Have: runtime identity context-injection; immutable binding (#14a). Identity is fixed at session creation, full stop |
| D9 | **Public relay / tunnel / hosted connectors** | Hermes `gateway enroll` relay + Nous Portal routing; OpenClaw remote-exposure recipes; ntfy public instances | Will-Not-Have: no public ingress, ever (re-affirmed 2026-08-18 internal-only ruling). Any notify path in TP-2 must terminate on LAN/tailnet |
| D10 | **In-process plugin ecosystems** | all three | OpenClaw's own words: "a malicious native plugin is equivalent to arbitrary code execution inside the OpenClaw process." Pantheon extends only by registering remote/HTTP MCP servers behind Peta (ADR-0003) |
| D11 | **Middleware that rewrites tool args before approval** | Hermes middleware contract ("Rewrite tool arguments before guardrails, approval checks… see them") | Direct inversion of ratified P4 frozen-args. Named so nobody imports the pattern with the (otherwise fine) observer-hook idea |
| D12 | **Semantic / cross-session response caching** | (Bifrost precedent; none of the four pushes it, OpenClaw prompt-caching is provider-side) | Identity bleed — already ruled in the Bifrost walls; recorded here so it stays refused |
| D13 | **Skill-registry auto-install** (ClawHub, skills.sh) | OpenClaw, Hermes | Supply-chain: registries vet the platform, not the code ("Treat third-party skills as untrusted code"). Pantheon's path stays T5 (scan-at-install in the Registrar) + operator review |

---

# Could any of the four replace something Pantheon is building?

Asked directly, answered directly:

- **The session waker / CLI comms loop (OpenClaw)** — OpenClaw is the industrialized
  version of exactly what `prototypes/cli-channel-loop` starts: keep an agent reachable,
  wake it from channels, schedule it, guard the loops. **It still cannot replace the
  waker**, because its runtime *is the agent* — adopting it replaces Claude Code's loop
  (its `claude-cli` backend is a "text-only fallback" that loses tools) and moves the
  operator off interactive Max-subscription use in exchange for a multi-million-line,
  2,299-commits-a-week dependency whose own threat model disclaims prompt-injection
  containment. What it *does* do is validate the waker roadmap completely and supply
  the deterministic mechanics (TP-1, TP-5). Verdict: keep building; harvest.
- **LibreChat (Odysseus)** — Odysseus is the only candidate that even resembles a chat
  UI replacement, and it isn't one: AGPL, no releases, ~3 months old, UI welded to its
  own agent loop (Pantheon's Facade must own the loop), single-process trust domain.
  The Decision-B LibreChat spike stands. Odysseus becomes a **watch item** on the
  quarterly re-scan — if it matures and modularizes, its taint-armed gate + scoped
  tokens make it the most doctrinally compatible external codebase yet seen.
- **Peta (all four)** — none ships an out-of-process durable HITL gateway; the
  2026-07-02 conclusion stands unchanged. Nothing here touches the fallback ladder.
- **The R18 cost meter (OpenClaw usage tracking)** — no; on plan auth OpenClaw itself
  can't see dollar costs and stores transcripts besides. Hand-built meter stands
  (P4/P6 as ratified).
- **The task board Pantheon isn't building (Hermes kanban)** — flagged honestly: this
  is the one place a studied system has a *whole subsystem* Pantheon may eventually
  want and has nothing of. The adoption path is still pattern-build (TP-4), because
  the board arrives welded to 1.6M lines of agent framework.

---

# dsh residue — NOT COMPLETED

The sub-agent tasked with enumerating what the ratified dsh study (P1–P9,
`dsh-pattern-map.md` @ SHA `99f6f02`) did **not** cover failed to return before this
document's deadline. **No findings are asserted here.** For the record, the areas it
was instructed to check, chosen because the three study clusters (A audit/accounting,
B identity/lifecycle, C seams/approval/subagents) plausibly never touched them:

- session search / FTS ("session-query") and session-browsing UX
- compaction/summarization mechanics beyond the `surfaceOp` audit shape
- sandboxing providers (subprocess-e2b), fs capability events, sandbox policy
- the ACP bridge (editor integration) and Code Mode (tool calls as code)
- the CLI/TUI apps themselves: approval UI, resume, keybindings, printing
- any web UI; skills/prompt-bundle system if distinct from presets; MCP support
- checkpoints/branching UX beyond the `fork` primitive
- provider layer: streaming/retry, the `llm-replay` test double (already known by name
  from cluster C as a first-class test-double provider — its mechanics unexamined)
- shell/exec/file/web tools, attachments/multimodal, scheduling/background tasks
- the `.agents/` engineering-process corpus, `gen-doc-graphs`, `run-gates`

**Recommendation:** re-run this enumeration as a bounded half-day task before the next
quarterly landscape re-scan (~2026-10), or fold it into that re-scan. The pattern map's
own session-2 verification notes suggest the biggest unharvested value sits in the
provider/test-double layer (`llm-replay` — session logs as replayable test fixtures,
which would pair with P1 and could give `obsidian-mcp/src/server.ts` and the Facade
their missing conformance-style coverage) — but that is an expectation, not a finding.

---

# Standing watch list (fold into the ~2026-10 quarterly re-scan)

- **OpenClaw**: re-check exec-approvals and sandbox maturity; if it ever ships
  out-of-process enforcement or a stable LTS line, re-run the four-part test on the
  *gateway* alone. Track the Anthropic subscription-policy language it cites.
- **Odysseus**: watch for releases, modularization of the approval gate, sandbox work
  (their issue #1058). AGPL stays a hard friction for code lifts — pattern borrows
  only, no verbatim code without a license decision.
- **Hermes**: FROZEN → recommend closing as REJECTED (verdict table above); keep as
  pattern quarry; watch the kanban spec (versioned, PDF) as prior art for TP-4.
- Existing items unchanged: Turnstone triggers, Preloop, FIDES, LibreChat Slice B,
  Peta releases.

---

# Methodology details & what was NOT verified

- **Hermes evidence** is first-hand but shallow-by-design: CLI `--help` output,
  SECURITY.md and three docs files in full, six module docstrings, LOC counts
  (`find … | xargs cat | wc -l`, excluding venv/node_modules/web/website — includes
  tests and vendored Python, so treat 1.33M as an upper-bound order of magnitude).
  Its agent was never run; its config was never read (secrets discipline); runtime
  behavior of kanban/cron/webhooks is asserted from help text + docs, not observed.
- **OpenClaw and Odysseus** inventories come from dedicated research agents fetching
  primary sources (docs.openclaw.ai pages + sitemap; the Odysseus repo cloned at
  commit `b4d1293` and read file-by-file). Their per-claim citations are reproduced,
  but I did not independently re-fetch each URL. Load-bearing claims used in verdicts
  (Odysseus AGPL license; OpenClaw threat-model quotes; the NON_ADMIN_BLOCKED_TOOLS
  enforcement path; the subscription-policy language) were reported with file/line or
  URL citations by the agents; anything they marked unverifiable is excluded or
  labeled here.
- **Specific unverified items:** whether OpenClaw's `sessions_spawn` across agents is
  gated by the agentToAgent allowlist (verified only for `sessions_send`); ClawHub's
  scanning depth; OpenClaw true LOC; the mechanics of OpenClaw's `auto` exec-reviewer;
  Odysseus's UI-route-level gating beyond the audited dispatch path; Hermes runtime
  behavior generally; everything in the dsh-residue section.
- **Freeze note:** nothing here starts before the walking-skeleton acceptance checklist
  passes, except where a suggestion explicitly rides an in-scope skeleton item and the
  operator so rules (the CH-3 usage sanitizer on step-06 is the only such candidate).

---

# Plain-English TL;DR of the whole study

We compared Pantheon against four other AI-harness systems: OpenClaw (huge, famous,
moves impossibly fast), PewDiePie's Odysseus (impressive for three months old, but one
big program with no safety walls between parts, and a license that limits copying),
Hermes (Nous Research's giant agent — which honestly admits its own safety prompts are
not real security), and a leftover check on the DeepSeek harness we already studied
(that checker didn't finish — noted honestly, to be redone).

**None of them should replace anything Pantheon is building.** None has our
combination: a separate armored gate that holds every risky write for your approval,
labels on everything the AI recalls so you can see what's trusted, one identity = one
locked set of keys, and — uniquely — your own Claude terminal on your own subscription
as the main way of working. Three of them independently invented pieces of our rules,
which is good evidence the rules are right.

**What we should copy (all small, built by us, in our own code):** a doorbell that
pings you when an approval is waiting; circuit breakers that stop two AIs from
ping-ponging forever; a one-command health check that also proves the locked doors are
locked; a strict filter on the text plugged-in tools use to describe themselves; a
short internet guest list for the harness machine; narrow read-only keycards so your
terminal sessions can ask the harness about spend and pending approvals; and later, a
small shared task board for your projects. **What we must not copy:** approving things
from chat with an emoji, letting a model approve another model's actions, switching
identities mid-conversation, always-on background AI activity that quietly eats your
subscription, and anything that turns your Claude Max plan into a server backend —
that last one risks the account this whole project is built around.
