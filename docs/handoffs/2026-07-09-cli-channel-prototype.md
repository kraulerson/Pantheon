# Session Handoff — 2026-07-09 — CLI↔Harness channel prototype

## Where we are

Branch `main`, clean, on the pantheon-harness repo (no remote push yet — gated, see below).
The project is under the **walking-skeleton feature freeze** (APPROVAL_LOG Ruling C,
2026-07-09) — no `feat:` work until the skeleton runs end-to-end. This session was
*design + evaluation*, not product feature work.

Karl's last instruction: **prototype the Claude Code "channels" auto-relay loop** (start
with the fakechat demo to prove the mechanism, then build our own **Alden-bridge
channel**), bundle the channel MCP server into the harness install, and design the harness
to deploy as an **LXC/Docker container reached via webpage**, with **dev CLI sessions
running in tmux** for persistence. I had just finished (a) probing the local environment
and (b) fetching the Claude Code `channels-reference` protocol, and was about to start
building when Karl called for this handoff. **Nothing was built yet — the prototype is the
next action.**

Karl is a non-programmer: **every reply must open with a plain-English TLDR** (memory
`user-plain-english-tldr`).

## Load-bearing facts gathered this session (not yet in any artifact — capture/verify)

**Local env probe (this Mac):** `claude` v2.1.206 ✓ (channels need ≥2.1.80), `node`
v25.9.0 ✓, `tmux` 3.6a ✓, `docker` 29.3.1 ✓, **`bun` NOT installed**. Key consequence:
the channels-reference confirms the only hard dep is `@modelcontextprotocol/sdk` + a
Node-compatible runtime — **Bun is not required; we can build the channel in Node/TS,
matching the harness's existing Node 20 + TypeScript stack.** (The official fakechat/
Telegram plugins happen to use Bun, so running *fakechat itself* would need Bun — but the
webhook-receiver reference example is runnable on Node, and our custom channel will be
Node/TS.)

**Claude Code channels protocol (from `code.claude.com/docs/en/channels-reference`, verify
against current docs — research preview, may change):**
- A channel = an MCP server Claude Code spawns as a **stdio subprocess** on the same
  machine. Declare capability `experimental: { 'claude/channel': {} }` (always `{}`).
- **Push an event:** `mcp.notification({ method: 'notifications/claude/channel', params: {
  content, meta } })`. `content` → body of a `<channel source="<servername>" ...>` tag;
  each `meta` key → a tag attribute (identifiers only — letters/digits/underscores).
- **Two-way reply:** add `tools: {}` capability + register a `reply` tool
  (ListTools/CallTool handlers). Claude calls it to send back.
- **Permission relay** (v2.1.81+, optional): capability
  `experimental: { 'claude/channel/permission': {} }`; Claude Code sends
  `notifications/claude/channel/permission_request` (fields `request_id` = 5 lowercase
  letters, no `l`; `tool_name`; `description`; `input_preview`); server replies
  `notifications/claude/channel/permission` with `{ request_id, behavior: 'allow'|'deny' }`.
  This is how an away-from-terminal operator approves tool use — relevant to unattended
  runs; **the security rules here are Opus 4.8's lane.**
- **Sender gating** (prompt-injection defense): check an allowlist on the sender's id
  (not room id) before emitting `notifications/claude/channel`.
- **Register** in `.mcp.json` (`{mcpServers:{name:{command,args}}}`); run during preview
  with `claude --dangerously-load-development-channels server:<name>` (custom channels are
  off the Anthropic allowlist during preview — the dev flag is acceptable on a trusted LAN
  homelab). Events queue while Claude is busy and are delivered together next turn.

## What shipped this session (artifacts — links, not re-quotes)

- `docs/2026-07-09-turnstone-bifrost-eval.md` — Turnstone **rejected** as adoption (borrow
  patterns T1–T6, quarterly watch); Bifrost **adopt-with-walls for brain plane** eval.
- `docs/2026-07-09-cli-comms-autonomy-design.md` — the CLI↔harness autonomy design;
  channels mechanism **verified real**; loop-safety = Karl's llm-mini progress-judge (not
  a fixed turn limit). **This is the primary design doc the prototype implements.**
- `docs/security-audits/2026-07-09-project-security-review.md` — full review (history
  CLEAN, deps/SAST clean; findings F1–F6).
- `docs/security-remediation-plan-2026-07-09.md` — junior-dev-executable, **assigned to
  Opus 4.8** (not yet run).
- `docs/walking-skeleton-milestone.md` — amended: Bifrost spike replaces the hand-built
  cost meter (Decision F amendment).
- `docs/ADR documentation/ADR-0004` (reconstructed), `ADR-0006` (registry=projection of
  alden-infra), `ADR-0007` (admin/Facade split).
- `APPROVAL_LOG.md` — rulings B–I + Turnstone + Decision-F amendment + security review.
- `BUGS.md` backfilled; `PROJECT_BIBLE.md` amended (ADR-0002 as-built, C.7 busy-queue,
  two-service topology, DM-4 registry projection).
- Vault (`02 Personal/Projects/Alden Ecosystem/Future State/`): `Pantheon Harness —
  Document Map.md`, `Pantheon Harness — Review & Decision Points (2026-07-05).md`
  (all decisions A–I marked); build-plan line-63 wording fix.
- Memory updated: `alden-harness-architecture`, `MEMORY.md`, `user-plain-english-tldr`.

Every repo change is committed on `main`. Clone/scratchpad: turnstone + bifrost were
cloned to the session scratchpad (not vendored).

