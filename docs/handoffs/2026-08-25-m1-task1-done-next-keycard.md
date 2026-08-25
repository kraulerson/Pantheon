# Session Handoff — 2026-08-25 — M1 task 1 DONE (tmux-aware launcher); next: task 2 (scoped session keycard)

## Where we are

Branch `main`, clean, in sync with BOTH remotes (`origin` GitHub + `gitea` mirror) at the commit
this handoff ships in (the code commits are **`65a88fe` feat, `94b1b9b` fix #32, `39316fa` fix #33**).
VM 1093 is deployed at **`82a92c5`** (code `39316fa` + the better-sqlite3 bump) and live-verified.
**Test gate: 1/2** — the next cutline feature trips a UAT session (needs Karl at a browser); batch
accordingly. **0 open SEV-1/2**; BUGS #25–#30 are open/deferred SEV-3/4 with rationale; #31/#32/#33
fixed. No `pending-approval.json` sentinel.
Suite **478 passed / 5 honest skips**, `tsc` + `eslint` clean.

Karl is a non-programmer: **every reply ends with a plain-English TL;DR**; decisions go to him as
plain-English cards with pros/cons + a recommendation; **never write outside this repo without
express permission**. Deploy target is **VM 1093** (`pantheon@192.168.1.93`, key-only SSH from the
Mac); the admin console binds `172.17.0.1:8088` (LAN-refused; reachable only through Caddy at
`https://pantheon-admin.ferrumcorde.com`).

## What shipped this session — M1 task 1: tmux-aware launcher (Feature 8)

The harness launch bar now asks each ready dev machine for its LIVE tmux sessions
(`GET /harness/tmux/:logicalName` → `tmux list-sessions` over the key-only SSH path) and shows one
text-labelled button per session — `Mac-Mini · pantheon (1 win, attached elsewhere)` — that opens a
terminal tab ATTACHED to that exact session (`/terminal/:name?tmux=<s>` →
`tmux attach-session -t '=<s>'`), plus a **+ tmux session** attach-or-create form (`&create=1`).
Ruled design (A-2): live-list, not a per-machine field. Records: `FEATURES.md` Feature 8,
`CHANGELOG.md` [Unreleased] (Security / Added / Fixed), `PROJECT_BIBLE.md` §5 (`provisioned`
column) + §9 C.6 (tmux states), `docs/user-guide.html` §4 "tmux sessions on a machine",
`docs/security-audits/tmux-aware-launcher-security-audit.md`.

Three parallel Phase-2.4 audits (input validation / threat model / client+CC1): **0 SEV-1, 1 SEV-2,
8 SEV-3, ~25 SEV-4; every authz, secret and injection check PASSED.** 22 findings fixed in-loop,
test-first — headline fixes: `createTmuxLister` (per-machine coalescing, 3 s cache, 4-dial cap —
the SSH-dial amplifier), sentinel-prefixed records (shell-profile stdout chatter ignored + counted,
not fatal), machine stderr as a separate `remoteDetail` shown as `machine said: "…"` (trusted:false),
byte-accurate capture + timeouts on BOTH ssh2 paths, reattach origin check, branded `RemoteCommand`
type at the exec seam, `X-Content-Type-Options: nosniff` on every response, dead-socket tab text,
`novalidate` form, 401 labelled "signed out".

Two defects found by LIVE verification (a WebSocket probe from the VM against this Mac) and fixed:
- **#32** zsh expands an unquoted `=name` target ("zsh:1: 0 not found") → targets are single-quoted.
- **#33** closing a tab left the SSH session (and a ghost tmux client) alive → explicit `{t:"c"}`
  close frame ends the session; a bare socket drop still only detaches (reconnectable).

Live evidence (VM → Mac mini): list = this Mac's five real sessions; attach to `0` lands inside tmux
(status bar + prompt visible); attach-or-create works; unsafe name refused before any dial; public
entrance answers 401 + `nosniff` without credentials; close frame drops the tmux client to 0.

## What's blocked / waiting

- **Nothing blocks task 2.** Gate is 1/2.
- **BUGS #31 FIXED (ruling A, commit `82a92c5`):** the admin service used to abort 2–5× at every
  restart (`better-sqlite3` 11.10.0 had no Node 24 support). Now pinned 12.11.1; three restart
  cycles on the VM: up in 2 s, 0 crashes. Deploys are plain again: `git pull --ff-only && npm ci &&
  npm run build && sudo -n systemctl restart pantheon-admin@pantheon` (use `npm ci` whenever the
  lockfile changed).
- **Deploy mechanics (learned the hard way):** the VM's `origin` remote is the **Gitea** mirror, so
  pushing GitHub alone does NOT deploy. Push Gitea with the minimal-scope `GITEA_TOKEN` from
  `services/control-plane/.env.local` through a tiny credential-helper script (no keychain entry, no
  TTY — see the scratchpad pattern in this session; token never in argv/output). Then on the VM:
  `git pull --ff-only && npm run build && sudo -n systemctl restart pantheon-admin@pantheon`.
- Deferred audit items with rationale: **#25** keyboard-unreachable tab close, **#26** WebSocket
  `Origin` check (blocked on the edge proxy's `Host` rewrite — needs header facts), **#27** dialog
  empty state, **#28** tab ARIA, **#29** CSP (inline script must move first), **#30** config-page
  `innerHTML`, **#17 extended** (host-key pinning now covers three ssh2 paths). `SameSite=Strict`
  NOT adopted (Homepage tile is cross-site) — recorded as a residual.
- `scripts/check-versions.sh` hung >2 min at session start (network/interactive?) — not blocking,
  worth a look.

## What's next (the work, in order)

Continue `docs/handoffs/2026-08-20-M1-build-plan.md`:

2. **Scoped session keycard (TP-3, HIGH)** — build on `docs/machine-auth-design.md`: token store +
   per-route scope guard in Fastify; read/propose scopes only (`usage:read`, `approvals:read`,
   `sessions:read`), never a management/write scope (TM-011); minting only on the D6 admin surface;
   deny-by-default, fail closed. Tests first: unscoped → 403; each scope grants exactly its routes;
   no management route at any scope; token in no log/response. **This trips the gate (2/2) → UAT
   session 3 template for Karl before task 3.**
3. Unified Pending-Approvals inbox (TP-2). 4. Session-waker promotion + guardrails (TP-1/TP-5).
5. Cross-project task board (TP-4). 6. `pantheon doctor` (XC-2, tooling). Then M2.

## References

- Plan: `docs/handoffs/2026-08-20-M1-build-plan.md`; decisions `docs/research/2026-08-20-capability-decisions.md`.
- This feature: `services/control-plane/src/devmachine/tmux.ts`, `connection.ts`, `terminal-gateway.ts`,
  `src/http/routes/{harness,terminal}.ts`, `src/http/harness-frame.ts`; tests `test/devmachine-tmux.test.ts`,
  `harness-tmux-route.test.ts`, `harness-shell.test.ts` (+ extended connection/route/frame tests).
- Bugs / changes: `BUGS.md` (#17 ext., #24–#33), `CHANGELOG.md` [Unreleased].
- Prior handoff (superseded): `docs/handoffs/2026-08-25-m1-terminal-plane.md`.

## Resume prompt

> Continuing from `docs/handoffs/2026-08-25-m1-task1-done-next-keycard.md`. Branch `main`, both
> remotes synced, VM 1093 deployed at `82a92c5` and live-verified; M1 task 1 (tmux-aware launcher)
> is DONE; test gate 1/2 (the next cutline feature trips UAT session 3 — needs Karl at a browser);
> 0 open SEV-1/2; BUGS #31 fixed (better-sqlite3 12.11.1). Begin **M1 task 2 — scoped session keycard
> (TP-3)** per `docs/handoffs/2026-08-20-M1-build-plan.md` on `docs/machine-auth-design.md`:
> test-first Build Loop (`scripts/process-checklist.sh --start-feature`), read/propose scopes only,
> deny-by-default, fail closed; commit + push BOTH remotes (the VM pulls from Gitea — token from
> `.env.local` via a credential-helper script); deploy (`git pull --ff-only && npm run build &&
> sudo -n systemctl restart pantheon-admin@pantheon`) and verify via
> `https://pantheon-admin.ferrumcorde.com`. Then generate + lint the UAT-3 template for Karl. End
> every reply with a plain-English TL;DR; decisions to Karl as plain-English cards with pros/cons +
> a recommendation; never write outside this repo without his express permission.
