/**
 * Thin MCP transport wiring for the Obsidian/filesystem vault server (#8).
 *
 * All tool logic lives in the pure `Vault` core (vault.ts); this file only adapts it to
 * the MCP StreamableHTTP transport (pattern mirrored from peta-eval/harness). It is kept
 * deliberately thin and is excluded from the coverage gate — the security-critical logic
 * is the unit-tested core.
 *
 * Registered behind Peta:
 *   vault_list / vault_read / vault_search  — READ (frictionless)
 *   vault_write                             — WRITE, marked dangerLevel:2 at the gateway.
 */
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Vault, PathTraversalError } from "./vault.js";

const VAULT_DIR = process.env.VAULT_DIR;
if (!VAULT_DIR) {
  throw new Error("VAULT_DIR is required (the configured Obsidian vault root).");
}
const PORT = Number(process.env.PORT ?? 9200);

const vault = new Vault(VAULT_DIR);

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };
function ok(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}
function fail(err: unknown): TextResult {
  const msg = err instanceof Error ? err.message : String(err);
  const prefix = err instanceof PathTraversalError ? "REJECTED (path-safety): " : "ERROR: ";
  return { content: [{ type: "text", text: prefix + msg }], isError: true };
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: "obsidian-mcp", version: "0.1.0" });

  server.registerTool(
    "vault_list",
    {
      title: "Vault List",
      description: "List note paths under the vault (optionally a subfolder).",
      inputSchema: { subfolder: z.string().optional() }
    },
    async ({ subfolder }) => {
      try {
        const paths = await vault.list(subfolder);
        return ok(JSON.stringify(paths));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "vault_read",
    {
      title: "Vault Read",
      description: "Read a note's content by vault-relative path.",
      inputSchema: { path: z.string() }
    },
    async ({ path }) => {
      try {
        return ok(await vault.read(path));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "vault_search",
    {
      title: "Vault Search",
      description: "Substring (default) or regex search across notes; returns matches with paths.",
      inputSchema: { query: z.string(), regex: z.boolean().optional() }
    },
    async ({ query, regex }) => {
      try {
        const hits = await vault.search(query, regex === undefined ? {} : { regex });
        return ok(JSON.stringify(hits));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "vault_write",
    {
      title: "Vault Write",
      description:
        "SENSITIVE (dangerLevel:2): create or append/overwrite a note at a vault-relative path; creates parent dirs.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        mode: z.enum(["overwrite", "append"]).optional()
      }
    },
    async ({ path, content, mode }) => {
      try {
        await vault.write(path, content, mode === undefined ? {} : { mode });
        return ok(`WROTE:${path}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

const transports: Record<string, StreamableHTTPServerTransport> = {};
const app = express();
app.use(express.json());

app.post("/mcp", async (req: Request, res: Response) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport | undefined;
  if (sid && transports[sid]) {
    transport = transports[sid];
  } else if (!sid && isInitializeRequest(req.body)) {
    const fresh = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = fresh;
      }
    });
    fresh.onclose = () => {
      if (fresh.sessionId) delete transports[fresh.sessionId];
    };
    // The SDK's Transport interface types `onclose?: () => void`, which clashes with this
    // project's exactOptionalPropertyTypes; the instance is a valid Transport at runtime.
    await buildServer().connect(fresh as Transport);
    transport = fresh;
  } else {
    res
      .status(400)
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionReq = async (req: Request, res: Response): Promise<void> => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  if (!sid || !transports[sid]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sid].handleRequest(req, res);
};
app.get("/mcp", sessionReq);
app.delete("/mcp", sessionReq);

app.listen(PORT, () => {
  console.log(`obsidian-mcp listening on :${PORT} (vault=${vault.root})`);
});
