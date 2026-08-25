# ADR-0008 — Session keycards: a scoped, read-only machine door for CLI sessions (§7 tier 4)

- **Status:** Accepted
- **Date of decision:** 2026-08-25 (M1 task 2; implements ruling TP-3 of 2026-08-20 — APPROVAL_LOG)
- **Deciders:** Karl (Orchestrator) ruled TP-3 ADOPT ("no management scope, ever — TM-011"); the
  concrete shape below was derived from `docs/machine-auth-design.md` and PROJECT_BIBLE §7 by the
  executor within that ruling.

## Context

A Claude-CLI session running on a dev machine (ADR-0005 terminal plane) has no legitimate way to
ask the harness anything — which sessions exist, what approvals are pending, what it has spent —
except by holding the operator's admin credential, which would put a management credential inside
a model-driven session (TM-011, the exact thing D6 forbids). `docs/machine-auth-design.md` already
designs a fourth, non-human auth tier (service principals, hash-only custody, deny-by-default
grants, a separate auth domain, no endpoint accepting two tiers) for the future Autonomy Driver on
the Facade. TP-3 asks for the same shape, narrowed to read/propose, for CLI sessions — now, on the
admin service, because M1 ships the terminal plane before the Facade exists.

## Decision

1. **A keycard is a distinct actor kind.** `principal` is a free label (`cli-mac-mini`), never an
   Identity, never the operator, never mapped to a Peta user or an identity token. The impersonation
   boundary of the design (§5) holds by construction: nothing in the code path can turn a keycard
   into an identity credential.
2. **Closed read-only scope enum:** `usage:read`, `approvals:read`, `sessions:read`. There is no
   write or management scope *to grant* — the enum is the enforcement (TM-011), not a policy table.
   Adding a scope is a Bible change.
3. **Own auth domain: `/keycard/v1/*`.** The app-level guard dispatches this prefix FIRST (by raw
   path and by route pattern): a keycard bearer is the only accepted credential there — the
   operator cookie is ignored, the admin bearer is rejected — and a keycard bearer is rejected on
   every other route (the admin guard compares it to the admin token: 403). One route per scope,
   all `GET`, plus a zero-scope `whoami`. An unmatched URL under the prefix still meets the keycard
   guard (401), never the admin guard.
4. **Custody = hash only.** The server stores `SHA-256(token)`; the raw `pk1_<64 hex>` token
   (256-bit) exists once — in the JSON mint response, or on a one-shot `Cache-Control: no-store`
   page the Configuration form redirects to (read-and-burn slot; a reload cannot re-mint and the
   token is never in a URL) — then only in the holder's own environment. **Deliberate deviation from
   the design's vault custody of the raw token:** raw custody is the holder's environment, not a
   vault; loss ⇒ re-mint, there is no escrow. A vault copy would be a second theft target for a
   credential whose whole blast radius is three read scopes, and Bible §5 Principle 1 binds HMAC keys
   and Peta tokens, which a keycard is not. The lookup is by hash (indexed equality on a SHA-256
   digest), which satisfies the design's "constant-time comparison" in substance — a timing signal
   could only concern the digest, and steering it needs a preimage. Rotation = mint a new card, hand
   it over, revoke the old (that *is* the two-hash overlap window); revocation fails closed on the
   next call. Keycard principals are bare labels (`cli-mac-mini`); the design's `svc:<name>` namespace
   stays reserved for the Facade's service principals.
5. **Minting, listing and revoking live only on the D6 admin surface** (`/api/keycards`, the
   Configuration page "Session Keycards" section). Default expiry 90 days, max 365.
6. **Approvals through a keycard are reference-only (D8):** a closed allow-list projection —
   id / tool / server / status / time / requester — never arguments, diff or payload.
7. **Deny visibility without an audit log (interim):** each card carries `useCount` (calls actually
   served — counted after the rate check), `denyCount` (wrong scope, replay after revoke/expiry,
   rate-limited), `lastUsedAt`; the door keeps counts of refused authentications (unknown tokens
   have no card to charge) and 429s; all shown on the Configuration page. The per-call `AuditEntry`
   the design wants lands with the M2 step-04 audit/pino work (BUGS #34); this ADR does not pretend
   otherwise.
8. **Bounded:** 60 calls per sliding minute per card and a door-wide pre-auth budget of 120
   refused authentications per sliding minute (beyond it the door answers 429 without a store
   lookup); the approvals read is capped upstream (10 s) and downstream (200 items, 256 chars per
   field). Network wall deviation: the design wants the machine API on an internal-only bind; the
   keycard door rides the admin service behind the same (internal-DNS-only) Caddy entrance because
   CLI sessions live on LAN dev machines, not inside the compose network. Accepted: the keycard
   *prefix* answers 401/403 to anything without a valid card; the *entrance* itself continues to
   serve the admin service's existing public paths (`/login`, `/help`, xterm assets).
9. **Cross-site protection is browser-labelled.** A state-changing request the browser marks
   `Sec-Fetch-Site: cross-site` or `same-site` is refused before any guard (the session cookie is
   `SameSite=Lax`, which still travels on a same-site cross-origin POST — the chat UI is same-site).
   `Origin == Host` was rejected because the household edge proxy rewrites `Host`.

## Consequences

- A stolen keycard can read session metadata (ids, `identityId`, `backendId`, taint, timestamps),
  approval *references* and (later) usage totals for ≤ its TTL or until revoked — and nothing else.
  That is the whole blast radius. Two honest caveats: the holder is on-LAN by construction, so it
  also sees whatever the admin entrance's public paths give any on-network party; and theft is
  visible only through the counters until per-call audit rows exist (BUGS #34). `identityId` is
  included deliberately (metadata, not content); the chat entry's header-only identity auth is an
  M2 concern independent of this door.
- **D6 step-up is not yet enforced on the privileged tier anywhere** (`verifyStepUp` is a stub —
  BUGS #36). Minting a machine credential is the strongest act on the admin surface, so keycard
  mint and revoke are named the first two routes to require the step-up once it exists.
- Data model: the `keycard` table is additive DDL like every table in this service; the entity
  carries `updatedAt`. Whether the Bible's "versioned migrations" wording is amended for the
  single-operator SQLite convention is a ruling for Karl (offered 2026-08-25).
- `usage:read` answers a labelled 503 until the M2 usage ledger exists; the scope and route are
  real so the acceptance ("each scope grants exactly its routes") is testable now.
- The Facade's future machine tier (Autonomy Driver) can reuse `KeycardService`'s shape (hash
  lookup, closed grant enum, counters) with its own principal kind and scope enum; nothing here
  presumes the two tiers share a table.
- Bible §5 gains the **Keycard** entity; §7 gains tier 4; §9 C.5 gains the section. FEATURES 9.
