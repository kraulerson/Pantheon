# cli-channel-loop — PROOF OF CONCEPT, not part of the harness build

> **Status: spike.** Built 2026-07-09 under a recorded Ruling C freeze exception
> (APPROVAL_LOG.md). Nothing here ships: no `feat:` commits, no Build Loop, no MVP-cutline
> item. Promotion to product is post-skeleton and requires its own ADR plus a recorded
> decision. Design authority: `docs/2026-07-09-cli-comms-autonomy-design.md`.

## What this proves

Claude Code **channels** (research preview, v2.1.80+) let an MCP server push events into
a running session so Claude reacts while nobody is at the terminal. This spike proves the
full auto-relay loop end-to-end and grows it into the Alden-bridge channel:

| Piece | File | What it does |
|---|---|---|
| Echo channel | `src/echo-channel.ts` | Minimal two-way channel (Node port of the official webhook reference): `curl` POST → `<channel>` event in the session → Claude calls `reply` → answer lands on an SSE stream. |
| Alden-bridge channel | `src/alden-bridge-channel.ts` | Watches the comms-bridge mailbox for messages to the Claude-Code identity, pushes a **wake notification** into the session, optionally relays replies back to the bridge. |
| Loop detector | `src/loop-detector.ts` + `src/llm-mini-judge.ts` | Karl's loop-safety design: arm at ~25 relayed messages, judge the trailing ~10 with llm-mini for *progress vs looping/stalled*, pause + notify on loop, absolute backstops regardless. |

The protocol contract was verified against `code.claude.com/docs/en/channels-reference`
on 2026-07-09. **It is a research preview and may change** — re-verify before any live run.

## Protocol facts the spike relies on

- A channel is an MCP server Claude Code spawns as a **stdio subprocess**. Capability:
  `experimental: { 'claude/channel': {} }` (always `{}`).
- Push an event: `mcp.notification({ method: 'notifications/claude/channel', params: {
  content, meta } })` — `content` becomes the `<channel source="<name>">` body, each
  `meta` key an attribute (identifier keys only; others silently dropped).
- Two-way = plain MCP `tools: {}` + a `reply` tool.
- Events queue while Claude is busy and are delivered together next turn.
- Custom channels are off the preview allowlist → sessions need
  `--dangerously-load-development-channels server:<name>` (acceptable on the trusted LAN
  homelab only).
- Permission relay (`claude/channel/permission`, v2.1.81+) is **deliberately NOT
  implemented** — unattended permission handling is the Opus 4.8 security lane.

## Run it

```bash
cd prototypes/cli-channel-loop
npm install
npm test          # builds, then runs unit + e2e protocol tests (no live session needed)
```

The e2e test spawns the built channel over stdio exactly the way Claude Code does and
asserts the whole loop, so a green suite is a real protocol proof.

### Echo demo inside a live session

1. `npm run build`
2. Copy `.mcp.json.example` to the directory you'll start `claude` from (or merge into an
   existing `.mcp.json`), fixing paths.
3. `claude --dangerously-load-development-channels server:echo-channel`
4. In another terminal:
   ```bash
   curl -N localhost:8788/events                       # watch Claude's replies live
   curl -d "ping from outside" -H "X-Sender: dev" localhost:8788
   ```

### Alden-bridge channel

Configure `prototypes/cli-channel-loop/.env.local` (gitignored, control-plane convention):

| Var | Meaning | Default |
|---|---|---|
| `BRIDGE_MCP_URL` / `BRIDGE_MCP_TOKEN` | Bridge MCP endpoint + bearer | unset → idle mode |
| `CLAUDE_IDENTITY` | Mailbox recipient to watch | `claude-code` |
| `ALLOWED_SENDERS` | Comma-separated **sender** allowlist | empty → deny all |
| `BRIDGE_SEND_TOOL` | Bridge tool for outbound replies | unset → wake-only |
| `POLL_INTERVAL_MS` | Mailbox poll cadence | `5000` |
| `CONTROL_PORT` | Localhost `GET /status`, `POST /pause`, `POST /resume` | `8790` |
| `LOOP_ARM_AT` / `LOOP_WINDOW` / `LOOP_RECHECK` | Judge arming/window/cadence | `25` / `10` / `3` |
| `LOOP_BACKSTOP_MSGS` / `LOOP_BACKSTOP_MINUTES` | Absolute ceilings | `200` / `240` |
| `LLM_MINI_URL` / `LLM_MINI_MODEL` | OpenAI-compatible judge endpoint | unset → backstops only |

Then: `claude --dangerously-load-development-channels server:alden-bridge`.

## Security posture (spike-level)

- **Wake, not body**: bridge events carry sender names + message ids only. Claude pulls
  bodies through its existing, gated bridge tool, so inbound content stays inside the
  tainted/`trusted:false` pipeline. The channel never injects third-party text.
- **Sender gating** on the sender's identity (never the room/bus) before anything is
  emitted — prompt-injection defense per the reference docs. Empty allowlist = deny all.
- **Non-destructive reads only**: `alden_mailbox_list` with `since_id` high-water marking;
  never `alden_mailbox_read` (marks-read — would eat Cloud Alden's heartbeat).
- **Token custody**: bearer token from env/`.env.local` only; never logged, never in an
  error object (same rules as the control-plane `BridgeClient`).
- **Local binds**: both HTTP listeners bind `127.0.0.1` only.
- **Pause, don't kill** (P7 / A1 circuit-breaker shape): on a loop verdict or backstop the
  relay stops, the mailbox high-water mark freezes (no mail lost), the session gets a
  `kind="loop_pause"` event, and Karl resumes via `POST /resume` after reading the thread.
- Judge outage returns `unknown` and does **not** pause (instrument, don't freeze); the
  absolute backstops bound a runaway if the judge is down or wrong.

## Assumptions to verify before a live bridge run

1. **`BRIDGE_SEND_TOOL` name + argument schema** — the in-repo bridge doc only records the
   read tools; the spike sends `{ message }` to whatever tool is configured. Verify against
   the live bridge (or leave unset for wake-only).
2. The bus is a **shared broadcast** — the `recipient` field is convention, not routing.
   Filtering on it is a courtesy filter, not isolation.
3. Multi-party thread keying for the detector is an open design question (design note §5);
   the stub uses one global window.
4. Channels remain a research preview — re-check `code.claude.com/docs/en/channels-reference`.

## Layout

```
src/echo-channel.ts          two-way reference channel (e2e-tested protocol proof)
src/alden-bridge-channel.ts  bridge watcher channel (wake-only or two-way)
src/bridge-client.ts         spike-local minimal bridge MCP client (deliberate copy —
                             spikes don't import across package boundaries)
src/loop-detector.ts         pure loop-safety logic (fully unit-tested)
src/llm-mini-judge.ts        llm-mini progress judge (OpenAI-compatible endpoint)
test/                        vitest: unit + stdio e2e protocol tests
```
