/**
 * BUGS #57 — pins the request-amplification bound that the @modelcontextprotocol/sdk upgrade
 * (1.29.0 -> 1.32.1) brings to this server: a JSON-RPC batch longer than 100 messages is refused
 * (SDK 1.30.1, MAX_BATCH_SIZE). On 1.29.0 one in-limit request could carry ~900 vault_search calls.
 *
 * BUGS #66 — pins body-parser 1.20.9 (GHSA-27r3-jxmh-p828): on 1.20.8 a gzip body followed by
 * trailing bytes made the finished decoder throw an uncaught error and the process exit.
 *
 * server.ts listens on import, so the built server runs as a child process: `npm run build` first.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

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

// Kept last: on a vulnerable body-parser this kills the shared server.
describe("BUGS #66: body-parser trailing bytes after a compressed body (GHSA-27r3-jxmh-p828)", () => {
  it("survives a gzip body followed by 100 KB of trailing bytes and keeps answering", async () => {
    // The advisory's shape: one gzip frame, a 0x00, then trailing bytes. 100 KB spans more than one
    // socket read, so the tail reaches the decoder after it has finished. Session-less: parsing runs
    // before routing, so no session or authentication is needed to reach it.
    const body = Buffer.concat([
      gzipSync(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }))),
      Buffer.from([0x00]),
      Buffer.alloc(100 * 1024, 0x58)
    ]);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        base,
        {
          method: "POST",
          headers: { ...HEADERS, "content-encoding": "gzip", "content-length": String(body.length) }
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode));
        }
      );
      req.once("error", reject);
      req.end(body);
    });
    expect(status).toBe(400);

    const proc = child;
    if (!proc) throw new Error("server not started");
    const outcome = await new Promise<string>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve(`exited code=${proc.exitCode} signal=${proc.signalCode}`);
        return;
      }
      const t = setTimeout(() => resolve("alive"), 1_000);
      proc.once("exit", (code, signal) => {
        clearTimeout(t);
        resolve(`exited code=${code} signal=${signal}`);
      });
    });
    expect(outcome).toBe("alive");

    const r = await fetch(base, { method: "POST", headers: { ...HEADERS, "mcp-session-id": sessionId }, body: batch(1) });
    await r.text();
    expect(r.status).toBe(200);
  });
});
