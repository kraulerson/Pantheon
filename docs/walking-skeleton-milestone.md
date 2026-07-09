# Walking-Skeleton Milestone — charter

**Declared:** 2026-07-09 (decision C, APPROVAL_LOG ruling — operator-approved feature freeze)
**Status:** OPEN — freeze in effect
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
6. **Bifrost spike — CONDITIONAL** (decision F as amended 2026-07-09; replaces the
   original hand-built cost-meter item, which is cancelled permanently). If household
   consent on Bifrost has landed by skeleton execution: deploy Bifrost v1.6.3 pinned in
   **file-only config mode** with all walls (zero MCP clients; localhost bind; Caddy
   path-denies on `/mcp` + UI + `/api`; semantic-cache plugin absent; ledger payload
   redaction on), routing Facade → Bifrost → 122B. If consent has not landed: skip —
   the skeleton has no metered brains, and the spike becomes the first post-skeleton
   item. Either way, no meter is hand-built (`docs/2026-07-09-turnstone-bifrost-eval.md`).
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

## Acceptance checklist (all must pass)

- [ ] Appendix-A-style smoke test: **one identity, one brain, one conversation, one
      `dangerLevel:2` write held for approval and executed on approve — end to end
      through LibreChat (or fallback UI) → Facade → Peta → downstream.**
- [ ] Denied tool call returns `-32602` and provably does not execute (write-evidence
      pattern from `peta-eval/harness`).
- [ ] Streaming visibly works in the UI (words appear as generated).
- [ ] IF the Bifrost spike is in (see scope item 6): the smoke-test conversation
      appears in Bifrost's ledger attributed to the identity's virtual key with token
      counts and **no prompt/response content stored**; `curl` from a LAN host to
      `/mcp` and the Bifrost UI is denied; killing Bifrost mid-session produces a
      labeled "brain unreachable" error at the Facade (fail closed, no retry storm).
      IF the spike is deferred: no accounting acceptance applies to the skeleton.
- [ ] Busy-brain queue: two concurrent sessions on the single-slot backend → the second
      shows the C.7 labeled queue state, then proceeds.
- [ ] Admin-service restart does **not** drop an in-flight Facade conversation
      (ADR-0007 failure-domain check).
- [ ] **Colorblind-safe pass (decision I3)** on every skeleton-visible surface: config
      page, harness frame tabs, C.7 busy signal, inspector — every state distinguishable
      by shape/label/icon, never color alone (CB/TL). A color-only cue is SEV-2.
- [ ] Inspector verdict recorded (inside LibreChat OR fallback + ADR-0001 amendment).
- [ ] `install-debian.sh` re-run on the VM is idempotent (safe to run twice).

## Explicitly NOT in the skeleton

- New identity provisioning UX, prompt-master, cross-session search wiring, D6
  passkey step-up (its seam stays), machine-auth **implementation**, any Alden
  Phase 3+ component (Registrar/brain registry/profiles).
- Anything on the security review's queue (token rotation, git-history audit, push to
  GitHub) — Opus 4.8 owns those; the skeleton must not wait on them except where
  credentials are literally required to deploy.

## Exit

When the checklist is green: record a ruling in APPROVAL_LOG (freeze lifted), archive
results to `docs/test-results/`, and resume feature work per the MVP cutline — next
candidates: LibreChat integration hardening or fallback-view build-out (per spike
outcome), then registry-projection design (ADR-0006) before Alden Phase 3.
