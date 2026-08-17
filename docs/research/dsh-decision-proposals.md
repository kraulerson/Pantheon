# dsh Decision Proposals — RATIFIED

> **Status (2026-08-17):** Karl approved all nine as recommended; household
> ratification COMPLETE — P1/P5/P6/P7 **unconditional consent from both full
> identities** (Cloud Alden bus 1205→1219, Alden-1 1208→1223, both after reading these
> docs from source at Gitea `alden/infra/docs/research/`); P8/P9 no objection; P2/P3/P4
> Pantheon-internal. Alden-1's underline on P2 stands in the record: the
> dump-renders-every-layer amendment "is not optional polish, it's the property."
> Open technical items with the alden-infra session: Phase 0.2 column-conflict check
> (P6) and P8-vs-Phase-4 alignment.

**Source study:** `dsh-pattern-map.md` (~100 patterns @ pinned SHA
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`, MIT). Nine proposals; each is answerable
**yes / no / amend** without reopening design. Costs are S/M/L in Pantheon's stack.
Patterns lifted near-verbatim carry MIT attribution into THIRD_PARTY notices in the
implementing commit. Every proposal ends with a plain-English TL;DR + pros/cons +
recommendation (Karl's decision format). All are **post-skeleton** unless marked;
none change skeleton scope.

---

## P1 — Audit: append-only SessionEvent log with an always-on "identity-visible ⟺ logged" invariant

**Decision.** Pantheon's per-session audit adopts dsh's shape: one append-only event
log per session; everything any identity's model call saw is derived from the log,
never stored beside it; a runtime invariant re-derives each request from the log and
fails loudly on mismatch — **always-on** (sampled if perf demands). Adopt with it:
append-time validation + freeze (bad events never enter), `ignorable?`
default-required (unknown required event ⇒ reader refuses), refusals close a durable
turn ("the log records the attempt"), crash repair appends a synthetic unforgeable
`interrupted` end marker instead of truncating, and full request-snapshot events so
`identity_state_hash` becomes *verifiable*.
**Precedent.** `architecture.md:96`; `packages/core/session/src/index.ts:604–655`;
`packages/core/agent-loop/src/invariant.ts:19–55`. **dsh ships the invariant OFF in
product configs** — we differ deliberately.
**Fit.** Completes the audit pillar: reconstruction by construction; extends the
existing hash-chain philosophy from identity changes to conversation history.
**Cost.** M. **Alternative considered:** keep today's AuditEntry-only model — rejected:
it records actions, not what the model *saw*; drift stays invisible.
**Pros:** perfect-reconstruction audit; compaction/summarization stays auditable;
arbitration-grade evidence. **Cons:** storage growth (cheap, text); the invariant adds
per-request compute (samplable); migration touches the Facade pipeline.
**Recommendation: ADOPT.** The whole household doctrine ("silent change is evidence
destruction") wants exactly this, and dsh proved the mechanics work.
**TL;DR (plain English):** Every conversation keeps a complete, tamper-proof diary,
and the system constantly re-checks that what an AI was shown matches what the diary
says — alarm if not. dsh invented this but ships it switched off; we'd keep it on.

## P2 — Identity packages: ordered config layers + a drift-proof "show me this identity" command

**Decision.** Identity packages compose as ordered layers (base → identity → instance
overlay) with patch-by-row-id and whole-value replacement (no deep merge), plus a
`dump-config`-style command that renders the exact composed result **using the same
code path the boot uses**, with per-row provenance ("this line came from that layer").
**Amendments vs dsh (all fail-closed):** an unmatched patch **throws** (dsh warns);
**no machine-local override layer** (dsh's home patch outranks the identity layer —
inverted here: nothing outranks the alden-infra-derived layers); staleness =
**content hash + refuse to start** (ADR-0006), not advisory timestamps; the composed
tree is **read-only at runtime** (config is input, never a persistence target).
**Precedent.** `apps/cli/reference/README.md:9`; `vendor/include/src/index.ts:58–128`;
`packages/boot/app-boot/README.md:22,43`. **Fit.** Gives ADR-0006's projections a
concrete composition + introspection mechanism. **Cost.** M (S–M for dump alone).
**Alternative:** single flat config per identity — rejected: can't express
"standard + one change" without copy-drift (dsh documents that failure explicitly).
**Pros:** "what exactly is this identity right now" answered provably; layered
overrides without copies; recovery diagnostic for a corrupt overlay. **Cons:**
whole-value patches are verbose (restate kept fields); layering is a new concept for
the household to learn. **Recommendation: ADOPT WITH THE FAIL-CLOSED AMENDMENTS.**
The mechanics are excellent; dsh's trust posture around them is the part we refuse.
**TL;DR:** An identity's setup is built from stacked layers (shared base + personal
settings + per-window tweaks), and one command shows exactly what the final stack is
and which layer each piece came from — guaranteed truthful because it's computed the
same way the system actually starts. Any broken or mismatched layer stops the boot
instead of limping.

## P3 — Bus isolation: per-identity scoped registration with automatic unwind

**Decision.** Every per-identity contribution (tools, prompt sections, listeners,
channel joins) registers through that identity-instance's scope, making it
**visible only in that scope and disposed with that scope — one fact drives both**.
Tool filtering: a revoked/unfiltered tool is absent from the prompt AND refuses
execution, **indistinguishable from a nonexistent one**; restrictions compose by
intersection (later layers only narrow). **Boundary unchanged:** scopes are routing +
lifecycle; **authority remains Peta + per-identity stores** (dsh says its scopes "are
not sandboxes or authority boundaries" — we agree and keep our wall).
**Precedent.** `glossary.md:15,19`; `packages/core/scope/README.md:5,15,27`.
**Fit.** Dissolves the "manual cleanup sweep" class: an instance's channel joins
unwind with its scope — the lease reaper stops needing a remove-from-everything loop.
**Cost.** M. **Alternative:** central bookkeeping tables per instance — rejected: the
forget-one-place failure mode is exactly what this removes.
**Pros:** leak-proof by construction; clean lite-instance unload for free; compile-time
brands catch mis-scoped dispatch. **Cons:** every registry we build must be
scope-aware (dsh's honest hole: anything else stays global — we invert to
default-deny, which is work). **Recommendation: ADOPT (semantics), authority stays at
Peta.** **TL;DR:** Everything an identity-window plugs in is tagged as belonging to
that window, so when the window closes, everything it plugged in vanishes with it —
nothing to remember, nothing left behind, and one window can't see another's plugs.
The security wall itself stays where it is (the gateway).

## P4 — Channel governance: seam grammar + hook pipeline, with authorization NOT hookable

**Decision.** Adopt the three-role seam grammar (Definition / Provider / Consumer —
"complete, never one role") for Pantheon's capability seams, and the waterfall
pre/post hook pipeline with explicit `next()` for **observability, annotation, and
policy advice**. Adopt three hard properties: **frozen arguments** (what the human
approved is byte-identical to what executes — no hook may rewrite args), **monotonic
guards** (deny-only checks with no allow result — ordering can never restore
permission), and post-execute block/replace for result redaction. **Amendment:** the
authorization *decision* is never a registerable listener — it stays at Peta.
**Precedent.** `architecture.md:100`; `tools.md:172,311,315–324,379–389`.
**Fit.** Formalizes what the Facade/Peta pipeline half-does already; the guard
primitive is a drop-in for taint-gated writes. **Cost.** S–M.
**Alternative:** ad-hoc hooks per feature — rejected: that's how bypasses are born.
**Pros:** approved==executed guaranteed; deny is a one-way ratchet; test doubles
become first-class providers. **Cons:** discipline overhead (every capability needs
all three roles named); guards must be curated to avoid deny-storms.
**Recommendation: ADOPT WITH THE AMENDMENT.** dsh's own design shows why: its
approval-as-listener topology is the thing we reject in P8.
**TL;DR:** Standardize how capabilities plug in (each has a socket, an implementation,
and a user — always all three), let inspection hooks watch and annotate, but make two
things physically impossible: changing a request after a human approved it, and any
add-on turning a "no" back into a "yes." The actual yes/no stays at the gateway.

## P5 — Multi-instance sessions: the continuable-child model + residency-routed wake

**Decision.** Pantheon's lite-instance registry adopts dsh's continuable-child shape:
**durable session + at most one live activation + "the inbox is the only queue."**
The Autonomy Driver dispatches by **residency routing**: running → enqueue; waiting →
wake; absent → **cold-resume from the durable session** (no provider involvement).
Delivery keeps dsh's **quiet vs wakeup split** — with the payload amended to
Pantheon's rule: **wake carries sender + ids only, never bodies.** Adopt with it:
capability discovery that fails loud ("never accepted-then-ignored"), typed provenance
(child's words vs runtime's account — "never credit the child with words it never
wrote"), and no-load enumeration with per-child corrupt/unavailable diagnostics ("one
damaged sibling cannot hide healthy children").
**Precedent.** `subagent.md:116–144,130–134,194,212,289`. **Fit.** This is Q7's
product answer (single dispatcher, claim/lease, thread affinity) arriving pre-solved;
dsh can only do it in-process — our session registry closes exactly the gap dsh
documents. **Cost.** M–L (the largest adopt). **Alternative:** invent our own
dispatch semantics — rejected: dsh's residency ladder is battle-tested and matches
our lease design 1:1. **Pros:** wake/dispatch/resume semantics settled; crash-safe
(cold resume from durable state); provenance types reinforce the taint doctrine.
**Cons:** biggest build item; needs the bridge's thread_id/sender_session columns
(shipping Sunday) underneath. **Recommendation: ADOPT (payload amended).**
**TL;DR:** Each helper-AI window gets a permanent file and at most one live body; new
messages go into exactly one inbox; the dispatcher checks "is it awake?" — busy: queue
it; idle: tap its shoulder; closed: reopen it from the file. The tap says who's
calling, never the message itself. And the system never puts words in a helper's
mouth — its own words and the system's notes about it are typed differently.

## P6 — UsageEvent ledger amendments (R18)

**Decision.** Three additions to the ratified UsageEvent schema, all pre-build (the
meter is skeleton item 6, so this is a **skeleton-relevant** amendment): (1) an
**anchor** — `(turn, step)` or log `seq` — with replace-not-add semantics on the same
anchor, giving idempotent de-dupe for retried completions; (2) **disjoint token
buckets**: `input_tokens` (uncached ONLY) + `cache_read_tokens` + `cache_write_tokens`
+ `output_tokens` (`reasoning ⊂ output`), billed input = sum of three; (3)
**`provider` + `model` columns** so `rate_version` is auditable against what actually
ran. Also record usage for **failed/aborted** completions (that's where costs leak).
Explicitly rejected from dsh: usage riding the content event ("no separate usage
record") — our ledger stays separate and content-free (P4-single-authority).
**Precedent.** `packages/llm/llm/src/types.ts:127–142`; `session.md:59–64,530`.
**Cost.** S. **Alternative:** ship the schema as ratified — rejected: retrofit is the
expensive path, the household said so themselves. **Pros:** no silent double-billing
of prompt-cache traffic; retries can't double-count; rates auditable. **Cons:**
none material — three columns and a uniqueness rule. **Recommendation: ADOPT.**
**TL;DR:** Three small upgrades to the cost tracker before it's built: a receipt
number so a retried call can't be billed twice; separate counters for cached vs fresh
work so caching discounts are never silently double-charged; and recording which brain
actually ran, so bills can be checked against reality. Failed calls get receipts too —
that's where money leaks.

## P7 — Config changes are durable events in the session log

**Decision.** Any composition change affecting a live session (identity package
version, tool grants, brain rebind at session boundaries, prompt sections) is recorded
as a **durable, ordered event in that session's log**, appended when the change
commits — never just a mutated header/registry row. Replay then reconstructs exactly
which composition governed which turns. This is the concrete shape of Pantheon's
divergence documentation (session forking was evaluated for this and is a **false
friend** — it copies conversations, not composition).
**Precedent.** `agent-presets/README.md:43–45` ("the preset decides the tool schemas
and prompt sections the model sees, so it has to be reconstructable from the log").
**Fit.** Pairs with `identity_state_hash` in UsageEvent (P6) and the boot-hash rule:
hash says *which* config; this event says *when it changed*. **Cost.** S–M.
**Alternative:** rely on git history + registry timestamps — rejected: joins across
three stores to answer "what rules was it under at turn N."
**Pros:** arbitration evidence complete; "silent change is evidence destruction"
enforced mechanically. **Cons:** every config-touching path must emit the event
(enforced by the P1 invariant). **Recommendation: ADOPT.**
**TL;DR:** Whenever an identity's rules or settings change mid-stream, that change is
written into the same diary as the conversation, at the exact spot it happened — so
later you can always answer "which rules were in force when it said that?"

## P8 — Approval record shape: adopt dsh's mechanics, keep Pantheon's gateway + durability

**Decision.** Peta's approval flow adopts four dsh mechanics: (1) the **log-only audit
pair** `asked`/`decided` with the atomicity rule (an unloggable decision REJECTS);
(2) the **closed, fail-closed outcome vocabulary** (`allowed-once` is the only grant;
missing/throwing/non-conforming answerer normalizes to `unavailable` = deny); (3)
**`allowed-once` granularity** — no standing "always allow" exists in the type; (4)
**approval-by-reference** — the prompt attaches to the already-displayed tool call by
id instead of re-rendering the payload (kills approve-X-execute-Y drift). **Kept from
Pantheon, explicitly:** decision at the external gateway; durable
pending/approved/rejected/**expired** records that survive restarts; **human-only**
answerers for dangerLevel:2. dsh's topology (in-process, optional, machine-answerable,
no expiry) is **rejected with reasons** in the pattern map.
**Precedent.** `approval.md:21,53,86`; `persistence-catalog.md:153–181`.
**Cost.** S–M. **Alternative:** dsh's model wholesale — rejected: the gate would live
inside the thing it gates. **Pros:** audit the model can't read or forge; no display
drift; rigor formalized. **Cons:** none — this is a strict strengthening.
**Recommendation: ADOPT.**
**TL;DR:** Keep our rule that a human at the gateway approves every risky action —
but borrow four locks from dsh: every ask and answer is logged or the action fails;
"yes" only ever means "yes, this once"; anything abnormal counts as "no"; and the
approval screen points at the exact displayed action rather than a copy that could
differ.

## P9 — Identity lifecycle: effects-with-disposers unmount discipline

**Decision.** Identity mount/unmount follows dsh's reversible-effects model,
implemented as a plain-TS disposer stack (no framework): every mount-time
registration returns a disposer; unmount = stop work → **await quiescence** (closing
listener registries **before** killing stragglers) → **unwind the scoped world**
(which removes channel joins automatically, per P3) → unregister from the live
registry → flush/detach stores → release the lease. *(Order verified against dsh's
implementation, `agent-loop/src/index.ts:497–520` — note dsh's own docs state a
different order than its code; see verification table.)* Disposers run reverse-ordered (sequence inside one disposer when order
matters); `dispose()` is idempotent and race-safe; the disposer is a **capability**
(only the mounting owner can tear down — a slug lookup returns no teardown power);
creation is **transactional** (failure publishes no id); the provider drains every
live instance on its own unload.
**Precedent.** `cordis-primer.md:13`; `core.md:28–49`; `defensive-patterns.md:19–21`.
**Fit.** The lease/reaper design gets its other half: not just detecting death, but
dying cleanly. **Cost.** M. **Alternative:** teardown checklists in code review —
rejected: "if you have to remember, you'll forget one."
**Pros:** no orphaned watchers/timers/joins ever; concurrent unmounts safe; A cannot
unmount B. **Cons:** every resource acquisition must go through the effect helper
(a discipline, enforced by lint). **Recommendation: ADOPT.**
**TL;DR:** Opening an identity window automatically writes its own complete shutdown
list; closing it runs that list in reverse until everything is truly gone — waits for
work to stop, unplugs everything, leaves the group chats, hands back its lease. Only
whoever opened the window holds the off switch, and a half-opened window can never
exist.

---

## Verification status (session 2 — targeted source reads @ 99f6f02, zero execution)

| # | Claim | Verdict | Impact |
|---|---|---|---|
| 1 | `AgentHandle.dispose()` ordering per docs | **REFUTED in part** — code unwinds the scoped world BEFORE unregister/detach (`agent-loop/src/index.ts:497–520`); dsh's own docs + in-file comment say the opposite | **P9 amended** to the verified order; bonus: dsh has doc-drift too — our citation-sweep doctrine validated |
| 2 | Scope store: synchronous action → synchronous undo, installed before notification | CONFIRMED (`scope/src/store.ts:226–266`) | P3 stands |
| 3 | Cold resume bypasses providers | CONFIRMED (`continuation.ts:876–932`; provider only builds a lifecycle observer) | P5 strengthened |
| 4 | `send_message` direct-parent authority at runtime | CONFIRMED (`continuation.ts:1211–1225`, rejects ancestors/teams/hosts, `UNAUTHORIZED`) | P5 strengthened |
| 5 | Only apiproxy + ACP register approval answerers | CONFIRMED (+ caveat: base-only profile has ZERO answerers ⇒ every ask fails closed) | P8 strengthened |
| 6 | Crash repair appends synthetic `interrupted`; unreachable from loop | CONFIRMED (`repair.ts:27–133`; sole producer) | P1 strengthened |
| 7 | Write batching + retained-events-on-reject | CONFIRMED, except reporting goes to `logger.warn`, not `agent/error` (docs wrong) | minor; another doc-drift instance |
| 8 | Projection read ladder + one-below anchor | CONFIRMED (one stale doc clause re the no-units path) | P1/A-19 stand |
| 9 | Doc-graph completeness guard fails CI | CONFIRMED (`gen-doc-graphs.ts:614–625`; wired via `run-gates.ts:610`) | C-3 stands |
| 10 | SQLite vs JSONL backend deltas | CONFIRMED (3 deltas: `locate()`, refusal enrichment, true suffix reads) | informational |
| 11 | Dump and boot share `applyEntryPatches` | CONFIRMED (one symbol, one module) — **caveat:** boot appends a telemetry env-switch patch the dump never renders | **P2 amended:** our dump must render EVERY layer incl. runtime-appended ones, or runtime-appended layers are forbidden |

**Amendments applied:** P9's teardown order now reads: stop work → await quiescence
(close listener registries before killing stragglers) → **unwind the scoped world**
(channel joins, tools, listeners) → unregister from the live registry → flush/detach
stores → release the lease. P2 gains the completeness rule: the dump path and the
boot path must consume the *identical* layer list — no boot-only appended layers.
