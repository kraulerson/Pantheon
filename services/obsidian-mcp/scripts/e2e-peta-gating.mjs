/**
 * End-to-end INTEGRATION proof (#8): the obsidian-mcp server, registered behind the LIVE
 * Peta gateway, has `vault_write` GATED (dangerLevel:2, human approval) while
 * `vault_read`/`vault_list` are frictionless.
 *
 * This is a self-gating infra integration script, NOT a unit test. It is written as a
 * runnable .mjs (not vitest) because the gateway BLOCKS the MCP `vault_write` call
 * synchronously (up to ~55s) while it waits for an admin approval decision — so the
 * approval dance must run CONCURRENTLY with the in-flight tool call. vitest's
 * per-test model makes that awkward; a script with Promise.all is the honest shape.
 *
 * Preconditions: Peta reachable at PETA_BASE. If not, SKIP gracefully (exit 0).
 *
 * All Peta interaction (CryptoService PBKDF2/AES-GCM, /admin API, MCP SDK client, the
 * approval flow) mirrors peta-eval/harness/peta.mjs + mock-server.mjs, which already
 * drive this exact flow against the running Peta and work.
 */
import { webcrypto as wc, randomBytes } from "node:crypto";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.PETA_BASE || "http://localhost:3002";
const STATE = process.env.PETA_STATE ||
  "/Users/karl/Documents/Claude Projects/Pantheon/peta-eval/harness/state.json";
const SERVER_ID = "obsidian-e2e";
const USER_NAME = "obsidian-e2e-user";
const SKIP_MSG =
  "SKIPPED — Peta not running; start with: docker-compose -p peta-eval " +
  "-f peta-eval/deploy/docker-compose.yml --env-file peta-eval/deploy/.env up -d";

const te = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- crypto, replicating src/security/CryptoService.ts (copied from peta.mjs) ----
async function deriveKey(password, salt) {
  const base = await wc.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
  return wc.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
  );
}
async function encryptData(data, key) {
  const salt = wc.getRandomValues(new Uint8Array(16));
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ck = await deriveKey(key, salt);
  const out = new Uint8Array(await wc.subtle.encrypt({ name: "AES-GCM", iv }, ck, te.encode(data)));
  return { data: b64(out.slice(0, -16)), iv: b64(iv), salt: b64(salt), tag: b64(out.slice(-16)) };
}
async function calcUserId(token) {
  const h = new Uint8Array(await wc.subtle.digest("SHA-256", te.encode(token)));
  return [...h].map((x) => x.toString(16).padStart(2, "0")).join("").substring(0, 32);
}

