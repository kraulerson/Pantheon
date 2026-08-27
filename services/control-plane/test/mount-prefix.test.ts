/**
 * Harness under the chat address (design 2026-08-27): Caddy strips `/harness` and sends
 * `X-Forwarded-Prefix: /harness`; every page, form, asset, redirect and socket URL the console
 * emits must carry that base — and without the header nothing changes at all.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/http/app.js";
import { SessionStore } from "../src/http/auth/session.js";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { McpRegistrationService } from "../src/registry/mcp-registration.js";
import { SqliteKeycardStore } from "../src/keycard/sqlite-store.js";
import { KeycardService } from "../src/keycard/service.js";
import { renderTerminalTab } from "../src/http/terminal-tab.js";

const TOKEN = "super-strong-admin-token-0123456789abcdef";
const admin = { authorization: `Bearer ${TOKEN}` };
const PREFIX = { "x-forwarded-prefix": "/harness" };
const form = { "content-type": "application/x-www-form-urlencoded" };

function makeApp(o: { login?: boolean; chatUrl?: string } = {}): FastifyInstance {
  const repo = new SqliteRegistry(":memory:");
  seedDefaults(repo);
  const registry = new RegistryService(repo);
  const mcp = new McpRegistrationService({ createServer: vi.fn(), getServers: vi.fn(async () => ({ success: true, servers: [] })) } as never);
  const keycards = new KeycardService(new SqliteKeycardStore(":memory:"), { now: () => Date.parse("2026-08-27T12:00:00.000Z") });
  return buildApp({
    adminToken: TOKEN,
    registry,
    mcp,
    keycards,
    peta: { listApprovals: vi.fn(async () => ({ success: true, data: { requests: [], hasMore: false } })), decideApproval: vi.fn(async () => ({ success: true })) },
    ...(o.login ? { operatorPassword: "correct horse", sessions: new SessionStore() } : {}),
    ...(o.chatUrl !== undefined ? { chatUrl: o.chatUrl } : {})
  });
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Every way a console-relative URL can be written without `withBase`/`BASE` (audit B F-F): attribute
 * literals in either quote, a ternary inside an attribute expression, DOM property/attribute sets,
 * fetch/open/redirect/location-header calls, and the socket URL. `/` alone (the chat root) is allowed.
 */
