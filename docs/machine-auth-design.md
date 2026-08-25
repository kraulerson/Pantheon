# Machine Auth — Service-Principal Path on the Facade (Design Note)

**Status:** DESIGN ONLY — decision F (2026-07-09) requires this designed at skeleton
time and **built at Alden build-plan Phase 3**. The skeleton reserves the seam (a
distinct auth domain on the Facade, ADR-0007) but mounts no machine endpoint.
**Scope:** how a *machine* actor — first and foremost the future **Autonomy Driver**
(the single dispatcher of docs/2026-07-10-identity-classes-and-channel-lifecycle.md) —
authenticates to the Facade. Extends Bible §7's three ceremony tiers with a fourth,
non-human tier. Nothing here changes tiers 1–3.

## 1. The actor and its job

The Autonomy Driver watches the comms bridge queue and wakes exactly one session per
identity/thread (claim/lease + thread affinity). To do that it must be able to:

- ask the Facade to **wake/dispatch** a session for identity X (or start one, subject to
  the identity-class rules: full = 1 active session cap, lite = instance minting);
- read **queue/lease state** (which instances are live, which threads are claimed);
- **renew/release leases** and set/clear the **loop-safety pause flag** (A1 pause
  authority — pause, never kill);
- have its actions land in the audit trail and in `UsageEvent.trigger`
  (`wake | quiet_loop`) so unattended spend is distinguishable from operator-talk.

What it must NEVER be able to do (deny-by-default, enforced Facade-side):

- approve or resolve a `dangerLevel:2` write (that is the operator's D6 step-up,
  exclusively — unattended approvals are the Opus 4.8 permission-relay lane);
- read **message bodies** (wake-not-body applies to the Driver itself: it routes on
  queue *metadata* — sender, ids, thread — never content);
- reach the admin surface or any Configuration/registry mutation (TM-011 unchanged);
- mint, widen, or read identity tokens; rebind identities (#14a); touch custody handles.

## 2. Principal model

- A **service principal** is a first-class actor kind: `svc:<name>` (first:
  `svc:autonomy-driver`). It is NOT an Identity (no persona, no Peta user, no memory,
  no bus voice) and NOT the operator.
- One principal per machine service; no shared credentials. Future machine actors (e.g.
  a dormancy reaper) get their own principals with their own grant sets.
- Grants are a **closed enum of machine capabilities**
  (`dispatch_wake | read_queue_state | lease_manage | loop_pause`), stored as a
  per-principal grant table, deny-by-default. `svc:autonomy-driver` gets exactly the
  four above; nothing else exists to grant.

## 3. Credential + custody

- Credential = a ≥256-bit bearer minted at provisioning, mapped to the principal by
  `principalId = SHA-256(token)[:32]` (same shape as Peta user tokens; token entropy is
  the whole of auth; constant-time comparison).
- **Custody invariant unchanged (Bible §5 Principle 1):** the raw token lives in Peta
  vault custody; the Driver's runtime config carries the raw bearer only in its own
  gitignored env (like `BRIDGE_MCP_TOKEN` today), and the Facade stores only the hash.
  Never logged (allow-list redaction), never in a URL, never in an error body.
- **Rotation:** re-mint + swap env + revoke old hash row; two-hash overlap window
  allowed for zero-downtime rotation. **Revocation:** delete the hash row — fail closed
  on the next call.

## 4. Transport + surface

- The Facade mounts a separate **machine API** (`/machine/v1/*`) on the machine auth
  domain (ADR-0007 anticipated exactly this split: "session + machine auth" on the
  Facade). Endpoints (Phase 3): `POST /machine/v1/dispatch`, `GET /machine/v1/queue`,
  `POST /machine/v1/lease/{renew|release}`, `POST /machine/v1/pause` + `/resume`.
- **Network wall:** the machine API binds to the internal compose network only — it is
  NOT published through Caddy and not reachable from LAN/Tailscale. The Driver runs
  inside the same Docker network. (Defense-in-depth with the bearer, not instead of it.)
  *Note (2026-08-25, ADR-0008):* the **session keycard** door (`/keycard/v1/*`, the CLI-session
  read tier) deliberately does NOT get this wall — its holders live on LAN dev machines — and
  rides the admin service behind the internal-DNS Caddy entrance instead. The wall above still
  binds the future Autonomy Driver machine API on the Facade.
- Operator UI auth (cookies) is **rejected** on `/machine/v1/*`; machine bearers are
  **rejected** everywhere else. No endpoint accepts both tiers.

## 5. The impersonation boundary (load-bearing)

When the Driver dispatches a wake for identity X, the Facade — not the Driver — runs
the normal session machinery: identity-class check (full-session cap / lite instance
mint), lease registration, and the identity's own per-identity Peta token for any tool
calls, exactly as if the operator had opened the session. **The Driver's credential
never becomes an identity credential.** The Driver is a *trigger with a budget*, not an
authority: policy lives Facade-side, and a compromised Driver token can wake, pause,
and read queue metadata — nothing more. That is the whole blast radius by construction.

## 6. Abuse & failure analysis

| Scenario | Outcome |
|---|---|
| Driver token stolen | Attacker can wake sessions (rate-limited), renew leases, pause relays. No writes, no bodies, no admin, no identity tokens. Detection: AuditEntry anomalies; response: revoke hash row. |
| Wake storm (bug or abuse) | Per-principal **rate limit** on `dispatch` (constant tune-at-deploy) + the loop-detector backstops on the session side. |
| Driver down | Fail-safe: no wakes happen; sessions idle; leases expire naturally; nothing is lost (mail accumulates behind cursors). |
| Facade restart | Machine grants + lease state persist in SQLite; the Driver retries with backoff. |
| Pause abuse | Pause is the Driver's most privileged verb and is deliberately fail-safe: pausing can only *stop* unattended activity, never start or approve it. |

## 7. Audit

Every machine call writes an `AuditEntry`: `actor = svc:autonomy-driver`, new `action`
values `machine_dispatch | machine_queue_read | lease_renew | lease_release |
loop_pause | loop_resume`, `outcome ∈ {allow, deny, error}`, correlation ID propagated
into any session activity the dispatch caused (so "why did this session wake at 3am"
is answerable end-to-end). Denied machine calls are audited too (deny-by-default is
only trustworthy if denies are visible).

## 8. Build plan (Phase 3, per decision F)

1. Grant table + bearer-hash auth guard on the Facade machine domain (unit-tested,
   deny-by-default proven by test).
2. `/machine/v1/*` endpoints behind it, internal-network bind.
3. Driver provisioning script: mint token → vault custody → grant row → env handoff.
4. Negative tests in the Phase 3 acceptance: machine bearer rejected on admin + session
   surfaces; operator cookie rejected on machine surface; revoked hash fails closed;
   dispatch rate limit trips.

The skeleton's only obligation (scope item 9): this document, plus keeping the Facade's
auth-guard module shaped so a fourth tier slots in without touching tiers 1–3.
