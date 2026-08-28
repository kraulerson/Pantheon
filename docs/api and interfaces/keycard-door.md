# Interface — Session keycard door and admin routes (ADR-0008, PROJECT_BIBLE §7 tier 4)

Two auth domains, no endpoint accepts both tiers.

## The door — `/keycard/v1/*` (keycard bearer ONLY)

Authenticate with `Authorization: Bearer pk1_<64 hex>`. The operator session cookie is ignored here;
the admin bearer is rejected. All routes are `GET`. Every failure is a labeled JSON body.

| Route | Scope | 200 body | Notes |
|---|---|---|---|
| `GET /keycard/v1/whoami` | none | `{ principal, scopes[], expiresAt }` | never the token or its hash |
| `GET /keycard/v1/sessions` | `sessions:read` | `{ sessions: [{ id, identityId, backendId, taintFlag, createdAt, closedAt }] }` | metadata only, newest first, ≤ 500 |
| `GET /keycard/v1/approvals` | `approvals:read` | `{ approvals: [{ id?, tool?, server?, status?, createdAt?, requester?, source }], truncated, failed? }` | reference-only (D8); PENDING from EVERY configured store (`source` = store label; `failed` lists stores that did not answer, omitted when all did — BUGS #42); ≤ 200 items per store, ≤ 256 chars per field; one upstream timeout (10 s) for the whole read |
| `GET /keycard/v1/usage` | `usage:read` | — | `503 { state:"unavailable", message }` until the M2 usage ledger exists |

Failure codes (in order of evaluation): `503 keycard_unavailable` (feature not wired) ·
`429 rate_limited` (door-wide pre-auth budget: 120 refusals / minute; or per-card 60 calls / minute) ·
`401 keycard_required` (no bearer) · `403 invalid_keycard | keycard_revoked | keycard_expired` ·
`403 insufficient_scope` with `required: <scope>` · `404` for any other path in the domain ·
`503 { state:"unavailable" }` / `502 { state:"failed" }` from the scoped routes when their backend is
unwired / unreachable / malformed.

## Admin surface — `/api/keycards*` (operator guard: admin bearer or session cookie)

| Route | Body | Result |
|---|---|---|
| `GET /api/keycards` | — | `Keycard[]` (no token, no hash), newest first, ≤ 500 |
| `POST /api/keycards` (JSON) | `{ principal, scopes: string[], ttlDays? }` | `201 { card, token }` — the token is shown ONCE; `Cache-Control: no-store` |
| `POST /api/keycards` (form) | `principal`, `scopes` (repeatable), `ttlDays` | `303 → /admin/keycards/minted?slot=<nonce>` (one-shot page); validation → `303 → /admin/config?error=keycard_{principal|scopes|ttl}` |
| `GET /admin/keycards/minted?slot=` | — | `200` token page once, then `410` "already collected" |
| `POST /api/keycards/:id/revoke` | — | `204` (JSON) / `303 → /admin/config?notice=keycard_revoked` (form); unknown id `404` / `?error=keycard_not_found` |

Validation: `principal` `^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$`; `scopes` a non-empty array drawn from
`usage:read | approvals:read | sessions:read` (JSON is not coerced — a bare string or a nested
array is `400`); `ttlDays` an integer 1–365 (default 90; a repeated form key is `400`).

State-changing requests the browser labels `Sec-Fetch-Site: cross-site | same-site` are refused
with `403 cross_origin_rejected` before any guard (CSRF; applies to every form on the admin surface).

## Entity

`Keycard { id, principal, scopes[], createdAt, updatedAt, expiresAt, revokedAt|null, lastUsedAt|null,
useCount (served), denyCount (wrong scope / replay after revoke or expiry / rate-limited) }`.
Store: table `keycard`, `token_hash TEXT UNIQUE` = `SHA-256(token)`; never selected into the entity.
