# deepseek-harness (dsh) Pattern Map — Study for Pantheon

**Status: SESSION 1 COMPLETE (docs + mapping, 2026-07-11).** Session 2 (targeted code
verification + `dsh-decision-proposals.md`) follows per the study spec; each cluster's
verification list is at its end, the consolidated one in §Synthesis.
**Repo:** https://github.com/deepseek-ai/deepseek-harness (MIT) — **pinned SHA
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`** (cloned read-only 2026-07-11; dsh is a
developer preview with guaranteed breaking changes — every reference below is against
this SHA). Clone lives in session scratchpad; **nothing from the clone executes; zero
dependencies introduced.**
**Method:** agent-driven doc study (three parallel readers over the spec's reading
list), then synthesis here. Study, not adoption: output is patterns, schemas, and
invariants — language-portable into Pantheon's stack (TypeScript/Fastify/
better-sqlite3). Findings that would change ratified Pantheon decisions go through the
divergence protocol (documented, directly addressed, Karl cc'd).
**Attribution rule:** if schema or code text is lifted near-verbatim, MIT attribution
lands in Pantheon's third-party notices in the same commit.

## Classification key

- **Adopt** — lift the shape (schema/invariant/state machine) near-verbatim,
  re-expressed in Pantheon's stack
- **Adapt** — right idea, wrong assumptions for a multi-identity/multi-host system;
  what changes and why is recorded
- **Inspire** — informs thinking; nothing lifted
- **Reject** — considered and refused, reason recorded (pre-closed argument)

Every entry cites file/doc @ the pinned SHA. Cost column = rough implementation size
in Pantheon's stack (S/M/L).

## Divergence watchlist (ratified decisions a finding may not silently change)

ADR-0006 (git is config master; projections boot-verify Profile hash) · approval at
the GATEWAY, never in-model (Peta, dangerLevel:2, durable records, fail-closed
timeout) · WAKE-NOT-BODY (named invariant) · one accounting authority (P4) ·
append-only mailbox (D-0.2c) · trusted:false / sticky taint · full=1-session,
lite=N-instances w/ leases.

---

*(Findings land below as the three study agents report: A — audit/events/token-meter;
B — identity packages/isolation/lifecycle/fork; C — capability seams/approval/
subagents.)*

---

# Cluster A — Audit · events · persistence · token accounting

**Headline:** the single append-only `SessionEvent` log with the **"Model-visible ⟺
logged"** invariant is the strongest architecture in dsh and maps directly onto
Pantheon's audit pillar — with one hard caveat found in source: **dsh ships its own
reconstruction invariant OFF in the production configs** (`.agents/notes/implemented/
simplification/2026-08-03-omit-invariants-from-shipped-config.md:13`; confirmed — no
bundle mounts the invariants package). Pantheon adopts the pattern always-on.

## A1. The invariant (verbatim, `architecture.md:96`)

> "**Model-visible means logged.** Anything that reaches a model request must be
> reconstructable from the log, and a runtime invariant asserts it. This is why a new
> model-visible input requires a new session event: extend `SessionEventMap` and render
> from the log."

Strong form (design note): "anyone holding the log, its referenced attachment objects,
and the pinned code version reconstructs every loop request **byte-for-byte**."
Enforcement stack (source-verified): **(always-on)** `Session.append()` validates
lossless-JSON via single-snapshot read, rejects legacy formats and reentrancy,
deep-freezes before the push — a bad event never enters the log
(`packages/core/session/src/index.ts:604–655`); **(always-on, compile-time)** surface
events must declare `surfaceOp` via a conditional rest tuple — "new model-visible input
⇒ new event type" is unrepresentable-if-violated; **(opt-in)** a dispatch-time check
independently re-derives every loop request from a fresh `Session` and compares
(`packages/core/agent-loop/src/invariant.ts:19–55`, registered `prepend:true` "so a
short-circuiting replay listener cannot silence the check"); **(opt-in)** a relational
log check (seq contiguity, turn/step nesting, callId pairing).

## A2. The durable schema

Envelope: `{ type, seq (== log.length, contiguous), time, data (lossless JSON,
deep-frozen), ignorable? (absent = required — unknown required type ⇒ READER REFUSES
to reconstruct), surfaceOp? (surface types only), sourceEventSeqs? (provenance) }`.
Exactly **three surface types** produce model messages: `user/message`,
`assistant/message`, `tool/result`; everything else is log-only.
`request/header` logs a **full snapshot** of config + rendered system prompt + tool
schemas (folded last-wins) — the piece that makes "everything the model saw" complete
and turns an `identity_state_hash` from opaque into *verifiable*. `MessageSource` is a
typed sum, and dsh's `ContextForm` vocabulary already contains **`recall`** ("material
lifted out of another session's log") and **`relay`** ("a message another agent
addressed to this one") — drop-in names for Pantheon's grounding and bus injections
(`packages/llm/llm/src/message.ts:56–60`). Crash repair **never truncates**: an open
turn gets a synthetic `turn/end {reason:{kind:'interrupted'}}` — the one reason no
loop ever emits, so it cannot be forged.

## A3. Three event domains (`architecture.md:57–59`)

**Durable session events** (survive reload; commit = push; `session/event` broadcast is
post-commit fire-and-forget) · **live agent events** (`agent/*`, in-flight only —
`agent/pre-step` is the "decide what the model sees" waterfall; "a rejected or empty
first claim still closes a durable turn that spent no step, **so the log records the
attempt**") · **capability events** (`fs/*`, `tools/*` — policy at seams). Pantheon
mapping: grounding injection = `user/message` w/ `form:'recall'` (durable); bus
delivery = `form:'relay'` (durable); approval ask/decision = log-only audit pair
(durable); taint/admission = pre-step waterfall (live); UsageEvent = **durable writer,
NOT a contained observer** (divergence A-29 below).

## A4. Projections & token accounting

Projections are pure `{key, schema, init, apply, view, stateVersion}` units — 100%
rebuildable from the log; `stateVersion` mismatch discards cached rows instead of
forward-applying garbage; `restoreFloor` returns *one event below* the watermark so a
shrunk log is detected instead of served stale. State-carrying events carry the
**complete post-change state, never bare deltas**.
Token accounting: `TokenUsage { inputTokens (uncached ONLY), outputTokens,
cacheReadTokens?, cacheWriteTokens?, reasoningTokens? (⊂ output) }` — **disjoint by
contract** (billed input = sum of three); rides `assistant/message` ("there is no
separate usage record") with the usage *chunk* as the durable record for failed
attempts. `token-meter` is a heuristic estimator, explicitly "not a billing or gating
input."

## A5. Classification (cluster A)

| # | Pattern | Verdict | Cost | Note |
|---|---|---|---|---|
| A-1 | Single append-only SessionEvent log; history derived, never stored | **Adopt** | M | audit pillar core |
| A-2 | `surfaceOp` append/replace + `sourceEventSeqs` provenance | **Adopt** | M | compaction stays auditable |
| A-3 | Compile-time SurfaceIntent requirement | **Adopt** | S | invariant at zero runtime cost |
| A-4 | Append-time validate + deep-freeze + reentrancy reject | **Adopt** | S | bad event never enters the log |
| A-5 | `ignorable?` default-required; unknown ⇒ refuse reconstruction | **Adopt** | S | textbook fail-closed |
| A-6 | `request/header` full-snapshot EpochHeader | **Adopt** | M | makes identity_state_hash verifiable |
| A-7 | `request/context` outside header equality | **Adopt** | S | route change ≠ envelope change |
| A-8 | Dispatch-time re-derivation invariant, `prepend:true` | **Adapt** | M | ⚠️ dsh ships it OFF — Pantheon runs it always-on/sampled |
| A-9 | Package-owned invariant registry (named, fiber-scoped, atomic release) | **Adapt** | M | maps to control-plane modules |
| A-10 | `verify-package-invariants` (own a check or explain why not) | **Adopt** | S | mechanical anti-rot |
| A-11 | Three-domain event taxonomy | **Adopt** | S | forcing question: "must this survive reload?" |
| A-12 | Waterfall interception w/ mandatory `next()` | **Adapt** | M | Facade taint pass is a natural waterfall |
| A-13 | Refusals close a durable turn ("log records the attempt") | **Adopt** | S | refusals as durable as acceptances |
| A-14 | `approval/asked`+`decided` log-only pair, fail-closed `unavailable` | **Adopt (shape only)** | S | ⚠️ decision stays at Peta |
| A-15 | `approval/policy` last-wins, never in model transcript | **Adapt** | S | |
| A-16 | Crash repair: synthetic unforgeable `interrupted` turn/end | **Adopt** | S | never truncate |
| A-17 | `session/end-seed` seed-vs-live boundary | **Adapt** | S | lite resume/fork; NOT a liveness signal (leases are) |
| A-18 | Projection seam (init/apply/view/stateVersion) | **Adopt** | M | every read model rebuildable |
| A-19 | stateVersion invalidation + restoreFloor one-below anchor | **Adopt** | S | detects shrunk log |
| A-20 | Whole-value state events, never bare deltas | **Adopt** | S | |
| A-21 | `ContextForm` incl. `recall` + `relay` (who vs what axes) | **Adopt** | S | drop-in for trusted:false provenance |
| A-22 | Storage domains `{name, version, tables(zod)}`, reject-don't-migrate | **Adopt** | M | better-sqlite3+zod maps 1:1 |
| A-23 | Backend-agnostic durability seam + shared conformance suite | **Adapt** | M | one contract suite, every backend |
| A-24 | `TokenUsage` disjoint bucket contract | **Adopt** | S | prevents silent cache double-billing |
| A-25 | Usage anchored to (turn,step)/seq, replace-not-add | **Adopt** | S | **highest-value borrow for UsageEvent** — idempotent de-dupe |
| A-26 | Usage rides the content event ("no separate usage record") | **Reject** | — | 🚩 two authorities + content coupling; keep the separate content-free ledger |
| A-27 | token-meter heuristic estimator | **Inspire** | M | 🚩 second authority if it ever feeds billing |
| A-28 | session-stats timing fold (llmMs/ttft/decode/toolMs) | **Adopt** | S | free latency observability |
| A-29 | `session/event` fire-and-forget, observer failures contained | **Reject for the bus** | — | 🚩 lost message ≠ contained failure; per-consumer cursors are correct — keep them |
| A-30 | Telemetry ships no redaction rules (deployment-mounted) | **Reject as default** | — | 🚩 fail-open export; adopt the waterfall shape w/ default-deny innermost |
| A-31 | Telemetry best-effort + dedupe on (id,seq); ops records unsummable | **Adapt** | S | "signals to alert on, not entries to sum" guards second-ledger drift |
| A-32 | `agent/inbox/spliced` carries full message bodies | **Reject for wake** | — | 🚩 WAKE-NOT-BODY — never inherit this payload for a wake channel |
| A-33 | Profile/bundle layering (see Cluster B for full treatment) | **Inspire** | L | no boot hash verify — Pantheon's ADR-0006 strictly stronger |
| A-34 | SessionHeader outside the log (incl. `agentPreset`) | **Adapt w/ care** | S | ⚠️ model-visible composition partly outside the log; in Pantheon it goes IN |
| A-35 | Correlated event families carry one stable business id | **Adopt** | S | channel/thread groupability without adjacency guessing |

**Session-2 verification (A):** persistence write-batching/crash-repair in source;
projection-cache read ladder implementation; telemetry per-record containment; SQLite
vs JSONL backend deltas; session-query FTS lifecycle. (Everything about
`Session.append`, both invariant companions, `TokenUsage`, the usage fold, and
invariants-off-in-product was **confirmed in source**.)

---

# Cluster B — Identity packages · isolation · lifecycle · fork

**Headline:** composition-as-ordered-patches with `--dump-config` sharing the exact
boot code path is the identity-package answer; scoped registration's "visibility and
lifetime from one fact" is the study's single best idea. But dsh **explicitly
disclaims authority boundaries** ("Scopes route trusted same-process plugins; they are
not sandboxes or authority boundaries") and its config **trust posture contradicts
ADR-0006 four separate ways** — adopt the mechanics, keep Pantheon's trust model.

## B1. Layered composition (source-verified)

No base file — composition applies patches **over an empty root**: each bundle in
profile order → profile `cordis.patch.yml` → **home patch (machine-local — outranks
the profile layer!)** → `--patch` overlays in argv order
(`apps/cli/reference/README.md:9`; `packages/boot/app-boot/src/profile.ts:405–421`).
Patch mechanics: target by **row id**; per-field wholesale replacement (no deep
merge — "a profile override restates the bundle fields it keeps"); `name` is a
non-applied **guard** (mismatch = skip loudly); `insert` appends; **no remove verb**
(patch `disabled: true`); **unmatched patch = stderr warning, composition continues**
(fail-open — rejected below). All layers flatten into ONE patch application.

`--dump-config` is the flagship: composes **offline with the same
`applyEntryPatches` the boot path uses** ("so the result equals what `boot()`
mounts"), renders one **loadable YAML document** with `# == source, patched by layers`
provenance comments from positional prefix-diffing, prints `!!js` expressions
unevaluated, and `--dump-default-config` skips the user layer entirely as the recovery
diagnostic for a corrupt overlay.

## B2. Scoped registration & isolate realms

`agent.ctx` registrations are "**scope-visible AND scope-lifetime (one fact drives
both)**" — impossible to register something visible in A's scope but disposed with
B's. Scope keys are opaque objects compared by identity (the Agent IS its key);
registration views inherit DOWN the parent chain, event admission extends UP, never
the reverse. Tool isolation: shadowing (most-specific-wins) + restrictions composing
by **intersection**, and — the fail-closed jewel — "a filtered-away global tool is
absent from the prompt AND refuses execution, **indistinguishably from a nonexistent
one**" (`glossary.md:19`). Declared holes (dsh's own honest list): only scope-aware
APIs isolate ("an arbitrary Cordis service remains context-global merely because it is
called through a scoped context"); handing out a scope ctx hands out the minter's
services, and "a broader minter cannot later be narrowed by the holder."

**Isolate realms** (per-package service instances) work but are expensive, and dsh
documents the costs: realm services are invisible even to the host (every browser RPC
needs a keyed `serviceFor` read-through; DI across the realm is structurally
impossible); every service row needs a **permanent host-plane vs realm-local decision**
(~80 lines of per-row justification in the shipped preset config, several with bug
histories); a **fiber-topology footgun with a shipped postmortem** (ancestor-only
resolution; the unit-test bypass makes the failure test-invisible; rule: read optional
services with `ctx.get()`, never property reads); **superseded preset generations are
never reclaimed** (watcher sets accumulate per config edit). Presets mount **once per
process; N sessions join by scope-key parentage** — per-session separation is a
per-plugin *convention* (key your state by Session/Agent), not an enforced boundary.

## B3. Reversible effects — the clean-unmount model

"Registrations are effects": every contribution returns a disposer attached to the
mounting plugin; anything else (timers, watchers, subprocesses, connections) must be
`ctx.effect()`-wrapped. The four hard rules: disposers run in reverse order but
**async disposers run concurrently** (sequence inside one disposer); "dispose must
reach **quiescence**, not just request it" (kill → await done); **close listener
registries BEFORE killing work** so late completions land silent; `dispose()` is
idempotent and race-safe (one shared completion). The reference teardown
(`AgentHandle.dispose()`): stop loop → await exit → unregister → detach session →
unwind scoped world. The disposer is a **capability** (only the mounting owner holds
it — a registry lookup returns a bare handle with no teardown power); provider unload
stops and drains every live handle it made; creation is transactional (rejection rolls
back without publishing an id). **For Pantheon: a manual "remove instance from all
channels" sweep is the anti-pattern — channel joins registered through the instance's
scoped context unwind automatically.** `ctx.effect()` is portable to plain TS as a
reverse-order disposer stack; no framework needed.

## B4. `ctx.sessions.fork` — false friend, with the real answer nearby

`fork(source, boundary?, childId?)` deep-clones a **conversation-log prefix**
(inclusive seq boundary; **rejects a prefix ending inside an open turn instead of
clipping silently**; typed error codes) into a new live child with
`parentSession`/`seedLength` lineage. **It is NOT Pantheon's divergence workflow**:
wrong subject (copies events, never composition), wrong authority direction (a branch
that never reconciles vs a recorded divergence that gets ratified or reverted), wrong
lifecycle stance (runtime state as source-of-truth is what ADR-0006 forbids). It IS
the right primitive for conversation branching and delegation seeding.
**The real transferable answer:** dsh records a config swap as a durable session event
(`agent-preset/selected`) appended after the swap commits — "the preset decides the
tool schemas and prompt sections the model sees, so it has to be reconstructable from
the log." **A config change is an ordered fact in the same log as the work it
governs** — that is the shape Pantheon's divergence documentation should take.

## B5. Classification (cluster B)

| # | Pattern | Verdict | Cost | Note |
|---|---|---|---|---|
| B-1 | Ordered patch layers over an empty root | **Adopt** | M | Profile = base + identity + instance overrides |
| B-2 | Patch-by-row-id, whole-value replace, no deep merge | **Adopt** | S | legibility over convenience |
| B-3 | `name` as non-applied patch guard | **Adopt** | S | free integrity assertion |
| B-4 | Unmatched patch = warning, continue | **Reject** | S (invert to throw) | 🚩 a dropped grant-restriction is a security event — fail-closed |
| B-5 | Home patch outranks profile patch | **Reject** | S | 🚩 machine-local layer overriding master-derived config inverts ADR-0006 |
| B-6 | `--dump-config` sharing the boot code path + provenance comments + loadable output | **Adopt** | S–M | **highest-value pattern in the study** — identity introspection, provably drift-free |
| B-7 | `--dump-default-config` recovery diagnostic | **Adopt** | S | boot-diagnose a corrupt overlay w/o parsing it |
| B-8 | Boot audit fails loud + disposes the partial tree | **Adopt** | M | no half-mounted context survives |
| B-9 | Staleness by mtime+size stamp, advisory | **Reject** | S (sha256 + hard fail) | 🚩 ADR-0006 requires hash + refuse-to-start |
| B-10 | Agent-writable preset root; `trust` presentational | **Reject** | S | 🚩 identity could self-grant; registry must be read-only projection |
| B-11 | Scoped registration: visibility+lifetime from one fact | **Adopt** | M | the study's best idea |
| B-12 | Opaque object scope keys + parent chain | **Adapt** | M | instance object as key; skip the chain unless lite instances share a mount |
| B-13 | Filtered tool = absent from prompt AND refuses execution, indistinguishable from nonexistent | **Adopt** | M | exactly Pantheon's grant semantics |
| B-14 | Restrictions compose by intersection (monotonic narrowing) | **Adopt** | S–M | later layers only reduce authority |
| B-15 | Generated scoped-dispatch invariant (Program-backed) | **Inspire** | L→S | right instinct; codegen over-engineered — dev-mode assert instead |
| B-16 | `Scoped<T>` compile-time brand | **Adopt** | S | mis-dispatch = type error, free |
| B-17 | Opt-in isolation ("arbitrary service is context-global") | **Reject as posture** | M | 🚩 opt-in isolation is opt-out leakage — default-deny instead |
| B-18 | "Scopes are not authority boundaries" | **Reject as posture** | L | 🚩 routing ≠ isolation; Pantheon's boundary stays Peta + process/store separation |
| B-19 | Cordis isolate realms | **Inspire** | L (replicate) / M (plain DI container) | costs documented incl. postmortem; get the result explicitly |
| B-20 | `serviceFor` keyed read-through for out-of-band RPC | **Adapt** | S–M | Fastify routes need exactly this if services go per-identity |
| B-21 | Preset mounted once, N sessions join by parentage | **Adapt** | M | fits LITE identities; full identities get dedicated mounts; enforce per-session keying, don't assume |
| B-22 | Superseded generations never reclaimed | **Reject** | S | leases already give the join count dsh lacks |
| B-23 | Mount gate: refuse unscoped/unusable/root-realm rows, re-checked on async publish | **Adopt** | M | fail-closed identity-mount gate |
| B-24 | Mounted subtree no-ops `write()` ("config is input, never persistence target") | **Adopt** | S | one-way projection, verbatim |
| B-25 | Registrations-are-effects + `ctx.effect()` disposer stack | **Adopt** | M | plain-TS portable; unmount foundation |
| B-26 | `AgentHandle.dispose()` ordering | **Adopt** | M | ready-made unmount checklist |
| B-27 | Disposer as capability | **Adopt** | S | A cannot unmount B via lookup |
| B-28 | Provider unload drains every live handle | **Adopt** | M | structural orphan backstop |
| B-29 | Quiescence not request; close registries before killing | **Adopt** | S | the two universal teardown bugs, as rules |
| B-30 | Async disposers concurrent; sequence inside one | **Adopt** | S | non-obvious footgun |
| B-31 | Idempotent race-safe dispose | **Adopt** | S | routine under expiring leases |
| B-32 | Refcounted shared registrations | **Adopt** | S–M | N lite instances, one package |
| B-33 | Transactional creation (rollback publishes nothing) | **Adopt** | M | no half-mounted identity is addressable |
| B-34 | `sessions.fork(source, boundary?)` | **Adapt** | M | conversation branching yes; divergence workflow NO (false friend) |
| B-35 | Fork rejects open-turn boundary, typed errors | **Adopt** | S | fail-closed on ambiguous state |
| B-36 | `session/end-seed` + durable `seedLength` | **Adopt** | M | which bytes did THIS instance produce — per-slug attribution |
| B-37 | Config swap = durable appended event (`agent-preset/selected`) | **Adopt** | M | **the real divergence-documentation answer** |
| B-38 | Model-visible ⟺ logged (shared with A) | **Adopt** | M | divergence auditable by construction |
| B-39 | Deep-Cordis-fluency cost of realm plane-assignment | **Reject (the cost)** | L | recorded per spec: pattern not adoptable without the paradigm tax |

**Session-2 verification (B):** live `--dump-config` stdout; root-realm mount
rejection (leaky vs isolated fixtures); `AgentHandle.dispose()` ordering against a
live tree; `packages/core/scope/src/index.ts` + `store.ts` (the synchronous
effect/undo rule); the `.agents/notes/implemented/architecture/` rationale notes.

---

# Cluster C — Capability seams · tool pipeline · approval · subagents

**Headline:** dsh's fail-closed *primitives* (monotonic guards, closed outcome
vocabulary, frozen args, `allowed-once`, unlogged-decision-rejects) are excellent and
adoptable nearly verbatim. Its *placement* of those primitives — in-process, optional,
listener-registerable, zero tool classification, no durable pending state — is the
opposite of Pantheon's gateway doctrine. **Take the mechanisms; reject the topology.**

## C1. Seam grammar (Service Definition / Provider / Consumer)

A seam = swappable capability with three roles: Definition (owns the `ctx.<key>` and
vocabulary types), one-or-more Providers, one-or-more Consumers — "complete, never one
role" (`architecture.md:100`, `glossary.md:9`, `AGENTS.md:109`). Binding is by string
key + declared injection, chosen at composition time; two shapes exist (single-provider
like `ctx.shell`; named-registry like `ctx.subagents`). Payoff: one provider swap moves
the whole product (e.g. `subprocess-local` → `subprocess-e2b` relocates seven consumers
into a remote sandbox, `capability-seams.md:447`); test doubles are first-class
providers (`llm-replay`). **Explicitly NOT an authority boundary** — dsh's own README:
`toolFilter` "is not a parent-derived authority ceiling"; agent-scope "security and
authority are non-goals" (`packages/subagent/tool-subagent/README.md`). A seam is DI,
never a gateway.

## C2. Tool pipeline — six stages, not three

`tools/pre-execute` (reorderable allow/deny/ask waterfall) → **monotonic guards** →
`tools/execute` (around-dispatch) → `tools/post-execute` (inspect/replace result) →
`finalizeContent` → `tools/result` (immutable emit) (`tools.md:172`,
`tool-execution-pipeline.md:6`). Approval resolves *before* guards — a guard can still
deny a human-approved call; guards are the last word (`tool-execution-pipeline.md:39,60`).

Load-bearing rules (verbatim-cited in the study record):
- **`next()` = delegate; return-without-next = short-circuit veto** (`cordis-primer.md:30`).
- **Args are frozen before policy; pre-execute may NOT rewrite arguments** — "arguments
  are already logged and presented" (`tools.md:311,379–389`). What the human approved is
  byte-identical to what executes.
- **Monotonic guards have no allow result** — `(execution) => string | undefined`;
  "listener ordering cannot turn a denial back into permission" (`tools.md:315–324`).
  The single best primitive in dsh.
- Post-execute may `block` (removes value, emits corrective feedback) or replace
  content — with dsh's own warning that replacement is presentation, not
  confidentiality (`tools.md:404`).
- **Code-execution transport is not a bypass**: Code Mode sub-calls run the same
  pipeline with the parent token; a model-direct native call in code mode is denied
  `UNKNOWN_TOOL` before policy (`tool-execution-pipeline.md:60`, `tools.md:196–205`).

## C3. Approval — the core DIVERGENCE

dsh approval is a **"readonly same-process permission question"** (`approval.md:56`):
an optional in-process service resolved by `ctx.get('approval')` (absent → degrade to
deny; `packages/core/tools/src/index.ts:1678–1729`). The answerer chain is a waterfall
listeners can join — including MACHINE answerers (ACP bridge: "Clients may answer
automatically"). Lifecycle is ask → single-decision-slot → decided; **no durable
pending record, no TTL/expiry anywhere** (verified: zero hits in
`user-approval/src`); only a log-only audit pair `approval/asked`/`approval/decided`
with a strong atomicity rule ("returning an unlogged decision would violate the
pair"). Permission presets are a 2-axis UI bundle (sandbox × approval policy) with
**zero per-tool information**; dsh has **no read-vs-write tool classification at all**
(`ToolCallKind` "picks an icon on a generic card", `tools.md:466`).

**Divergence table (vs ratified Pantheon doctrine):**

| Pantheon (ratified) | dsh (actual, verified) | Verdict |
|---|---|---|
| Authorization at the GATEWAY, server-side, non-optional | In-process optional service, co-resident with what it gates | 🚩 core contradiction |
| Explicit read-vs-write classification, no defaults | No classification exists; `ask` only from external hooks + sandbox escalation | 🚩 dsh gap — Pantheon strictly ahead |
| Explicit HUMAN approval for dangerLevel:2 | Answerers may be machines; type system can't tell human from bot | 🚩 |
| Durable pending/approved/rejected/expired; timeout ⇒ no execution | In-memory promise; process death = fail-closed but nothing survives restart | 🚩 Pantheon's async HITL needs what dsh lacks |
| Fail-closed | Fail-closed, rigorously (closed vocabulary; `unavailable` normalization) | ✅ agrees — adopt the rigor |
| Display the proposed write | Request deliberately omits args; UI attaches by `callId` to the already-streamed call — no second copy to drift | ✅ agrees, better mechanism — adopt |

## C4. Subagents — one seam, six providers, and the shape Pantheon needs

`SubagentProvider` contract: `name`, static `capabilities` (rejected loud if
unsupported — "never accepted-then-ignored", `subagent.md:13–20`),
`inheritsParentContext`, `start()`, optional `prepareContinuable` (method presence IS
the capability). Providers: `spawn`/`fork` (in-process, full capabilities,
continuable) vs `acp`/`codex`/`claude-code`/`dsh-sdk` (out-of-process, zero start
capabilities, strictly one-shot). **Peer-ness and controllability are inversely
related in dsh** — its biggest structural limitation for Pantheon.

The valuable shape: **continuable child** = durable Session + ≤1 live Activation +
"the Agent inbox is the only queue"; `followup()` routes purely on residency
(running→enqueue / waiting→wake / absent→**cold-resume with no provider involved**).
Delivery splits **quiet** (`inject`, no turn) vs **wakeup** (`followup`, one turn) —
exactly the Autonomy Driver's axis, except dsh's wake carries the body (Pantheon's
carries ids only — adapt the payload, keep the split). Distinct provenance kinds
(`subagent-report` = child's words vs `subagent-settled` = runtime's account; "never
credit the child with words it never wrote") reinforce Pantheon's provenance doctrine
as types, not conventions. `listChildren()` enumerates durable children with no Agent
load and per-child `corrupt`/`unavailable` rows — "one damaged sibling cannot hide
healthy children" — directly transplantable to the lite-session registry.

Honest identity mapping: Alden-1 ≈ root Agent (NOT a subagent — dsh agrees);
Cloud Alden has **no dsh analogue** (every dsh relationship is parent→child; no
sovereign peer); lite instances ≈ continuable children — which dsh can only do
in-process, so Pantheon's session registry closes exactly the gap dsh documents.

## C5. Classification (cluster C)

| # | Pattern | Verdict | Cost | Note |
|---|---|---|---|---|
| C-1 | Seam grammar (Definition/Provider/Consumer, complete-or-not-a-seam) | **Adopt** | S | convention + doc table |
| C-2 | `ctx.<key>` DI + reversible effects | **Adapt** | M | idea yes, Cordis no — small typed registry w/ disposers |
| C-3 | Generated seam graph w/ CI completeness guard | **Adopt** | M | verify guard in session 2 |
| C-4 | Frozen args; no pre-execute rewrite | **Adopt** | S | approved == executed, byte-identical |
| C-5 | Monotonic guards (no allow result) | **Adopt** | S | best primitive in dsh |
| C-6 | Waterfall `next()` interception | **Adapt** | M | ⚠️ hooks/observability only — authorization must never be a listener chain |
| C-7 | Post-execute block/replace | **Adopt** | S | block to hide, replace to present |
| C-8 | Code-mode non-bypass rule | **Adopt (rule)** | S | if a code transport ever lands |
| C-9 | In-process optional `ctx.approval` | **Reject** | — | 🚩 gateway doctrine |
| C-10 | Closed fail-closed outcome vocabulary + `unavailable` normalization | **Adopt** | S | copy the enum + rule |
| C-11 | `allowed-once` only grant, no standing permission | **Adopt** | S | = dangerLevel:2 per-write |
| C-12 | Approval-by-reference (`callId`, no arg re-render) | **Adopt** | S | kills display/execute drift |
| C-13 | Log-only audit pair + unlogged-decision-rejects atomicity | **Adopt** | S–M | model can't read or forge it |
| C-14 | No durable pending approval / no TTL | **Reject** | M to build ours | 🚩 Pantheon ratified expiry |
| C-15 | Machine answerers permitted | **Reject** | — | 🚩 human-only for writes |
| C-16 | Session-settable `never`/`danger-full-access` knobs | **Reject** | — | 🚩 policy belongs to Peta |
| C-17 | Presets as 2-axis UI bundle | **Reject as classification / Inspire as UI** | S | owns no enforcement — good UI shape |
| C-18 | `ToolCallKind` icon-hint "classification" | **Reject** | — | 🚩 cosmetic masquerade; Pantheon ahead |
| C-19 | Two-mode capability discovery, fail-loud | **Adopt** | S | never accepted-then-ignored |
| C-20 | Continuable child (Session + ≤1 Activation, inbox = only queue) | **Adopt** | M–L | THE lite-instance model |
| C-21 | `followup` residency routing + cold resume | **Adopt** | M | the Autonomy Driver dispatch, pre-solved |
| C-22 | Quiet vs wakeup delivery split | **Adopt** | S | ⚠️ adapt payload: ids only, never body |
| C-23 | Provenance kinds as types (report vs settled) | **Adopt** | S | untrusted doctrine, typed |
| C-24 | `listChildren` no-load enumeration + per-child diagnostics | **Adopt** | M | lite-session registry pattern |
| C-25 | Object-identity as credential | **Inspire** | S | principle: attribution ≠ authority; mechanism dies at process boundary |
| C-26 | toolFilter = visibility, explicitly not authority | **Reject for authz / Adopt the honesty** | S | copy the disclaimer, not the mechanism |
| C-27 | Out-of-process children strictly one-shot | **Reject** | L (build what dsh lacks) | 🚩 no cross-process durable identity in dsh |

**Session-2 verification list (C):** CI completeness guard actually fails on
unclassified services; no additional approval answerers in real compositions;
`send_message` direct-parent check enforced at runtime; cold-resume provider bypass
(`packages/subagent/subagent/src/continuation.ts`).

---

# Synthesis (Session 1)

## Per-pillar verdict

| Pantheon pillar | dsh's answer | One-line verdict |
|---|---|---|
| **Audit** | Append-only SessionEvent log + "model-visible ⟺ logged" + full-snapshot request headers | **Strongest match in the study.** Adopt the log shape, the invariant (always-on, unlike dsh), the three-domain taxonomy, and the crash-repair/`ignorable` fail-closed semantics. |
| **Identity packages** | Ordered patch layers + `--dump-config` on the boot code path + config-swap-as-durable-event | **Adopt the mechanics, reject the trust posture** (4 fail-open findings). `--dump-config` is the single highest-value borrow. |
| **Bus isolation** | Scoped registration (visibility+lifetime one fact) + intersection restrictions + indistinguishable-from-nonexistent filtering | **Adopt the semantics; keep Pantheon's boundary.** dsh says out loud its scopes are not authority boundaries — Peta + per-identity stores remain the wall. |
| **Channel governance** | Six-stage tool pipeline: frozen args, monotonic guards, approval-by-reference, closed outcome vocabulary | **Take the mechanisms, reject the topology** — approval is in-process, optional, machine-answerable, with no durable pending state. |

## Divergence rollup (grouped; every item individually flagged above)

1. **Approval topology** (C-9/14/15/16): in-process optional service vs Pantheon's
   non-optional gateway; no durable pending/expiry; machine answerers legal; policy is
   a session-settable knob. *The core architectural contradiction of the study.*
2. **Config trust posture** (B-4/5/9/10/17/18, A-33): unmatched patch warns instead of
   failing; machine-local layer outranks the identity layer; staleness is
   advisory mtime, not hash-refuse; the preset root is agent-writable with
   presentational trust; isolation is opt-in; scopes disclaim authority. *ADR-0006 and
   fail-closed are strictly stronger on every axis — keep Pantheon's.*
3. **Accounting** (A-26/27): usage rides the content event ("no separate usage
   record") and a heuristic meter could become a second authority. *P4: keep the one
   separate content-free ledger.*
4. **Wake/bus payloads** (A-29/32, C-22 caveat): the inbox splice event carries full
   bodies; dsh's wake (`followup`) carries the body; `session/event` fan-out is
   fire-and-forget with contained observer failures. *WAKE-NOT-BODY and per-consumer
   cursors stand.*
5. **No cross-process durable identity** (C-27, B-18): out-of-process children are
   strictly one-shot; peer-ness and controllability inversely related; no sovereign
   peer shape exists. *Pantheon's session registry + leases close exactly the gap dsh
   documents.*

## Flagship adopts (the cost ledger's head — full costs per-row above)

| Borrow | Pillar | Cost | Why it leads |
|---|---|---|---|
| `--dump-config` on the boot code path (B-6) | identity | S–M | "what is this identity composed of right now," provably drift-free |
| Append-only session log + model-visible⟺logged, always-on (A-1/4/8, B-38) | audit | M | reconstruction by construction; refusals durable |
| Config-swap-as-durable-event (B-37) | identity/audit | M | the divergence-documentation answer |
| Frozen args + monotonic guards + approval-by-reference (C-4/5/12) | governance | S each | approved == executed; denial is a one-way ratchet |
| Continuable child + residency routing + quiet/wakeup split (C-20/21/22) | multi-instance | M–L | the lite-instance and Autonomy-Driver dispatch model, pre-solved (payload adapted: ids only) |
| UsageEvent additions: (turn,step)/seq anchor + disjoint token buckets + provider/model (A-24/25) | audit/R18 | S | idempotent de-dupe; no silent cache double-billing |
| Effects/disposer lifecycle + capability disposers + transactional creation (B-25–33) | lifecycle | M | clean unmount without manual sweeps |
| Fail-closed reader semantics: `ignorable` default-required; unknown ⇒ refuse (A-5) | audit | S | never silently resume a gutted session |

## Success criteria check (spec)

- ✅ Every pillar has ≥1 Adopt/Adapt with cited precedent (see per-pillar table).
- ✅ ≥3 Reject-with-reason: **19 rejects** recorded across clusters, each with reason.
- ✅ Zero new dependencies; zero dsh code executed; clone read-only in scratchpad.
- ⏳ ≥5 decision proposals — session 2 deliverable (`dsh-decision-proposals.md`).

## Session 2 plan

1. Run the three clusters' verification lists (targeted source reads; still zero
   execution — the two "verify by running" items are replaced by deeper source reads
   or recorded as unverified).
2. Write `docs/research/dsh-decision-proposals.md`: validate the spec's five seed
   candidates against the map (all five survive session 1, with amendments — e.g.
   "SessionEvent-style schema" gains the `ignorable`/`surfaceOp` semantics; "bus
   isolation as scoped registration" is visibility+lifetime only, authority stays at
   Peta) plus the earned additions: UsageEvent schema amendments (A-24/25),
   config-swap-as-durable-event (B-37), `--dump-config` introspection (B-6),
   fail-closed patch composition (B-4/5/9 inversions).
3. Deliver proposals sized one page each, yes/no/amend-ready for the Karl + Alden-1 +
   Claude-Code ratification session.
