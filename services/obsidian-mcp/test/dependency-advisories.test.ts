/**
 * BUGS #57 — pins the request-amplification bound that the @modelcontextprotocol/sdk upgrade
 * (1.29.0 -> 1.32.1) brings to this server: a JSON-RPC batch longer than 100 messages is refused
 * (SDK 1.30.1, MAX_BATCH_SIZE). On 1.29.0 one in-limit request could carry ~900 vault_search calls.
 *
 * server.ts listens on import, so the built server runs as a child process: `npm run build` first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_JS = fileURLToPath(new URL("../dist/server.js", import.meta.url));

let child: ChildProcess | undefined;
let vaultDir: string | undefined;
let base: string;
let sessionId: string;

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  vaultDir = mkdtempSync(join(tmpdir(), "obsidian-mcp-deps-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}/mcp`;
  const proc = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, VAULT_DIR: vaultDir, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child = proc;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start within 10s")), 10_000);
    proc.stdout?.on("data", (d: Buffer) => {
      if (d.toString().includes("listening")) {
        clearTimeout(t);
        resolve();
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`server exited early: ${code} (is dist/ built?)`));
    });
  });
  const init = await fetch(base, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "deps-test", version: "0" } }
    })
  });
  sessionId = init.headers.get("mcp-session-id") ?? "";
  await init.text();
  expect(sessionId).not.toBe("");
});

afterAll(async () => {
  const proc = child;
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    proc.kill();
    await exited;
  }
  if (vaultDir) rmSync(vaultDir, { recursive: true, force: true });
});

const batch = (n: number): string =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: "2.0", id: 100 + i, method: "ping" })));

describe("BUGS #57: SDK batch bound (amplification of one in-limit request)", () => {
  it("still answers a batch of 100 messages", async () => {
    const r = await fetch(base, { method: "POST", headers: { ...HEADERS, "mcp-session-id": sessionId }, body: batch(100) });
    await r.text();
    expect(r.status).toBe(200);
  });

  it("refuses a batch of 101 messages with 400 and JSON-RPC -32600", async () => {
    const r = await fetch(base, { method: "POST", headers: { ...HEADERS, "mcp-session-id": sessionId }, body: batch(101) });
    const text = await r.text();
    expect(r.status).toBe(400);
    expect(JSON.parse(text).error.code).toBe(-32600);
  });
});
