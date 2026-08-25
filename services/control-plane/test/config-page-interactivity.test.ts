/**
 * Configuration-page Edit/Remove wiring (BUGS #19). The page shipped no JavaScript, so every
 * Edit/Remove button was inert. These tests prove the wiring: Remove fires a DELETE, Edit reveals
 * a prefilled inline form, Save fires a PUT with the patch. MCP removal is deliberately disabled
 * (its DELETE route is a documented server-side no-op — no Peta delete action yet).
 */
import { describe, it, expect, vi } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { renderConfigPage } from "../src/http/config-page.js";

const backend = { id: "b-1", kind: "local_alden1", endpoint: "192.168.1.89:8080", displayName: "Alden Brain", enabled: true, createdAt: "x", updatedAt: "x" };
const machine = { id: "m-1", logicalName: "mac-studio", host: "192.168.1.192", port: 2222, user: "karl", sshKeyHandle: "h", provisioned: true, enabled: false, createdAt: "x", updatedAt: "x" };

function page(over: Record<string, unknown> = {}) {
  return renderConfigPage({ backends: [backend], serviceEndpoints: [], mcpServers: [{ serverId: "s1", serverName: "S1" }], devMachines: [machine], ...over } as never);
}

/** Load the page, run its script, and stub the browser bits the wiring calls. */
function live(html: string) {
  const vc = new VirtualConsole(); // swallow jsdom's "Not implemented: navigation" from location.reload
  const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole: vc });
  const w = dom.window as unknown as { document: Document; fetch: unknown; confirm: () => boolean; alert: () => void; Event: typeof Event; location: Location };
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  w.fetch = fetchMock;
  w.confirm = () => true;
  w.alert = () => undefined;
  try { Object.defineProperty(w.location, "reload", { configurable: true, value: () => undefined }); } catch { /* jsdom */ }
  const click = (el: Element) => el.dispatchEvent(new w.Event("click", { bubbles: true }));
  return { doc: w.document, fetchMock, click };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("config page — the buttons carry the data the editor needs", () => {
  it("edit buttons expose the current mutable values as data-* attributes", () => {
    const h = page();
    expect(h).toMatch(/data-action="edit-backend"[^>]*data-display="Alden Brain"[^>]*data-endpoint="192.168.1.89:8080"[^>]*data-enabled="true"/);
    expect(h).toMatch(/data-action="edit-devmachine"[^>]*data-host="192.168.1.192"[^>]*data-port="2222"[^>]*data-user="karl"[^>]*data-enabled="false"/);
  });
  it("the MCP remove button is disabled (its delete route is a server-side no-op)", () => {
    expect(page()).toMatch(/data-action="remove-mcp"[^>]*disabled/);
  });
  it("the page now ships a wiring script", () => {
    expect(page()).toContain("<script>");
    expect(page()).toContain("addEventListener('click'");
  });
});

describe("config page — Remove fires a DELETE (BUGS #19)", () => {
  it("clicking Remove on a backend DELETEs the right route", async () => {
    const { doc, fetchMock, click } = live(page());
    click(doc.querySelector('[data-action="remove-backend"]')!);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, { method: string }];
    expect(url).toBe("/api/backends/b-1");
    expect(opts.method).toBe("DELETE");
  });
  it("clicking the disabled MCP remove does NOT fetch", async () => {
    const { doc, fetchMock, click } = live(page());
    click(doc.querySelector('[data-action="remove-mcp"]')!);
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("config page — Edit reveals a prefilled form and Save PUTs it (BUGS #19)", () => {
  it("Edit replaces the row with inputs prefilled from the current values", async () => {
    const { doc, click } = live(page());
    click(doc.querySelector('[data-action="edit-backend"]')!);
    const inputs = doc.querySelectorAll("[data-edit]");
    const byName = (n: string) => Array.from(inputs).find((i) => i.getAttribute("data-edit") === n) as HTMLInputElement;
    expect(byName("displayName").value).toBe("Alden Brain");
    expect(byName("endpoint").value).toBe("192.168.1.89:8080");
    expect((byName("enabled") as HTMLInputElement).checked).toBe(true);
    expect(doc.querySelector('[data-action="save-edit"]')).not.toBeNull();
  });
  it("Save PUTs the edited patch to the record's route", async () => {
    const { doc, fetchMock, click } = live(page());
    click(doc.querySelector('[data-action="edit-backend"]')!);
    const endpoint = Array.from(doc.querySelectorAll("[data-edit]")).find((i) => i.getAttribute("data-edit") === "endpoint") as HTMLInputElement;
    endpoint.value = "10.0.0.9:9000";
    click(doc.querySelector('[data-action="save-edit"]')!);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe("/api/backends/b-1");
    expect(opts.method).toBe("PUT");
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ displayName: "Alden Brain", endpoint: "10.0.0.9:9000", enabled: true });
  });
});

describe("config page — keycard Revoke asks for a labeled confirm (BUGS-audit 2026-08-25)", () => {
  const keycard = { id: "k-1", principal: "cli-mac-mini", scopes: ["sessions:read"], createdAt: "2026-08-25T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z", expiresAt: "2026-11-23T12:00:00.000Z", revokedAt: null, lastUsedAt: null, useCount: 0, denyCount: 0 };
  function submitRevoke(confirmAnswer: boolean): boolean {
    const html = page({ keycards: [keycard] });
    const vc = new VirtualConsole();
    const dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole: vc });
    const w = dom.window as unknown as { document: Document; confirm: (m: string) => boolean; Event: typeof Event };
    let asked = "";
    w.confirm = (m: string) => { asked = m; return confirmAnswer; };
    const form = w.document.querySelector('[data-form="revoke-keycard"]') as HTMLFormElement;
    const ev = new w.Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(ev);
    expect(asked).toMatch(/cli-mac-mini/);
    return ev.defaultPrevented;
  }
  it("cancelling the confirm prevents the submit", () => {
    expect(submitRevoke(false)).toBe(true);
  });
  it("accepting the confirm lets the form submit", () => {
    expect(submitRevoke(true)).toBe(false);
  });
});
