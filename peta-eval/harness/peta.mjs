// Peta-core eval harness: replicates CryptoService (PBKDF2/AES-GCM) so we can
// bootstrap an Owner, register servers, set per-tool permissions, and drive the
// gateway as MCP clients WITHOUT the closed-source Peta Console. Pure Node + MCP SDK.
import { webcrypto as wc, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.PETA_BASE || 'http://localhost:3002';
const MOCK_URL = process.env.MOCK_URL || 'http://host.docker.internal:9100/mcp';
const STATE = fileURLToPath(new URL('./state.json', import.meta.url));
const te = new TextEncoder();
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// ---- crypto replicating src/security/CryptoService.ts exactly ----
async function deriveKey(password, salt) {
  const base = await wc.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return wc.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}
export async function encryptData(data, key) {
  const salt = wc.getRandomValues(new Uint8Array(16));
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ck = await deriveKey(key, salt);
  const out = new Uint8Array(await wc.subtle.encrypt({ name: 'AES-GCM', iv }, ck, te.encode(data)));
  return { data: b64(out.slice(0, -16)), iv: b64(iv), salt: b64(salt), tag: b64(out.slice(-16)) };
}
export async function calcUserId(token) {
  const h = new Uint8Array(await wc.subtle.digest('SHA-256', te.encode(token)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
}

// ---- admin API ----
export async function admin(action, data, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}/admin`, { method: 'POST', headers, body: JSON.stringify({ action, data }) });
  let json; try { json = await r.json(); } catch { json = { _unparseable: true }; }
  return { status: r.status, json };
}
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const ownerTok = () => { const s = loadState(); if (!s.ownerToken) throw new Error('no owner; run create-owner'); return s.ownerToken; };

// ---- MCP client through peta as a given token ----
async function mcpClient(token) {
  const client = new Client({ name: 'eval-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

const cmd = process.argv[2];
const arg = (i) => process.argv[i];

if (cmd === 'create-owner') {
  const state = loadState();
  const token = state.ownerToken || randomBytes(24).toString('hex');
  const userId = await calcUserId(token);
  const encryptedToken = JSON.stringify(await encryptData(token, token));
  const create = await admin(1010, { userId, role: 1, status: 1, name: 'owner', encryptedToken, proxyId: 0 });
  console.log('CREATE_USER(owner):', create.status, create.json.success ?? JSON.stringify(create.json));
  const authCheck = await admin(1011, {}, token);
  console.log('GET_USERS(as owner):', authCheck.status, authCheck.json.success);
  saveState({ ...state, ownerToken: token, ownerUserId: userId });
  console.log('owner ready: userId=%s', userId);

} else if (cmd === 'register-server') {
  const serverId = arg(3) || 'mock';
  const launchObj = { type: 'http', url: MOCK_URL };
  if (process.env.MOCK_SECRET) launchObj.headers = { 'x-eval-secret': process.env.MOCK_SECRET };
  const launch = JSON.stringify(launchObj);
  const launchConfig = JSON.stringify(await encryptData(launch, ownerTok()));
  const r = await admin(2010, {
    serverId, serverName: 'Mock MCP', category: 2, authType: 1, allowUserInput: false,
    enabled: true, configTemplate: JSON.stringify({ url: MOCK_URL }), launchConfig,
  }, ownerTok());
  console.log('CREATE_SERVER:', r.status, JSON.stringify(r.json));
  const start = await admin(2001, { targetId: serverId }, ownerTok());
  console.log('START_SERVER:', start.status, JSON.stringify(start.json));

} else if (cmd === 'inspect') {
  console.log('STATUS:', JSON.stringify((await admin(3004, {}, ownerTok())).json));
  console.log('CAPS:', JSON.stringify((await admin(3002, {}, ownerTok())).json));

} else if (cmd === 'set-caps') {
  // set-caps <serverId> <capsJSON>
  const serverId = arg(3); const caps = arg(4);
  const r = await admin(2003, { targetId: serverId, capabilities: caps }, ownerTok());
  console.log('UPDATE_SERVER_CAPABILITIES:', r.status, JSON.stringify(r.json));

} else if (cmd === 'create-user') {
  // create-user <name> <permsJSON>
  const name = arg(3); const perms = arg(4) ? JSON.parse(arg(4)) : {};
  const state = loadState();
  const token = randomBytes(24).toString('hex');
  const userId = await calcUserId(token);
  const encryptedToken = JSON.stringify(await encryptData(token, ownerTok())); // encrypted with ADMIN token
  const r = await admin(1010, { userId, role: 3, status: 1, name, encryptedToken, permissions: perms, proxyId: 0 }, ownerTok());
  console.log('CREATE_USER(%s):', name, r.status, JSON.stringify(r.json).slice(0, 200));
  state.users = state.users || {}; state.users[name] = { token, userId };
  saveState(state);
  console.log('user %s ready: userId=%s', name, userId);

} else if (cmd === 'set-perms') {
  // set-perms <name> <permsJSON>
  const name = arg(3); const perms = arg(4);
  const state = loadState();
  const r = await admin(1002, { targetId: state.users[name].userId, permissions: perms }, ownerTok());
  console.log('UPDATE_USER_PERMISSIONS(%s):', name, r.status, JSON.stringify(r.json));

} else if (cmd === 'client') {
  // client <name> list | client <name> call <tool> <argsJSON>
  const name = arg(3); const sub = arg(4);
  const state = loadState();
  const token = state.users?.[name]?.token || (name === 'owner' ? state.ownerToken : name); // allow raw token
  const { client, transport } = await mcpClient(token);
  try {
    if (sub === 'list') {
      const tools = await client.listTools();
      console.log('TOOLS:', JSON.stringify(tools.tools.map((t) => t.name)));
    } else if (sub === 'call') {
      const tool = arg(5); const args = arg(6) ? JSON.parse(arg(6)) : {};
      const res = await client.callTool({ name: tool, arguments: args });
      console.log('CALL_OK:', JSON.stringify(res).slice(0, 400));
    }
  } catch (e) {
    console.log('CALL_ERROR:', e?.code ?? '', e?.message ?? String(e));
  } finally {
    await transport.close();
  }

} else if (cmd === 'admin') {
  const action = Number(arg(3)); const data = arg(4) ? JSON.parse(arg(4)) : {};
  const r = await admin(action, data, ownerTok());
  console.log(r.status, JSON.stringify(r.json, null, 2));
} else {
  console.log('usage: create-owner | register-server [id] | inspect | set-caps <id> <json> | create-user <name> <perms> | set-perms <name> <perms> | client <name> list|call <tool> <args> | admin <action> <json>');
}
