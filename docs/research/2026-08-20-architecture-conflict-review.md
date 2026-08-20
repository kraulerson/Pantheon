# Architecture-Conflict Review — Capability Decisions vs. Existing Canon (2026-08-20)

> **STATUS: REVIEW, pre-ruling.** Reviewer: Fable 5 (session model), full decision context.
> Measures the 20 rulings in `docs/research/2026-08-20-capability-decisions.md` against
> `PRODUCT_MANIFESTO.md`, `PROJECT_BIBLE.md` (ADRs, D-rulings, CC1–CC3), the walking-skeleton
> charter, and `APPROVAL_LOG.md`. Four items need a Karl ruling BEFORE the architecture docs
> are mutated (§A). The rest are design reconciliations Fable resolves in the update (§B). One
> reassurance up front (§0).

## §0 — The reassuring finding first

**None of the 19 adopts is an adoption of an external system.** Every one was ruled PASS on the
four-part test *as a pattern build in our own code*, not as importing OpenClaw/Odysseus/Hermes
(all three REJECT-as-adoption; Hermes's FROZEN status is now closed). So the decisions do **not**
trigger the "three external infrastructure layers / adoption creep" concern Alden-1 warned of
(APPROVAL_LOG 2026-07-09). Pantheon stays hand-built; it borrows shapes. That is consistent with
ADR-0001's adopt-only-validated-boundary-code doctrine and the manifesto intent clause.

## §A — Needs a Karl ruling before the Bible is edited

### A-1. Terminal transcript recording (TP-7) contradicts the founding intent — this is the sharp one
The manifesto's intent clause (line 28) is explicit: the harness exists to orchestrate AI
"**without the harness ever becoming a prompt-injection vector**," and D8 keeps secrets out of any
store a session could reach; ADR-0005 deliberately keeps CLI sessions **outside** the data
pipeline. TP-7 records terminal streams — which routinely display passwords, keys, and `cat`'d
secrets — into a durable, searchable store (NAS). NAS-vs-local changes *where*, not *whether*, that
store exists.
- **Karl already ruled ADOPT with NAS storage.** What still needs his explicit sign-off: (a) this is
  a **named exception to D8 + ADR-0005** and gets its own APPROVAL_LOG ruling; (b) **default-on vs
  per-tab opt-in**; (c) the mandatory safeguards are binding (redaction-before-write,
  encryption-at-rest on the NAS, access control, retention). Recommendation: **per-tab opt-in,
  off by default** — it minimises the secret-exposure surface while still giving Karl the capability
  where he wants it, and it keeps the intent clause defensible.

### A-2. Milestone structure — terminal-first re-scope vs. the chat-centric skeleton
The walking-skeleton charter's acceptance checklist is almost entirely **chat plane** (Facade,
streaming, cost meter, session binding, LibreChat spike, one gated write). On 2026-08-19 Karl
re-scoped so the **terminal plane ships first**. The 20 decisions pile a substantial terminal-plane
roadmap on top (TP-1 waker guardrails, TP-3 session keycard, **TP-4 board promoted to MVP**, TP-5
wake levers, TP-7 transcripts). These cannot all sit "post-skeleton" if the terminal plane is now
milestone one.
- **Needs a ruling:** does the roadmap become **M1 = terminal plane** (terminal comms + keycard +
  board + doctor) → **M2 = walking skeleton / chat plane** (Facade…gated write) → **M3 = chat-plane
  capability items**? Or do they interleave? TP-4-as-MVP + terminal-first strongly implies TP-4 is
  in M1. Recommendation: **explicit three-milestone structure, terminal plane as M1**, and re-title
  the "walking skeleton" as M2 rather than "the" milestone. The Opus 5 build plan is built against
  whatever ordering Karl rules here.

### A-3. Ruling C freeze vs. "start during the skeleton" items
Decision C freezes new `feat:` work until the skeleton's acceptance checklist is green
(APPROVAL_LOG 2026-07-09; charter Status: OPEN). Two adopts are marked "start now":
- **CH-3 token-sanitizer** folds into **step-06**, already a skeleton step — **no exception
  needed**, it rides existing scope.
- **XC-2 `pantheon doctor`** is new work. It is *assembly/verification tooling* that directly serves
  the skeleton's own M2 network-test and acceptance checks, so it is arguably skeleton-supporting
  rather than a product feature — but that is a judgement call.
- **Needs a ruling:** grant `pantheon doctor` a **Ruling-C freeze exception** (as the CLI-channel
  spike got), OR fold it into skeleton acceptance tooling, OR hold it until freeze lifts.
  Recommendation: **freeze exception + build as `chore:`/tooling** — it pays for itself immediately
  in the assembly phase and covers the untested obsidian-mcp vault transport.

