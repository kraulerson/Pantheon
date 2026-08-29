/**
 * Terminal tab render — Task #16(d), PROJECT_BIBLE §9 C.6 (ADR-0005).
 *
 * Server-rendered xterm.js terminal tab (no SPA, matching config-page.ts). COLORBLIND-SAFE (CC1):
 * every state carries a TEXT label + a shape/icon token + `data-state`, never color alone. The four
 * §9 C.6 states (Empty / Loading / Error / Success) plus disconnect are all represented. The private
 * key never appears (it lives server-side); the page only opens a WebSocket to the broker.
 */

import { describe, it, expect } from "vitest";
import { renderTerminalTab } from "../src/http/terminal-tab.js";

const machineModel = {
  logicalName: "mac-studio",
  user: "karl",
  host: "192.168.1.192",
  port: 22,
  hasMachines: true
} as const;

describe("renderTerminalTab", () => {
  it("shows the machine identity and connection details in TEXT", () => {
    const html = renderTerminalTab(machineModel);
    expect(html).toContain("mac-studio");
    expect(html).toContain("karl");
    expect(html).toContain("192.168.1.192");
  });

  it("represents all four §9 C.6 states with a text label + shape/icon, never color alone", () => {
    const html = renderTerminalTab(machineModel);
    // text labels for each state
    expect(html).toMatch(/Connecting to/i); // Loading
    expect(html).toMatch(/connected to/i); // Success
    expect(html).toMatch(/disconnected/i); // Success→disconnect
    // error region is a labeled alert, not color-only
    expect(html).toMatch(/role="alert"/);
    // shape/state tokens accompany (CC1): runtime data-state regions present in the machine tab
    for (const s of ["loading", "error", "connected", "disconnected"]) {
      expect(html).toContain(`data-state="${s}"`);
    }
    // a non-color glyph/icon marker is present
    expect(html).toMatch(/aria-label|role="img"|class="glyph"/);
  });

  it("mounts an xterm.js terminal and opens a WebSocket to the broker for the machine", () => {
    const html = renderTerminalTab(machineModel);
    expect(html).toMatch(/id="terminal"/);
    expect(html).toMatch(/new WebSocket\(/);
    expect(html).toContain("/terminal/mac-studio"); // default ws path
    expect(html).toMatch(/xterm/); // xterm.js asset referenced
  });

  it("honors an explicit wsPath override", () => {
    const html = renderTerminalTab({ ...machineModel, wsPath: "/terminal/mac-studio?session=abc" });
    expect(html).toContain("/terminal/mac-studio?session=abc");
  });

  it("EMPTY state: no machine selected but machines exist → points to New Session", () => {
    const html = renderTerminalTab({ hasMachines: true });
    expect(html).toContain('data-state="empty"');
    expect(html).toMatch(/No dev machine selected/i);
    expect(html).toMatch(/New Session/i);
  });

  it("EMPTY state: no machines configured → points to Configuration", () => {
    const html = renderTerminalTab({ hasMachines: false });
    expect(html).toMatch(/No dev machines configured/i);
    expect(html).toMatch(/Configuration/i);
  });

  it("escapes HTML in machine fields (no injection)", () => {
    const html = renderTerminalTab({ ...machineModel, logicalName: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});


describe("renderTerminalTab — fills the window (fit addon) — operator report 2026-08-27", () => {
  it("loads the fit addon from our origin and fits on open, on ready, and on resize", () => {
    const html = renderTerminalTab(machineModel);
    expect(html).toMatch(/<script src="\/assets\/xterm-addon-fit\.js\?b=[^"]+"><\/script>/); // build-versioned (2026-08-28)
    expect(html).toMatch(/new window\.FitAddon\.FitAddon\(\)/);
    expect(html).toMatch(/loadAddon\(/);
    expect(html).toMatch(/ResizeObserver/);
    expect(html).toMatch(/addEventListener\("resize"/);
    // the fitted size is sent when the broker says ready
    expect(html).toMatch(/t: "r", c: term\.cols, r: term\.rows/);
  });
});
