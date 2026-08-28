# Interface — Pending-Approvals inbox and the shared approvals projection (M1 task 3, TP-2)

One read-only page over EVERY approval store the household uses (this host's Peta, labelled
`Pantheon`, plus each `PANTHEON_APPROVAL_SOURCES` entry — BUGS #42), plus the ONE module through
which every reference-only read of those queues passes (D8).

## Page — `GET /admin/approvals` (operator guard: admin bearer or session cookie)

Server-rendered HTML (`text/html; charset=utf-8`, `Cache-Control: no-store`, `nosniff` from the app
hook). Not in `PUBLIC_PATHS`; a keycard bearer is rejected here like on every admin route. Linked
from the harness chrome as **Approvals** (`data-nav="approvals"`).

| Outcome | Code | Markup contract |
|---|---|---|
| pending rows | 200 | `<main data-state="ok" data-sources="A|B">` + `<tr data-approval-id="…">` per row: **Source** · Identity · Tool · Target · Age (`<time datetime>` + words) · Status · Ref |
| all stores empty | 200 | `<main data-state="empty">` + "No pending approvals — nothing is waiting on you. Checked: A, B." |
| some store failed | 200 | rows from the stores that answered + one `<p class="banner" data-source-state="failed">[!] <label>: <our label> — its requests are missing from this page.</p>` per failed store |
| no store configured | 503 | `<main data-state="unavailable">` + "[!] the approval gate (Peta) is not configured on this server" |
| EVERY store failed / slow / odd shape | 502 | `<main data-state="failed">` + the per-store banners; upstream text is NEVER echoed |

Notes rendered under the table: `<p data-more="true">` when the page walk stopped early (cap, page
budget, no-progress page) or Peta reports another page; `<p data-hidden-count="N">` when N returned
items are already resolved; `<p data-unidentified-count="N">` when N items carried no reference id
(both counted, never listed). A `<p data-resolution="m2-c3">` line says approve/reject arrives with M2 (C.3) — the
page carries no form, button or link to `POST /approvals/:id/decide`, and the route is wired with a
`listApprovals`-only reader, so the decide verb is structurally out of reach.

The read asks Peta for `{ status: "PENDING", page }` and walks pages (see `readPendingApprovals`).
Hidden = `status` in Peta's resolved vocabulary `approved | rejected | expired` (case-insensitive);
everything else — `PENDING`, an unknown label, or no status — is SHOWN with its own label
(fail-visible; a missing status reads "(not given)"). Age words: `just now` (< 60 s),
`N min ago`, `N h ago` (< 48 h), `N d ago`; missing/unparseable time → `unknown age`. Clock
injectable via `AppOptions.now` (tests).

## Module — `src/approvals/projection.ts`

| Export | Contract |
|---|---|
| `ApprovalsListFilter` | `{ status?, page?, pageSize? }` — Peta's own vocabulary (`status: "PENDING"`, 1-based `page`) |
| `ApprovalsReader` | `{ listApprovals(filter?): Promise<unknown> }` — the narrowest surface a reader may hold |
| `ApprovalReference` | `{ id?, tool?, server?, status?, createdAt?, requester? }` — closed allow-list, strings only |
| `projectApprovalReference(raw)` | non-object → `{}`; each field from a closed key list (`approvalId|requestId|id`, `tool|toolName`, `serverId|serverName|server`, `status|state`, `createdAt|requestedAt|timestamp`, `userId|requester|identity`), string-typed only (a finite epoch number is accepted for the time field and rendered ISO), control / zero-width / bidi characters stripped, cut at `MAX_FIELD_CHARS` (256) |
| `approvalsArray(res)` | top-level array; or `requests|approvals|items|pending` at top level; or `data` array; or `data.<same keys>` — else `undefined` |
| `hasMoreApprovals(res)` | `true` only for a literal boolean `true` at `hasMore` or `data.hasMore` |
| `readApprovalReferences(reader, timeoutMs)` | ONE unfiltered call (the door); never throws → `{ state:"ok", approvals (≤ MAX_APPROVALS = 200), truncated, more }` or `{ state:"failed", message: ReadFailureLabel }` |
| `ApprovalSource` / `readPendingFromSources(sources, timeoutMs)` | every store read IN PARALLEL with the walk below (a hung store costs one timeout for the whole read); each reference stamped with `source`; a failed store reported by label, never thrown |
| `readPendingApprovals(reader, timeoutMs)` | the per-store walk: `{ status:"PENDING", page: 1..MAX_PENDING_PAGES (10) }` until `hasMore` is false, ONE timeout for the whole walk, dedupe by id, stop with `more:true` on cap / page budget / a page adding nothing; any page failing fails the read (never a partial list as complete) |
| `ReadFailureLabel` | the ONLY failure texts: `the approval gate did not answer` · `the approval gate did not answer in time` · `unexpected approvals response shape` |

## Unchanged consumer — keycard door `GET /keycard/v1/approvals`

Now reads through `readApprovalReferences`; contract as in `keycard-door.md`: 200
`{ approvals, truncated }`, 503 `{ state:"unavailable" }` when unwired, 502 `{ state:"failed", message }`
with the same three labels; bounds 200 / 256 / 10 s.

## Sources — `src/approvals/sources.ts`

`PANTHEON_APPROVAL_SOURCES` (env, JSON `[{ label, url, token }]`): `label` `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$`,
unique, not `Pantheon` (reserved for this host's Peta); `url` an origin (`http(s)://host[:port]`, the
client appends `/admin`); `token` that store's Peta admin token (env only). Malformed → the service
refuses to start with a message that names the entry and never echoes a token.