### A-4. CH-4 frontier Compare introduces real out-of-plan spending
Compare-against-frontier means outbound calls to **Anthropic / Gemini / OpenAI APIs**. Gemini and
OpenAI are **not** on the Max plan — they bill per token in real dollars, and they need their own
API accounts/keys. This is the first time Pantheon would spend money outside the subscription.
- **Needs a ruling / confirmation:** do you have (or will you provision) Gemini + OpenAI API
  credentials, and do you accept per-call billing for Compare runs? Also confirmed as binding: the
  **#14a guardrail** (Compare only in bare/ungrounded sessions — never send an identity's grounded
  memory to a cloud frontier model) and the egress-allowlist tie-in (XC-3). Recommendation: **keep
  CH-4 but gate the cloud arm behind an explicit per-provider key + a "this costs money" confirm**;
  local-vs-local Compare needs neither and can ship first.

## §B — Design reconciliations Fable resolves in the update (no ruling needed, recorded for transparency)

| Tension | Resolution written into the architecture update |
|---|---|
| **TP-4 30s board cron** ↔ TP-5/TP-1 wake discipline + "wake when needed" | The 30s poll is a **harness-side check, not a model wake** — it reads the board and injects a session turn *only* when the board actually changed *and* the session is idle. Compatible with "wake when needed" (Karl) because idle polling costs no model turn; honours TP-1 "new turn only when idle." |
| **CH-2 Qdrant compaction** ↔ grounding pipeline (#13/#4) + D5 sticky-taint | Qdrant offload/restore routes **through the taint engine**: restored chunks are recalled content ⇒ `trusted:false`, inspectable, and taint the session. A compaction summary is model-generated ⇒ also `trusted:false`. D5 keeps the session tainted; no laundering path is created. Compaction becomes a *grounding-pipeline* feature, not a Facade-only one. |
| **TP-2 unified Pending-Approvals inbox** | New **admin-surface aggregated view** over the durable ApprovalRecord store (Peta): one list of every pending approval across all sessions, reference-only (identity, tool, target, age) — **no arguments/diff in the list** (D8); opening one goes to the existing D6 step-up resolution surface. Extends C.3, does not replace it. |
| **XC-8 Vaultwarden at startup** ↔ CC2 fail-closed | If Vaultwarden is unreachable at boot, the service **fails closed** (does not start with missing/stale secrets) rather than degrading — consistent with CC2. Startup fetch of service tokens only; **Peta's tool-credential vault invariant is untouched** (two distinct custody roles). |
| **XC-3 egress allowlist** contents | Allowlist = Anthropic API + (CH-4) Gemini/OpenAI once Compare's cloud arm lands + apt/npm mirrors + LAN services; everything else denied; `pantheon doctor` (XC-2) reports egress state. |
| **XC-1 / XC-4 / XC-5 / XC-6 / XC-7** | Pure additions, no canon conflict. XC-4 populates R4's already-mandated `tier` column (do while tables are young). XC-5's stored-plan-reuse and sealed-exact-action are recorded as **independent convergence** with P4/P8/C-12 (validation, not change). XC-6 is CC2 specialised (one Bible sentence). |
| **CH-1 group mechanics / CH-5 memory queue** | CH-1 = presentation borrow into C.8; substrate stays the bus (per-identity provenance, send=write/D2). CH-5 = propose-only queue is the ONLY permitted form (D2 + CC3); Alden-side owns memory-tier semantics. |

## §C — What the architecture update will touch (once §A is ruled)

- **PRODUCT_MANIFESTO §5 (MVP Cutline):** promote TP-4 (board) above the line; add the milestone
  structure from A-2. Record TP-6 as an explicit non-goal.
- **PROJECT_BIBLE:** new/updated ADRs or Resolved-Decisions for — terminal-transcript exception
  (A-1), Qdrant-backed compaction in the grounding pipeline (CH-2), MCP-schema hardening as a CC3
  extension (XC-1), the tool-effect taxonomy `tier`+integrity axes (XC-4), the tighten-only approval
  invariant (XC-5), the fail-closed inbound-adapter invariant next to CC2 (XC-6), Vaultwarden
  startup custody (XC-8). Record the four-harness study verdict + Hermes FROZEN-closed.
- **APPROVAL_LOG:** one ruling row per §A decision + a batch row for the 19 adopts.
- **walking-skeleton-milestone.md:** reconcile with the milestone structure (A-2); note the
  freeze-exception (A-3) if granted.
- **BUGS.md / CHANGELOG / FEATURES / README (GitHub):** per the doc-update phase.

> **Bottom line:** the decisions are architecturally coherent and stay true to the founding intent,
> **with one genuine tension (A-1, terminal recording) that needs an explicit exception ruling**,
> one structural choice (A-2, milestone ordering), one freeze-handling call (A-3), and one
> spend/consent confirmation (A-4). Everything else composes cleanly.