const BARE_URL_PATTERN =
  /(?:href|action|src)=\\?["']\/[a-z]|(?:href|action|src)="\$\{(?![^}]*withBase)[^}]*["']\/[a-z]|setAttribute\(["'](?:src|href|action)["'],\s*["']\/[a-z]|\.(?:href|action|src) = ["']\/[a-z]|fetch\(["'`]\/[a-z]|window\.open\(["'`]\/[a-z]|redirect\(["'`]\/[a-z]|header\(["']location["'],\s*["'`]\/[a-z]|location\.host \+ ["']\/[a-z]/i;

/** Every `href/action/src` in the body must start with the base (or be a fragment / external). */
function assertAllUrlsPrefixed(html: string, base: string): void {
  // real attributes only (`data-action="…"` is not a URL) — the attribute must start at a word boundary
  const urls = Array.from(html.matchAll(/(?:^|[\s<])(?:href|action|src)="([^"]*)"/g)).map((m) => m[1]);
  expect(urls.length).toBeGreaterThan(0);
  const offenders = urls.filter((u) => !(u.startsWith("#") || /^https?:\/\//.test(u) || u.startsWith(`${base}/`)));
  expect(offenders).toEqual([]);
}

describe("pages under the prefix", () => {
  it("harness frame: every link/asset carries the base and the client learns it from <html data-base>", async () => {
    app = makeApp();
    const res = await app.inject({ method: "GET", url: "/harness", headers: { ...admin, ...PREFIX } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-base="/harness"');
    assertAllUrlsPrefixed(res.body, "/harness");
    expect(res.body).toContain('href="/harness/admin/config"');
    expect(res.body).toContain('src="/harness/assets/xterm.js"');
    expect(res.body).toContain('href="/harness/assets/harness.css"');
  });

  it("without the header the frame is byte-identical in its URLs (root mount unchanged)", async () => {
    app = makeApp();
    const res = await app.inject({ method: "GET", url: "/harness", headers: admin });
    expect(res.body).toContain('data-base=""');
    expect(res.body).toContain('href="/admin/config"');
    expect(res.body).not.toContain("/harness/admin");
  });

  it("an unclean prefix header fails closed to the root mount", async () => {
    app = makeApp();
    const res = await app.inject({ method: "GET", url: "/harness", headers: { ...admin, "x-forwarded-prefix": "/harness/" } });
    expect(res.body).toContain('data-base=""');
  });

  it("configuration page: form actions, links and the client route table use the base", async () => {
    app = makeApp();
    const res = await app.inject({ method: "GET", url: "/admin/config", headers: { ...admin, ...PREFIX } });
    expect(res.statusCode).toBe(200);
    assertAllUrlsPrefixed(res.body, "/harness");
    expect(res.body).toContain('action="/harness/api/backends"');
    expect(res.body).toContain('action="/harness/api/keycards"');
    expect(res.body).toContain('data-base="/harness"');
  });

  it("approvals inbox and terminal page use the base (incl. the WebSocket path)", async () => {
    app = makeApp();
    const inbox = await app.inject({ method: "GET", url: "/admin/approvals", headers: { ...admin, ...PREFIX } });
    expect(inbox.statusCode).toBe(200);
    assertAllUrlsPrefixed(inbox.body, "/harness");
    const tab = await app.inject({ method: "GET", url: "/harness/terminal/nope", headers: { ...admin, ...PREFIX } });
    expect(tab.statusCode).toBe(200);
    assertAllUrlsPrefixed(tab.body, "/harness");
    expect(tab.body).toContain('href="/harness/assets/harness.css"'); // the empty-state page is themed too
    const known = renderTerminalTab({ logicalName: "mac", user: "karl", host: "192.168.1.192", port: 22, hasMachines: true, base: "/harness" });
    assertAllUrlsPrefixed(known, "/harness");
    expect(known).toContain('WS_PATH = "/harness/terminal/mac"');
    expect(renderTerminalTab({ logicalName: "mac", user: "karl", host: "h", port: 22, hasMachines: true })).toContain('WS_PATH = "/terminal/mac"');
  });

  it("the shared stylesheet is a public asset", async () => {
    app = makeApp();
    const res = await app.inject({ method: "GET", url: "/assets/harness.css" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/css/);
    expect(res.body).toContain("--surface-primary");
  });
});

describe("redirects under the prefix", () => {
  it("bare origin, login round-trip and logout all redirect within the base", async () => {
    app = makeApp({ login: true });
    const html = { accept: "text/html" };
    expect((await app.inject({ method: "GET", url: "/", headers: { ...admin, ...PREFIX } })).headers.location).toBe("/harness/harness");
    const anon = await app.inject({ method: "GET", url: "/harness", headers: { ...html, ...PREFIX } });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe("/harness/login");
    const page = await app.inject({ method: "GET", url: "/login", headers: PREFIX });
    expect(page.body).toContain('action="/harness/login"');
    assertAllUrlsPrefixed(page.body, "/harness");
    const login = await app.inject({ method: "POST", url: "/login", payload: "password=correct%20horse", headers: { ...form, ...PREFIX } });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe("/harness/harness");
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const out = await app.inject({ method: "POST", url: "/logout", headers: { cookie, ...PREFIX } });
    expect(out.headers.location).toBe("/harness/login");
  });

  it("configuration form posts, keycard mint/revoke and validation errors redirect within the base", async () => {
    app = makeApp();
    const add = await app.inject({ method: "POST", url: "/api/backends", headers: { ...admin, ...form, ...PREFIX }, payload: "displayName=b1&kind=local_alden1&endpoint=192.168.1.89:8080&enabled=on" });
    expect(add.statusCode).toBe(303);
    expect(add.headers.location).toBe("/harness/admin/config");
    const bad = await app.inject({ method: "POST", url: "/api/keycards", headers: { ...admin, ...form, ...PREFIX }, payload: "principal=cli&ttlDays=30" });
    expect(bad.headers.location).toBe("/harness/admin/config?error=keycard_scopes");
    const mint = await app.inject({ method: "POST", url: "/api/keycards", headers: { ...admin, ...form, ...PREFIX }, payload: "principal=cli&scopes=usage%3Aread&ttlDays=30" });
    expect(mint.statusCode).toBe(303);
    expect(mint.headers.location).toMatch(/^\/harness\/admin\/keycards\/minted\?slot=/);
    const slotPath = mint.headers.location!.replace(/^\/harness/, "");
    const minted = await app.inject({ method: "GET", url: slotPath, headers: { ...admin, ...PREFIX } });
    expect(minted.statusCode).toBe(200);
    assertAllUrlsPrefixed(minted.body, "/harness");
    expect(minted.body).toContain("<code>/harness/keycard/v1/whoami</code>");
    expect(minted.body).not.toContain("<code>/keycard/v1/");
    const list = await app.inject({ method: "GET", url: "/api/keycards", headers: admin });
    const id = (list.json() as Array<{ id: string }>)[0].id;
    const revoke = await app.inject({ method: "POST", url: `/api/keycards/${id}/revoke`, headers: { ...admin, ...form, ...PREFIX }, payload: "" });
    expect(revoke.headers.location).toBe("/harness/admin/config?notice=keycard_revoked");
  });
});

describe("invariant: no URL is written without the base", () => {
  it("no source file under src/http emits a bare absolute href/action/src/redirect/fetch", () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
      }
    };
    walk(join(process.cwd(), "src/http"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(new RegExp(BARE_URL_PATTERN.source, "g"))) offenders.push(`${f.replace(process.cwd() + "/", "")}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("audit 2026-08-27 hardenings (shared origin with the chat page)", () => {
  it("scopes the console cookie to the base so the chat backend never receives it (root stays Path=/)", async () => {
    app = makeApp({ login: true });
    const under = await app.inject({ method: "POST", url: "/login", payload: "password=correct%20horse", headers: { ...form, ...PREFIX } });
    expect(String(under.headers["set-cookie"])).toMatch(/;\s*Path=\/harness(;|$)/);
    const root = await app.inject({ method: "POST", url: "/login", payload: "password=correct%20horse", headers: form });
    expect(String(root.headers["set-cookie"])).toMatch(/;\s*Path=\/(;|$)/);
    const cookie = String(under.headers["set-cookie"]).split(";")[0];
    const out = await app.inject({ method: "POST", url: "/logout", headers: { cookie, ...PREFIX } });
    expect(String(out.headers["set-cookie"])).toMatch(/;\s*Path=\/harness(;|$)/);
    expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
  });

  it("console HTML is framed only by itself (frame-ancestors 'self') and busts out of any same-origin frame, under the prefix and at the root", async () => {
    app = makeApp({ login: true });
    for (const headers of [{ ...admin, ...PREFIX }, admin, PREFIX, {}]) {
      const url = "authorization" in headers ? "/harness" : "/login";
      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
      // same-origin framing (the chat tab's footer link loading the console INSIDE the chat iframe)
      // is allowed by CSP and then busted to the top window by the page itself (audit B F-A).
      expect(res.body).toMatch(/window\.top !== window\.self/);
      expect(res.body).toMatch(/window\.top\.location\.replace\(/);
    }
    const asset = await app.inject({ method: "GET", url: "/assets/harness.css" });
    expect(asset.headers["content-security-policy"]).toBeUndefined();
  });

  it("refuses a terminal WebSocket handshake the browser labels same-site or cross-site (sibling hosts), like the POST check", async () => {
    app = makeApp();
    const ws = { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": Buffer.from("the sample nonce").toString("base64") };
    for (const site of ["same-site", "cross-site"]) {
      const res = await app.inject({ method: "GET", url: "/terminal/mac", headers: { ...admin, ...ws, "sec-fetch-site": site } });
      expect(res.statusCode, site).toBe(403);
      expect(res.json()).toEqual({ error: "cross_origin_rejected" });
    }
    for (const site of ["same-origin", "none", undefined]) {
      const res = await app.inject({ method: "GET", url: "/terminal/mac", headers: { ...admin, ...ws, ...(site ? { "sec-fetch-site": site } : {}) } });
      expect(res.statusCode, String(site)).not.toBe(403);
    }
  });
});


describe("chat address for the admin-site Chat tab (audit B F-B)", () => {
  it("renders data-chat-url on the frame when configured, and nothing when not", async () => {
    app = makeApp({ chatUrl: "https://pantheon.ferrumcorde.com/" });
    expect((await app.inject({ method: "GET", url: "/harness", headers: admin })).body).toContain('data-chat-url="https://pantheon.ferrumcorde.com/"');
    await app.close();
    app = makeApp();
    expect((await app.inject({ method: "GET", url: "/harness", headers: admin })).body).not.toContain('data-chat-url="');
  });
});

describe("the static invariant catches every way a URL can be written (audit B F-F)", () => {
  it("matches each known escape pattern", () => {
    const bare = BARE_URL_PATTERN;
    const samples = [
      'href="/admin/config"', "href='/admin/config'", 'action="/api/x"', 'src="/assets/x.js"',
      'href="${ok ? "/harness" : "/admin/config"}"', "setAttribute('src', '/x')", 'setAttribute("href", "/x")',
      "a.href = '/x'", 'f.action = "/x"', "fetch('/x'", 'fetch("/x"', "fetch(`/x", "window.open('/x'",
      'redirect("/x"', "redirect(`/x", 'header("location", "/x"', "location.host + '/terminal/'"
    ];
    for (const sm of samples) expect(sm, sm).toMatch(bare);
    for (const ok of ['href="${withBase(base, "/admin/config")}"', "fetch(BASE + '/harness/tmux/'", 'src="/"', "iframe src='/'", 'href="#keycards"', 'href="https://x/"']) expect(ok, ok).not.toMatch(bare);
  });
});
