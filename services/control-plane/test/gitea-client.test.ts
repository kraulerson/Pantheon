/**
 * GiteaClient unit tests (always run; fetch fully mocked — no network).
 *
 * Asserts: request/URL construction, `Authorization: token <T>` header presence,
 * the token NEVER appears in thrown GiteaError messages, and non-2xx → typed
 * GiteaError carrying the API message. The live round-trip lives in
 * gitea-live.integration.test.ts (guarded).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { GiteaClient, GiteaError } from "../src/gitea/client.js";

const BASE = "https://gitea.example.com";
const TOKEN = "super-secret-token-DO-NOT-LEAK";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responder: (call: FetchCall) => { status: number; body: unknown }
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init: init ?? {} };
    calls.push(call);
    const { status, body } = responder(call);
    const hasBody = status !== 204 && status !== 205 && status !== 304;
    return new Response(hasBody ? JSON.stringify(body) : null, {
      status,
      headers: { "content-type": "application/json" }
    });
  });
  vi.stubGlobal("fetch", spy);
  return { calls };
}

function client(): GiteaClient {
  return new GiteaClient({ baseUrl: BASE, token: TOKEN });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GiteaClient — construction & config", () => {
  it("strips a trailing slash from baseUrl", () => {
    const c = new GiteaClient({ baseUrl: BASE + "/", token: TOKEN });
    expect(c.baseUrl).toBe(BASE);
  });

  it("throws if baseUrl or token is missing", () => {
    expect(() => new GiteaClient({ baseUrl: "", token: TOKEN })).toThrow();
    expect(() => new GiteaClient({ baseUrl: BASE, token: "" })).toThrow();
  });
});

describe("GiteaClient — auth header & URL construction", () => {
  it("getVersion() GETs /api/v1/version with the token auth header", async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: { version: "1.22.0" } }));
    const v = await client().getVersion();
    expect(v).toEqual({ version: "1.22.0" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/api/v1/version`);
    expect(call.init.method ?? "GET").toBe("GET");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe(`token ${TOKEN}`);
  });

  it("getFile() builds the contents URL with ref and decodes base64 content", async () => {
    const text = "# Persona\nYou are helpful.\n";
    const { calls } = mockFetch(() => ({
      status: 200,
      body: {
        name: "persona.md",
        path: "persona.md",
        sha: "abc123",
        encoding: "base64",
        content: Buffer.from(text, "utf8").toString("base64")
      }
    }));
    const f = await client().getFile("alice", "persona-repo", "persona.md", "main");
    expect(f.content).toBe(text);
    expect(f.sha).toBe("abc123");
    expect(calls[0]!.url).toBe(
      `${BASE}/api/v1/repos/alice/persona-repo/contents/persona.md?ref=main`
    );
  });

  it("getFile() omits the ref query when not provided", async () => {
    const { calls } = mockFetch(() => ({
      status: 200,
      body: { sha: "s", encoding: "base64", content: Buffer.from("x").toString("base64") }
    }));
    await client().getFile("o", "r", "dir/file.txt");
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/repos/o/r/contents/dir/file.txt`);
  });

  it("getFile() url-encodes path segments but keeps slashes", async () => {
    const { calls } = mockFetch(() => ({
      status: 200,
      body: { sha: "s", encoding: "base64", content: Buffer.from("x").toString("base64") }
    }));
    await client().getFile("o", "r", "a b/c.md");
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/repos/o/r/contents/a%20b/c.md`);
  });

  it("writeFile() PUTs base64 content + message and includes the auth header", async () => {
    const { calls } = mockFetch(() => ({
      status: 201,
      body: { content: { sha: "newsha", path: "persona.md" }, commit: { sha: "c1" } }
    }));
    const res = await client().writeFile("o", "r", "persona.md", "hello world", "add persona");
    expect(res.content.sha).toBe("newsha");
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/api/v1/repos/o/r/contents/persona.md`);
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe(`token ${TOKEN}`);
    const sent = JSON.parse(String(call.init.body)) as { content: string; message: string };
    expect(Buffer.from(sent.content, "base64").toString("utf8")).toBe("hello world");
    expect(sent.message).toBe("add persona");
  });

  it("writeFile() passes through pre-encoded base64 untouched and sets branch", async () => {
    const b64 = Buffer.from("raw bytes").toString("base64");
    const { calls } = mockFetch(() => ({
      status: 201,
      body: { content: { sha: "s", path: "f" }, commit: { sha: "c" } }
    }));
    await client().writeFile("o", "r", "f", b64, "msg", "dev");
    const sent = JSON.parse(String(calls[0]!.init.body)) as {
      content: string;
      branch: string;
    };
    expect(sent.content).toBe(b64);
    expect(sent.branch).toBe("dev");
  });

  it("createRepo() POSTs to /user/repos with private + auto_init defaults", async () => {
    const { calls } = mockFetch(() => ({
      status: 201,
      body: { id: 1, name: "r", full_name: "admin/r", private: true }
    }));
    const repo = await client().createRepo({ name: "r" });
    expect(repo.name).toBe("r");
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/api/v1/user/repos`);
    expect(call.init.method).toBe("POST");
    const sent = JSON.parse(String(call.init.body)) as {
      name: string;
      private: boolean;
      auto_init: boolean;
    };
    expect(sent).toMatchObject({ name: "r", private: true, auto_init: true });
  });

  it("createRepo({fromTemplate}) uses the generate-from-template endpoint", async () => {
    const { calls } = mockFetch(() => ({
      status: 201,
      body: { id: 2, name: "r", full_name: "admin/r", private: true }
    }));
    await client().createRepo({ name: "r", fromTemplate: "tmpl-owner/tmpl-repo" });
    const call = calls[0]!;
    expect(call.url).toBe(`${BASE}/api/v1/repos/tmpl-owner/tmpl-repo/generate`);
    const sent = JSON.parse(String(call.init.body)) as { name: string; private: boolean };
    expect(sent).toMatchObject({ name: "r", private: true });
  });

  it("getRepo() / listRepos() / deleteRepo() hit the right URLs+methods", async () => {
    const { calls } = mockFetch((c) => {
      if (c.init.method === "DELETE") return { status: 204, body: {} };
      if (c.url.endsWith("/user/repos")) return { status: 200, body: [{ id: 1, name: "a" }] };
      return { status: 200, body: { id: 1, name: "a", full_name: "o/a" } };
    });
    const cl = client();
    await cl.getRepo("o", "a");
    expect(calls[0]!.url).toBe(`${BASE}/api/v1/repos/o/a`);

    const list = await cl.listRepos();
    expect(Array.isArray(list)).toBe(true);
    expect(calls[1]!.url).toBe(`${BASE}/api/v1/user/repos`);

    await cl.deleteRepo("o", "a");
    expect(calls[2]!.url).toBe(`${BASE}/api/v1/repos/o/a`);
    expect(calls[2]!.init.method).toBe("DELETE");
  });
});

describe("GiteaClient — error mapping & token safety", () => {
  it("maps non-2xx to a typed GiteaError carrying status + API message", async () => {
    mockFetch(() => ({ status: 404, body: { message: "Not Found", url: "..." } }));
    let err: unknown;
    try {
      await client().getRepo("o", "missing");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GiteaError);
    const ge = err as GiteaError;
    expect(ge.status).toBe(404);
    expect(ge.message).toContain("Not Found");
  });

  it("NEVER includes the token in a thrown error (message, url field, or stack)", async () => {
    mockFetch(() => ({ status: 403, body: { message: "Forbidden" } }));
    let err: GiteaError | undefined;
    try {
      await client().getVersion();
    } catch (e) {
      err = e as GiteaError;
    }
    expect(err).toBeDefined();
    const serialized = `${err!.message}|${err!.stack ?? ""}|${JSON.stringify(err)}|${err!.url ?? ""}`;
    expect(serialized).not.toContain(TOKEN);
  });

  it("handles a non-JSON error body without leaking and still throws GiteaError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream boom", { status: 502 }))
    );
    await expect(client().getVersion()).rejects.toBeInstanceOf(GiteaError);
  });

  it("rejects a base64-claimed file whose encoding is unexpected", async () => {
    mockFetch(() => ({ status: 200, body: { sha: "s", encoding: "weird", content: "x" } }));
    await expect(client().getFile("o", "r", "f")).rejects.toBeInstanceOf(GiteaError);
  });
});
