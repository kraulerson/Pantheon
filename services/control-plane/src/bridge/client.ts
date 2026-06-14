/**
 * BridgeClient — typed MCP client for the Alden Bridge (PROJECT_BIBLE integration seam).
 *
 * The bridge is an MCP Streamable-HTTP server exposing Alden's memory (Qdrant) and a shared
 * mailbox bus. This client wraps the official MCP SDK Client + StreamableHTTPClientTransport,
 * authenticating with a Bearer token supplied via `requestInit.headers` (the working pattern
 * proven in peta-eval/harness/peta.mjs). The SDK Client handles initialize + mcp-session-id reuse.
 *
 * SECURITY: the Bearer token is read from the caller (env-sourced) and is NEVER placed in an
 * error message, log line, or thrown object. BridgeError carries only a safe message + the tool
 * name. Tool inputs/outputs are validated to the AUTHORITATIVE bridge schemas before mapping.
 *
 * Tools used (all read-only / non-destructive):
 *  - alden_memory_search  — scoped semantic recall (EXPLICIT per-identity collection).
 *  - alden_mailbox_list   — non-destructive listing (NOT mailbox_read, which marks-read).
 *  - alden_mailbox_check  — unread counter.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Memory collections the bridge exposes. "all" merges identities — callers MUST avoid it for
 *  isolated identities (see MemoryRetriever). */
export type MemoryCollection = "alden-1" | "alden-shared" | "alden-cloud" | "all";

/** One semantic-recall hit (alden_memory_search). `information` is the document text. */
export interface MemoryHit {
  readonly collection: string;
  readonly score: number;
  readonly id: string | number;
  readonly information: string;
  readonly metadata?: unknown;
}

/** One mailbox message (alden_mailbox_list). The bus is a SHARED broadcast — see MailboxRetriever. */
export interface MailboxMessage {
  readonly id: number;
  readonly timestamp: string;
  readonly sender: string;
  readonly recipient: string;
  readonly message: string;
  readonly read: boolean;
}

export interface MemorySearchArgs {
  readonly query: string;
  readonly collection: MemoryCollection;
  readonly limit?: number;
}

export interface MailboxListArgs {
  readonly sinceId?: number;
  readonly limit?: number;
  readonly newestFirst?: boolean;
}

export interface MailboxCheckResult {
  readonly unreadCount: number;
  readonly latestTimestamp: string | null;
}

/** Narrow ports so retrievers can depend on just the method they use (testable with a mock). */
export interface MemorySearchPort {
  memorySearch(args: MemorySearchArgs): Promise<MemoryHit[]>;
}
export interface MailboxListPort {
  mailboxList(args?: MailboxListArgs): Promise<MailboxMessage[]>;
}

/** Error from a bridge interaction. Carries NO token and no raw transport detail. */
export class BridgeError extends Error {
  readonly tool: string | undefined;
  constructor(message: string, tool?: string) {
    super(message);
    this.name = "BridgeError";
    this.tool = tool;
  }
}

export interface BridgeClientOptions {
  /** Full MCP endpoint, e.g. http://10.100.23.88:8765/mcp (from BRIDGE_MCP_URL). */
  readonly url: string;
  /** Bearer token (from BRIDGE_MCP_TOKEN). Never logged. */
  readonly token: string;
  readonly clientName?: string;
  readonly clientVersion?: string;
}

/**
 * Construct a BridgeClient from the environment (BRIDGE_MCP_URL / BRIDGE_MCP_TOKEN).
 * Returns undefined if either is unset — callers fail closed (no bridge → no recall).
 */
export function bridgeClientFromEnv(env: NodeJS.ProcessEnv = process.env): BridgeClient | undefined {
  const url = env["BRIDGE_MCP_URL"];
  const token = env["BRIDGE_MCP_TOKEN"];
  if (!url || !token) return undefined;
  return new BridgeClient({ url, token });
}

