# Walking-Skeleton Milestone — charter

> **AMENDED 2026-08-20 (ruling A-2): this is now MILESTONE 2 (M2), the chat plane.** The
> roadmap is three milestones, terminal-plane first — M1 = terminal plane (session
> comms/waker, scoped session keycard, task board, `pantheon doctor`); **M2 = this
> walking-skeleton chat plane**; M3 = chat-plane capability items. **Ruling C's freeze is
> re-scoped to M2's acceptance checklist below** — M1 terminal-plane work is unblocked as
> the operator's re-prioritized primary plane. `pantheon doctor` is folded into M2 acceptance
> tooling (A-3). See `PRODUCT_MANIFESTO.md` §5 amendment (2026-08-20).

**Declared:** 2026-07-09 (decision C, APPROVAL_LOG ruling — operator-approved feature freeze)
**Status:** OPEN — freeze in effect (re-scoped 2026-08-20 to M2/chat plane per ruling A-2)
**Rule:** no new `feat:` work (nothing new above the MVP cutline) until the acceptance
checklist below passes end-to-end. Skeleton tasks that touch MVP-cutline code follow the
framework's Build Loop as usual; assembly/deployment steps are `chore:`/`build:` work.

## Why

Every component passes its own tests; the composed system has never run. The
pre-processor (the project's reason to exist) is built but not mounted; LibreChat has
never been deployed; Peta has no production instance; the target VM does not exist. The
2026-07-02 landscape re-validation named deployment — not features — the critical path
(§R2). Assembling once, now, surfaces fit-together failures while they are cheap, and
every later phase of the ratified Alden build plan assumes this assembled system exists.

## Scope (in dependency order)

1. **Debian VM on Proxmox** — provision the target VM ([[pantheon-deploy-target]] memory:
   host custody of SSH keys lives there). Finish `scripts/install-debian.sh` gaps: SSH
   keypair generation, `ssh-copy-id` step, LibreChat deploy, Peta deploy.
2. **Peta, hardened** — deploy per ADR-0003 (non-root, no `docker.sock`, remote/HTTP
   downstreams only, LAN/Tailscale only), pinned image.
3. **Control plane as TWO services (ADR-0007)** — split entrypoints (admin service /
   Facade), separate ports + auth domains; **the pre-processor is mounted** in the
   Facade (it is currently unmounted by `src/server.ts`'s own design note).
4. **pino structured logging** (ADR-0002 amendment / Bible §8) — correlation IDs across
   UI → grounding → taint → gateway before first assembled debugging session.
5. **Streaming pass-through** (decision F) — SSE from backend through the Facade to the
   UI; replaces the `"streaming not yet implemented"` seam in `src/backend/client.ts`.
6. **Per-identity cost meter (decision F — RESTORED 2026-07-09; Bifrost not adopted,
   see APPROVAL_LOG same date).** Hand-built in the control plane as the seed of the
   Alden R18 ledger: the Facade records per-identity, per-backend token counts (and
   cost where the backend reports it) for every conversation turn, durable in SQLite,
   **counts/cost only — never prompt or response content**. Single accounting
   authority (P4). The skeleton's local brain is free-to-run but still counted —
   the seam is proven before any metered cloud brain lands.
   **Schema (household-converged, bus msgs 1102 Cloud Alden + 1104 Alden-1, 2026-07-10):**
   per-event rows carry server-authoritative timestamp (never caller-supplied),
   `identity_slug`, `session_id`, `thread_id`, `brain_slug` +
   `brain_classification` (local|cloud-ok, at time of call), prompt/completion/total
   tokens, `cost` (null for local) + `rate_version` (price changes never rewrite
   history), `trigger` (interactive|wake|quiet-loop|consolidation — the oscillator
   budget-governance key), and `identity_state_hash` (Profile hash active at time of
   call — arbitration evidence, Alden-1's addition). `thread_id`+`trigger`+`timestamp`
   are first-class indexed columns (§4.3 arbitration joins). **No-content is a schema
   invariant, not a convention.** Retention: keep long as audit evidence; excluded from
   bus-sweep memory input at source (operational telemetry, not identity memory). The
   ledger is itself an ADR-0006 projection target: rate tables / budget caps read from
   alden-infra with boot-time Profile-hash verification. `thread_id` becomes a real
   bridge column in Alden Phase 0.2 (ships 2026-07-12) — do not build a workaround.
   **P6 amendments (dsh study, APPROVAL_LOG 2026-07-11):** an **anchor** — `(turn,
   step)` or completion-sequence — with replace-not-add semantics on the same anchor
   (idempotent de-dupe for retried completions); **disjoint token buckets**:
   `input_tokens` (uncached ONLY) + `cache_read_tokens` + `cache_write_tokens` +
   `output_tokens` (reasoning ⊂ output; billed input = sum of three — never
   double-count cached traffic); **`provider` + `model` columns** (audit
   `rate_version` against what actually ran); **failed/aborted completions get rows
   too** (that's where costs leak).
7. **Session binding + brain-busy queue** (decision E) — enforce Session's
   identity+backend binding at the Facade; single-slot backend queue with the C.7
   honest labeled wait signal; interactive preempts background.
8. **LibreChat spike** (decision B) — deploy LibreChat pointed at the Facade as a custom
   OpenAI-compatible endpoint. **Decision tree:**
   - Inspector (C.2) renders inside LibreChat → ADR-0001 confirmed; record in
     APPROVAL_LOG.
   - It does not → invoke Investigation A's documented fallback (separate
     control-plane-served inspector view) and **amend ADR-0001** with a new ADR.
9. **Machine-auth design note** (decision F) — design only: service-principal path on
   the Facade for the future Autonomy Driver. Written as `docs/machine-auth-design.md`;
   built at Alden build-plan Phase 3.

### Security hardening pulled in by the 2026-07-09 review (F5/F6)
10. **CSP tightening** — move the harness frame's inline bootstrap to a served file or
    nonce'd script; verify no `unsafe-inline` needed once a real browser is in play.
11. **CSRF token** — per-request token on state-changing admin routes (defense-in-depth
    beyond SameSite=Lax).
12. **Machine-auth TM rows (design-time, with item 9)** — the Facade service principal
    is a distinct credential domain from operator cookie/bearer; add TM entries for the
    admin↔Facade boundary and the ADR-0006 propose-a-change commit authorship (only
    Karl can author/merge alden-infra changes).
13. **C.7 queue depth bound** — reject beyond a fixed queue length (flooding cannot grow
    memory); cost-meter ledger rows carry counts only, never prompt content.

## Acceptance checklist (all must pass)

- [ ] Appendix-A-style smoke test: **one identity, one brain, one conversation, one
      `dangerLevel:2` write held for approval and executed on approve — end to end
      through LibreChat (or fallback UI) → Facade → Peta → downstream.**
- [ ] Denied tool call returns `-32602` and provably does not execute (write-evidence
      pattern from `peta-eval/harness`).
- [ ] Streaming visibly works in the UI (words appear as generated).
- [ ] Cost meter (scope item 6): the smoke-test conversation appears in the meter
      attributed to the correct identity with token counts and **no prompt/response
      content stored**; a second identity's session accrues to its own rows (no
      cross-identity blending).
- [ ] Busy-brain queue: two concurrent sessions on the single-slot backend → the second
      shows the C.7 labeled queue state, then proceeds.
- [ ] Admin-service restart does **not** drop an in-flight Facade conversation
      (ADR-0007 failure-domain check).
- [ ] **Colorblind-safe pass (decision I3)** on every skeleton-visible surface: config
      page, harness frame tabs, C.7 busy signal, inspector — every state distinguishable
      by shape/label/icon, never color alone (CB/TL). A color-only cue is SEV-2.
- [ ] Inspector verdict recorded (inside LibreChat OR fallback + ADR-0001 amendment).
- [ ] **One front door (operator ruling 2026-08-19).** The harness frame is the single entry
      point an operator uses for work: chat and terminal sessions are both started from it, and
      the operator is never asked to visit a second address to begin working. Today the working
      surface answers on a hostname labelled `pantheon-admin`, with chat on a separate address —
      accepted as temporary, NOT as the shape we ship. ADR-0005 already specifies the frame as
      "a single entry point that presents both modalities"; this box makes it checkable.
- [ ] `install-debian.sh` re-run on the VM is idempotent (safe to run twice).
- [ ] CSP passes without `unsafe-inline`; CSRF token present on admin mutations.
- [ ] Queue depth is bounded (test: N+1th concurrent request rejected with a labeled error).

## Explicitly NOT in the skeleton

- New identity provisioning UX, prompt-master, cross-session search wiring, D6
  passkey step-up (its seam stays), machine-auth **implementation**, any Alden
  Phase 3+ component (Registrar/brain registry/profiles).
- Anything on the security review's queue (token rotation, git-history audit, push to
  GitHub) — Opus 4.8 owns those; the skeleton must not wait on them except where
  credentials are literally required to deploy.
- Deferred-with-owner (F5/F6 backlog, not skeleton): SSH host-key pinning before any
  non-LAN terminal use; terminal WS input-flood rate limiting; D6 passkey step-up
  (unchanged, post-skeleton).

## Exit

When the checklist is green: record a ruling in APPROVAL_LOG (freeze lifted), archive
results to `docs/test-results/`, and resume feature work per the MVP cutline — next
candidates: LibreChat integration hardening or fallback-view build-out (per spike
outcome), then registry-projection design (ADR-0006) before Alden Phase 3.
