# Alden Bridge integration (control-plane grounding retrievers)

The control-plane's real grounding retrievers (Qdrant memory + inter-Alden mailbox) talk to the
**Alden Bridge**, an MCP server fronting Alden's memory and a shared message bus. This note is the
authoritative in-repo reference for that seam.

## Endpoint & auth

- **MCP endpoint:** `http://10.100.23.88:8765/mcp` (LAN). Public/TLS via Caddy:
  `https://alden.ferrumcorde.com/mcp`.
- **Auth:** `Authorization: Bearer <token>`. The token is a 256-bit secret loaded from env
  (`BRIDGE_MCP_URL`, `BRIDGE_MCP_TOKEN`) in the gitignored `services/control-plane/.env.local`.
  It is **never** hardcoded, logged, or placed in any error/thrown object (`BridgeError` carries
  only a safe message + the tool name).
- **Transport:** MCP **Streamable HTTP** (`@modelcontextprotocol/sdk` v1.29.0,
  `StreamableHTTPClientTransport`), with `Accept: application/json, text/event-stream`. The SDK
  `Client` performs `initialize` and reuses the `mcp-session-id` automatically. The Bearer header
  is supplied via `requestInit.headers`.

Implementation: `services/control-plane/src/bridge/client.ts` (`BridgeClient`).

## Tools used (read-only / non-destructive)

1. `alden_memory_search` — semantic recall.
   - input: `{ query: string (req), collection: "alden-1"|"alden-shared"|"alden-cloud"|"all"
     (default "alden-1"), limit: int 1..50 (default 5) }`
   - output: `hits: [{ collection, score, id, information, metadata }]` — `information` is the
     document text.
2. `alden_mailbox_list` — **non-destructive** listing (USE THIS).
   - input: `{ since_id?: int>=0, limit?: int 1..500 (default 100), newest_first?: bool (default false) }`
   - output: `[{ id, timestamp, sender, recipient, message, read }]`
3. `alden_mailbox_check` — `{}` → `{ unread_count, latest_timestamp }`.

**Do NOT use** `alden_mailbox_read` (marks-read / consumes — would eat Cloud Alden's heartbeat) or
`alden_memory_inject` (a generate/write action, not retrieval).

## Memory scoping = EXPLICIT per-identity collection (isolation)

The bridge has **no per-caller identity scoping** — it trusts whatever `collection` it is asked
for. Identity isolation is therefore enforced by the control-plane: `MemoryRetriever` is constructed
with the identity's **own** collection and passes it explicitly (cloud → `alden-cloud`,
alden-1 → `alden-1`). The merge-collection **`"all"` is forbidden** for an isolated identity (it
would blend every identity's memory) and is rejected at retriever construction. `includeShared`
additionally pulls `alden-shared` as a separate, explicitly-scoped query — still never `"all"`.

Peta / control-plane MUST be the enforcement point here; do not rely on the bridge to scope.

## Embeddings

- Model: `all-MiniLM-L6-v2`, 384-dim.
- Qdrant named vector: `fast-all-minilm-l6-v2`.

## Mailbox = shared broadcast bus (caveats)

The bridge mailbox is a **single shared broadcast bus**: `recipient` is **not** routed (there is no
per-identity delivery at the bridge), so per-identity mailbox filtering does not exist there. The
harness surfaces recent messages as **untrusted** (`trusted:false`) context for whichever identity
is active. `MailboxRetriever` polls with `since_id` high-water marking so a message is surfaced only
once per process, and uses `list` (never `read`) to stay non-destructive.

## Trust model

Everything returned by these retrievers is `trusted:false` (recalled, never the operator's typed
input), so any retrieved item flips the session taint flag by presence in the grounding engine.

## Cross-session search (later seam)

Cross-session recall (LibreChat / Meilisearch) is intentionally not yet a grounding source toggle;
it is a documented later increment that will implement the same `GroundingRetriever` interface and
tag its items `trusted:false`.
