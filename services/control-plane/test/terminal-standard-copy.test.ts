// @vitest-environment jsdom
/**
 * Standard-terminal copy in every Pantheon terminal (BUGS #84).
 *
 * Mac-Mini's tmux runs `mouse on`, so it asks the terminal for every mouse event (DECSET 1000/1002/1003 + 1006) and
 * xterm handed plain drags to tmux: a browser highlight needed Option-drag. The shared wiring now swallows those
 * mouse modes (xterm never starts reporting the mouse, so a plain drag selects) while remembering what the remote
 * asked for, reports the wheel itself so tmux history still scrolls, and copies with the platform's own chord.
 *
 * The stand-in terminal models xterm's parser contract (the newest handler is tried first; `true` = handled, the
 * built-in DECSET handler never runs; `false` = fall through to it) and records what reaches the PTY (`input`) and
 * what the page writes back into the terminal (`write`).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TERMINAL_CLIPBOARD_JS } from "../src/http/terminal-client.js";

type Params = (number | number[])[];
type CsiHandler = (params: Params) => boolean;

const CELL_W = 10;
const CELL_H = 20;

class FakeTerm {
  cols = 80;
  rows = 24;
  selection = "";
  cleared = 0;
  csi: Record<string, CsiHandler[]> = {};
  esc: Record<string, Array<() => boolean>> = {};
  /** Modes that fell through to xterm's own DECSET/DECRST handler. */
  xtermApplied: string[] = [];
  inputs: Array<{ data: string; wasUserInput: boolean | undefined }> = [];
  writes: string[] = [];
  keyHandler?: (e: KeyboardEvent) => boolean;
  wheelHandler?: (e: WheelEvent) => boolean;
  /** Per wheel event: did the handler cancel the browser default (page scroll, Ctrl+wheel zoom) and stop it bubbling? */
  wheelCancels: Array<{ prevented: boolean; stopped: boolean }> = [];
  element: HTMLElement;
  constructor() {
    this.element = document.createElement("div");
    this.element.className = "xterm";
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    screen.getBoundingClientRect = () => ({ left: 100, top: 50, width: this.cols * CELL_W, height: this.rows * CELL_H, right: 0, bottom: 0, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect;
    this.element.appendChild(screen);
  }
  parser = {
    registerCsiHandler: (id: { prefix?: string; final: string }, fn: CsiHandler) => {
      const k = (id.prefix ?? "") + id.final;
      (this.csi[k] ??= []).push(fn);
      return { dispose: () => undefined };
    },
    registerEscHandler: (id: { final: string }, fn: () => boolean) => {
      (this.esc[id.final] ??= []).push(fn);
      return { dispose: () => undefined };
    }
  };
  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = fn;
  }
  attachCustomWheelEventHandler(fn: (e: WheelEvent) => boolean): void {
    this.wheelHandler = fn;
  }
  getSelection(): string {
    return this.selection;
  }
  hasSelection(): boolean {
    return this.selection.length > 0;
  }
  clearSelection(): void {
    this.selection = "";
    this.cleared += 1;
  }
  input(data: string, wasUserInput?: boolean): void {
    this.inputs.push({ data, wasUserInput });
  }
  write(data: string): void {
    this.writes.push(data);
  }
  /** Feed `CSI ? <params> <final>` the way xterm's parser dispatches it. */
  decset(final: "h" | "l", params: Params): void {
    const list = this.csi["?" + final] ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i](params) === true) return;
    this.xtermApplied.push(`?${params.join(";")}${final}`);
  }
  /** Feed `ESC c` (RIS, full reset). */
  ris(): void {
    for (const fn of (this.esc["c"] ?? []).slice().reverse()) if (fn() === true) return;
  }
  /** The wheel at grid cell (col, row), 1-based, or at raw client coordinates. Returns what the custom handler told xterm. */
  wheel(init: Partial<{ deltaY: number; deltaMode: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; col: number; row: number; clientX: number; clientY: number }>): boolean {
    const col = init.col ?? 1;
    const row = init.row ?? 1;
    const cancel = { prevented: false, stopped: false };
    this.wheelCancels.push(cancel);
    const ev = {
      type: "wheel", deltaX: 0, deltaY: init.deltaY ?? -100, deltaMode: init.deltaMode ?? 0,
      shiftKey: !!init.shiftKey, ctrlKey: !!init.ctrlKey, altKey: !!init.altKey, metaKey: false,
      clientX: init.clientX ?? 100 + (col - 1) * CELL_W + CELL_W / 2, clientY: init.clientY ?? 50 + (row - 1) * CELL_H + CELL_H / 2,
      preventDefault: () => { cancel.prevented = true; },
      stopPropagation: () => { cancel.stopped = true; }
    } as unknown as WheelEvent;
    expect(this.wheelHandler, "the wiring attaches a custom wheel handler").toBeTypeOf("function");
    return this.wheelHandler!(ev);
  }
  /** tmux's own `mouse on` request, byte for byte (tty.c sends each mode as its own sequence). */
  tmuxMouseOn(): void {
    this.decset("h", [1006]);
    this.decset("h", [1000]);
    this.decset("h", [1002]);
  }
}