// ---- admin API (copied from peta.mjs) ----
async function admin(action, data, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/admin`, {
    method: "POST", headers, body: JSON.stringify({ action, data })
  });
  let json; try { json = await r.json(); } catch { json = { _unparseable: true }; }
  return { status: r.status, json };
}

async function mcpClient(token) {
  const client = new Client({ name: "obsidian-e2e-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  });
  await client.connect(transport);
  return { client, transport };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "0.0.0.0", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitHttp(url, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }); if (r.status) return true; }
    catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
};
const text = (res) => (res?.content || []).map((c) => c.text).join(" ");

async function main() {
  // ---- precondition ----
  try {
    const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(4000) });
    if (!h.ok) throw new Error(`health ${h.status}`);
  } catch {
    console.log(SKIP_MSG);
    process.exit(0);
  }

  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const ownerToken = state.ownerToken;
  if (!ownerToken) { console.log(SKIP_MSG + " [no ownerToken in state.json]"); process.exit(0); }

  const vaultDir = mkdtempSync(join(tmpdir(), "obsidian-e2e-vault-"));
  const port = await freePort();
  const downstreamUrl = `http://host.docker.internal:${port}/mcp`;
  const distServer = fileURLToPath(new URL("../dist/server.js", import.meta.url));

  // (2) seed temp vault with one note so reads have content
  const seedRel = "seed.md";
  const seedBody = "# Seed Note\nhello from the e2e vault\n";
  writeFileSync(join(vaultDir, seedRel), seedBody);

  // (1) start obsidian-mcp against TEMP vault, bound to 0.0.0.0:P
  const child = spawn(process.execPath, [distServer], {
    env: { ...process.env, VAULT_DIR: vaultDir, PORT: String(port), HOST: "0.0.0.0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (d) => process.stdout.write(`[obsidian] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[obsidian:err] ${d}`));

  let userToken = null;
  let serverRegistered = false;
  try {
    const up = await waitHttp(`http://127.0.0.1:${port}/mcp`, 8000);
    if (!up) throw new Error("obsidian-mcp did not start");

    // (3) register obsidian as CustomRemote http downstream; launchConfig encrypted w/ owner token
    const launch = JSON.stringify({ type: "http", url: downstreamUrl });
    const launchConfig = JSON.stringify(await encryptData(launch, ownerToken));
    const reg = await admin(2010, {
      serverId: SERVER_ID, serverName: "Obsidian Vault (e2e)", category: 2, authType: 1,
      allowUserInput: false, enabled: true,
      configTemplate: JSON.stringify({ url: downstreamUrl }), launchConfig
    }, ownerToken);
    if (reg.status !== 200 || reg.json?.success === false)
      throw new Error(`register failed: ${JSON.stringify(reg.json)}`);
    serverRegistered = true;
    const start = await admin(2001, { targetId: SERVER_ID }, ownerToken);
    if (start.json?.success === false)
      throw new Error(`start failed: ${JSON.stringify(start.json)}`);

    // set capabilities: vault_write dangerLevel:2 (approval), reads dangerLevel:0
    const caps = JSON.stringify({
      tools: {
        vault_list: { enabled: true, dangerLevel: 0 },
        vault_read: { enabled: true, dangerLevel: 0 },
        vault_search: { enabled: true, dangerLevel: 0 },
        vault_write: { enabled: true, dangerLevel: 2 }
      },
      resources: {}, prompts: {}
    });
    const setCaps = await admin(2003, { targetId: SERVER_ID, capabilities: caps }, ownerToken);
    if (setCaps.status !== 200 || setCaps.json?.success === false)
      throw new Error(`set-caps failed: ${JSON.stringify(setCaps.json)}`);

    // (4) scoped Peta user granted vault_list/read/write
    userToken = randomBytes(24).toString("hex");
    const userId = await calcUserId(userToken);
    const encUserTok = JSON.stringify(await encryptData(userToken, ownerToken));
    const perms = {
      [SERVER_ID]: {
        enabled: true,
        tools: {
          vault_list: { enabled: true }, vault_read: { enabled: true },
          vault_search: { enabled: true }, vault_write: { enabled: true }
        }
      }
    };
    const cu = await admin(1010, {
      userId, role: 3, status: 1, name: USER_NAME,
      encryptedToken: encUserTok, permissions: perms, proxyId: 0
    }, ownerToken);
    if (cu.status !== 200 || cu.json?.success === false)
      throw new Error(`create-user failed: ${JSON.stringify(cu.json)}`);
    await sleep(500); // let caps/perms propagate

    // (5) drive Peta /mcp as the scoped user
    const { client, transport } = await mcpClient(userToken);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      console.log("VISIBLE TOOLS:", JSON.stringify(tools));

      // (5a) reads → frictionless SUCCESS
      const list = await client.callTool({ name: "vault_list", arguments: {} });
      record("read: vault_list frictionless", !list.isError && text(list).includes("seed.md"),
        text(list).slice(0, 80));
      const read = await client.callTool({ name: "vault_read", arguments: { path: seedRel } });
      record("read: vault_read frictionless", !read.isError && text(read).includes("hello from the e2e vault"),
        text(read).slice(0, 60).replace(/\n/g, "\\n"));

      // (5b) vault_write → PAUSE for approval; APPROVE → completes AND file created
      const approveRel = "approved/created-by-approval.md";
      const approveBody = "content written only after human APPROVAL\n";
      const approvedFile = join(vaultDir, approveRel);
      const writeCallApprove = client.callTool({
        name: "vault_write", arguments: { path: approveRel, content: approveBody }
      });
      const pendId = await waitForPending(ownerToken, "vault_write");
      record("write: paused for approval (PENDING request created)", !!pendId, pendId || "no pending found");
      let approveDecided = false;
      if (pendId) {
        const dec = await admin(9203, { id: pendId, decision: "APPROVED", reason: "e2e approve" }, ownerToken);
        approveDecided = dec.json?.status === "APPROVED" || dec.json?.data?.status === "APPROVED";
      }
      const approveRes = await Promise.race([
        writeCallApprove.then((r) => ({ r })),
        sleep(58000).then(() => ({ timeout: true }))
      ]);
      const approveOk = !approveRes.timeout && !approveRes.r?.isError && existsSync(approvedFile) &&
        readFileSync(approvedFile, "utf8") === approveBody;
      record("write+APPROVE → call completes AND file written (evidence)", approveOk,
        approveRes.timeout ? "timed out" :
          `decided=${approveDecided}, fileExists=${existsSync(approvedFile)}, callResult=${text(approveRes.r).slice(0, 40)}`);

      // (5c) vault_write again, different content → REJECT → call fails AND file NOT changed
      const denyRel = "denied/should-not-exist.md";
      const denyBody = "this must NEVER be written (rejected)\n";
      const deniedFile = join(vaultDir, denyRel);
      const existedBefore = existsSync(deniedFile);
      const writeCallDeny = client.callTool({
        name: "vault_write", arguments: { path: denyRel, content: denyBody }
      });
      const pendId2 = await waitForPending(ownerToken, "vault_write", pendId);
      let rejectDecided = false;
      if (pendId2) {
        const dec = await admin(9203, { id: pendId2, decision: "REJECTED", reason: "e2e reject" }, ownerToken);
        rejectDecided = dec.json?.status === "REJECTED" || dec.json?.data?.status === "REJECTED";
      }
      const denyRes = await Promise.race([
        writeCallDeny.then((r) => ({ r })).catch((e) => ({ err: e })),
        sleep(58000).then(() => ({ timeout: true }))
      ]);
      const callRejected = !denyRes.timeout &&
        (denyRes.err != null || denyRes.r?.isError === true || /reject/i.test(text(denyRes.r)));
      const fileUnchanged = !existedBefore && !existsSync(deniedFile);
      record("write+REJECT → call fails AND file NOT created (evidence)", callRejected && fileUnchanged,
        denyRes.timeout ? "timed out" :
          `rejectedDecision=${rejectDecided}, callRejected=${callRejected}, fileExists=${existsSync(deniedFile)}`);
    } finally {
      await transport.close();
    }
  } finally {
    // (6) cleanup
    if (userToken) {
      const uid = await calcUserId(userToken);
      await admin(1001, { targetId: uid }, ownerToken).catch(() => {}); // disable
      await sleep(400); // let session disconnect settle before delete
      await admin(1013, { userId: uid }, ownerToken).catch(() => {}); // delete user
    }
    if (serverRegistered) {
      await admin(2002, { targetId: SERVER_ID }, ownerToken).catch(() => {}); // stop
      await admin(2013, { serverId: SERVER_ID }, ownerToken).catch(() => {}); // delete server
    }
    child.kill("SIGKILL");
    try { rmSync(vaultDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} assertions passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

// Poll 9201 for a PENDING vault_write approval request (created when the blocked call pauses).
async function waitForPending(ownerToken, toolName, excludeId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const r = await admin(9201, { serverId: SERVER_ID, toolName, status: "PENDING" }, ownerToken);
    const reqs = r.json?.requests || r.json?.data?.requests || [];
    const hit = reqs.find((x) => x.status === "PENDING" && x.id !== excludeId);
    if (hit) return hit.id;
    await sleep(300);
  }
  return null;
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(1); });
