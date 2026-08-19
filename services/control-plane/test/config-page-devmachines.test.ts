/**
 * Config page — DevMachine section (Task #16(a), PROJECT_BIBLE §9 C.5/C.6, ADR-0005, TM-020).
 *
 * Colorblind-safe per §9 (CC1): text label + shape/icon, never color alone. Security (C.5/TM-020):
 * the page NEVER displays a raw private key — and we render only the provisioned *status*, never
 * the opaque `sshKeyHandle` custody reference itself.
 */

import { describe, it, expect } from "vitest";
import { renderConfigPage } from "../src/http/config-page.js";
import type { DevMachine } from "../src/registry/types.js";

const machine: DevMachine = {
  id: "m1",
  logicalName: "mac-studio",
  host: "192.168.1.192",
  port: 22,
  user: "karl",
  sshKeyHandle: "vault:ssh/harness-ed25519",
  provisioned: true,
  enabled: true,
  createdAt: "2026-06-13T00:00:00.000Z",
  updatedAt: "2026-06-13T00:00:00.000Z"
};

describe("renderConfigPage — DevMachine section", () => {
  it("renders a labeled Dev Machines section with an Add control", () => {
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [], devMachines: [machine] });
    expect(html).toMatch(/Dev Machines/i);
    expect(html).toMatch(/Add Dev Machine/i);
  });

  it("shows logicalName, host, port and user for a configured machine", () => {
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [], devMachines: [machine] });
    expect(html).toContain("mac-studio");
    expect(html).toContain("192.168.1.192");
    expect(html).toContain("karl");
    expect(html).toMatch(/22/);
  });

  it("shows provisioning status as text + shape, never color alone", () => {
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [], devMachines: [machine] });
    expect(html).toMatch(/Provisioned/i);
    const unprov = renderConfigPage({
      backends: [],
      mcpServers: [],
      serviceEndpoints: [],
      devMachines: [{ ...machine, provisioned: false }]
    });
    expect(unprov).toMatch(/Not provisioned/i);
    // shape/icon token accompanies the status (CC1)
    expect(html).toMatch(/aria-label|role="img"|data-status/);
  });

  it("NEVER displays the SSH key handle / custody reference (TM-020 / C.5)", () => {
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [], devMachines: [machine] });
    expect(html).not.toContain("vault:ssh/harness-ed25519");
    // and certainly no raw-key form field
    expect(html).not.toMatch(/PRIVATE KEY/i);
    expect(html).not.toMatch(/name="sshKeyHandle"/i);
  });

  it("EMPTY state: shows empty-state text when no machines are configured", () => {
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [], devMachines: [] });
    expect(html).toMatch(/No dev machines/i);
  });

  it("remains backward-compatible when devMachines is omitted (renders empty state, no throw)", () => {
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [] });
    expect(html).toMatch(/Dev Machines/i);
    expect(html).toMatch(/No dev machines/i);
  });

  it("escapes HTML in dev-machine values (no injection)", () => {
    const evil = { ...machine, logicalName: "x", host: "x", user: '<script>alert(1)</script>' };
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [], devMachines: [evil] });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderConfigPage — provisioning a machine from the page (no terminal required)", () => {
  const page = (over: Partial<DevMachine> = {}) =>
    renderConfigPage({ backends: [], serviceEndpoints: [], mcpServers: [], devMachines: [{ ...machine, ...over }] } as never);

  it("offers a Provision form for an unprovisioned machine, posting to its enrollment route", () => {
    const html = page({ provisioned: false });
    expect(html).toContain('action="/api/dev-machines/m1/provision"');
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/api\/dev-machines\/m1\/provision"/);
  });

  it("collects the machine password in a password field that browsers will not autofill or store", () => {
    const html = page({ provisioned: false });
    const form = html.slice(html.indexOf("/api/dev-machines/m1/provision"));
    expect(form).toContain('type="password"');
    expect(form).toContain('name="password"');
    expect(form).toContain('autocomplete="off"');
  });

  it("does not offer the form for a machine that is already provisioned", () => {
    expect(page({ provisioned: true })).not.toContain("/api/dev-machines/m1/provision");
  });

  it("says plainly what the password is used for — one-time key install, not stored", () => {
    const html = page({ provisioned: false }).toLowerCase();
    expect(html).toContain("not stored");
  });
});