const clipboardWrites: string[] = [];
type Wire = (term: unknown, host: unknown, before?: (e: KeyboardEvent) => boolean) => void;

function setPlatform(p: string): void {
  Object.defineProperty(window.navigator, "platform", { configurable: true, value: p });
}

function wire(platform = "MacIntel", before?: (e: KeyboardEvent) => boolean): { term: FakeTerm; host: HTMLElement } {
  setPlatform(platform);
  window.eval(`${TERMINAL_CLIPBOARD_JS}\nwindow.__pantheonWireClipboard = pantheonWireClipboard;`);
  const term = new FakeTerm();
  const host = document.createElement("div");
  document.body.appendChild(host);
  (window as unknown as { __pantheonWireClipboard: Wire }).__pantheonWireClipboard(term, host, before);
  return { term, host };
}

const key = (init: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ type: "keydown", key: "c", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

const sgr = (code: number, col: number, row: number): string => `\x1b[<${code};${col};${row}M`;
const reports = (t: FakeTerm): string[] => t.inputs.map((i) => i.data);

beforeEach(() => {
  clipboardWrites.length = 0;
  document.body.innerHTML = "";
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t: string) => { clipboardWrites.push(t); return Promise.resolve(); } }
  });
});

describe("mouse-tracking requests are swallowed and remembered (a plain drag selects in the browser)", () => {
  it("tmux's `mouse on` sequences never reach xterm's own DECSET handler", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    term.decset("h", [1003]);
    term.decset("h", [9]);
    term.decset("h", [1005]);
    term.decset("h", [1015]);
    expect(term.xtermApplied).toEqual([]);
  });

  it("the matching resets are swallowed too", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    for (const m of [1006, 1000, 1002, 1003, 9, 1005, 1015]) term.decset("l", [m]);
    expect(term.xtermApplied).toEqual([]);
  });

  it("modes that are not mouse modes fall through to xterm untouched", () => {
    const { term } = wire();
    term.decset("h", [1049]);
    term.decset("l", [25]);
    term.decset("h", [2004]);
    expect(term.xtermApplied).toEqual(["?1049h", "?25l", "?2004h"]);
    expect(term.writes).toEqual([]);
  });

  it("a mixed set (`CSI ? 1000 ; 25 h`) keeps the mouse away from xterm and still applies the cursor mode", () => {
    const { term } = wire();
    term.decset("h", [1000, 25]);
    expect(term.xtermApplied).toEqual([]);
    expect(term.writes).toEqual(["\x1b[?25h"]);
    expect(term.wheel({ deltaY: -100 })).toBe(false); // and the tracking request was recorded (the wheel is now tracked)
    expect(term.wheelCancels).toEqual([{ prevented: true, stopped: true }]);
  });

  it("a sub-parameter list in a mixed set is dropped, not re-issued (`CSI ? 1000 : 1 ; 25 h` → only `?25h`)", () => {
    const { term } = wire();
    term.decset("h", [1000, [1], 25]);
    expect(term.xtermApplied).toEqual([]);
    expect(term.writes).toEqual(["\x1b[?25h"]);
  });

  it("a mixed reset (`CSI ? 1006 ; 1000 ; 25 l`) records tracking off and still applies the cursor mode", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    term.decset("l", [1006, 1000, 25]);
    expect(term.writes).toEqual(["\x1b[?25l"]);
    expect(term.wheel({ deltaY: -100 })).toBe(true);
    expect(reports(term)).toEqual([]);
  });

  it("a full reset (RIS) forgets the remote's mouse request, as xterm itself does, and still lets xterm reset", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    term.ris();
    expect(term.wheel({ deltaY: -100 })).toBe(true);
    expect(reports(term)).toEqual([]);
    expect(term.esc["c"]?.every((fn) => fn() === false)).toBe(true);
  });
});

