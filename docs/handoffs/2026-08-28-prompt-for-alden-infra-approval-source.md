# Prompt for the Alden infra session — an approval-store token for the Pantheon inbox (2026-08-28)

**Why (Karl's ruling A, 2026-08-28, pantheon-harness BUGS #42):** UAT-4 showed Alden-1's gated
`gitea_file_write` producing approval `2a2749b3-f26e-40ed-890e-7b3bb53a343a` in the **capability
gateway's Peta** (gateway VM), while the Pantheon Approvals inbox reads Pantheon's own Peta on VM 1093
— so the inbox showed nothing. Pantheon's inbox and keycard door now read a LIST of approval stores
(`PANTHEON_APPROVAL_SOURCES`), reference-only (id / tool / server / status / createdAt / requester —
never arguments, diff or payload; D8), PENDING only, bounded (200 items, 256 chars/field, 10 s). It
needs a way to call the gateway Peta's `LIST_APPROVALS` (action 9201). The inbox does not decide
(`DECIDE_APPROVAL` 9203 stays where it is until M2 C.3).

**Paste to the Alden infra session:**

> Pantheon's Approvals inbox (VM 1093, `pantheon@192.168.1.93`) needs to READ the capability
> gateway's Peta approval queue (`LIST_APPROVALS`, action 9201, filter `{status:"PENDING", page,
> pageSize:100}`) — reference-only, no decide. Please (1) confirm the gateway Peta's admin URL as
> seen from VM 1093 (origin only, e.g. `http://10.100.23.88:3002`), and whether its network policy
> allows VM 1093 to reach it (open the port to 192.168.1.93 only if it is currently closed); (2)
> mint an admin token for that Peta dedicated to this consumer (Peta admin tokens are all-or-nothing
> — record in your APPROVAL_LOG that this token is held by the Pantheon control-plane service, env
> only, and that Karl authorized it on 2026-08-28); (3) hand the token to Karl out-of-band (never
> in a bus message or a repo). Karl will place it on VM 1093 in
> `/opt/pantheon/pantheon-harness/services/control-plane/.env.local` as
> `PANTHEON_APPROVAL_SOURCES=[{"label":"Alden gateway","url":"<origin>","token":"<token>"}]` and
> restart `pantheon-admin@pantheon`. Rotation: same as your other tokens; Pantheon reads the env at
> start, so a rotation is an env edit + restart on VM 1093. Please also tell us the approval TTL the
> gateway uses (~12 min was observed) so the inbox's "age" column and the user guide can say so.

**After the token is in place (Pantheon side):** restart the service, open the Approvals page — the
empty state must read "Checked: Pantheon, Alden gateway"; ask Alden-1 for a gated write and the row
must appear with Source = Alden gateway within one reload. That is UAT-5 scenario material.
