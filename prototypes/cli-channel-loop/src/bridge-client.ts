/**
 * Minimal Alden Bridge MCP client — SPIKE-LOCAL copy.
 *
 * Deliberately duplicates the pattern of services/control-plane/src/bridge/client.ts
 * rather than importing across package boundaries: the spike must stay deletable without
 * touching the harness build. If this spike is promoted, the real BridgeClient is reused.
 *
 * SECURITY (same rules as the control-plane client):
 *  - the Bearer token NEVER appears in an error message, log line, or thrown object;
 *  - only non-destructive mailbox tools are used for reading (alden_mailbox_list, never
 *    alden_mailbox_read, which marks-read and would eat Cloud Alden's heartbeat).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface MailboxMessage {
  readonly id: number;
  readonly timestamp: string;
  readonly sender: string;
  readonly recipient: string;
  readonly message: string;
  readonly read: boolean;
}

export class BridgeError extends Error {
  readonly tool: string | undefined;
  constructor(message: string, tool?: string) {
    super(message);
    this.name = "BridgeError";
    this.tool = tool;
  }
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["hits", "messages", "results", "items"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

function extractToolResult(result: {
  isError?: boolean;
  structuredContent?: unknown;
  content?: ReadonlyArray<{ type?: string; text?: unknown }>;
}): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const text = result.content.find((c) => c?.type === "text");
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

export class SpikeBridgeClient {
  private readonly url: string;
  private readonly token: string;
  private readonly client: Client;
  private transport: StreamableHTTPClientTransport | undefined;
  private connected = false;

  constructor(url: string, token: string) {
    if (!url) throw new BridgeError("SpikeBridgeClient requires a url");
    if (!token) throw new BridgeError("SpikeBridgeClient requires a token");
    this.url = url;
    this.token = token;
    this.client = new Client({ name: "cli-channel-loop-spike", version: "0.0.1" });
  }

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

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) await this.connect();
    let result;
    try {
      result = await this.client.callTool({ name, arguments: args });
    } catch {
      throw new BridgeError("bridge tool call failed", name);
    }
    if (result.isError) throw new BridgeError("bridge tool returned an error", name);
    return extractToolResult(result as Parameters<typeof extractToolResult>[0]);
  }

  /** Non-destructive listing (alden_mailbox_list — never mailbox_read). */
  async mailboxList(args: { sinceId?: number; limit?: number; newestFirst?: boolean } = {}): Promise<MailboxMessage[]> {
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

  /**
   * Outbound send via a configured bridge tool (BRIDGE_SEND_TOOL). The tool name and its
   * argument schema are an ASSUMPTION TO VERIFY against the live bridge before first use
   * (see README); the spike passes `{ message }` and lets the bridge validate.
   */
  async send(toolName: string, message: string): Promise<void> {
    await this.call(toolName, { message });
  }
}
