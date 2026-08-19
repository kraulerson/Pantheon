/**
 * Harness frame render — Task #16(e), PROJECT_BIBLE §9 C.1/C.6 (ADR-0005, amends ADR-0001).
 *
 * The top-level UI behind the #9 auth gate hosting BOTH modalities: LibreChat chat tabs and
 * xterm.js terminal tabs. The New Session popup (AI SYSTEM × IDENTITY) routes a "Claude CLI → dev
 * machine" selection to a terminal tab, by the machine's logicalName (#14a). Colorblind-safe text
 * labels throughout. Only provisioned + enabled machines are offered as connectable.
 */

import { describe, it, expect } from "vitest";
import { renderHarnessFrame } from "../src/http/harness-frame.js";
import type { DevMachine } from "../src/registry/types.js";

function machine(over: Partial<DevMachine>): DevMachine {
  return {
    id: "m",
    logicalName: "mac-studio",
    host: "192.168.1.192",
    port: 22,
    user: "karl",
    sshKeyHandle: "harness",
    provisioned: true,
    enabled: true,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...over
  };
}

describe("renderHarnessFrame", () => {
  it("renders a New Session popup with AI SYSTEM and IDENTITY selectors (§9 C.1)", () => {
    const html = renderHarnessFrame({ devMachines: [machine({})] });
    expect(html).toMatch(/New Session/i);
    expect(html).toMatch(/AI System/i);
    expect(html).toMatch(/Identity/i);
  });

  it("offers a 'Claude CLI → <logicalName>' route to a terminal tab for each provisioned, enabled machine", () => {
    const html = renderHarnessFrame({ devMachines: [machine({ logicalName: "mac-studio" }), machine({ id: "m2", logicalName: "linux-box", host: "192.168.1.78" })] });
    expect(html).toMatch(/Claude CLI/i);
    expect(html).toContain("mac-studio");
    expect(html).toContain("linux-box");
    // routes to the terminal tab by logicalName (a labeled control pointing at the terminal modality)
    expect(html).toMatch(/data-open-terminal="mac-studio"|\/harness\/terminal\/mac-studio/);
  });

  it("shows an unprovisioned or disabled machine as NOT connectable, with a text reason", () => {
    const html = renderHarnessFrame({
      devMachines: [machine({ logicalName: "unprov", provisioned: false }), machine({ id: "d", logicalName: "off", enabled: false })]
    });
    expect(html).toMatch(/not provisioned/i);
    expect(html).toMatch(/disabled/i);
    // a not-ready machine is not offered as a live terminal route
    expect(html).not.toMatch(/data-open-terminal="unprov"/);
  });

  it("hosts both modalities: a tab bar and a chat (LibreChat) area", () => {
    const html = renderHarnessFrame({ devMachines: [machine({})], chatUrl: "https://chat.local" });
    expect(html).toMatch(/role="tablist"|class="tabs"|data-tabs/);
    expect(html).toMatch(/chat/i);
    expect(html).toContain("https://chat.local");
  });

  it("uses text labels for tab/state, not color alone (CC1)", () => {
    const html = renderHarnessFrame({ devMachines: [machine({})] });
    expect(html).toMatch(/aria-label|role="tablist"|data-state|class="glyph"/);
  });

  it("escapes HTML in machine values (no injection)", () => {
    const html = renderHarnessFrame({ devMachines: [machine({ logicalName: "<script>alert(1)</script>", provisioned: true })] });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderHarnessFrame — reaching Configuration (BUGS #16)", () => {
  // The Configuration link used to live ONLY in the "no machines at all" empty state, so the
  // first machine an operator registered made the link disappear — and with an unprovisioned
  // machine there is no terminal to open either, leaving the page a dead end with no way back
  // to the page that fixes it. Navigation must not be a function of registry contents.
  it("links to Configuration when the registry is empty", () => {
    expect(renderHarnessFrame({ devMachines: [] })).toContain('href="/admin/config"');
  });

  it("still links to Configuration once a machine exists but is not provisioned", () => {
    const html = renderHarnessFrame({ devMachines: [machine({ provisioned: false })] });
    expect(html).toContain('href="/admin/config"');
  });

  it("still links to Configuration when a machine is ready to use", () => {
    const html = renderHarnessFrame({ devMachines: [machine({ provisioned: true, enabled: true })] });
    expect(html).toContain('href="/admin/config"');
  });

  it("keeps the link in the page chrome, not only inside the empty-state message", () => {
    const html = renderHarnessFrame({ devMachines: [machine({ provisioned: false })] });
    const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
    expect(header).toContain('href="/admin/config"');
  });
});

describe("renderHarnessFrame — Help", () => {
  it("puts a Help link in the header, in every registry state", () => {
    for (const machines of [[], [machine({ provisioned: false })], [machine({})]]) {
      const html = renderHarnessFrame({ devMachines: machines });
      const header = html.slice(html.indexOf("<header>"), html.indexOf("</header>"));
      expect(header).toContain('href="/help"');
    }
  });
});
