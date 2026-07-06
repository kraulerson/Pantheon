// Mock downstream MCP server for peta-core functional tests.
// Exposes read_thing (benign) and write_thing (records evidence to writes.log).
// write_thing executing => a line is appended. Lets us PROVE deny == no execution.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.MOCK_PORT || 9100);
const WRITES = fileURLToPath(new URL('./writes.log', import.meta.url));

function buildServer() {
  const server = new McpServer({ name: 'mock-mcp', version: '1.0.0' });
  server.registerTool(
    'read_thing',
    { title: 'Read Thing', description: 'Benign read-only tool', inputSchema: { q: z.string().optional() } },
    async ({ q }) => ({ content: [{ type: 'text', text: `READ_OK:${q ?? ''}` }] })
  );
  server.registerTool(
    'write_thing',
    { title: 'Write Thing', description: 'Sensitive write tool; records evidence', inputSchema: { note: z.string() } },
    async ({ note }) => {
      appendFileSync(WRITES, `${new Date().toISOString()} WRITE ${note}\n`);
      return { content: [{ type: 'text', text: `WROTE:${note}` }] };
    }
  );
  return server;
}

const SECRET = process.env.MOCK_SECRET || '';
const transports = {};
const app = express();
app.use(express.json());
// A4: require an injected secret header on /mcp (simulates a credentialed downstream).
app.use((req, res, next) => {
  if (SECRET && req.path === '/mcp' && req.headers['x-eval-secret'] !== SECRET) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'missing/invalid x-eval-secret' }, id: null });
    return;
  }
  next();
});

app.post('/mcp', async (req, res) => {
  const sid = req.headers['mcp-session-id'];
  let transport;
  if (sid && transports[sid]) {
    transport = transports[sid];
  } else if (!sid && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports[id] = transport; },
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    await buildServer().connect(transport);
  } else {
    res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

const sessionReq = async (req, res) => {
  const sid = req.headers['mcp-session-id'];
  if (!sid || !transports[sid]) { res.status(400).send('Invalid or missing session ID'); return; }
  await transports[sid].handleRequest(req, res);
};
app.get('/mcp', sessionReq);
app.delete('/mcp', sessionReq);

// Out-of-band evidence endpoint (NOT part of MCP): how many times write_thing ran.
app.get('/__writes', (_req, res) => {
  const count = existsSync(WRITES) ? readFileSync(WRITES, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  res.json({ count });
});

app.listen(PORT, '0.0.0.0', () => console.log(`mock MCP server listening on 0.0.0.0:${PORT}`));
