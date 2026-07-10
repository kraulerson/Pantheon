# Deployment Topology — Harness Container + tmux Dev Sessions (2026-07-09)

**Status:** design, NOT built. Written under the recorded Ruling C freeze exception
(APPROVAL_LOG 2026-07-09). Companion to `docs/2026-07-09-cli-comms-autonomy-design.md`
(the what/why of the channel loop; this doc is the where/how of deployment). The channel
capability itself is post-skeleton; the **enclosure decision in §2 gates the walking
skeleton's deploy target** and should be ruled on before skeleton assembly.

## 1. Topology Karl specified

Three planes, one direction of trust:

```
                         LAN / Tailscale only
┌──────────────┐  https   ┌──────────────────────────────────────────────┐
│ Karl's       │─────────▶│ PANTHEON HOST                                │
│ browser      │          │  Docker Compose (Bible §11, unchanged) in a  │
│              │          │  Debian VM (D-ENC resolved → A, §2):         │
│  · chat tab  │          │   Caddy ─▶ LibreChat (+Mongo/Meilisearch)    │
│  · terminal  │          │           admin service │ Facade (ADR-0007)  │
│    tab       │          │           Peta-core (+Postgres) · obsidian-  │
└──────┬───────┘          │           mcp                                │
       │ ws (xterm.js,    └──────────────────────────────────────────────┘
       │  C.6 tab)                 ┌──────────────────────────────┐
       ▼                           │ Alden Bridge (today .88:8765) │
┌──────────────────────┐           └──────────────▲───────────────┘
│ admin service         │  ssh (broker,           │ HTTP, OUTBOUND from
│ SSH broker (TM-020)   │─────────────┐           │ the dev machine only
└──────────────────────┘             ▼           │
┌────────────────────────────────────────────────┴─────────────────────┐
│ DEV MACHINE (Mac today; any DevMachine row later)                    │
│   tmux session "alden-claude"                                        │
│    └─ claude --dangerously-load-development-channels                 │
│         server:alden-bridge            (research-preview dev flag)   │
│         └─ spawns the channel MCP server as a stdio child            │
│              · polls the bridge mailbox (non-destructive list)       │
│              · pushes wake notifications into the session            │
│              · loop-detector pauses + notifies on a runaway          │
└──────────────────────────────────────────────────────────────────────┘
```

- **Harness = one web-reachable appliance.** Everything Karl clicks lives behind Caddy on
  the Pantheon host, LAN/Tailscale only. Nothing here changes Bible §11's Compose stack or
  ADR-0007's two-service split — this doc only decides the *enclosure* around it (§2).
- **Dev CLI sessions live on dev machines, inside tmux.** The Claude Code process (and
  therefore the stdio-spawned channel server) runs on the dev box, NOT in the harness
  container. Claude Code needs a real workspace, its own auth, and a PTY; the harness
  merely *reaches* it (ADR-0005 terminal modality).
- **The channel server dials OUT.** The only network the channel needs is an outbound
  HTTP(S) connection from the dev machine to the bridge MCP endpoint. No inbound port on
  the dev machine, no listener exposed beyond `127.0.0.1` control/inject ports.

## 2. Enclosure decision (D-ENC) — RESOLVED 2026-07-09: A, Debian VM

**Ruling (Karl, 2026-07-09, recorded in APPROVAL_LOG):** option A — Debian VM on Proxmox
running Docker Compose. The analysis below is retained as the decision record.

The record and the spoken instruction diverged, so this was surfaced, not silently picked:

- **Design of record:** Bible §11 ("Docker Compose on the LAN host") + the deploy-target
  memory: a **Debian VM on Proxmox** running Docker Compose (not built yet; needs a
  fresh-install script).
- **Karl, 2026-07-09 session:** "deploy as an **LXC/Docker container** reached via webpage."

Both shapes run the identical Compose stack inside; the decision is only the box around it.

| | **A — Debian VM on Proxmox running Compose (recommended)** | B — Proxmox LXC with nested Docker |
|---|---|---|
| Matches recorded design | Yes (Bible §11 + memory; zero re-decision, no ADR edit) | No — would amend Bible §11/§17 |
| Docker friction | None — Docker's normal home | Known Proxmox friction: `nesting`/`keyctl` flags, overlayfs-on-ZFS quirks, AppArmor interactions, historic breakage on Proxmox upgrades; Proxmox guidance itself steers Docker workloads to VMs |
| Isolation | Hardware-virt boundary. This host holds **dev-machine SSH keys (TM-020 SEV-1)** and operator auth — the strongest available wall is warranted | Shared kernel with the Proxmox host; container-escape blast radius includes the hypervisor host |
| Resources | ~1–2 GB RAM + a few GB disk overhead | Lighter (near-native), faster boot |
| Ops | Standard Debian; PBS backups; live-migratable | Lighter backups; but nested-Docker snapshots can be fragile |

**Recommendation: A.** The operative requirement in Karl's instruction — *one
container-shaped appliance reached via a webpage* — is satisfied by Compose-in-a-VM, and A
avoids re-opening a ratified artifact, avoids Docker-in-LXC fragility, and keeps the
hardest boundary around the machine that custodies SSH keys (Security > Correctness >
Stability ordering). Choose B only if Proxmox host RAM is genuinely tight.

