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

describe("renderHarnessFrame — logout control (BUGS #20)", () => {
  it("renders a logout form posting to /logout when operator login is enabled", () => {
    const html = renderHarnessFrame({ devMachines: [], loginEnabled: true });
    expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/logout"/);
    expect(html).toMatch(/Log ?out/i);
  });
  it("omits the logout control when operator login is disabled", () => {
    const html = renderHarnessFrame({ devMachines: [], loginEnabled: false });
    expect(html).not.toContain('action="/logout"');
  });
});

describe("renderHarnessFrame — launch shortcuts persist while a tab is open (BUGS #22)", () => {
  const html = () => renderHarnessFrame({ devMachines: [machine({ provisioned: true, enabled: true })] });
  it("renders the terminal shortcuts OUTSIDE the hide-on-open welcome section", () => {
    const h = html();
    const start = h.indexOf("<section data-welcome>");
    const welcomeBlock = h.slice(start, h.indexOf("</section>", start));
    expect(h).toContain("data-open-terminal=");           // present in the page
    expect(welcomeBlock).not.toContain("data-open-terminal="); // but NOT inside the welcome section
  });
  it("puts the shortcuts in a persistent launch bar", () => {
    expect(html()).toMatch(/<nav class="launch-bar"[^>]*>[\s\S]*data-open-terminal=/);
  });
});

describe("renderHarnessFrame — tmux-aware launcher (M1 task 1)", () => {
  const ready = machine({ logicalName: "mac-mini" });

  it("renders a live tmux list slot, a Refresh control and a new-session form for each READY machine", () => {
    const html = renderHarnessFrame({ devMachines: [ready] });
    expect(html).toContain('data-tmux-list="mac-mini"');
    expect(html).toContain('data-tmux-refresh="mac-mini"');
    expect(html).toContain('data-tmux-new="mac-mini"');
  });

  it("renders NO tmux controls for a not-ready machine", () => {
    const html = renderHarnessFrame({
      devMachines: [machine({ logicalName: "unprov", provisioned: false }), machine({ id: "d", logicalName: "off", enabled: false })]
    });
    expect(html).not.toContain('data-tmux-list="unprov"');
    expect(html).not.toContain('data-tmux-list="off"');
    expect(html).not.toContain("data-tmux-new=");
  });

  it("labels the loading state in text with an icon (CC1), never colour alone", () => {
    const html = renderHarnessFrame({ devMachines: [ready] });
    expect(html).toMatch(/\[~\] listing tmux sessions on mac-mini/);
    expect(html).toMatch(/data-tmux-list="mac-mini"[^>]*data-state="loading"/);
  });

  it("constrains new-session names to the allow-list at the input (the server re-validates)", () => {
    const html = renderHarnessFrame({ devMachines: [ready] });
    expect(html).toMatch(/pattern="\[A-Za-z0-9_\]\[A-Za-z0-9_-\]\{0,63\}"/);
    expect(html).toMatch(/<form[^>]*data-tmux-new="mac-mini"[^>]*>[\s\S]*<input[^>]*name="session"/);
  });

  it("keeps the tmux controls in the persistent launch bar (BUGS #22 invariant)", () => {
    const html = renderHarnessFrame({ devMachines: [ready] });
    const bar = html.slice(html.indexOf('<nav class="launch-bar"'), html.indexOf("</nav>"));
    expect(bar).toContain('data-tmux-list="mac-mini"');
    expect(bar).toContain('data-tmux-new="mac-mini"');
  });

  it("escapes the machine name inside the tmux control attributes", () => {
    const html = renderHarnessFrame({ devMachines: [machine({ logicalName: '<x>"' })] });
    expect(html).not.toContain('data-tmux-list="<x>');
    expect(html).toContain("&lt;x&gt;&quot;");
  });
});

describe("renderHarnessFrame — tmux launcher audit remediation (2026-08-25)", () => {
  const html = () => renderHarnessFrame({ devMachines: [machine({ logicalName: "mac-mini" })] });

  it("the new-session form is novalidate so the labeled [!] text error is the real path (native bubbles swallow submit)", () => {
    expect(html()).toMatch(/<form[^>]*data-tmux-new="mac-mini"[^>]*novalidate/);
  });

  it("per-machine controls carry the machine name in their VISIBLE text (unique accessible names)", () => {
    expect(html()).toMatch(/<button[^>]*data-tmux-refresh="mac-mini"[^>]*>[^<]*mac-mini[^<]*<\/button>/);
    expect(html()).toMatch(/<button type="submit"[^>]*>[^<]*tmux session[^<]*mac-mini[^<]*<\/button>/);
  });

  it("the live status text is its own role=status element inside the slot (buttons render beside it, not in it)", () => {
    expect(html()).toMatch(/data-tmux-list="mac-mini"[^>]*>\s*<span[^>]*data-tmux-status[^>]*role="status"/);
  });
});
