/**
 * Guarded live integration against the real Alden Bridge MCP server.
 *
 * Runs ONLY if BRIDGE_MCP_URL + BRIDGE_MCP_TOKEN are set (loaded from .env.local) AND the
 * bridge is reachable. The Bearer token is read from env only — never hardcoded, never logged.
 * If unset/unreachable: SKIP (never fails CI offline).
 *
 * Asserts the documented shapes:
 *  - memorySearch({query:"test", collection:"alden-1", limit:2}) → hits[] with the hit shape;
 *  - mailboxList({limit:3}) → array of the documented message shape.
 * Uses ONLY non-destructive tools (mailboxList, not mailboxRead).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BridgeClient } from "../src/bridge/client.js";

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../.env.local");
if (existsSync(ENV_PATH)) {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    /* ignore malformed env; guard below handles missing token */
  }
}

const URL_ = process.env["BRIDGE_MCP_URL"] ?? "";
const TOKEN = process.env["BRIDGE_MCP_TOKEN"] ?? "";

let client: BridgeClient | undefined;
let reachable = false;

describe("BridgeClient — live MCP round-trip (guarded)", () => {
  beforeAll(async () => {
    if (!URL_ || !TOKEN) {
      console.warn("[bridge-live] SKIP: BRIDGE_MCP_URL or BRIDGE_MCP_TOKEN unset");
      return;
    }
    try {
      client = new BridgeClient({ url: URL_, token: TOKEN });
      await client.connect();
      reachable = true;
    } catch {
      console.warn(`[bridge-live] SKIP: ${URL_} unreachable`);
      reachable = false;
    }
  }, 15_000);

  afterAll(async () => {
    if (client) await client.close();
  });

  it("memorySearch returns the documented hit shape", async (ctx) => {
    if (!reachable || !client) return ctx.skip();
    const hits = await client.memorySearch({ query: "test", collection: "alden-1", limit: 2 });
    expect(Array.isArray(hits)).toBe(true);
    for (const h of hits) {
      expect(typeof h.collection).toBe("string");
      expect(typeof h.score).toBe("number");
      expect(h.id).toBeDefined();
      expect(typeof h.information).toBe("string");
    }
  }, 15_000);

  it("mailboxList returns an array of the documented message shape", async (ctx) => {
    if (!reachable || !client) return ctx.skip();
    const msgs = await client.mailboxList({ limit: 3 });
    expect(Array.isArray(msgs)).toBe(true);
    for (const m of msgs) {
      expect(m.id).toBeDefined();
      expect(typeof m.sender).toBe("string");
      expect(typeof m.message).toBe("string");
      expect(typeof m.timestamp).toBe("string");
    }
  }, 15_000);
});
