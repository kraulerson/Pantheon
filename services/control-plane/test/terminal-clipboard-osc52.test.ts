// @vitest-environment jsdom
/**
 * OSC 52 through the REAL pinned `@xterm/addon-clipboard` (UAT-5 #10, BUGS #48).
 *
 * tmux pushes a copy-mode selection to the terminal as `ESC ] 52 ; <selection> ; <base64> BEL`
 * with an EMPTY selection field. The addon's stock provider only honours the selection `c`, so a
 * copy made inside tmux never reached the Mac clipboard while an app-emitted `52;c;…` did. These
 * tests drive the addon's own OSC handler (captured from a stand-in parser) with the exact byte
 * forms the tester used, and look at what reaches `navigator.clipboard`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { TERMINAL_CLIPBOARD_JS, TERMINAL_ADDONS_JS } from "../src/http/terminal-client.js";

type OscHandler = (data: string) => boolean | Promise<boolean>;

/** Just enough of xterm's Terminal for the addon: the OSC 52 registration and `input` (query replies). */
class FakeTerm {
  handler?: OscHandler;
  inputs: string[] = [];
  parser = {
    registerOscHandler: (id: number, fn: OscHandler) => {
      if (id === 52) this.handler = fn;
      return { dispose: () => undefined };
    }
  };
  loadAddon(addon: { activate: (t: unknown) => void }): void {
    addon.activate(this);
  }
  input(data: string): void {
    this.inputs.push(data);
  }
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
/** The payload after `ESC ] 52 ;` as the parser hands it to the handler. */
const osc52 = (selection: string, text: string): string => `${selection};${b64(text)}`;

const clipboardWrites: string[] = [];
let clipboardReads = 0;

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  clipboardWrites.length = 0;
  clipboardReads = 0;
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (t: string) => { clipboardWrites.push(t); return Promise.resolve(); },
      readText: () => { clipboardReads += 1; return Promise.resolve("OPERATOR-SECRET"); }
    }
  });
});

describe("OSC 52 with the stock clipboard provider (the behaviour Pantheon has to work around)", () => {
  it("drops a copy whose selection field is empty — the form tmux emits — while honouring `c`", async () => {
    const term = new FakeTerm();
    term.loadAddon(new ClipboardAddon());
    await term.handler!(osc52("", "UAT5-COPY-TMUX"));
    await settle();
    expect(clipboardWrites).toEqual([]);
    await term.handler!(osc52("c", "UAT5-APP"));
    await settle();
    expect(clipboardWrites).toEqual(["UAT5-APP"]);
  });
});

describe("OSC 52 through pantheonLoadAddons (what both terminal hosts ship)", () => {
  function loadTerm(): FakeTerm {
    (window as unknown as { ClipboardAddon: unknown }).ClipboardAddon = { ClipboardAddon };
    delete (window as unknown as { WebglAddon?: unknown }).WebglAddon;
    window.eval(`${TERMINAL_CLIPBOARD_JS}\n${TERMINAL_ADDONS_JS}\nwindow.__pantheonLoadAddons = pantheonLoadAddons;`);
    const term = new FakeTerm();
    (window as unknown as { __pantheonLoadAddons: (t: unknown) => string }).__pantheonLoadAddons(term);
    expect(term.handler).toBeTypeOf("function");
    return term;
  }

  it("a copy made inside tmux (empty selection field) reaches the system clipboard", async () => {
    const term = loadTerm();
    await term.handler!(osc52("", "UAT5-COPY-TMUX"));
    await settle();
    expect(clipboardWrites).toEqual(["UAT5-COPY-TMUX"]);
  });

  it("an application's own clipboard write (`c`) still reaches it", async () => {
    const term = loadTerm();
    await term.handler!(osc52("c", "UAT5-APP"));
    await settle();
    expect(clipboardWrites).toEqual(["UAT5-APP"]);
  });

  it("a primary-selection write (`p`) is ignored, as before — the Mac has no primary selection", async () => {
    const term = loadTerm();
    await term.handler!(osc52("p", "not-for-the-clipboard"));
    await settle();
    expect(clipboardWrites).toEqual([]);
  });

  it("a program asking to READ the clipboard gets nothing back, and the clipboard is never read", async () => {
    const term = loadTerm();
    await term.handler!("c;?");
    await settle();
    expect(clipboardReads).toBe(0);
    for (const reply of term.inputs) expect(reply).not.toContain(b64("OPERATOR-SECRET"));
  });
});