**Consequence either way:** the fresh-install script (already flagged in memory) targets
"Debian + Docker Compose"; the enclosure choice only changes its first ten lines
(create-VM vs create-CT). Ruling requested via the pending-approval sentinel.

## 3. Dev-machine plane: tmux as the persistence layer

The Claude Code session must outlive the browser tab and the harness itself — events only
arrive while the session is open, so session lifetime IS relay uptime.

Convention: one named session per identity-facing CLI, attach-or-create so the terminal
tab and any SSH login land in the same place:

```bash
tmux new-session -A -s alden-claude \
  claude --dangerously-load-development-channels server:alden-bridge
```

Lifecycle matrix (what survives what):

| Event | CLI session + channel relay |
|---|---|
| Browser tab closed / laptop viewing it sleeps | **Survives** — tmux detaches, claude keeps running |
| Harness container/VM restarts | **Survives** — session lives on the dev box; the terminal tab reattaches; bridge polling retries until the bridge answers |
| Bridge briefly down | **Survives** — poll errors are logged and retried; high-water mark means no mail is lost |
| `claude` exits or crashes | tmux session ends (or shows exit) — reattach and rerun; the channel dies with it (it's a stdio child) |
| Channel server crashes alone | claude keeps running; `/mcp` shows the failure; restart the session to respawn |
| **Dev machine reboots** | **Dies.** tmux is not reboot-persistent. This is the accepted single point of interruption |

Reboot mitigation (a launchd/systemd user unit that recreates the tmux session at boot) is
**deliberately not decided here**: auto-starting an unattended, shell-capable agent at boot
is a security posture question → Opus 4.8 lane, alongside permission relay.

Multiple viewers (terminal tab + a direct SSH login) attach to the same tmux session and
mirror each other — that is the desired "glance at it from anywhere" behaviour.

## 4. Terminal attach path (existing ADR-0005 plumbing, one new default)

Browser terminal tab (C.6) → admin-service WebSocket → SSH broker (ssh2, key custody per
TM-020: private keys resolved server-side by opaque handle, never sent to the browser) →
dev machine `sshd` → `tmux new-session -A -s alden-claude …`.

The only change to the existing design: the brokered connection's remote command defaults
to the attach-or-create line above instead of a bare login shell (per-DevMachine
configurable). Detach (`C-b d`) leaves the session running; closing the tab equals detach.

## 5. Bundling & provisioning

The channel plugin ships **in the harness repo** (today: `prototypes/cli-channel-loop/`;
on promotion: its product home per the future ADR) and reaches dev machines through the
**ADR-0005 DevMachine provisioning flow**, which gains these steps:

1. Ensure runtime: Node **≥ 22.9** on the dev machine (the `--env-file-if-exists` flag the
   start scripts use landed in 22.9; the fleet already runs 25.x — pin it in provisioning
   rather than discover it in the field).
2. Install + build the channel package; register it in the project `.mcp.json`
   (`.mcp.json.example` in the spike).
3. Write `.env.local` (0600): `BRIDGE_MCP_URL`, `BRIDGE_MCP_TOKEN`, `CLAUDE_IDENTITY`,
   `ALLOWED_SENDERS`, loop-detector tuning.
4. Ensure `tmux` present; record the session-name convention on the DevMachine row.

**Custody flag (Wall-4-adjacent, raised, not resolved):** step 3 puts a bridge bearer
token on every provisioned dev machine — a custody location outside Peta vault ("raw keys
live only in Peta vault; everything else stores handles"). Acceptable for the spike on the
trusted LAN; before promotion the Opus 4.8 security review should choose between
per-dev-machine scoped tokens, short-lived harness-issued credentials, or a recorded
bounded exception. Same review owns permission relay and tainted-inbound rules (design
note §6).

## 6. Security posture summary

- `--dangerously-load-development-channels` is trusted-LAN-homelab-only usage, and only
  until channels leave research preview (fallback if the preview shifts: Agent-SDK loop /
  Stop-hook per the design note).
- Trust rule unchanged: the channel pushes **wake notifications, never message bodies**;
  bodies arrive through the existing gated bridge tool inside the `trusted:false` pipeline.
- Sender allowlist gating on the **sender's** identity before any event is emitted.
- All channel listeners bind `127.0.0.1`; the dev machine exposes nothing new inbound.
- Loop safety: llm-mini progress judge + absolute backstops; pause-don't-kill (P7 / A1
  shape); pauses freeze the mailbox high-water mark so no mail is lost.

## 7. Open decisions & next steps

1. ~~D-ENC: enclosure A (VM) vs B (LXC)~~ — **RESOLVED 2026-07-09: A (Debian VM)**;
   next step: write the fresh-install script against a fresh Debian VM.
2. Auto-respawn at dev-host boot — Opus 4.8 lane.
3. Bridge-token custody on dev machines — Opus 4.8 lane / household Wall-4 thread (§5).
4. Verify `BRIDGE_SEND_TOOL` name/schema against the live bridge before any two-way run
   (spike README, "assumptions to verify").
5. Channels preview drift — re-verify `channels-reference` at build time.
6. On promotion from spike: dedicated ADR (capability + product home + provisioning).
