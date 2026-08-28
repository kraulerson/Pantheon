/**
 * Unified Pending-Approvals inbox — M1 task 3 (TP-2 amendment, build plan §3).
 *
 *  - ONE admin-surface page (`GET /admin/approvals`) listing every pending approval across ALL
 *    sessions/identities, read from Peta's durable approval store.
 *  - REFERENCE-ONLY (D8): identity, tool, target, age, status — never arguments / diff / payload.
 *  - every outcome is a LABELLED state (CC1/CC2): ok, empty ("no pending approvals" — not blank),
 *    unavailable (Peta not wired, 503), failed (Peta down / slow / odd shape, 502).
 *  - resolution buttons arrive with M2 C.3; until then the page says so in words.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions } from "../src/http/app.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { renderHarnessFrame } from "../src/http/harness-frame.js";
import { SessionStore } from "../src/http/auth/session.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const admin = { authorization: `Bearer ${TOKEN}` };
const NOW = Date.parse("2026-08-26T12:00:00.000Z");
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();

const PENDING_A = {
  approvalId: "ap-1", tool: "gitea_file_write", serverId: "gitea", status: "pending", createdAt: minutesAgo(5), userId: "alden-1",
  arguments: { path: "secret.txt", content: "SECRET-CONTENT" }, diff: "--- a\n+++ b\n+SECRET-CONTENT", payload: { token: "PAYLOAD-SECRET" }
};
const PENDING_B = { approvalId: "ap-2", tool: "memory_store", serverId: "qdrant", status: "pending", createdAt: minutesAgo(3 * 60), userId: "alden-cloud", arguments: { text: "ARGS-B" } };
const RESOLVED = { approvalId: "ap-3", tool: "gitea_repo_create", serverId: "gitea", status: "approved", createdAt: minutesAgo(600), userId: "alden-1" };

const peta = (requests: unknown[], extra: Record<string, unknown> = {}) => ({ success: true, data: { requests, page: 1, pageSize: 50, hasMore: false, ...extra } });

interface Made { app: FastifyInstance; listApprovals: ReturnType<typeof vi.fn> }

function makeApp(o: { peta?: false | ((filter?: unknown) => Promise<unknown>); timeoutMs?: number; login?: boolean; sources?: Array<{ label: string; reader: { listApprovals: (f?: unknown) => Promise<unknown> } }> } = {}): Made {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({ createServer: vi.fn(), getServers: vi.fn(async () => ({ success: true, servers: [] })) } as never);
  const listApprovals = vi.fn(o.peta === undefined ? async () => peta([PENDING_A, PENDING_B]) : o.peta === false ? async () => ({}) : o.peta);
  const opts: AppOptions = {
    adminToken: TOKEN,
    registry,
    mcp,
    now: () => NOW,
    ...(o.peta === false ? {} : { peta: { listApprovals, decideApproval: vi.fn(async () => ({ success: true })) } }),
    ...(o.timeoutMs !== undefined ? { approvalsTimeoutMs: o.timeoutMs } : {}),
    ...(o.login ? { operatorPassword: "correct horse", sessions: new SessionStore() } : {}),
    ...(o.sources ? { approvalSources: o.sources } : {})
  };
  return { app: buildApp(opts), listApprovals };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const get = (a: FastifyInstance, headers: Record<string, string> = admin) => a.inject({ method: "GET", url: "/admin/approvals", headers });

describe("GET /admin/approvals — the inbox is an admin page", () => {
  it("refuses an unauthenticated caller before reading anything from Peta", async () => {
    const made = makeApp();
    app = made.app;
    const res = await get(app, {});
    expect(res.statusCode).toBe(401);
    expect(made.listApprovals).not.toHaveBeenCalled();
  });

  it("lists every pending approval across all identities/sessions as reference rows", async () => {
    ({ app } = makeApp());
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).toContain('data-state="ok"');
    expect(html).toContain('data-approval-id="ap-1"');
    expect(html).toContain('data-approval-id="ap-2"');
    for (const s of ["alden-1", "alden-cloud", "gitea_file_write", "memory_store", "gitea", "qdrant"]) expect(html).toContain(s);
  });

  it("NEVER renders arguments, diff or payload (D8) — only references", async () => {
    ({ app } = makeApp());
    const html = (await get(app)).body;
    for (const leak of ["SECRET-CONTENT", "secret.txt", "+++ b", "PAYLOAD-SECRET", "ARGS-B", "arguments", "payload"]) expect(html).not.toContain(leak);
  });

  it("renders age as words from createdAt, and says so when the time is missing", async () => {
    ({ app } = makeApp({ peta: async () => peta([PENDING_A, PENDING_B, { approvalId: "ap-9", tool: "t", serverId: "s", status: "pending", userId: "x" }]) }));
    const html = (await get(app)).body;
    expect(html).toContain("5 min ago");
    expect(html).toContain("3 h ago");
    expect(html).toContain("unknown age");
  });

  it("labels the empty state in words — never a blank page", async () => {
    ({ app } = makeApp({ peta: async () => peta([]) }));
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-state="empty"');
    expect(res.body).toContain("No pending approvals");
  });

  it("does not list already-resolved items but says how many were left out", async () => {
    ({ app } = makeApp({ peta: async () => peta([PENDING_A, RESOLVED]) }));
    const html = (await get(app)).body;
    expect(html).toContain('data-approval-id="ap-1"');
    expect(html).not.toContain('data-approval-id="ap-3"');
    expect(html).toContain('data-hidden-count="1"');
    expect(html).not.toContain("gitea_repo_create"); // the resolved item is named nowhere on the page
  });

  it("says when more approvals exist than the page shows (Peta hasMore or the 200-item cap)", async () => {
    ({ app } = makeApp({ peta: async () => peta([PENDING_A], { hasMore: true }) }));
    expect((await get(app)).body).toContain('data-more="true"');
    await app.close();
    const many = Array.from({ length: 201 }, (_, i) => ({ ...PENDING_B, approvalId: `ap-m${i}` }));
    ({ app } = makeApp({ peta: async () => peta(many) }));
    const html = (await get(app)).body;
    expect(html).toContain('data-more="true"');
    expect(html.match(/data-approval-id="/g)).toHaveLength(200);
    await app.close();
    ({ app } = makeApp());
    expect((await get(app)).body).not.toContain('data-more="true"');
  });

  it("escapes hostile text from Peta — a tool name is data, never markup", async () => {
    ({ app } = makeApp({ peta: async () => peta([{ ...PENDING_A, tool: "<script>alert(1)</script>", userId: "\"><img src=x onerror=alert(2)>" }]) }));
    const html = (await get(app)).body;
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("answers a labelled 503 when Peta is not configured on this server", async () => {
    ({ app } = makeApp({ peta: false }));
    const res = await get(app);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('data-state="unavailable"');
    expect(res.body).toContain("not configured");
  });

  it("answers a labelled 502 when Peta fails, hangs, or answers an odd shape — no stack, no text echo", async () => {
    ({ app } = makeApp({ peta: async () => { throw new Error("upstream-detail-must-not-leak"); } }));
    let res = await get(app);
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('data-state="failed"');
    expect(res.body).toContain("did not answer");
    expect(res.body).not.toContain("upstream-detail-must-not-leak");
    await app.close();
    ({ app } = makeApp({ peta: () => new Promise(() => {}), timeoutMs: 20 }));
    res = await get(app);
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("did not answer in time");
    await app.close();
    ({ app } = makeApp({ peta: async () => ({ success: true }) }));
    res = await get(app);
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("unexpected approvals response shape");
  });

  it("tells the operator in words that approve/reject arrives with M2 (C.3) — read-only for now", async () => {
    ({ app } = makeApp());
    const html = (await get(app)).body;
    expect(html).toContain('data-resolution="m2-c3"');
    expect(html).not.toMatch(/<button[^>]*>(Approve|Reject)/);
    expect(html).not.toContain("/decide");
  });
});

describe("GET /admin/approvals — audit remediation (2026-08-26)", () => {
  it("treats Peta's PENDING (any case) as pending, hides only KNOWN-terminal statuses, and shows unknown ones (fail-visible)", async () => {
    const items = [
      { ...PENDING_A, approvalId: "up", status: "PENDING" },
      { ...PENDING_A, approvalId: "mixed", status: "Pending" },
      { ...PENDING_A, approvalId: "weird", status: "escalated" },
      { ...PENDING_A, approvalId: "rej", status: "REJECTED" },
      { ...PENDING_A, approvalId: "app", status: "approved" },
      { ...PENDING_A, approvalId: "exp", status: "expired" }
    ];
    ({ app } = makeApp({ peta: async () => peta(items) }));
    const html = (await get(app)).body;
    for (const id of ["up", "mixed", "weird"]) expect(html).toContain(`data-approval-id="${id}"`);
    for (const id of ["rej", "app", "exp"]) expect(html).not.toContain(`data-approval-id="${id}"`);
    expect(html).toContain('data-hidden-count="3"');
    expect(html).toContain('data-state="ok"');
  });

  it("never fabricates a pending row: items without a reference id are counted, and a missing status reads '(not given)'", async () => {
    ({ app } = makeApp({ peta: async () => peta([null, {}, { tool: "orphan-tool" }, { approvalId: "ap-nostatus", tool: "t", serverId: "s", userId: "u", createdAt: minutesAgo(1) }]) }));
    const html = (await get(app)).body;
    expect(html.match(/data-approval-id="/g)).toHaveLength(1);
    expect(html).toContain('data-unidentified-count="3"');
    expect(html).not.toContain("orphan-tool");
    const row = /<tr data-approval-id="ap-nostatus">[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
    expect(row).toContain("(not given)");
    expect(row).not.toContain("pending");
  });

  it("sends no-store and nosniff on every outcome (ok, 503, 502)", async () => {
    ({ app } = makeApp());
    let res = await get(app);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
    ({ app } = makeApp({ peta: false }));
    res = await get(app);
    expect(res.statusCode).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
    ({ app } = makeApp({ peta: async () => { throw new Error("x"); } }));
    res = await get(app);
    expect(res.statusCode).toBe(502);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("escapes hostile text inside ATTRIBUTE values too (id → data-approval-id, createdAt → datetime)", async () => {
    ({ app } = makeApp({ peta: async () => peta([{ ...PENDING_A, approvalId: '" onmouseover="alert(1)', createdAt: '"><script>x</script>' }]) }));
    const html = (await get(app)).body;
    expect(html).not.toContain('onmouseover="alert');
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&quot; onmouseover=&quot;alert(1)");
    expect(html).toContain("unknown age");
  });

  it("a keycard bearer cannot open the inbox (admin route; 403, never a Peta read)", async () => {
    const made = makeApp();
    app = made.app;
    const res = await get(app, { authorization: "Bearer pk1_" + "a".repeat(64) });
    expect(res.statusCode).toBe(403);
    expect(made.listApprovals).not.toHaveBeenCalled();
  });
});

describe("GET /admin/approvals — reads ALL waiting items, not Peta's first unfiltered page", () => {
  it("asks Peta for PENDING items page by page and lists rows from every page", async () => {
    const made = makeApp({ peta: async (f?: unknown) => ((f as { page: number }).page === 1 ? peta([PENDING_A], { hasMore: true, page: 1 }) : peta([PENDING_B], { hasMore: false, page: 2 })) });
    app = made.app;
    const html = (await get(app)).body;
    expect(made.listApprovals.mock.calls.map((c) => c[0])).toEqual([{ status: "PENDING", page: 1, pageSize: 100 }, { status: "PENDING", page: 2, pageSize: 100 }]);
    expect(html).toContain('data-approval-id="ap-1"');
    expect(html).toContain('data-approval-id="ap-2"');
    expect(html).not.toContain('data-more="true"');
  });

  it("the more-note never claims a number the read did not enforce", async () => {
    ({ app } = makeApp({ peta: async () => peta([PENDING_A], { hasMore: true }) }));
    const html = (await get(app)).body;
    expect(html).toContain('data-more="true"');
    expect(html).not.toMatch(/first 200|at most 200/);
  });
});

describe("GET /admin/approvals — the other tiers", () => {
  it("an identity header alone is not a credential (401) and Peta is never read", async () => {
    const made = makeApp();
    app = made.app;
    expect((await get(app, { "x-pantheon-identity": "alden-1" })).statusCode).toBe(401);
    expect(made.listApprovals).not.toHaveBeenCalled();
  });

  it("a logged-out browser is sent to /login (never raw JSON); the session cookie then opens the inbox", async () => {
    const made = makeApp({ login: true });
    app = made.app;
    const anon = await get(app, { accept: "text/html" });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toMatch(/^\/login/);
    expect(made.listApprovals).not.toHaveBeenCalled();
    const login = await app.inject({ method: "POST", url: "/login", payload: "password=correct%20horse", headers: { "content-type": "application/x-www-form-urlencoded" } });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const res = await get(app, { cookie });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-state="ok"');
  });
});

describe("harness frame — reaching the inbox", () => {
  it("links to Approvals in the page chrome next to Configuration and Help", () => {
    const html = renderHarnessFrame({ devMachines: [], loginEnabled: false });
    expect(html).toContain('href="/admin/approvals"');
    expect(html).toContain('data-nav="approvals"');
  });
});

describe("GET /admin/approvals — every approval store the household uses (BUGS #42, UAT-4 #14)", () => {
  const alden = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ listApprovals: async () => peta(rows, extra) });
  const ALDEN_ROW = { approvalId: "2a2749b3", tool: "gitea_file_write", serverId: "gitea", status: "PENDING", createdAt: minutesAgo(2), userId: "alden-1" };

  it("lists rows from this host's Peta AND every configured source, each labelled with its source", async () => {
    ({ app } = makeApp({ sources: [{ label: "Alden gateway", reader: alden([ALDEN_ROW]) }] }));
    const html = (await get(app)).body;
    expect(html).toContain('data-state="ok"');
    expect(html).toContain('data-approval-id="ap-1"');
    expect(html).toContain('data-approval-id="2a2749b3"');
    expect(html).toMatch(/<th scope="col">Source<\/th>/);
    expect(html).toMatch(/data-approval-id="2a2749b3">\s*<td>Alden gateway<\/td>/);
    expect(html).toMatch(/data-approval-id="ap-1">\s*<td>Pantheon<\/td>/);
    expect(html).toContain('data-sources="Pantheon|Alden gateway"');
  });

  it("names the stores it checked in the empty state, so 'nothing waiting' is never mistaken for 'nothing anywhere'", async () => {
    ({ app } = makeApp({ peta: async () => peta([]), sources: [{ label: "Alden gateway", reader: alden([]) }] }));
    const html = (await get(app)).body;
    expect(html).toContain('data-state="empty"');
    expect(html).toMatch(/No pending approvals[^<]*Checked: Pantheon, Alden gateway/);
  });

  it("a source that does not answer is a labelled banner; the other sources' rows still show (200)", async () => {
    ({ app } = makeApp({ sources: [{ label: "Alden gateway", reader: { listApprovals: async () => { throw new Error("secret-detail"); } } }] }));
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-approval-id="ap-1"');
    expect(res.body).toMatch(/data-source-state="failed"[^>]*>\[!\] Alden gateway: the approval gate did not answer/);
    expect(res.body).not.toContain("secret-detail");
  });

  it("when EVERY source fails the page is a labelled 502; with no source at all it is a labelled 503", async () => {
    ({ app } = makeApp({ peta: async () => { throw new Error("x"); }, sources: [{ label: "Alden gateway", reader: { listApprovals: () => new Promise(() => {}) } }], timeoutMs: 20 }));
    let res = await get(app);
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain('data-state="failed"');
    expect(res.body).toMatch(/Pantheon: the approval gate did not answer/);
    expect(res.body).toMatch(/Alden gateway: the approval gate did not answer in time/);
    await app.close();
    ({ app } = makeApp({ peta: false }));
    res = await get(app);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('data-state="unavailable"');
  });

  it("an extra source works even when this host's Peta is not wired (the household's store is the one that matters)", async () => {
    ({ app } = makeApp({ peta: false, sources: [{ label: "Alden gateway", reader: alden([ALDEN_ROW]) }] }));
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-approval-id="2a2749b3"');
    expect(res.body).toContain('data-sources="Alden gateway"');
  });
});
