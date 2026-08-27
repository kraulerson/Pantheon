# Adversarial / Exploratory Probe — UAT Session 4

**Date:** 2026-08-27 · **Commit under test:** `e0140d7` · **Sources:** three audits run this cycle —
`docs/security-audits/pending-approvals-inbox-security-audit.md` (2 parallel auditors),
`docs/security-audits/harness-under-chat-address-security-audit.md` (2 parallel auditors) — plus live
probes from VM 1093 through the VM Caddy and the household edge.

**Verdict in one line: no SEV-1 open; every authz / injection / escaping / path-collision / prefix-trust
check passed with a test behind it; the correctness findings (Peta's UPPERCASE `PENDING`, first-page-only
reads, the `'none'` frame policy blanking the embedded chat's links, no chat URL on the admin side) were
fixed in-loop; ONE residual is accepted by ruling (one address = one browser origin, APPROVAL_LOG 2026-08-27).**

## What was probed and what happened

| Probe | Result |
|---|---|
| Inbox with hostile Peta bodies (prototype keys, non-objects, non-string fields, `hasMore` non-boolean, 201+ items, hung socket, thrown detail text) | Reference-only rows or labelled 502/503; upstream text never echoed; caps 200/256/timeout hold; byte bound upstream remains BUGS #35. |
| Lowercase `pending` display filter vs live Peta | Live Peta rejects `status: "pending"` (HTTP 500) and answers `PENDING` → fixed: only `approved/rejected/expired` (any case) hidden; PENDING walk with `pageSize 100`. |
| Attribute-context XSS via `id`/`createdAt`, bidi/zero-width names | Escaped; spoofing code points stripped at the projection. |
| Forged `X-Forwarded-Prefix` on both entrances | Chat site: Caddy overwrites. Admin site: now deleted (`header_up -X-Forwarded-Prefix`) — live: `/evil` → `data-base=""`. Value regex-bound; no open redirect possible. |
| Any console URL escaping the base | Static invariant (17 patterns) + runtime sweep: 0 bare links on `/harness/harness` live. |
| Cookie reaching LibreChat's backend | Cookie `Path=/harness` under the chat address (`/` at the root). |
| WebSocket handshake from a sibling household host | `Sec-Fetch-Site: same-site` → 403 through VM Caddy and the edge; same-origin → 101. (Probe over HTTP/1.1 — h2 drops `Upgrade`.) |
| Console framed by LibreChat content / the embedded chat navigating itself to the console | `frame-ancestors 'self'` refuses cross-origin ancestors (artifacts); a same-origin frame busts to the top window. |
| Caddy path split semantics | `caddy adapt` + live: `/harness` 308 → `/harness/` 302 → `/harness/harness`; LibreChat keeps `/login`, `/api/*`, `/assets/*`. Gotcha found: bind-mounted Caddyfile inode — recreate, don't reload. |
| Terminal fit | Fit on open / ready / tab switch / host resize / window resize; hidden tabs never fitted; missing addon fails closed. Visual confirmation was the operator's (2026-08-27: "The resize bug is fixed."). |

## Open items for the human session to keep in mind

- **No real pending approval has ever been seen by the inbox** (Peta's queue was empty at every probe); the projection's key list is inferred from Peta's request shapes. Scenario with a real gated write is the important one.
- Accepted residual: script on the chat page = the console (ruling 2026-08-27). Guardrails on file.
- BUGS #35 (client byte cap), #37/#38, #40 (cookie shadowing on the bare-IP host), #41 (`HOST` default) tracked, not regressions.
