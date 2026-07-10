#!/usr/bin/env node
/**
 * echo-channel — minimal two-way Claude Code channel (PROOF OF CONCEPT, not shipped).
 *
 * Node/TS port of the official channels-reference webhook example (the original uses
 * Bun.serve; the only hard dependency is the MCP SDK). Proves the full relay loop:
 *
 *   curl POST → sender gate → notifications/claude/channel → <channel> tag in the live
 *   session → Claude calls the `reply` tool → reply lands on the SSE stream (/events).
 *
 * Run inside Claude Code (research preview, custom channels need the dev flag):
 *   claude --dangerously-load-development-channels server:echo-channel
 *
 * stdout is the MCP stdio transport — all human-facing logging goes to stderr.
 */

import { createServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORT = Number(process.env["ECHO_PORT"] ?? 8788);
/** Sender allowlist (prompt-injection defense): gate on the SENDER's id, never the room. */
const ALLOWED_SENDERS = new Set(
  (process.env["ECHO_ALLOWED_SENDERS"] ?? "dev")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const sseListeners = new Set<ServerResponse>();
const replies: Array<{ chat_id: string; text: string; at: string }> = [];

function sseBroadcast(text: string): void {
  const chunk = text.split("\n").map((l) => `data: ${l}\n`).join("") + "\n";
  for (const res of sseListeners) res.write(chunk);
}

const mcp = new Server(
  { name: "echo-channel", version: "0.0.1" },
  {
    capabilities: {
      // this key is what makes it a channel — Claude Code registers a listener for it
      experimental: { "claude/channel": {} },
      tools: {}
    },
    instructions:
      'Messages arrive as <channel source="echo-channel" chat_id="...">. ' +
      "Reply with the reply tool, passing the chat_id from the tag."
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message back over this channel",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The conversation to reply in" },
          text: { type: "string", description: "The message to send" }
        },
        required: ["chat_id", "text"]
      }
    }
  ]
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string };
    replies.push({ chat_id, text, at: new Date().toISOString() });
    sseBroadcast(`Reply to ${chat_id}: ${text}`);
    return { content: [{ type: "text" as const, text: "sent" }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

await mcp.connect(new StdioServerTransport());

let nextChatId = 1;
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  // GET /events — SSE stream so `curl -N` can watch Claude's replies live
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(": connected\n\n");
    sseListeners.add(res);
    req.on("close", () => sseListeners.delete(res));
    return;
  }

  // GET /replies — JSON of everything the reply tool sent (used by the e2e test)
  if (req.method === "GET" && url.pathname === "/replies") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(replies));
    return;
  }

  // POST — inbound: gate on sender, then forward to Claude as a channel event
  if (req.method === "POST") {
    const sender = String(req.headers["x-sender"] ?? "");
    if (!ALLOWED_SENDERS.has(sender)) {
      req.resume();
      res.writeHead(403).end("forbidden");
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      const chat_id = String(nextChatId++);
      void mcp
        .notification({
          method: "notifications/claude/channel",
          params: {
            content: body, // becomes the body of the <channel> tag
            // each key becomes a tag attribute (identifiers only)
            meta: { chat_id, path: url.pathname, method: "POST" }
          }
        })
        .then(() => res.writeHead(200).end("ok"))
        .catch(() => res.writeHead(500).end("notify failed"));
    });
    return;
  }

  res.writeHead(404).end();
});

http.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(
    `echo-channel: inject via POST http://127.0.0.1:${PORT}/ (X-Sender gated), ` +
      `watch replies via GET /events\n`
  );
});