describe("the wheel still scrolls tmux history (reported in the encoding the remote asked for)", () => {
  it("with tmux's `mouse on` (SGR 1006), wheel up sends `ESC [ < 64 ; col ; row M` at the pointer and keeps xterm off it", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    expect(term.wheel({ deltaY: -100, col: 7, row: 3 })).toBe(false); // false: xterm does not turn it into arrow keys
    expect(reports(term)).toEqual([sgr(64, 7, 3)]);
    expect(term.inputs[0].wasUserInput).toBe(false); // a report, not typing: never clears the highlight
  });

  it("wheel down sends button 65", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    term.wheel({ deltaY: 100, col: 80, row: 24 });
    expect(reports(term)).toEqual([sgr(65, 80, 24)]);
  });

  it("without SGR (1006 never asked, or reset) nothing is sent — an X10 report never reached the PTY before either", () => {
    const { term } = wire();
    term.decset("h", [1000]);
    expect(term.wheel({ deltaY: -100, col: 7, row: 3 })).toBe(false); // still kept from xterm: no arrow keys
    term.decset("h", [1006]);
    term.decset("l", [1006]);
    expect(term.wheel({ deltaY: 100, col: 1, row: 1 })).toBe(false);
    expect(reports(term)).toEqual([]);
  });

  it("a page-sized wheel step (DOM_DELTA_PAGE) is one report", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    term.wheel({ deltaY: 1, deltaMode: 2 });
    expect(reports(term)).toEqual([sgr(65, 1, 1)]);
  });

  it("a pointer outside the grid is clamped to its edge cells", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    term.wheel({ deltaY: -100, clientX: 100 + 80 * CELL_W + 500, clientY: 50 + 24 * CELL_H + 500 });
    term.wheel({ deltaY: -100, clientX: 0, clientY: 0 });
    expect(reports(term)).toEqual([sgr(64, 80, 24), sgr(64, 1, 1)]);
  });

  it("every wheel event the remote tracks cancels the browser default and stops it bubbling (no page scroll, no Ctrl+wheel zoom)", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    term.wheel({ deltaY: -100 }); // a report
    term.wheel({ deltaY: -100, ctrlKey: true }); // a report with Ctrl (pinch / Ctrl+wheel zoom)
    term.wheel({ deltaY: -4 }); // below one line: no report yet
    term.wheel({ deltaY: -100, shiftKey: true }); // Shift: no report
    term.wheel({ deltaY: 0 }); // horizontal only: no report
    term.decset("l", [1006]);
    term.wheel({ deltaY: -100 }); // tracking on, SGR off: no report
    expect(term.wheelCancels).toHaveLength(6);
    expect(term.wheelCancels.every((c) => c.prevented && c.stopped)).toBe(true);
  });

  it("Ctrl and Alt are carried in the button code, as xterm reports them", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    term.wheel({ deltaY: -100, ctrlKey: true, col: 2, row: 2 });
    term.wheel({ deltaY: -100, altKey: true, col: 2, row: 2 });
    expect(reports(term)).toEqual([sgr(64 + 16, 2, 2), sgr(64 + 8, 2, 2)]);
  });

  it("one mouse-wheel notch is one report (as xterm sent it before), whatever its pixel size", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    term.wheel({ deltaY: -100 });
    term.wheel({ deltaY: -240 });
    term.wheel({ deltaY: -3, deltaMode: 1 }); // DOM_DELTA_LINE
    expect(reports(term)).toEqual([sgr(64, 1, 1), sgr(64, 1, 1), sgr(64, 1, 1)]);
  });

  it("a trackpad's many small deltas accumulate instead of each sending a report", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    // 4 px of a 20 px cell, damped for a trackpad as xterm does (×0.3): 0.06 line per event.
    for (let i = 0; i < 10; i++) expect(term.wheel({ deltaY: -4 })).toBe(false);
    expect(reports(term)).toEqual([]); // 0.6 of a line so far: nothing yet, and nothing for xterm either
    for (let i = 0; i < 115; i++) term.wheel({ deltaY: -4 });
    expect(reports(term)).toHaveLength(7); // 125 × 0.06 = 7.5 lines
  });

  it("Shift+wheel and a horizontal-only wheel send nothing and still keep xterm off the wheel", () => {
    const { term } = wire();
    term.tmuxMouseOn();
    expect(term.wheel({ deltaY: -100, shiftKey: true })).toBe(false);
    expect(term.wheel({ deltaY: 0 })).toBe(false);
    expect(reports(term)).toEqual([]);
  });

  it("with the remote's mouse off (Linux-Dev's `mouse off`), the wheel is left to xterm exactly as today", () => {
    const { term } = wire();
    expect(term.wheel({ deltaY: -100 })).toBe(true);
    term.tmuxMouseOn();
    term.decset("l", [1002]);
    expect(term.wheel({ deltaY: -100 })).toBe(true);
    term.decset("h", [9]); // X10 reports no wheel, so neither do we
    expect(term.wheel({ deltaY: -100 })).toBe(true);
    expect(reports(term)).toEqual([]);
    // xterm's own path decides about the browser default here (its arrow-key fallback cancels it itself).
    expect(term.wheelCancels).toHaveLength(3);
    expect(term.wheelCancels.some((c) => c.prevented || c.stopped)).toBe(false);
  });
});