## What's blocked / waiting

- **GitHub push** (`origin` = private `kraulerson/Pantheon`) — history is CLEARED by the
  review, but the push + Gitea mirror are **steps 5–6 of the Opus 4.8 remediation plan**,
  not yet run.
- **Token rotation (Gitea + Bridge)** — 26+ days open, in the remediation plan (Bridge
  rotation needs a maintenance window + smoke test).
- **Bifrost household consent** — Cloud Alden proposed it (bus 1087); still mid-decision.
- **Freeze-exception ruling NOT yet recorded** — Karl verbally authorized this
  prototype/design during the Decision-C freeze; the next session should record that in
  APPROVAL_LOG before/при committing prototype code so the record stays honest.

## What's next (the concrete build, in order)

The next session resumes the build Karl asked for. Recommended sequence:

1. **Record the freeze exception** in `APPROVAL_LOG.md` (Karl authorized a prototype spike
   + deployment-architecture design during the freeze).
2. **Prototype the channel loop** as a **non-shipping spike** (put it in
   `prototypes/cli-channel-loop/` in the repo, README marked "proof-of-concept, not part
   of the harness build"; commit `chore(spike):`/`docs:`, never `feat:` — the pre-commit
   gate blocks `feat:` without a Build Loop). Build in **Node/TS** (no Bun needed):
   - a minimal two-way channel MCP server (adapt the reference webhook example) that
     proves: external message → `<channel>` push → Claude reacts → `reply` tool → out;
   - then the **Alden-bridge channel**: watches the comms bridge (Alden Bridge MCP,
     mailbox) for messages to the Claude-Code identity, pushes them in, relays replies
     back; **push a notification, let Claude pull the body via its existing bridge tool**
     (trust rule);
   - the **loop-detector** stub (harness-side): after ~25 msgs, send trailing ~10 to
     **llm-mini** and judge *progress vs looping*; on loop → set a "paused" flag the
     channel respects + notify Karl; plus an absolute backstop ceiling.
   - If proving fakechat specifically: it needs **Bun** — either install Bun or use the
     Node webhook-receiver example to prove the same mechanism.
3. **Write the container/tmux architecture design doc** (`docs/` dated). Topology Karl
   specified: **harness = one LXC/Docker container** (control plane + LibreChat + Peta +
   obsidian-mcp + Caddy) reached via webpage, LAN/Tailscale only; **dev machines run
   `tmux`** holding `claude --channels plugin:alden-bridge ...` (tmux = persistence,
   survives browser detach + harness restart, dies only if dev host reboots); the browser
   xterm.js terminal tab attaches via `tmux attach` over the existing SSH broker; the
   **channel MCP server runs on the dev machine** (stdio-spawned by Claude Code) and
   connects OUT to the harness comms bridge over HTTP. Flag the open **VM-vs-LXC** decision
   (Bible §11 + memory say Debian VM on Proxmox running Docker Compose; Karl said
   "LXC/Docker" — surface the tradeoff, recommend, don't silently pick). Bundling: the
   channel plugin ships in the harness repo and dev-machine provisioning (ADR-0005
   DevMachine flow) installs it onto each dev box.
4. This whole capability is **post-skeleton** and warrants its **own ADR** when promoted
   from spike to product.

## References

- Design: `docs/2026-07-09-cli-comms-autonomy-design.md` (primary), `docs/walking-skeleton-milestone.md`
- Decisions: `APPROVAL_LOG.md` (rulings B–I, Turnstone, Decision-F amendment, security review)
- Eval: `docs/2026-07-09-turnstone-bifrost-eval.md`
- Security: `docs/security-audits/2026-07-09-project-security-review.md`, `docs/security-remediation-plan-2026-07-09.md` (Opus 4.8)
- Architecture: `PROJECT_BIBLE.md` §3 (ADR-0001–0007), §5 (DM-4), §9 (C.7); ADR-0005 (terminal modality), `docs/integration/alden-bridge.md`
- Future-state: vault `02 Personal/Projects/Alden Ecosystem/Future State/` (Architecture v1.2, Build Plan; Autonomy Driver / Oscillator; principle P7, amendment A1)
- Channels protocol: `code.claude.com/docs/en/channels` + `/channels-reference` (research preview — re-verify)

## Resume prompt (paste as the first message of the next session)

> Continuing from the 2026-07-09 handoff at `docs/handoffs/2026-07-09-cli-channel-prototype.md`.
> We're building a **spike** (not shipping — walking-skeleton freeze is on; Karl authorized
> this exception) that proves the Claude Code **channels** auto-relay loop and becomes the
> **Alden-bridge channel**: an MCP server that pushes comms-bridge messages into a persistent
> Claude Code CLI session so it converses with the other identities unattended, with a
> loop-detector (llm-mini progress-judge, not a fixed turn cap) that pauses+notifies. Env is
> ready (claude 2.1.206, node 25, tmux, docker; no Bun — build in Node/TS). The channels
> protocol facts and topology (harness=container-via-web, dev sessions=tmux, channel MCP runs
> on the dev machine and reaches the comms bridge) are in the handoff. First: record the
> freeze exception in APPROVAL_LOG, then build the prototype in `prototypes/cli-channel-loop/`
> (commit `chore(spike):`, never `feat:`), then write the container/tmux architecture design
> doc. Read `docs/2026-07-09-cli-comms-autonomy-design.md` first. Open every reply with a
> plain-English TLDR — Karl is a non-programmer.