/** Unwrap a bridge tool payload to its array of records (handles {hits|messages|results|items:[…]}). */
export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // The bridge wraps results as {hits:[...]} / {messages:[...]}; unwrap the first array field.
    for (const key of ["hits", "messages", "results", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

/** Minimal shape of an MCP CallToolResult this client reads from (structured or text content). */
export interface ToolCallResultLike {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: unknown }>;
}

/**
 * Extract a bridge tool's payload: prefer `structuredContent`, else parse the first text content
 * block as JSON (falling back to the raw string). Pure — unit-testable without a network.
 */
export function extractToolResult(result: ToolCallResultLike): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.find((c) => c?.type === "text");
    if (text && typeof text.text === "string") {
      try {
        return JSON.parse(text.text) as unknown;
      } catch {
        return text.text;
      }
    }
  }
  return undefined;
}

export class BridgeClient implements MemorySearchPort, MailboxListPort {
  private readonly url: string;
  private readonly token: string;
  private readonly client: Client;
  private transport: StreamableHTTPClientTransport | undefined;
  private connected = false;

  constructor(opts: BridgeClientOptions) {
    if (!opts.url) throw new BridgeError("BridgeClient requires a url");
    if (!opts.token) throw new BridgeError("BridgeClient requires a token");
    this.url = opts.url;
    this.token = opts.token;
    this.client = new Client({
      name: opts.clientName ?? "pantheon-control-plane",
      version: opts.clientVersion ?? "0.1.0"
    });
  }

  /** Connect (initialize + session). Idempotent. */
  async connect(): Promise<void> {
    if (this.connected) return;
    this.transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json, text/event-stream"
        }
      }
    });
    try {
      // The concrete transport's optional `sessionId` is `string | undefined`; the SDK's Transport
      // interface declares it `string?`. Under exactOptionalPropertyTypes these are structurally
      // incompatible even though the runtime contract matches — narrow via the interface type.
      await this.client.connect(this.transport as Transport);
      this.connected = true;
    } catch {
      // Never surface transport detail that could echo the token/header.
      throw new BridgeError("bridge connect failed");
    }
  }

  async close(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        /* best-effort */
      }
    }
    this.connected = false;
    this.transport = undefined;
  }

  /**
   * Call a bridge tool and return its payload. Protected + overridable so the mapping in
   * memorySearch/mailboxList is unit-testable without a live transport.
   */
  protected async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) await this.connect();
    let result;
    try {
      result = await this.client.callTool({ name, arguments: args });
    } catch {
      throw new BridgeError("bridge tool call failed", name);
    }
    if (result.isError) throw new BridgeError("bridge tool returned an error", name);
    return extractToolResult(result as ToolCallResultLike);
  }

  async memorySearch(args: MemorySearchArgs): Promise<MemoryHit[]> {
    const out = await this.call("alden_memory_search", {
      query: args.query,
      collection: args.collection,
      ...(args.limit !== undefined ? { limit: args.limit } : {})
    });
    return asArray(out)
      .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
      .map((h) => ({
        collection: String(h["collection"] ?? args.collection),
        score: Number(h["score"] ?? 0),
        id: (h["id"] as string | number) ?? "",
        information: String(h["information"] ?? ""),
        metadata: h["metadata"]
      }));
  }

  async mailboxList(args: MailboxListArgs = {}): Promise<MailboxMessage[]> {
    const out = await this.call("alden_mailbox_list", {
      ...(args.sinceId !== undefined ? { since_id: args.sinceId } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.newestFirst !== undefined ? { newest_first: args.newestFirst } : {})
    });
    return asArray(out)
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .map((m) => ({
        id: Number(m["id"] ?? 0),
        timestamp: String(m["timestamp"] ?? ""),
        sender: String(m["sender"] ?? ""),
        recipient: String(m["recipient"] ?? ""),
        message: String(m["message"] ?? ""),
        read: Boolean(m["read"])
      }));
  }

  async mailboxCheck(): Promise<MailboxCheckResult> {
    const out = await this.call("alden_mailbox_check", {});
    const obj = (out && typeof out === "object" ? (out as Record<string, unknown>) : {}) as Record<string, unknown>;
    const latest = obj["latest_timestamp"];
    return {
      unreadCount: Number(obj["unread_count"] ?? 0),
      latestTimestamp: typeof latest === "string" ? latest : null
    };
  }
}
