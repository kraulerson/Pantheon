import { describe, it, expect } from "vitest";
import { renderConfigPage } from "../src/http/config-page.js";
import type { Backend, ServiceEndpoint } from "../src/registry/types.js";

const backend: Backend = {
  id: "b1",
  kind: "local_alden1",
  endpoint: "192.168.1.89:8080",
  displayName: "Alden-1",
  enabled: true,
  createdAt: "2026-06-13T00:00:00.000Z",
  updatedAt: "2026-06-13T00:00:00.000Z"
};
const ep: ServiceEndpoint = {
  id: "e1",
  key: "qdrant",
  endpoint: "10.100.23.79:6333",
  displayName: "Qdrant",
  enabled: true,
  updatedAt: "2026-06-13T00:00:00.000Z"
};

describe("renderConfigPage — three labeled sections", () => {
  it("renders the three section labels", () => {
    const html = renderConfigPage({ backends: [backend], mcpServers: [{ serverId: "obsidian" }], serviceEndpoints: [ep] });
    expect(html).toContain("AI Backends");
    expect(html).toContain("MCP Servers");
    expect(html).toContain("Control-plane Service Endpoints");
    expect(html.toLowerCase()).toContain("<!doctype html>");
  });

  it("renders labeled add and remove controls (assert on markup, not color)", () => {
    const html = renderConfigPage({ backends: [backend], mcpServers: [], serviceEndpoints: [ep] });
    // Add controls (text labels, not color/icon-only)
    expect(html).toMatch(/Add Backend/i);
    expect(html).toMatch(/Add Service Endpoint/i);
    expect(html).toMatch(/Register MCP Server/i);
    // Remove controls carry a text label
    expect(html).toMatch(/Remove/);
    // Edit affordance for backends present
    expect(html).toMatch(/Edit/);
    // The data is shown
    expect(html).toContain("192.168.1.89:8080");
    expect(html).toContain("10.100.23.79:6333");
  });

  it("colorblind-safe: enabled/disabled status uses a text label and a shape/icon, not color alone", () => {
    const disabled = { ...backend, enabled: false };
    const html = renderConfigPage({ backends: [disabled], mcpServers: [], serviceEndpoints: [] });
    // Status conveyed in text
    expect(html).toMatch(/Disabled/);
    const html2 = renderConfigPage({ backends: [backend], mcpServers: [], serviceEndpoints: [] });
    expect(html2).toMatch(/Enabled/);
    // No reliance on color words alone as the only signal: a textual/shape token must accompany.
    // Shape/icon token present alongside the status label.
    expect(html2).toMatch(/aria-label|role="img"|data-status/);
  });

  it("EMPTY state: shows empty-state text for each section with no entries", () => {
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [] });
    expect(html).toMatch(/No backends/i);
    expect(html).toMatch(/No MCP servers/i);
    expect(html).toMatch(/No service endpoints/i);
  });

  it("ERROR state: renders an error banner with an icon+label when given an error", () => {
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [], error: "Peta unreachable" });
    expect(html).toMatch(/Error/);
    expect(html).toContain("Peta unreachable");
    // banner carries a non-color icon/shape marker + role
    expect(html).toMatch(/role="alert"/);
  });

  it("SUCCESS state: renders a success confirmation with icon+label when given a notice", () => {
    const html = renderConfigPage({ backends: [], mcpServers: [], serviceEndpoints: [], notice: "Backend saved" });
    expect(html).toMatch(/Success/);
    expect(html).toContain("Backend saved");
    expect(html).toMatch(/role="status"/);
  });

  it("escapes HTML in user-supplied values (no injection)", () => {
    const evil = { ...backend, displayName: '<script>alert(1)</script>' };
    const html = renderConfigPage({ backends: [evil], mcpServers: [], serviceEndpoints: [] });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