describe("copy chords: ⌘C on a Mac, Ctrl+C with a highlight elsewhere, Ctrl+Shift+C everywhere", () => {
  it("Mac: ⌘C copies the highlight and is not sent to the PTY", () => {
    const { term } = wire("MacIntel");
    term.selection = "mac copy";
    expect(term.keyHandler!(key({ metaKey: true }))).toBe(false);
    expect(clipboardWrites).toEqual(["mac copy"]);
  });

  it("Mac: plain Ctrl+C always goes to the PTY (interrupt), highlight or not", () => {
    const { term } = wire("MacIntel");
    term.selection = "highlighted";
    expect(term.keyHandler!(key({ ctrlKey: true }))).toBe(true);
    term.selection = "";
    expect(term.keyHandler!(key({ ctrlKey: true }))).toBe(true);
    expect(clipboardWrites).toEqual([]);
    expect(term.cleared).toBe(0);
  });

  for (const platform of ["Win32", "Linux x86_64"]) {
    it(`${platform}: Ctrl+C with a highlight copies it and clears it, so the next Ctrl+C interrupts`, () => {
      const { term } = wire(platform);
      term.selection = "pc copy";
      expect(term.keyHandler!(key({ ctrlKey: true }))).toBe(false);
      expect(clipboardWrites).toEqual(["pc copy"]);
      expect(term.cleared).toBe(1);
      expect(term.keyHandler!(key({ ctrlKey: true }))).toBe(true); // nothing highlighted now: interrupt
      expect(clipboardWrites).toEqual(["pc copy"]);
    });

    it(`${platform}: Ctrl+C with nothing highlighted goes to the PTY`, () => {
      const { term } = wire(platform);
      expect(term.keyHandler!(key({ ctrlKey: true }))).toBe(true);
      expect(clipboardWrites).toEqual([]);
    });

    it(`${platform}: Ctrl+Alt+C (AltGr) is not taken as copy`, () => {
      const { term } = wire(platform);
      term.selection = "x";
      expect(term.keyHandler!(key({ ctrlKey: true, altKey: true }))).toBe(true);
      expect(clipboardWrites).toEqual([]);
    });
  }

  for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
    it(`${platform}: Ctrl+Shift+C copies the highlight and keeps it`, () => {
      const { term } = wire(platform);
      term.selection = "shifted";
      expect(term.keyHandler!(key({ key: "C", ctrlKey: true, shiftKey: true }))).toBe(false);
      expect(clipboardWrites).toEqual(["shifted"]);
      expect(term.cleared).toBe(0);
    });
  }

  it("the host's own key hook still runs first and can claim a key (the console drawer's Esc)", () => {
    const seen: string[] = [];
    const { term } = wire("Linux x86_64", (e) => { seen.push(e.key); return false; });
    term.selection = "claimed";
    expect(term.keyHandler!(key({ ctrlKey: true }))).toBe(false);
    expect(seen).toEqual(["c"]);
    expect(clipboardWrites).toEqual([]);
    expect(term.cleared).toBe(0);
  });

  it("finishing a highlight still copies it at once, and an empty one never clobbers the clipboard", () => {
    const { term, host } = wire();
    term.selection = "on release";
    host.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    term.selection = "";
    host.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
    expect(clipboardWrites).toEqual(["on release"]);
  });
});
