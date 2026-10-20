// @vitest-environment jsdom
/**
 * Maestro Console page + client (plan Task 11; spec §6.1–6.2, §9; controller rulings carried from
 * Tasks 6–9). `renderConsolePage` is the server-rendered shell; `CONSOLE_CLIENT_JS` polls
 * `BASE + /console/api/state`, renders the two tab rows, the machine banners and the cards, and fetches a
 * card's expand view on demand (once per card). Everything rendered was written by Claude sessions on dev
 * machines, so the client builds the DOM with createElement + textContent only — the innerHTML spy below
 * is the proof — and every state is a glyph AND a word (CC1), never colour alone.
 *
 * Boot pattern as in test/harness-shell.test.ts: the rendered <body> goes into jsdom, `fetch` is stubbed,
 * and the exported client string is evaluated against the DOM.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { renderConsolePage, CONSOLE_CLIENT_JS, CONSOLE_FONT_ASSETS, type ConsolePageModel } from "../src/http/console-page.js";
import type { ConsoleCardRow, ConsoleSessionRow } from "../src/console/store.js";
import type { MachineHealth } from "../src/console/poller.js";

// ---- the API contract Task 10 serves (plan Task 10 interfaces) ----
type ApiSession = Omit<ConsoleSessionRow, "cwd">;
interface ApiProject {
  display: string;
  glyph: string;
  border: string;
  areas: readonly string[];
  hidden: boolean;
}
interface ApiSettings {
  pollSeconds: number;
  allTabAreas: readonly string[];
  projects: Record<string, ApiProject>;
}
interface StatePayload {
  machines: MachineHealth[];
  sessions: ApiSession[];
  cards: ConsoleCardRow[];
  settings: ApiSettings | { disabled: true; entry: string };
}
interface ConsoleApi {
  refresh(): Promise<void>;
  select(machine: string | null, project: string | null): void;
  expand(id: string, section: "full" | "why" | "what"): Promise<void>;
  stop(): void;
}

const HEX_A = "a".repeat(32);
const HEX_B = "b".repeat(32);
const HEX_C = "c".repeat(32);
const HEX_D = "d".repeat(32);
const HEX_E = "e".repeat(32);

function health(over: Partial<MachineHealth> & Pick<MachineHealth, "machine">): MachineHealth {
  return { state: "ok", since: "2026-10-17T17:00:00.000Z", ignoredLines: 0, problems: [], turnsTooLong: 0, turnsTooLongBySession: {}, storeErrors: 0, skippedTicks: 0, ...over };
}

function session(over: Partial<ApiSession> & Pick<ApiSession, "machine" | "tmuxSession">): ApiSession {
  const key = over.projectKey ?? over.tmuxSession;
  return {
    paneId: "%1", claudePid: 4242, sessionId: `s-${key}@${over.machine}`, procStart: "2026-10-17T16:00:00.000Z", projectKey: key, reachable: true,
    status: "idle", waitingFor: null, state: "idle", stateReason: null, transcriptOffset: 0, transcriptSize: 0,
    lastSeenAt: "2026-10-17T17:59:00.000Z", endedAt: null, version: 1, createdAt: "2026-10-17T16:00:00.000Z", updatedAt: "2026-10-17T17:59:00.000Z",
    ...over
  };
}

function card(over: Partial<ConsoleCardRow> & Pick<ConsoleCardRow, "id" | "machine" | "projectKey">): ConsoleCardRow {
  return {
    turnUuid: `t-${over.id}`, sessionId: `s-${over.projectKey}@${over.machine}`, createdAt: "2026-10-17T17:50:00.000Z", kind: "reply",
    title: "A reply title", tldrMasked: "TL;DR — a masked summary.", byteStart: 0, byteEnd: 100, toolCallCount: 0, thinkingChars: 0,
    needsYou: false, needsKind: null, asksYou: false, options: [], answeredAt: null, dismissedAt: null, purgeAfter: "2027-01-15T00:00:00.000Z", version: 1, updatedAt: "2026-10-17T17:50:00.000Z",
    ...over
  };
}

function settings(): ApiSettings {
  return {
    pollSeconds: 5,
    allTabAreas: ["fleet-sessions", "general"],
    projects: {
      solo: { display: "Solo", glyph: "▲", border: "dashed", areas: [], hidden: false },
      lancache: { display: "LanCache", glyph: "⬢", border: "solid", areas: [], hidden: false },
      hush: { display: "Hush", glyph: "x", border: "solid", areas: [], hidden: true }
    }
  };
}

/** Two machines, three projects, three cards: solo NEEDS YOU (pinned card), lancache WORKING, homelab IDLE. */
function fleet(): StatePayload {
  return {
    machines: [health({ machine: "mac-mini" }), health({ machine: "linux-dev" })],
    sessions: [
      session({ machine: "mac-mini", tmuxSession: "solo", status: "waiting", waitingFor: "R-452-2", state: "needs_you", stateReason: "R-452-2" }),
      session({ machine: "mac-mini", tmuxSession: "lancache", status: "busy", state: "working" }),
      session({ machine: "linux-dev", tmuxSession: "homelab", status: "idle", state: "idle" })
    ],
    cards: [
      card({ id: HEX_A, machine: "mac-mini", projectKey: "solo", title: "R-452-2: may an agent attest single authority?", needsYou: true, needsKind: "waiting", createdAt: "2026-10-17T17:40:00.000Z" }),
      card({ id: HEX_B, machine: "mac-mini", projectKey: "lancache", title: "#361 deployed", createdAt: "2026-10-17T17:55:00.000Z", toolCallCount: 4, thinkingChars: 120 }),
      card({ id: HEX_C, machine: "linux-dev", projectKey: "homelab", title: "Backups verified", createdAt: "2026-10-17T17:30:00.000Z" })
    ],
    settings: settings()
  };
}

// ---- jsdom boot ----
type FetchReply = { status: number; body: unknown };
let fetchFn: ReturnType<typeof vi.fn>;
function stubFetch(handler: (url: string, init?: { method?: string; body?: string }) => FetchReply | Promise<FetchReply>): void {
  fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const r = await handler(url, init);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  });
  (window as unknown as { fetch: unknown }).fetch = fetchFn;
}
const STATE_RE = /\/console\/api\/state$/;
const EXPAND_RE = /\/console\/api\/cards\/([^/]+)\/expand$/;
function serve(state: StatePayload | (() => StatePayload), expand?: (id: string) => FetchReply | Promise<FetchReply>): (url: string) => FetchReply | Promise<FetchReply> {
  return (url) => {
    if (STATE_RE.test(url)) return { status: 200, body: typeof state === "function" ? state() : state };
    const m = EXPAND_RE.exec(url);
    if (m && expand) return expand(decodeURIComponent(m[1] ?? ""));
    return { status: 404, body: { state: "failed", message: "unknown card" } };
  };
}
const expandCalls = (): string[] => fetchFn.mock.calls.map((c) => String(c[0])).filter((u) => EXPAND_RE.test(u));

function bodyOf(htmlDoc: string): string {
  return htmlDoc.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "";
}
const MODEL: ConsolePageModel = { base: "", loginEnabled: true };
const api = (): ConsoleApi => (window as unknown as { __console: ConsoleApi }).__console;

function boot(model: ConsolePageModel, handler: (url: string, init?: { method?: string; body?: string }) => FetchReply | Promise<FetchReply>): void {
  document.documentElement.setAttribute("data-base", model.base);
  document.body.innerHTML = bodyOf(renderConsolePage(model)); // <script> set via innerHTML stays inert
  stubFetch(handler);
  const w = window as unknown as Record<string, unknown>;
  if (w["TextEncoder"] === undefined) w["TextEncoder"] = TextEncoder; // jsdom lacks it; every browser has it
  const c = w["crypto"] as { randomUUID?: () => string } | undefined;
  if (c === undefined || c.randomUUID === undefined) Object.defineProperty(window, "crypto", { value: { randomUUID }, configurable: true });
  window.eval(CONSOLE_CLIENT_JS); // the same code the page ships inline
  // The page asks GET step-up once at load (header state). It is taken out of the call record so the F1 call counts and
  // the F2 request sequences below describe what the operator did; tests of the boot check assert the header instead.
  const rec = fetchFn.mock.calls as unknown[][];
  for (let i = rec.length - 1; i >= 0; i--) {
    if (String(rec[i]![0]).endsWith("/console/api/step-up")) {
      rec.splice(i, 1);
      fetchFn.mock.results.splice(i, 1);
    }
  }
}

function q<T extends Element = HTMLElement>(sel: string): T {
  const e = document.querySelector(sel);
  if (!e) throw new Error(`missing ${sel}`);
  return e as T;
}
const qa = (sel: string): HTMLElement[] => Array.from(document.querySelectorAll(sel)) as HTMLElement[];
const textOf = (sel: string): string => q(sel).textContent ?? "";
const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;
/** Local wall-clock HH:MM of an instant — what the page shows after "since". */
const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** A plain Map-backed Storage: this runner's jsdom exposes no usable localStorage / sessionStorage. */
class MemStorage {
  private readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: new MemStorage(), configurable: true });
  Object.defineProperty(window, "sessionStorage", { value: new MemStorage(), configurable: true });
});

afterEach(() => {
  const c = (window as unknown as { __console?: ConsoleApi }).__console;
  if (c) c.stop();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.title = "";
  document.documentElement.removeAttribute("data-base");
  window.localStorage.clear();
  window.sessionStorage.clear();
  FakeTerm.all.length = 0;
  FakeWS.all.length = 0;
});

describe("renderConsolePage", () => {
  it("renders the shell under the base: pageHead, data-base, two tab rows, the left panel, the cards main, the status line and the inline client", () => {
    const html = renderConsolePage({ base: "/harness", loginEnabled: true });
    expect(html).toMatch(/<html lang="en" data-base="\/harness">/);
    expect(html).toMatch(/<title>Console<\/title>/);
    expect(html).toMatch(/href="\/harness\/assets\/harness\.css\?b=[^"]+"/); // pageHead: themed + build-versioned
    expect(html).toContain("window.top !== window.self"); // pageHead: frame-bust
    expect(html).toMatch(/<nav[^>]*data-machine-tabs[^>]*aria-label="Machines"/);
    expect(html).toMatch(/<nav[^>]*data-project-tabs[^>]*aria-label="Projects"/);
    expect(html).toContain("data-machine-banners");
    expect(html).toMatch(/<aside[^>]*data-left-panel/);
    expect(html).toMatch(/<main[^>]*data-cards/);
    expect(html).toMatch(/<span[^>]*data-poll-status[^>]*role="status"[^>]*aria-live="polite"/);
    expect(html).toMatch(/<span[^>]*data-poll-heartbeat[^>]*aria-live="off"/); // the heartbeat is never announced
    expect(html).toMatch(/<form method="post" action="\/harness\/logout"/);
    expect(html).toContain('href="/harness/harness"'); // back to the Terminals tab
    expect(html).toContain('href="/harness/admin/config"');
    expect(html).toContain('href="/harness/admin/approvals"');
    expect(html).toContain('href="/harness/help"');
    expect(html).toMatch(/data-build="[^"]+"/); // the build stamp (BUGS #44)
    expect(html).toContain(CONSOLE_CLIENT_JS);
    expect(html).not.toMatch(/<p[^>]*data-console-disabled/); // no banner element (the client's selector text is not one)
  });

  it("omits the logout control when login is disabled", () => {
    expect(renderConsolePage({ base: "", loginEnabled: false })).not.toContain('action="/logout"');
    expect(renderConsolePage({ base: "", loginEnabled: true })).toContain('action="/logout"');
  });

  it("self-hosts Lexend from /assets with font-display swap and carries no external URL (Karl's Deep navy tokens, console-scoped)", () => {
    const html = renderConsolePage({ base: "/harness", loginEnabled: false });
    expect(html).toMatch(/@font-face\s*\{[^}]*font-family:\s*"Lexend"[^}]*font-weight:\s*400[^}]*\}/);
    expect(html).toMatch(/@font-face\s*\{[^}]*font-family:\s*"Lexend"[^}]*font-weight:\s*600[^}]*\}/);
    expect(html).toMatch(/url\("\/harness\/assets\/lexend-regular\.woff2\?b=[^"]+"\)\s*format\("woff2"\)/);
    expect(html).toMatch(/url\("\/harness\/assets\/lexend-semibold\.woff2\?b=[^"]+"\)\s*format\("woff2"\)/);
    expect(html.match(/font-display:\s*swap/g)?.length).toBe(2);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/fonts\.g(oogleapis|static)/);
    for (const token of ["--console-bg: #152035", "--console-surface: #1b2943", "--console-surface2: #233350", "--console-border: #435a80", "--console-text: #e9f0f8", "--console-text2: #bfcde0", "--console-need: #ff9f40", "--console-work: #a8a8a8", "--console-idle: #5aa9ff"]) {
      expect(html, token).toContain(token);
    }
    expect(html).toMatch(/font-size:\s*18px/);
    expect(html).toMatch(/line-height:\s*1\.45/);
    expect(html).toMatch(/max-width:\s*80ch/);
    expect(html).toContain("var(--font-mono)"); // the code/trail face stays the harness mono stack
  });

  it("renders the disabled banner with the entry escaped and no fetch wiring", () => {
    const html = renderConsolePage({ base: "", loginEnabled: false, disabled: { entry: 'projects["<x>"].glyph' } });
    expect(html).toMatch(/<p[^>]*role="alert"[^>]*data-console-disabled/);
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain('projects["<x>"]');
    expect(html).toMatch(/Console disabled/);
  });

  it("vendors Lexend 1.008 (googlefonts/lexend, SIL OFL 1.1) under /assets with the recorded SHA-256", () => {
    expect(CONSOLE_FONT_ASSETS.map((a) => a.path)).toEqual(["/assets/lexend-regular.woff2", "/assets/lexend-semibold.woff2"]);
    const pinned: Record<string, string> = {
      "Lexend-Regular.woff2": "dc9905cb55fde950de4e2c1c3240a9ece5ab7b3a7db8d8840322236705e0c017",
      "Lexend-SemiBold.woff2": "90341b5a4388f312327333c82fae2a9a3951e75f8f7e71568f25779fb6211a43"
    };
    for (const a of CONSOLE_FONT_ASSETS) {
      expect(a.sha256, a.file).toBe(pinned[a.file]);
      // resolved from this module's own file: URL with Node's URL — the jsdom environment swaps the global URL
      // for one that resolves relative paths against http://localhost:3000, which is not where the file is
      const buf = readFileSync(fileURLToPath(new NodeURL(`../assets/fonts/${a.file}`, import.meta.url)));
      expect(buf.subarray(0, 4).toString("latin1"), a.file).toBe("wOF2");
      expect(createHash("sha256").update(buf).digest("hex"), a.file).toBe(a.sha256);
    }
  });
});

describe("console client (behavior)", () => {
  it("renders two tab rows from state: machines with worst state glyph+word, then the selected machine's projects", async () => {
    boot(MODEL, serve(fleet()));
    await api().refresh();
    const machineTabs = qa("[data-machine-tabs] [data-machine-tab]");
    expect(machineTabs.map((b) => b.getAttribute("data-machine-tab"))).toEqual(["*", "mac-mini", "linux-dev"]);
    expect(textOf('[data-machine-tab="*"] .name')).toBe("◎ All machines");
    expect(textOf('[data-machine-tab="*"] .st')).toBe("! 1 NEEDS YOU · ⟳ 1 WORKING · ✓ 1 IDLE");
    expect(q('[data-machine-tab="mac-mini"]').getAttribute("data-state")).toBe("needs_you");
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toBe("! 1 NEEDS YOU · ⟳ 1 WORKING");
    expect(q('[data-machine-tab="linux-dev"]').getAttribute("data-state")).toBe("idle");
    expect(textOf('[data-machine-tab="linux-dev"] .st')).toBe("✓ 1 IDLE");
    // All machines is selected first; the second row then lists every project, worst state first
    expect(q('[data-machine-tab="*"]').getAttribute("aria-pressed")).toBe("true");
    expect(qa("[data-project-tabs] [data-project-tab]").map((b) => b.getAttribute("data-project-tab"))).toEqual(["*", "solo", "lancache", "homelab"]);
    expect(textOf('[data-project-tab="homelab"] .where')).toBe("on linux-dev");

    q('[data-machine-tab="mac-mini"]').click();
    expect(q('[data-machine-tab="mac-mini"]').getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-machine-tab="*"]').getAttribute("aria-pressed")).toBe("false");
    expect(qa("[data-project-tabs] [data-project-tab]").map((b) => b.getAttribute("data-project-tab"))).toEqual(["*", "solo", "lancache"]);
    expect(textOf('[data-project-tab="solo"] .name')).toBe("▲ Solo");
    expect(textOf('[data-project-tab="solo"] .st')).toBe("! NEEDS YOU");
    expect(q('[data-project-tab="solo"]').getAttribute("data-state")).toBe("needs_you");
    expect(q('[data-project-tab="solo"]').getAttribute("data-border")).toBe("dashed");
    expect(textOf('[data-project-tab="lancache"] .name')).toBe("⬢ LanCache");
    expect(textOf('[data-project-tab="lancache"] .st')).toBe("⟳ WORKING");
    expect(q('[data-project-tab="lancache"]').getAttribute("data-state")).toBe("working");
    // the cards follow the selection
    expect(qa("[data-cards] [data-card]").map((c) => c.getAttribute("data-card"))).toEqual([HEX_A, HEX_B]);
    q('[data-project-tab="lancache"]').click();
    expect(q('[data-project-tab="lancache"]').getAttribute("aria-pressed")).toBe("true");
    expect(qa("[data-cards] [data-card]").map((c) => c.getAttribute("data-card"))).toEqual([HEX_B]);
    const b = q(`[data-card="${HEX_B}"]`);
    expect(b.querySelector("[data-title]")!.textContent).toBe("#361 deployed");
    expect(b.querySelector("[data-tldr]")!.textContent).toBe("TL;DR — a masked summary.");
    expect(b.querySelector("[data-age]")!.textContent).toMatch(/ago|just now/);
    expect(b.querySelector("[data-age]")!.textContent).toContain("4 tool calls");
    expect(b.querySelector("[data-session-state]")!.textContent).toBe("⟳ WORKING");
    // the left panel summarises the selection with the same glyph + word pairs
    expect(textOf("[data-selection-summary]")).toContain("⟳ 1 WORKING");
  });

  it("a NEEDS YOU project is listed first and the tab title carries the count", async () => {
    const p = fleet();
    p.sessions.push(session({ machine: "linux-dev", tmuxSession: "cdf", status: "busy", state: "needs_you", stateReason: "menu on screen" }));
    p.sessions.push(session({ machine: "linux-dev", tmuxSession: "alpha", status: "idle", state: "idle" }));
    boot(MODEL, serve(p));
    await api().refresh();
    expect(document.title).toBe("(2) Console");
    expect(textOf('[data-machine-tab="*"] .st')).toBe("! 2 NEED YOU · ⟳ 1 WORKING · ✓ 2 IDLE");
    q('[data-machine-tab="linux-dev"]').click();
    // worst state first, then by name (alpha before homelab: both idle, unconfigured keys read as their name)
    expect(qa("[data-project-tabs] [data-project-tab]").map((b) => b.getAttribute("data-project-tab"))).toEqual(["*", "cdf", "alpha", "homelab"]);
    expect(textOf('[data-project-tab="cdf"] .st')).toBe("! NEEDS YOU");
    // the needs-you card is pinned above a newer one
    q('[data-machine-tab="mac-mini"]').click();
    expect(qa("[data-cards] [data-card]").map((c) => c.getAttribute("data-card"))).toEqual([HEX_A, HEX_B]);
    expect(q(`[data-card="${HEX_A}"]`).hasAttribute("data-needs-you")).toBe(true);
    expect(q(`[data-card="${HEX_A}"]`).getAttribute("data-state")).toBe("needs_you");
  });

  it("an unknown status renders ? UNKNOWN STATUS <value>, never idle", async () => {
    const p = fleet();
    p.sessions = [
      session({ machine: "mac-mini", tmuxSession: "solo", status: "paused", state: "unknown" }),
      session({ machine: "mac-mini", tmuxSession: "lancache", status: "", state: "unknown" })
    ];
    p.cards = [];
    boot(MODEL, serve(p));
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    expect(textOf('[data-project-tab="solo"] .st')).toBe("? UNKNOWN STATUS paused");
    expect(q('[data-project-tab="solo"]').getAttribute("data-state")).toBe("unknown");
    expect(textOf('[data-project-tab="lancache"] .st')).toBe("? UNKNOWN STATUS (missing)");
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toBe("? 2 UNKNOWN STATUS");
    expect(document.querySelector('[data-project-tabs] [data-state="idle"]')).toBeNull();
    expect(textOf("[data-project-tabs]")).not.toMatch(/IDLE/);
    expect(document.title).toBe("Console");
  });

  it("expand fetches once per card and renders the three sections as text", async () => {
    const view = {
      state: "ok",
      view: {
        fullText: "Full <b>text</b>\n\n- bullet `code`",
        why: "Because <i>why</i>",
        whatItDid: [{ tool: "Bash", inputSummary: "ls <x>", outputSummary: "ok <y>" }],
        agentRuns: 2
      }
    };
    const expand = vi.fn((_id: string): FetchReply => ({ status: 200, body: view }));
    boot(MODEL, serve(fleet(), expand));
    await api().refresh();
    const cardEl = q(`[data-card="${HEX_B}"]`);
    const full = cardEl.querySelector('[data-expand="full"]') as HTMLButtonElement;
    expect(full.textContent).toBe("▸ full text");
    expect(full.getAttribute("aria-expanded")).toBe("false");
    full.click();
    await vi.waitFor(() => expect(cardEl.querySelector('[data-section="full"]')!.textContent).toContain("Full <b>text</b>"));
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith(HEX_B);
    expect(expandCalls()).toEqual([`/console/api/cards/${HEX_B}/expand`]);
    expect(full.textContent).toBe("▾ full text");
    expect(full.getAttribute("aria-expanded")).toBe("true");
    expect((cardEl.querySelector('[data-section="full"]') as HTMLElement).hidden).toBe(false);

    (cardEl.querySelector('[data-expand="why"]') as HTMLElement).click();
    (cardEl.querySelector('[data-expand="what"]') as HTMLElement).click();
    await vi.waitFor(() => expect((cardEl.querySelector('[data-section="what"]') as HTMLElement).hidden).toBe(false));
    expect(expand).toHaveBeenCalledTimes(1); // one fetch per card, shared by the three sections
    expect(cardEl.querySelector('[data-section="why"]')!.textContent).toContain("Because <i>why</i>");
    const what = cardEl.querySelector('[data-section="what"]')!;
    expect(what.textContent).toContain("Bash");
    expect(what.textContent).toContain("ls <x>");
    expect(what.textContent).toContain("ok <y>");
    expect(what.textContent).toContain("2 agent runs (not expanded)");
    expect(cardEl.querySelectorAll("b, i, code").length).toBe(0); // markup inside the text stayed text (no Markdown in F1)

    full.click(); // closes without another fetch
    expect((cardEl.querySelector('[data-section="full"]') as HTMLElement).hidden).toBe(true);
    expect(full.getAttribute("aria-expanded")).toBe("false");
    expect(expand).toHaveBeenCalledTimes(1);
    await api().expand(HEX_B, "full"); // the test hook does what the button does
    expect((cardEl.querySelector('[data-section="full"]') as HTMLElement).hidden).toBe(false);
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("a disabled model renders the banner naming the entry and no fetch happens", async () => {
    boot({ base: "", loginEnabled: false, disabled: { entry: 'projects["<x>"].glyph' } }, serve(fleet()));
    const banner = q("[data-console-disabled]");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain('projects["<x>"].glyph');
    expect(banner.textContent).toMatch(/Console disabled/);
    await new Promise((r) => setTimeout(r, 25));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(q("[data-poll-status]").getAttribute("data-state")).toBe("disabled");
    expect(textOf("[data-poll-status]")).toMatch(/disabled/);
    window.dispatchEvent(new window.Event("focus"));
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("an unreachable machine shows ✕ UNREACHABLE since HH:MM and keeps its cards", async () => {
    const since = "2026-10-17T17:02:00.000Z";
    const p = fleet();
    p.machines[0] = health({ machine: "mac-mini", state: "unreachable", since, message: "mac-mini unreachable — connect timed out", lastOkAt: "2026-10-17T16:58:00.000Z" });
    boot(MODEL, serve(p));
    await api().refresh();
    const expected = `✕ UNREACHABLE since ${hhmm(since)}`;
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toContain(expected);
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toContain("! 1 NEEDS YOU · ⟳ 1 WORKING"); // last known states stay
    expect(q('[data-machine-tab="mac-mini"]').getAttribute("data-health")).toBe("unreachable");
    const banner = q('[data-machine-banner="mac-mini"]');
    expect(banner.getAttribute("data-health")).toBe("unreachable");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain(expected);
    expect(banner.textContent).toContain("mac-mini unreachable — connect timed out");
    expect(banner.textContent).toMatch(/last known/);
    // its cards stay (needs-you first, then newest first)
    expect(qa("[data-cards] [data-card]").map((c) => c.getAttribute("data-card"))).toEqual([HEX_A, HEX_B, HEX_C]);
    q('[data-machine-tab="mac-mini"]').click();
    expect(qa("[data-cards] [data-card]").map((c) => c.getAttribute("data-card"))).toEqual([HEX_A, HEX_B]);
    expect(document.querySelector('[data-machine-banner="linux-dev"]')).toBeNull(); // only the selected machine's banners
  });

  it("a 403 from the API shows signed out", async () => {
    vi.useFakeTimers();
    boot(MODEL, () => ({ status: 403, body: { error: "forbidden" } }));
    await api().refresh();
    expect(textOf("[data-poll-status]")).toContain("signed out — reload to sign in");
    expect(q("[data-poll-status]").getAttribute("data-state")).toBe("signed_out");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(1); // polling stopped: a reload is the way back in
  });

  it("no element is created from state text via innerHTML", async () => {
    const hostile = (s: string): string => `<img src=x onerror="window.__pwned=1">${s}<script>window.__pwned=1</script>`;
    const p = fleet();
    p.sessions[0] = session({ ...p.sessions[0]!, status: hostile("waiting"), stateReason: hostile("reason") });
    p.sessions.push(session({ machine: hostile("evil-machine"), tmuxSession: "new-one", status: hostile("odd"), state: "unknown" }));
    p.machines.push(health({ machine: hostile("evil-machine"), state: "failed", message: hostile("probe failed"), remoteDetail: hostile("stderr"), problems: [hostile("problem 1")] }));
    p.cards[0] = card({ ...p.cards[0]!, title: hostile("title"), tldrMasked: hostile("tldr") });
    (p.settings as ApiSettings).projects["solo"]!.display = hostile("Solo"); // refused server-side; the client must not care
    const expand = (): FetchReply => ({
      status: 200,
      body: { state: "ok", view: { fullText: hostile("full"), why: hostile("why"), whatItDid: [{ tool: hostile("tool"), inputSummary: hostile("in"), outputSummary: hostile("out") }], agentRuns: 0 } }
    });
    let serving = fleet();
    boot(MODEL, serve(() => serving, expand));
    await api().refresh();
    // spy on whichever prototype in the chain owns innerHTML (jsdom defines it on Element)
    let owner: object | null = document.body;
    while (owner && !Object.getOwnPropertyDescriptor(owner, "innerHTML")) owner = Object.getPrototypeOf(owner) as object | null;
    expect(owner).not.toBeNull();
    const setter = vi.spyOn(owner as { innerHTML: string }, "innerHTML", "set");
    try {
      serving = p;
      await api().refresh();
      const c = q(`[data-card="${HEX_A}"]`);
      (c.querySelector('[data-expand="full"]') as HTMLElement).click();
      (c.querySelector('[data-expand="why"]') as HTMLElement).click();
      (c.querySelector('[data-expand="what"]') as HTMLElement).click();
      await vi.waitFor(() => expect(c.querySelector('[data-section="what"]')!.textContent).toContain("out<script>"));
      expect(setter).not.toHaveBeenCalled();
    } finally {
      setter.mockRestore();
    }
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(document.querySelectorAll("[data-cards] script, [data-machine-tabs] script, [data-project-tabs] script, [data-machine-banners] script, [data-left-panel] script").length).toBe(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(textOf(`[data-card="${HEX_A}"] [data-title]`)).toContain('<img src=x onerror="window.__pwned=1">title');
    expect(textOf('[data-project-tab="solo"] .name')).toContain("<img src=x");
    expect(textOf("[data-machine-banners]")).toContain("probe failed<script>");
  });

  it("a session in an sh-* tmux session is listed unreachable under its cwd key, needs-you visible", async () => {
    // Re-ruled: the poller re-keys such a session to <cwd basename>@<machine> with reachable:false; the page has
    // no sh-* special case of its own, so nothing that needs Karl can hide behind a shell's name.
    const p = fleet();
    p.sessions.push(session({ machine: "mac-mini", tmuxSession: "sh-mac-mini", projectKey: "scratch@mac-mini", reachable: false, status: "waiting", waitingFor: "trust this folder?", state: "needs_you", stateReason: "trust this folder?" }));
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "scratch@mac-mini", title: "shell-started session", needsYou: true, needsKind: "waiting", createdAt: "2026-10-17T17:58:00.000Z" }));
    boot(MODEL, serve(p));
    await api().refresh();
    expect(document.title).toBe("(2) Console");
    q('[data-machine-tab="mac-mini"]').click();
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toBe("! 2 NEED YOU · ⟳ 1 WORKING");
    const group = q("[data-unreachable-group]");
    const tab = group.querySelector('[data-project-tab="scratch@mac-mini"]') as HTMLElement | null;
    expect(tab).not.toBeNull();
    expect(tab!.querySelector(".st")!.textContent).toBe("! NEEDS YOU");
    expect(tab!.getAttribute("data-state")).toBe("needs_you");
    expect(document.querySelector('[data-project-tab="sh-mac-mini"]')).toBeNull(); // never a tab under the shell's name
    expect(qa("[data-cards] [data-card]").map((c) => c.getAttribute("data-card"))).toEqual([HEX_D, HEX_A, HEX_B]);
    expect(textOf(`[data-card="${HEX_D}"] [data-reason]`)).toContain("trust this folder?");
    expect(textOf(`[data-card="${HEX_D}"]`)).toContain("not reachable");
  });

  it("an ended session renders ○ ENDED whatever its state says", async () => {
    const p = fleet();
    p.sessions[0] = session({ ...p.sessions[0]!, endedAt: "2026-10-17T17:58:00.000Z" }); // the row still says needs_you
    boot(MODEL, serve(p));
    await api().refresh();
    expect(document.title).toBe("Console");
    q('[data-machine-tab="mac-mini"]').click();
    expect(textOf('[data-project-tab="solo"] .st')).toBe("○ ENDED");
    expect(q('[data-project-tab="solo"]').getAttribute("data-state")).toBe("ended");
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toBe("⟳ 1 WORKING"); // ended projects are not live counts
    // its card is still listed (cards keep to retention) and says so
    const c = q(`[data-card="${HEX_A}"]`);
    expect(c.querySelector("[data-session-state]")!.textContent).toBe("○ ENDED");
    // a machine whose every project has ended says so instead of pretending to be idle
    p.sessions[1] = session({ ...p.sessions[1]!, endedAt: "2026-10-17T17:58:30.000Z" });
    await api().refresh();
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toBe("○ 2 ENDED");
  });

  it("a machine whose health is pending shows no data yet", async () => {
    const p = fleet();
    p.machines.push(health({ machine: "new-box", state: "pending", since: "2026-10-17T17:59:00.000Z" }));
    boot(MODEL, serve(p));
    await api().refresh();
    expect(textOf('[data-machine-tab="new-box"] .st')).toBe("… no data yet");
    expect(q('[data-machine-tab="new-box"]').getAttribute("data-health")).toBe("pending");
    q('[data-machine-tab="new-box"]').click();
    const banner = q('[data-machine-banner="new-box"]');
    expect(banner.textContent).toContain("no data yet");
    expect(banner.getAttribute("role")).toBe("status"); // not an alarm
    expect(textOf("[data-project-tabs]")).toContain("no data yet");
    expect(qa("[data-cards] [data-card]")).toHaveLength(0);
    expect(textOf("[data-cards]")).toMatch(/no cards/i);
  });

  it("a disabled settings payload renders the banner naming the entry and stops polling", async () => {
    vi.useFakeTimers();
    let serving: StatePayload = fleet();
    boot(MODEL, serve(() => serving));
    await api().refresh();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    serving = { ...fleet(), settings: { disabled: true, entry: "projects.solo.border" } };
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const banner = q("[data-console-disabled]");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("projects.solo.border");
    expect(q("[data-poll-status]").getAttribute("data-state")).toBe("disabled");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new window.Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("polls every settings.pollSeconds and again on window focus", async () => {
    vi.useFakeTimers();
    const p = fleet();
    p.settings = { ...settings(), pollSeconds: 7 };
    boot(MODEL, serve(p));
    await api().refresh();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0]![0])).toBe("/console/api/state");
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ credentials: "same-origin" });
    expect(q("[data-poll-status]").getAttribute("data-state")).toBe("ok");
    expect(textOf("[data-poll-status]")).toBe("✓ live · every 7 s"); // the live region names the state, not the time
    expect(textOf("[data-poll-heartbeat]")).toMatch(/^updated \d\d:\d\d:\d\d$/);
    await vi.advanceTimersByTimeAsync(6999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    window.dispatchEvent(new window.Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // a focus right after a poll is not another dial
    window.dispatchEvent(new window.Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("a network failure or a non-200 is said in the status line and polling continues", async () => {
    vi.useFakeTimers();
    let mode: "down" | "bad" | "ok" = "down";
    boot(MODEL, async (url) => {
      if (mode === "down") throw new TypeError("network down");
      if (mode === "bad") return { status: 502, body: { error: "bad gateway" } };
      return serve(fleet())(url);
    });
    await api().refresh();
    expect(q("[data-poll-status]").getAttribute("data-state")).toBe("error");
    expect(textOf("[data-poll-status]")).toContain("can't reach the harness");
    mode = "bad";
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(textOf("[data-poll-status]")).toContain("HTTP 502");
    mode = "ok";
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(q("[data-poll-status]").getAttribute("data-state")).toBe("ok");
    expect(document.querySelector('[data-machine-tab="mac-mini"]')).not.toBeNull();
  });

  it("a cant_read machine shows ⚠ CAN'T READ — format changed (N lines) and lists its problems in a collapsible list", async () => {
    const p = fleet();
    p.machines[1] = health({ machine: "linux-dev", state: "cant_read", since: "2026-10-17T17:30:00.000Z", ignoredLines: 7, message: "sessions/4242.json lacks status", problems: ["a problem", "b <x>"] });
    p.machines[0] = health({ machine: "mac-mini", state: "failed", since: "2026-10-17T17:40:00.000Z", message: "probe on mac-mini failed (exit 2)", remoteDetail: "bash: tmux: command not found" });
    boot(MODEL, serve(p));
    await api().refresh();
    expect(textOf('[data-machine-tab="linux-dev"] .st')).toContain("⚠ CAN'T READ — format changed (7 lines)");
    expect(q('[data-machine-tab="linux-dev"]').getAttribute("data-health")).toBe("cant_read");
    const banner = q('[data-machine-banner="linux-dev"]');
    expect(banner.textContent).toContain("⚠ CAN'T READ — format changed (7 lines)");
    expect(banner.textContent).toContain("sessions/4242.json lacks status");
    const details = q<HTMLDetailsElement>('details[data-machine-problems="linux-dev"]');
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain("2 problems");
    expect(Array.from(details.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["a problem", "b <x>"]);
    // a failed probe: first-party message, and the machine's own words labelled as such
    const failed = q('[data-machine-banner="mac-mini"]');
    expect(failed.textContent).toContain("⚠ PROBE FAILED");
    expect(failed.textContent).toContain("probe on mac-mini failed (exit 2)");
    expect(failed.textContent).toContain('machine said: "bash: tmux: command not found"');
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toContain("⚠ PROBE FAILED");
  });

  it("labels a card by needsKind while it needs you and treats card.kind as history otherwise", async () => {
    const p = fleet();
    p.cards = [
      card({ id: HEX_A, machine: "mac-mini", projectKey: "solo", needsYou: true, needsKind: "menu_on_screen", kind: "menu" }),
      card({ id: HEX_B, machine: "mac-mini", projectKey: "lancache", needsYou: false, needsKind: null, kind: "commit_approval" }),
      card({ id: HEX_C, machine: "mac-mini", projectKey: "lancache", needsYou: true, needsKind: "sentinel", kind: "commit_approval", createdAt: "2026-10-17T17:56:00.000Z" }),
      card({ id: HEX_D, machine: "linux-dev", projectKey: "homelab", needsYou: true, needsKind: "waiting", kind: "reply" }),
      card({ id: HEX_E, machine: "linux-dev", projectKey: "homelab", needsYou: false, needsKind: null, kind: "menu", createdAt: "2026-10-17T17:20:00.000Z" })
    ];
    boot(MODEL, serve(p));
    await api().refresh();
    const label = (id: string): string => textOf(`[data-card="${id}"] [data-kind-label]`);
    expect(label(HEX_A)).toBe("! MENU ON SCREEN");
    expect(label(HEX_B)).toBe("COMMIT APPROVAL · earlier");
    expect(label(HEX_C)).toBe("! COMMIT APPROVAL");
    expect(label(HEX_D)).toBe("! WAITING FOR YOU");
    expect(label(HEX_E)).toBe("MENU · earlier");
    expect(q(`[data-card="${HEX_A}"]`).getAttribute("data-state")).toBe("needs_you");
    expect(q(`[data-card="${HEX_B}"]`).getAttribute("data-state")).toBe("working"); // from its session row
    expect(q(`[data-card="${HEX_E}"]`).getAttribute("data-state")).toBe("idle");
    // needs-you cards are pinned above the rest; newest first within each group
    expect(qa("[data-cards] [data-card]").map((c) => c.getAttribute("data-card"))).toEqual([HEX_C, HEX_A, HEX_D, HEX_B, HEX_E]);
    expect(textOf(`[data-card="${HEX_A}"] [data-reason]`)).toContain("R-452-2"); // the session's reason, shown in words
  });

  it("an expand failure is said on the card (unreachable → Can't load the full text now; 403 → signed out) and can be retried", async () => {
    const replies: Record<string, FetchReply> = {
      [HEX_A]: { status: 502, body: { state: "unreachable", message: "mac-mini unreachable — connect timed out" } },
      [HEX_B]: { status: 403, body: { error: "forbidden" } },
      [HEX_C]: { status: 200, body: { state: "changed", message: "the transcript of this card is no longer on linux-dev" } }
    };
    boot(MODEL, serve(fleet(), (id) => replies[id] ?? { status: 500, body: null }));
    await api().refresh();
    await api().expand(HEX_A, "full");
    expect(textOf(`[data-card="${HEX_A}"] [data-expand-status]`)).toBe("✕ Can't load the full text now — mac-mini unreachable — connect timed out");
    expect((q(`[data-card="${HEX_A}"] [data-section="full"]`) as HTMLElement).hidden).toBe(true); // nothing to show; the button is back to ▸
    expect(textOf(`[data-card="${HEX_A}"] [data-expand="full"]`)).toBe("▸ full text");
    await api().expand(HEX_B, "why");
    expect(textOf(`[data-card="${HEX_B}"] [data-expand-status]`)).toBe("✕ signed out — reload to sign in");
    await api().expand(HEX_C, "what");
    expect(textOf(`[data-card="${HEX_C}"] [data-expand-status]`)).toBe("⚠ changed — the transcript of this card is no longer on linux-dev");
    // a failure is not cached: the next click asks the machine again
    await api().expand(HEX_A, "full");
    expect(expandCalls().filter((u) => u.includes(HEX_A))).toHaveLength(2);
    // a malformed id is never sent
    await api().expand("not-a-card-id", "full");
    expect(expandCalls().some((u) => u.includes("not-a-card-id"))).toBe(false);
  });

  it("an unconfigured project reads new — not set up, a hidden one is omitted, an unreachable one sits in the start-it-in-tmux group", async () => {
    const p = fleet();
    p.sessions.push(session({ machine: "mac-mini", tmuxSession: "fresh", status: "idle", state: "idle" })); // not in settings
    p.sessions.push(session({ machine: "mac-mini", tmuxSession: "hush", status: "busy", state: "working" })); // hidden by settings
    p.sessions.push(session({ machine: "mac-mini", tmuxSession: "", projectKey: "scratch@mac-mini", reachable: false, status: "busy", state: "working" }));
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "hush", title: "hidden card" }));
    p.cards.push(card({ id: HEX_E, machine: "mac-mini", projectKey: "scratch@mac-mini", title: "unreachable card", createdAt: "2026-10-17T17:57:00.000Z" }));
    boot(MODEL, serve(p));
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    expect(qa("[data-project-tabs] [data-project-tab]").map((b) => b.getAttribute("data-project-tab"))).toEqual(["*", "solo", "lancache", "fresh", "scratch@mac-mini"]);
    expect(textOf('[data-project-tab="fresh"] .name')).toBe("· fresh");
    expect(textOf('[data-project-tab="fresh"]')).toContain("new — not set up");
    expect(document.querySelector('[data-project-tab="hush"]')).toBeNull();
    expect(document.querySelector(`[data-card="${HEX_D}"]`)).toBeNull();
    const group = q("[data-unreachable-group]");
    expect(group.textContent).toContain("not reachable — start it in tmux");
    expect(group.querySelector('[data-project-tab="scratch@mac-mini"]')).not.toBeNull();
    expect(textOf('[data-project-tab="scratch@mac-mini"] .st')).toBe("⟳ WORKING");
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toBe("! 1 NEEDS YOU · ⟳ 2 WORKING · ✓ 1 IDLE");
    q('[data-project-tab="scratch@mac-mini"]').click();
    expect(qa("[data-cards] [data-card]").map((c) => c.getAttribute("data-card"))).toEqual([HEX_E]);
    expect(textOf(`[data-card="${HEX_E}"]`)).toContain("not reachable");
  });

  it("tab rows are real buttons with aria-pressed, arrow keys move focus along a row, and focus survives a poll", async () => {
    let serving = fleet();
    boot(MODEL, serve(() => serving));
    await api().refresh();
    for (const b of qa("[data-machine-tab], [data-project-tab]")) {
      expect(b.tagName).toBe("BUTTON");
      expect(["true", "false"]).toContain(b.getAttribute("aria-pressed"));
    }
    const first = q('[data-machine-tab="*"]');
    first.focus();
    first.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(q('[data-machine-tab="mac-mini"]'));
    document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(q('[data-machine-tab="linux-dev"]'));
    document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(first); // wraps — never trapped at an end
    document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(q('[data-machine-tab="linux-dev"]'));
    // a poll re-renders the rows; the focused tab is found again by its key
    q('[data-project-tab="solo"]').focus();
    serving = { ...fleet(), cards: [...fleet().cards, card({ id: HEX_D, machine: "mac-mini", projectKey: "solo", title: "newer" })] };
    await api().refresh();
    expect(document.activeElement).toBe(q('[data-project-tab="solo"]'));
    expect(q("[data-machine-tabs]").getAttribute("aria-label")).toBe("Machines");
  });

  it("the Open terminal link goes to the Terminals tab under the base and names the machine and tmux session", async () => {
    boot({ base: "/harness", loginEnabled: false }, serve(fleet()));
    await api().refresh();
    expect(String(fetchFn.mock.calls[0]![0])).toBe("/harness/console/api/state");
    const a = q<HTMLAnchorElement>(`[data-card="${HEX_A}"] a[data-open-terminal-link]`);
    expect(a.getAttribute("href")).toBe("/harness/harness");
    expect(a.textContent).toBe("Open terminal ↗");
    expect(a.title).toContain("mac-mini · solo");
    (q(`[data-card="${HEX_A}"] [data-expand="full"]`)).click();
    await vi.waitFor(() => expect(expandCalls()).toEqual([`/harness/console/api/cards/${HEX_A}/expand`]));
  });

  it("a heartbeat does not touch the status live region, a machine banner keeps its node and text across polls, and the problems fold keeps its open state", async () => {
    vi.useFakeTimers();
    const since = "2026-10-17T17:02:00.000Z";
    let tick = 0;
    const serving = (): StatePayload => {
      const p = fleet();
      p.machines[0] = health({ machine: "mac-mini", state: "unreachable", since, message: "mac-mini unreachable — connect timed out", problems: ["probe timed out", "probe timed out again"] });
      // something unrelated changes every poll (a transcriptSize — not per-tick churn, which no longer re-renders
      // since final review M6), so a render really happens each time
      p.sessions[1] = session({ ...p.sessions[1]!, transcriptSize: 1000 + tick++ });
      return p;
    };
    boot(MODEL, serve(serving));
    await api().refresh();
    const status = q("[data-poll-status]");
    const statusText = status.textContent;
    const beat1 = textOf("[data-poll-heartbeat]");
    const banner = q('[data-machine-banner="mac-mini"]');
    const bannerText = banner.textContent;
    const details = q<HTMLDetailsElement>('details[data-machine-problems="mac-mini"]');
    expect(details.open).toBe(false);
    details.open = true;
    details.dispatchEvent(new window.Event("toggle"));
    await vi.advanceTimersByTimeAsync(5000); // the next poll
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(q("[data-poll-status]")).toBe(status);
    expect(status.textContent).toBe(statusText); // a heartbeat is not a transition: nothing to announce
    expect(textOf("[data-poll-heartbeat]")).toMatch(/^updated \d\d:\d\d:\d\d$/);
    expect(textOf("[data-poll-heartbeat]")).not.toBe(beat1);
    expect(q('[data-machine-banner="mac-mini"]')).toBe(banner); // the same node — not a fresh role="alert" per poll
    expect(banner.textContent).toBe(bannerText);
    expect(q<HTMLDetailsElement>('details[data-machine-problems="mac-mini"]')).toBe(details);
    expect(details.open).toBe(true);
    // a real transition is still said once: the API goes away and comes back
    (window as unknown as { fetch: unknown }).fetch = vi.fn(async () => { throw new TypeError("down"); });
    await vi.advanceTimersByTimeAsync(5000);
    expect(q("[data-poll-status]").getAttribute("data-state")).toBe("error");
    expect(q("[data-poll-status]").textContent).not.toBe(statusText);
  });

  // Final review M6: lastSeenAt / updatedAt / version / lastOkAt change on every tick, so the identical-payload dedup
  // never fired in production and every card was rebuilt on every poll (a text selection was lost every 5 s).
  it("a poll that differs only in per-tick churn keeps the card nodes, still refreshing their ages and the heartbeat; a real change re-renders", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T18:00:00.000Z"));
    let poll = 0;
    const churned = (): StatePayload => {
      const p = fleet();
      const stamp = new Date(Date.parse("2026-10-17T18:00:00.000Z") + poll * 5000).toISOString();
      const version = 1 + poll++;
      p.machines = p.machines.map((m) => ({ ...m, lastOkAt: stamp, since: stamp }));
      p.sessions = p.sessions.map((x) => ({ ...x, lastSeenAt: stamp, updatedAt: stamp, version }));
      p.cards = p.cards.map((c) => ({ ...c, updatedAt: stamp, version }));
      return p;
    };
    let serving = churned;
    boot(MODEL, serve(() => serving()));
    await api().refresh();
    const node = q(`[data-card="${HEX_B}"]`);
    expect(node.querySelector("[data-age]")!.textContent).toBe("5 min ago · 4 tool calls · with reasoning");
    const beat = textOf("[data-poll-heartbeat]");
    vi.setSystemTime(new Date("2026-10-17T18:10:00.000Z"));
    await api().refresh();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(q(`[data-card="${HEX_B}"]`)).toBe(node); // the same node: nothing was rebuilt
    expect(node.querySelector("[data-age]")!.textContent).toBe("15 min ago · 4 tool calls · with reasoning");
    expect(textOf("[data-poll-heartbeat]")).not.toBe(beat);
    // A real change (a card's title) is rendered.
    serving = () => {
      const p = churned();
      p.cards[1] = { ...p.cards[1]!, title: "#361 deployed and verified" };
      return p;
    };
    await api().refresh();
    expect(q(`[data-card="${HEX_B}"]`)).not.toBe(node);
    expect(textOf(`[data-card="${HEX_B}"] [data-title]`)).toBe("#361 deployed and verified");
  });

  it("an expand button is aria-busy while its fetch is in flight and not after", async () => {
    let resolveExpand: ((r: FetchReply) => void) | undefined;
    boot(MODEL, serve(fleet(), () => new Promise<FetchReply>((res) => { resolveExpand = res; })));
    await api().refresh();
    const why = q(`[data-card="${HEX_B}"] [data-expand="why"]`);
    const done = api().expand(HEX_B, "why");
    expect(why.getAttribute("aria-busy")).toBe("true");
    expect(q(`[data-card="${HEX_B}"] [data-expand="full"]`).hasAttribute("aria-busy")).toBe(false); // only the pressed section
    expect(textOf(`[data-card="${HEX_B}"] [data-expand-status]`)).toContain("loading");
    resolveExpand!({ status: 200, body: { state: "ok", view: { fullText: "t", why: "w", whatItDid: [], agentRuns: 0 } } });
    await done;
    expect(why.hasAttribute("aria-busy")).toBe(false);
    expect(why.getAttribute("aria-expanded")).toBe("true");
    expect(textOf(`[data-card="${HEX_B}"] [data-expand-status]`)).toBe("");
  });

  it("a project glyph is capped by code points, so a two-emoji glyph stays whole", async () => {
    const p = fleet();
    (p.settings as ApiSettings).projects["solo"]!.glyph = "🔥🔥";
    (p.settings as ApiSettings).projects["lancache"]!.glyph = "⬢▲●"; // the settings loader refuses three; the client still cuts on a code point
    boot(MODEL, serve(p));
    await api().refresh();
    expect(textOf('[data-project-tab="solo"] .name')).toBe("🔥🔥 Solo");
    expect(textOf('[data-project-tab="lancache"] .name')).toBe("⬢▲ LanCache");
    expect(textOf(`[data-card="${HEX_A}"] .tag`)).toBe("🔥🔥 Solo");
  });

  it("a missing health timestamp reads as unknown time (never the epoch) and a long machine name is capped in its tab", async () => {
    const p = fleet();
    const long = "m" + "x".repeat(199);
    p.machines[0] = health({ machine: "mac-mini", state: "unreachable", since: null as unknown as string });
    p.machines.push(health({ machine: long }));
    p.sessions.push(session({ machine: long, tmuxSession: "solo", status: "idle", state: "idle" }));
    boot(MODEL, serve(p));
    await api().refresh();
    expect(textOf('[data-machine-tab="mac-mini"] .st')).toContain("✕ UNREACHABLE since (unknown time)");
    expect(textOf('[data-machine-tab="mac-mini"] .st')).not.toMatch(/since \d\d:\d\d/);
    expect(textOf('[data-machine-banner="mac-mini"]')).toContain("since (unknown time)");
    const tab = qa("[data-machine-tab]").find((b) => b.getAttribute("data-machine-tab") === long)!;
    const name = tab.querySelector(".name")!.textContent!;
    expect(name.length).toBe(61); // 60 characters + the ellipsis
    expect(name.endsWith("…")).toBe(true);
  });

  it("focus on a card's Open terminal link survives a poll", async () => {
    let serving = fleet();
    boot(MODEL, serve(() => serving));
    await api().refresh();
    q<HTMLAnchorElement>(`[data-card="${HEX_A}"] a[data-open-terminal-link]`).focus();
    expect(document.activeElement).toBe(q(`[data-card="${HEX_A}"] a[data-open-terminal-link]`));
    serving = { ...fleet(), cards: [...fleet().cards, card({ id: HEX_D, machine: "mac-mini", projectKey: "solo", title: "newer" })] };
    await api().refresh();
    expect(document.activeElement).toBe(q(`[data-card="${HEX_A}"] a[data-open-terminal-link]`));
  });
});

// ================= F2 Task 9: fold, reply box, buttons, step-up, view switch, drawer, new session =================

class FakeTerm {
  static all: FakeTerm[] = [];
  cols = 80;
  rows = 24;
  keyHandler: ((e: KeyboardEvent) => boolean) | undefined;
  titleCb: ((t: string) => void) | undefined;
  constructor(public opts: unknown) {
    FakeTerm.all.push(this);
  }
  loadAddon(): void {}
  open(): void {}
  write(): void {}
  onData(): void {}
  onResize(): void {}
  onTitleChange(cb: (t: string) => void): void {
    this.titleCb = cb;
  }
  attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = fn;
  }
  getSelection(): string {
    return "";
  }
  dispose(): void {}
}
class FakeWS {
  static all: FakeWS[] = [];
  readyState = 1;
  sent: string[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {}
  emit(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
const HEX_F = "f".repeat(32);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Extra = (c: Call) => FetchReply | undefined;
/** Every non-state request the page made, in order. */
const calls = (): Call[] =>
  (fetchFn.mock.calls as [string, { method?: string; body?: string } | undefined][])
    .map(([u, init]) => ({ method: init?.method ?? "GET", path: String(u), body: init?.body !== undefined ? (JSON.parse(init.body) as unknown) : undefined }))
    .filter((c) => !STATE_RE.test(c.path));
const brief = (): string[] => calls().map((c) => `${c.method} ${c.path}`);
const inTenMinutes = (): string => new Date(Date.now() + 10 * 60_000).toISOString();
const STEP_UP = "/console/api/step-up";
/** A step-up that is already open: GET answers elevated, POST answers 200. */
const elevated: Extra = (c) => (c.path === STEP_UP ? { status: 200, body: { elevatedUntil: inTenMinutes() } } : undefined);
/** A step-up that is closed until a POST (the dialog) opens it. */
function closedUntilPost(): Extra {
  let open = false;
  return (c) => {
    if (c.path !== STEP_UP) return undefined;
    if (c.method === "POST") {
      open = true;
      return { status: 200, body: { elevatedUntil: inTenMinutes() } };
    }
    return { status: 200, body: { elevatedUntil: open ? inTenMinutes() : null } };
  };
}
const submitPath = (id: string): string => `/console/api/cards/${id}/submit`;
const replyOk = (message: string, outcome = "sent"): FetchReply => ({ status: 200, body: { outcome, at: "2026-10-17T18:03:00.000Z", message } });
/** The first submit on this card is told to elevate (403); later ones are accepted. */
function firstSubmitNeedsStepUp(id: string): Extra {
  let first = true;
  return (c) => {
    if (c.path !== submitPath(id)) return undefined;
    if (first) {
      first = false;
      return { status: 403, body: { error: "step_up_required" } };
    }
    return replyOk("sent — waiting for the session");
  };
}
/** Chains extras: the first that answers wins. */
const firstOf = (...xs: Extra[]): Extra => (c) => xs.map((x) => x(c)).find((r) => r !== undefined);

function bootConsole(state: StatePayload | (() => StatePayload), extra: Extra = () => undefined, model: ConsolePageModel = MODEL): void {
  const w = window as unknown as Record<string, unknown>;
  w["Terminal"] = FakeTerm;
  w["FitAddon"] = { FitAddon: class { fit(): void {} } };
  w["WebSocket"] = FakeWS;
  boot(model, (url, init) => {
    if (STATE_RE.test(url)) return { status: 200, body: typeof state === "function" ? state() : state };
    const c: Call = { method: init?.method ?? "GET", path: url, body: init?.body !== undefined ? (JSON.parse(init.body) as unknown) : undefined };
    return extra(c) ?? { status: 404, body: { error: "not_found" } };
  });
}
const box = (id: string): HTMLTextAreaElement => q<HTMLTextAreaElement>(`[data-card="${id}"] [data-reply-box]`);
const submitBtn = (id: string): HTMLButtonElement => q<HTMLButtonElement>(`[data-card="${id}"] [data-submit]`);
const sendStatus = (id: string): string => textOf(`[data-card="${id}"] [data-send-status]`);
function typeIn(id: string, text: string): void {
  const t = box(id);
  t.value = text;
  t.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const keydown = (target: EventTarget, init: KeyboardEventInit): KeyboardEvent => {
  const e = new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
async function fillPassphraseAndConfirm(pass = "correct horse"): Promise<void> {
  await vi.waitFor(() => q("[data-stepup-dialog]"));
  const input = q<HTMLInputElement>("[data-stepup-dialog] input");
  input.value = pass;
  q("[data-stepup-confirm]").click();
}

describe("console client: fold (trial finding 4)", () => {
  it("opens needs-you cards and folds the rest to a '▸ TL;DR' toggle; the toggle flips hidden and remembers it under console.fold.<id>", async () => {
    bootConsole(fleet());
    await api().refresh();
    const tldr = (id: string): HTMLElement => q(`[data-card="${id}"] [data-tldr]`);
    const toggle = (id: string): HTMLElement => q(`[data-card="${id}"] [data-fold-toggle]`);
    expect(tldr(HEX_A).hidden).toBe(false); // needsYou → open by default
    expect(toggle(HEX_A).textContent).toBe("▾ TL;DR");
    expect(toggle(HEX_A).getAttribute("aria-expanded")).toBe("true");
    expect(tldr(HEX_B).hidden).toBe(true);
    expect(toggle(HEX_B).textContent).toBe("▸ TL;DR");
    expect(toggle(HEX_B).getAttribute("aria-expanded")).toBe("false");
    expect(textOf(`[data-card="${HEX_B}"] [data-title]`)).toBe("#361 deployed"); // the title line is always there

    toggle(HEX_B).click();
    expect(tldr(HEX_B).hidden).toBe(false);
    expect(window.localStorage.getItem(`console.fold.${HEX_B}`)).toBe("open");
    toggle(HEX_A).click();
    expect(tldr(HEX_A).hidden).toBe(true);
    expect(window.localStorage.getItem(`console.fold.${HEX_A}`)).toBe("closed");
    // a re-render (selection change) keeps what the operator chose, not the default
    q('[data-machine-tab="mac-mini"]').click();
    expect(tldr(HEX_B).hidden).toBe(false);
    expect(tldr(HEX_A).hidden).toBe(true);
  });

  it("'Fold all' / 'Expand all' names the next action and applies to every card shown", async () => {
    bootConsole(fleet());
    await api().refresh();
    const all = q("[data-fold-all]");
    expect(all.textContent).toBe("Fold all"); // the needs-you card is open
    all.click();
    expect(qa("[data-tldr]").every((t) => t.hidden)).toBe(true);
    expect(all.textContent).toBe("Expand all");
    all.click();
    expect(qa("[data-tldr]").every((t) => !t.hidden)).toBe(true);
    expect(all.textContent).toBe("Fold all");
    expect(window.localStorage.getItem(`console.fold.${HEX_C}`)).toBe("open");
  });

  it("survives localStorage throwing (private window): the default fold still applies", async () => {
    const spy = vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      bootConsole(fleet());
      await api().refresh();
      expect(q<HTMLElement>(`[data-card="${HEX_A}"] [data-tldr]`).hidden).toBe(false);
      expect(q<HTMLElement>(`[data-card="${HEX_B}"] [data-tldr]`).hidden).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("console client: reply box", () => {
  it("renders a box on a reachable non-menu card, none on a menu card, and a disabled box with the reason for shell / ended / not-reachable sessions", async () => {
    const p = fleet();
    p.sessions.push(session({ machine: "mac-mini", tmuxSession: "sh-mac-mini", projectKey: "scratch@mac-mini", reachable: false, status: "idle", state: "idle" }));
    p.sessions.push(session({ machine: "mac-mini", tmuxSession: "old", status: "idle", state: "idle", endedAt: "2026-10-17T17:58:00.000Z" }));
    p.sessions.push(session({ machine: "mac-mini", tmuxSession: "", projectKey: "tmuxless", reachable: false, status: "idle", state: "idle" }));
    p.cards.push(
      card({ id: HEX_D, machine: "mac-mini", projectKey: "solo", kind: "menu", needsYou: true, needsKind: "menu_on_screen", options: ["1", "2"] }),
      card({ id: HEX_E, machine: "mac-mini", projectKey: "scratch@mac-mini" }),
      card({ id: HEX_F, machine: "mac-mini", projectKey: "old" }),
      card({ id: "9".repeat(32), machine: "mac-mini", projectKey: "tmuxless" })
    );
    bootConsole(p);
    await api().refresh();
    expect(box(HEX_B).disabled).toBe(false);
    expect(box(HEX_B).getAttribute("maxlength")).toBe("4096");
    expect(submitBtn(HEX_B).textContent).toBe("Submit");
    expect(document.querySelector(`[data-card="${HEX_D}"] textarea`)).toBeNull(); // a menu has no box
    expect(textOf(`[data-card="${HEX_D}"] [data-options-readonly]`)).toContain("1");
    expect(box(HEX_E).disabled).toBe(true);
    expect(textOf(`[data-card="${HEX_E}"] [data-reply-disabled]`)).toMatch(/machine shell/);
    expect(box(HEX_F).disabled).toBe(true);
    expect(textOf(`[data-card="${HEX_F}"] [data-reply-disabled]`)).toMatch(/ended/);
    const tmuxless = "9".repeat(32);
    expect(box(tmuxless).disabled).toBe(true);
    expect(textOf(`[data-card="${tmuxless}"] [data-reply-disabled]`)).toMatch(/not reachable/);
    expect(submitBtn(tmuxless).disabled).toBe(true);
  });

  it("ruling T11-20 (M-1): a session showing a prompt (row status waiting) gets a disabled box with the reason in words — the server would refuse the send", async () => {
    bootConsole(fleet());
    await api().refresh();
    // fleet(): solo's session is `waiting` (HEX_A), lancache's is busy (HEX_B).
    expect(box(HEX_A).disabled).toBe(true);
    expect(textOf(`[data-card="${HEX_A}"] [data-reply-disabled]`)).toBe("⚠ the session is showing a prompt — answer it in the Claude session");
    expect(submitBtn(HEX_A).disabled).toBe(true);
    expect(box(HEX_B).disabled).toBe(false);
  });

  it("counts UTF-8 bytes, not characters; Submit stays disabled for empty or whitespace-only text (ruling T6-1)", async () => {
    bootConsole(fleet());
    await api().refresh();
    expect(textOf(`[data-card="${HEX_B}"] [data-byte-count]`)).toBe("0 / 4096 bytes");
    expect(submitBtn(HEX_B).disabled).toBe(true);
    typeIn(HEX_B, "  \n\t ");
    expect(submitBtn(HEX_B).disabled).toBe(true);
    typeIn(HEX_B, "héllo €"); // 1+2+1+1+1+1+3 = 10 bytes in 7 characters
    expect(textOf(`[data-card="${HEX_B}"] [data-byte-count]`)).toBe("10 / 4096 bytes");
    expect(submitBtn(HEX_B).disabled).toBe(false);
  });

  it("keeps what was typed across a poll that re-renders the card", async () => {
    let serving = fleet();
    bootConsole(() => serving);
    await api().refresh();
    typeIn(HEX_B, "half a thought");
    serving = { ...fleet(), cards: fleet().cards.map((c) => (c.id === HEX_B ? { ...c, title: "#361 deployed (edited)" } : c)) };
    await api().refresh();
    expect(textOf(`[data-card="${HEX_B}"] [data-title]`)).toBe("#361 deployed (edited)");
    expect(box(HEX_B).value).toBe("half a thought");
    expect(textOf(`[data-card="${HEX_B}"] [data-byte-count]`)).toBe("14 / 4096 bytes");
  });
});

describe("console client: buttons", () => {
  const question = (): StatePayload => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", needsYou: true, needsKind: "reply_question", asksYou: true, options: ["A1", "A2"], createdAt: "2026-10-17T17:58:00.000Z" }));
    return p;
  };

  it("a reply_question card gets one button per option that COPIES the id into the box and never sends", async () => {
    bootConsole(question());
    await api().refresh();
    const ids = qa(`[data-card="${HEX_D}"] [data-option]`).map((b) => b.getAttribute("data-option"));
    expect(ids).toEqual(["A1", "A2"]);
    q(`[data-card="${HEX_D}"] [data-option="A1"]`).click();
    expect(box(HEX_D).value).toBe("A1");
    q(`[data-card="${HEX_D}"] [data-option="A2"]`).click();
    expect(box(HEX_D).value).toBe("A1 A2");
    expect(textOf(`[data-card="${HEX_D}"] [data-byte-count]`)).toBe("5 / 4096 bytes");
    expect(calls()).toEqual([]); // not one request: a copy is not a send
  });

  it("a sentinel card's button sends ONLY the option id, after the step-up dialog resolved (GET step-up → POST step-up → POST submit)", async () => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", needsYou: true, needsKind: "sentinel", options: ["A1", "A2"] }));
    bootConsole(p, firstOf(closedUntilPost(), (c) => (c.path === submitPath(HEX_D) ? replyOk("sent — waiting for the session") : undefined)));
    await api().refresh();
    typeIn(HEX_D, "unrelated words in the box");
    q(`[data-card="${HEX_D}"] [data-option="A1"]`).click();
    await vi.waitFor(() => expect(document.querySelector("[data-stepup-dialog]")).not.toBeNull());
    expect(brief()).toEqual([`GET ${STEP_UP}`]); // nothing is sent before the operator confirmed
    await fillPassphraseAndConfirm("hunter2");
    await vi.waitFor(() => expect(brief()).toHaveLength(3));
    expect(brief()).toEqual([`GET ${STEP_UP}`, `POST ${STEP_UP}`, `POST ${submitPath(HEX_D)}`]);
    const [, stepUpPost, submitPost] = calls();
    expect(stepUpPost!.body).toEqual({ passphrase: "hunter2" });
    expect(submitPost!.body).toEqual({ text: "A1", key: expect.stringMatching(UUID_RE) });
    expect(document.querySelector("[data-stepup-dialog]")).toBeNull();
  });

  it("a commit_approval card has no buttons — the box only (D5)", async () => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", kind: "commit_approval", needsYou: true, needsKind: "sentinel", options: ["A1", "A2"] }));
    bootConsole(p);
    await api().refresh();
    expect(document.querySelectorAll(`[data-card="${HEX_D}"] [data-option]`).length).toBe(0);
    expect(box(HEX_D)).not.toBeNull();
  });

  it("Dismiss on a reply_question card posts to /dismiss and the card leaves the needs-you group", async () => {
    let dismissed = false;
    const state = (): StatePayload => {
      const p = question();
      if (dismissed) p.cards = p.cards.map((c) => (c.id === HEX_D ? { ...c, needsYou: false, dismissedAt: "2026-10-17T18:05:00.000Z" } : c));
      return p;
    };
    bootConsole(state, (c) => {
      if (c.path === `/console/api/cards/${HEX_D}/dismiss`) {
        dismissed = true;
        return { status: 200, body: { dismissedAt: "2026-10-17T18:05:00.000Z" } };
      }
      return undefined;
    });
    await api().refresh();
    expect(document.querySelector(`[data-card="${HEX_D}"]`)!.hasAttribute("data-needs-you")).toBe(true);
    expect(document.querySelector(`[data-card="${HEX_C}"] [data-dismiss]`)).toBeNull(); // only on a question
    q(`[data-card="${HEX_D}"] [data-dismiss]`).click();
    await vi.waitFor(() => expect(document.querySelector(`[data-card="${HEX_D}"]`)!.hasAttribute("data-needs-you")).toBe(false));
    // Ruling T11-15: the console's POST routes take JSON only, so Dismiss sends `{}` with the JSON type.
    expect(calls()).toEqual([{ method: "POST", path: `/console/api/cards/${HEX_D}/dismiss`, body: {} }]);
    const init = (fetchFn.mock.calls as [string, { headers?: Record<string, string> } | undefined][]).find(([u]) => u.endsWith("/dismiss"))?.[1];
    expect(init?.headers?.["content-type"]).toBe("application/json");
  });

  it("ruling T11-19 (I-1): Dismiss shows on any card that asks — even with no lettered options — while it is neither dismissed nor answered; never on a commit approval", async () => {
    const p = fleet();
    p.cards.push(
      card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", needsYou: true, needsKind: "reply_question", asksYou: true, options: [] }),
      card({ id: HEX_E, machine: "mac-mini", projectKey: "lancache", needsYou: false, needsKind: "reply_question", asksYou: true, options: [], answeredAt: "2026-10-17T18:00:00.000Z" }),
      card({ id: HEX_F, machine: "mac-mini", projectKey: "lancache", kind: "commit_approval", needsYou: true, needsKind: "sentinel", asksYou: true, options: [] }),
      card({ id: "9".repeat(32), machine: "mac-mini", projectKey: "lancache", needsYou: true, needsKind: "sentinel", asksYou: true, options: [], dismissedAt: "2026-10-17T18:00:00.000Z" })
    );
    bootConsole(p);
    await api().refresh();
    expect(document.querySelectorAll(`[data-card="${HEX_D}"] [data-option]`).length).toBe(0); // no buttons: nothing to copy
    expect(document.querySelector(`[data-card="${HEX_D}"] [data-dismiss]`)).not.toBeNull();
    expect(document.querySelector(`[data-card="${HEX_E}"] [data-dismiss]`)).toBeNull(); // answered
    expect(document.querySelector(`[data-card="${HEX_F}"] [data-dismiss]`)).toBeNull(); // commit approval
    expect(document.querySelector(`[data-card="${"9".repeat(32)}"] [data-dismiss]`)).toBeNull(); // dismissed
    expect(document.querySelector(`[data-card="${HEX_C}"] [data-dismiss]`)).toBeNull(); // asks nothing
  });

  it("M-2 (T11-20): the meta line says 'answered HH:MM' from the stored answeredAt, so it survives a reload", async () => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", asksYou: true, answeredAt: "2026-10-17T18:02:00.000Z" }));
    bootConsole(p);
    await api().refresh();
    expect(textOf(`[data-card="${HEX_D}"] [data-age]`)).toContain(`answered ${hhmm("2026-10-17T18:02:00.000Z")}`);
    expect(textOf(`[data-card="${HEX_B}"] [data-age]`)).not.toContain("answered");
  });

  it("a menu card shows its options read-only and an 'Open Claude session' button that switches the view in place", async () => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", kind: "menu", needsYou: true, needsKind: "menu_on_screen", options: ["1", "2"] }));
    bootConsole(p);
    await api().refresh();
    const open = q<HTMLButtonElement>(`[data-card="${HEX_D}"] [data-open-claude]`);
    expect(open.textContent).toBe("Open Claude session");
    open.click();
    expect(q('[data-project-tab="lancache"]').getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-machine-tab="mac-mini"]').getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-view="claude"]').getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-view="cards"]').getAttribute("aria-pressed")).toBe("false");
    expect(FakeWS.all.map((w) => w.url.replace(/^wss?:\/\/[^/]+/, ""))).toEqual(["/terminal/mac-mini?tmux=lancache"]);
  });
});

describe("console client: step-up dialog and header", () => {
  it("opens a modal with ONE password field; Tab is trapped, Esc closes it and says nothing was sent, focus returns to the opener", async () => {
    bootConsole(fleet(), firstOf(closedUntilPost(), firstSubmitNeedsStepUp(HEX_B)));
    await api().refresh();
    typeIn(HEX_B, "hello");
    const submit = submitBtn(HEX_B);
    submit.focus();
    submit.click(); // the 403 is what opens the dialog
    await vi.waitFor(() => expect(document.querySelector("[data-stepup-dialog]")).not.toBeNull());
    const dlg = q("[data-stepup-dialog]");
    expect(dlg.getAttribute("role")).toBe("dialog");
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    const fields = dlg.querySelectorAll("input");
    expect(fields.length).toBe(1);
    expect(fields[0]!.type).toBe("password");
    expect(fields[0]!.getAttribute("autocomplete")).toBe("current-password");
    expect(document.activeElement).toBe(fields[0]);
    const cancel = q<HTMLButtonElement>("[data-stepup-cancel]");
    cancel.focus();
    const tab = keydown(cancel, { key: "Tab" });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(fields[0]); // wrapped from the last control to the first
    const back = keydown(fields[0]!, { key: "Tab", shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel);
    keydown(dlg, { key: "Escape" });
    expect(document.querySelector("[data-stepup-dialog]")).toBeNull();
    expect(document.activeElement).toBe(submit);
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toContain("step-up cancelled — nothing was sent"));
    expect(box(HEX_B).value).toBe("hello");
  });

  it("a refused passphrase is said in the dialog, which stays open and clears the field; the passphrase is never kept", async () => {
    bootConsole(
      fleet(),
      firstOf((c) => (c.path === STEP_UP ? (c.method === "POST" ? { status: 403, body: { error: "step_up_refused" } } : { status: 200, body: { elevatedUntil: null } }) : undefined), firstSubmitNeedsStepUp(HEX_B))
    );
    await api().refresh();
    typeIn(HEX_B, "x");
    submitBtn(HEX_B).click();
    await fillPassphraseAndConfirm("wrong");
    await vi.waitFor(() => expect(textOf("[data-stepup-status]")).toMatch(/passphrase refused/));
    expect(q<HTMLInputElement>("[data-stepup-dialog] input").value).toBe("");
    expect(document.documentElement.outerHTML).not.toContain("wrong");
  });

  it("shows 'elevated until HH:MM' with a Drop elevation control that posts { revoke: true }", async () => {
    const until = inTenMinutes();
    let open = false;
    bootConsole(
      fleet(),
      firstOf((c) => {
        if (c.path !== STEP_UP) return undefined;
        if (c.method === "POST" && (c.body as { revoke?: boolean }).revoke === true) {
          open = false;
          return { status: 204, body: null };
        }
        if (c.method === "POST") open = true;
        return { status: 200, body: { elevatedUntil: open ? until : null } };
      }, firstSubmitNeedsStepUp(HEX_B))
    );
    await api().refresh();
    expect(document.querySelector("[data-drop-elevation]")).toBeNull(); // nothing is elevated until the operator says so
    typeIn(HEX_B, "x");
    submitBtn(HEX_B).click();
    await fillPassphraseAndConfirm();
    await vi.waitFor(() => expect(document.querySelector("[data-drop-elevation]")).not.toBeNull());
    expect(textOf("[data-elevation]")).toContain(`elevated until ${hhmm(until)}`);
    const drop = q<HTMLButtonElement>("[data-drop-elevation]");
    expect(drop.textContent).toBe("Drop elevation");
    drop.click();
    await vi.waitFor(() => expect(document.querySelector("[data-drop-elevation]")).toBeNull());
    expect(calls().at(-1)).toEqual({ method: "POST", path: STEP_UP, body: { revoke: true } });
    expect(textOf("[data-elevation]")).toContain("not elevated");
  });
});

describe("console client: submit flow", () => {
  it("clears the box only on 'sent' and shows the server's message verbatim with the time (answered by you, HH:MM)", async () => {
    bootConsole(fleet(), firstOf(elevated, (c) => (c.path === submitPath(HEX_B) ? replyOk("answered by you") : undefined)));
    await api().refresh();
    typeIn(HEX_B, "go ahead");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toBe(`✓ answered by you, ${hhmm("2026-10-17T18:03:00.000Z")}`));
    expect(box(HEX_B).value).toBe("");
    expect(textOf(`[data-card="${HEX_B}"] [data-byte-count]`)).toBe("0 / 4096 bytes");
    expect(submitBtn(HEX_B).disabled).toBe(true);
    expect(calls()).toEqual([{ method: "POST", path: submitPath(HEX_B), body: { text: "go ahead", key: expect.stringMatching(UUID_RE) } }]);
  });

  it("keeps the text on refused_menu_visible and says so with a glyph", async () => {
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? replyOk("refused — a menu is on screen; answer it in the Claude session", "refused_menu_visible") : undefined));
    await api().refresh();
    typeIn(HEX_B, "my answer");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toBe("⚠ refused — a menu is on screen; answer it in the Claude session"));
    expect(box(HEX_B).value).toBe("my answer");
    expect(submitBtn(HEX_B).disabled).toBe(false);
  });

  it("ruling T11-18: an unconfirmed send shows ⚠ with the server's words and keeps the text — never ✕, never cleared", async () => {
    const words = "Could not confirm the send — check the Claude session before sending again";
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? replyOk(words, "unconfirmed") : undefined));
    await api().refresh();
    typeIn(HEX_B, "maybe went in");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toBe(`⚠ ${words}`));
    expect(q(`[data-card="${HEX_B}"] [data-send-status]`).getAttribute("data-state")).toBe("warn");
    expect(box(HEX_B).value).toBe("maybe went in");
  });

  it("ruling T11-10 (L1): a 5xx answer keeps the key exactly like a lost answer (the retry meets the server's unresolved 409, never a second paste); a 2xx or 4xx answer rotates it", async () => {
    let n = 0;
    bootConsole(fleet(), (c) => {
      if (c.path !== submitPath(HEX_B)) return undefined;
      n++;
      if (n === 1) return { status: 500, body: { error: "internal_error" } };
      if (n === 2) return { status: 409, body: { error: "unresolved", message: "A send with this key did not finish — check the session before retrying" } };
      return replyOk("sent — waiting for the session");
    });
    await api().refresh();
    typeIn(HEX_B, "once");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toBe("✕ the harness answered HTTP 500 — nothing was confirmed; try again to retry"));
    expect(box(HEX_B).value).toBe("once");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/did not finish/));
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/^✓ sent/));
    const keys = calls().filter((c) => c.path === submitPath(HEX_B)).map((c) => (c.body as { key: string }).key);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]); // kept after the 500
    expect(keys[2]).not.toBe(keys[1]); // rotated after the 409
  });

  it("ruling T11-20 (I-3) + Task 12: a sent on a commit approval says the next step — type the id again — and any other card keeps the plain confirmation", async () => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", kind: "commit_approval", needsYou: true, needsKind: "sentinel", asksYou: true, options: ["A1", "A2"] }));
    const screen: FetchReply = { status: 200, body: { tail: "  Staged change:\n    README.md | 40 ++++", capturedAt: "2026-10-17T18:03:05.000Z", truncated: false } };
    bootConsole(p, (c) => {
      if (c.path === submitPath(HEX_D) || c.path === submitPath(HEX_B)) return replyOk("sent — waiting for the session");
      return c.path === `/console/api/cards/${HEX_D}/pane` ? screen : undefined;
    });
    await api().refresh();
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await vi.waitFor(() => expect(textOf(`[data-card="${HEX_D}"] [data-pane-text]`)).toContain("Staged change:"));
    expect(sendStatus(HEX_D)).toBe("⚠ Check the staged change above, then type A1 again and press Submit to confirm");
    // Any other card keeps the plain confirmation.
    typeIn(HEX_B, "go");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/^✓ sent — waiting for the session/));
  });

  it("triage 19 (F-3): a pane in copy mode shows the server's words — press q in the Claude session — with ⚠, and keeps the text", async () => {
    const words = "the session is in copy mode — press q in the Claude session, then Submit again";
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? replyOk(words, "refused_menu_visible") : undefined));
    await api().refresh();
    typeIn(HEX_B, "my answer");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toBe(`⚠ ${words}`));
    expect(box(HEX_B).value).toBe("my answer");
  });

  it("mints a FRESH key after a failed outcome (ruling T9-1): the stored 'failed' would replay forever on the old one", async () => {
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? replyOk("send failed — the session did not take the text", "failed") : undefined));
    await api().refresh();
    typeIn(HEX_B, "try me");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toBe("✕ send failed — the session did not take the text"));
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(calls()).toHaveLength(2));
    const keys = calls().map((c) => (c.body as { key: string }).key);
    expect(keys[0]).toMatch(UUID_RE);
    expect(keys[1]).toMatch(UUID_RE);
    expect(keys[1]).not.toBe(keys[0]);
    expect(box(HEX_B).value).toBe("try me");
  });

  it("keeps the SAME key across a transport failure (no response), then rotates after the answer", async () => {
    let n = 0;
    bootConsole(fleet());
    await api().refresh();
    const base = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url !== submitPath(HEX_B)) return base(url, init);
      n++;
      if (n === 1) throw new TypeError("network down");
      return { ok: true, status: 200, json: async () => ({ outcome: "sent", at: "2026-10-17T18:03:00.000Z", message: "sent — waiting for the session" }) };
    });
    typeIn(HEX_B, "once");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/can't reach the harness/));
    expect(box(HEX_B).value).toBe("once");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/^✓ sent — waiting for the session/));
    const keys = calls().map((c) => (c.body as { key: string }).key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]); // the server can dedupe a retry of a send whose answer was lost
  });

  it("on 403 step_up_required opens the dialog, then retries ONCE with the same key", async () => {
    let first = true;
    bootConsole(fleet(), firstOf(closedUntilPost(), (c) => {
      if (c.path !== submitPath(HEX_B)) return undefined;
      if (first) {
        first = false;
        return { status: 403, body: { error: "step_up_required" } };
      }
      return replyOk("sent — waiting for the session");
    }));
    await api().refresh();
    typeIn(HEX_B, "after elevation");
    submitBtn(HEX_B).click();
    await fillPassphraseAndConfirm();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/^✓ sent/));
    expect(brief()).toEqual([`POST ${submitPath(HEX_B)}`, `GET ${STEP_UP}`, `POST ${STEP_UP}`, `POST ${submitPath(HEX_B)}`]);
    const keys = calls().filter((c) => c.path === submitPath(HEX_B)).map((c) => (c.body as { key: string }).key);
    expect(keys[1]).toBe(keys[0]);
    expect(box(HEX_B).value).toBe("");
  });

  it("a second 403 after the dialog is said, not looped", async () => {
    bootConsole(fleet(), firstOf(closedUntilPost(), (c) => (c.path === submitPath(HEX_B) ? { status: 403, body: { error: "step_up_required" } } : undefined)));
    await api().refresh();
    typeIn(HEX_B, "again");
    submitBtn(HEX_B).click();
    await fillPassphraseAndConfirm();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/step-up expired/));
    expect(calls().filter((c) => c.path === submitPath(HEX_B))).toHaveLength(2); // the try and ONE retry
    expect(box(HEX_B).value).toBe("again");
  });

  it.each([
    ["empty", "nothing to send"],
    ["too_long", "too long — 4096 bytes max"],
    ["control_char", "the text contains characters that cannot be sent"],
    ["escape", "the text contains characters that cannot be sent"],
    ["invalid_utf8", "the text contains characters that cannot be sent"],
    ["not_text", "not text"],
    ["invalid_key", "request key"]
  ])("a 400 %s names the reason in words and keeps the text", async (error, words) => {
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? { status: 400, body: { error } } : undefined));
    await api().refresh();
    typeIn(HEX_B, "keep me");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toContain(words));
    expect(sendStatus(HEX_B)).toMatch(/^⚠ /);
    expect(box(HEX_B).value).toBe("keep me");
  });

  it("a 409 unresolved shows the server's message, keeps the text, and the next click uses a fresh key (T6-3, T9-1)", async () => {
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? { status: 409, body: { error: "unresolved", message: "could not tell whether the text went in — check the Claude session" } } : undefined));
    await api().refresh();
    typeIn(HEX_B, "maybe sent");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toBe("⚠ could not tell whether the text went in — check the Claude session"));
    expect(box(HEX_B).value).toBe("maybe sent");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(calls()).toHaveLength(2));
    const keys = calls().map((c) => (c.body as { key: string }).key);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it.each([
    ["not_reachable", "session not reachable"],
    ["menu_card", "this is a menu — open the Claude session"]
  ])("a 409 %s without a message falls back to fixed words", async (error, words) => {
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? { status: 409, body: { error } } : undefined));
    await api().refresh();
    typeIn(HEX_B, "x");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toContain(words));
    expect(box(HEX_B).value).toBe("x");
  });

  it("a 503 says 'step-up unavailable — login is disabled' and disables Submit and New session", async () => {
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? { status: 503, body: { error: "step_up_unavailable" } } : undefined));
    await api().refresh();
    expect(q<HTMLButtonElement>('[data-new-session="mac-mini"]').disabled).toBe(false);
    typeIn(HEX_B, "x");
    typeIn(HEX_C, "y");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toContain("step-up unavailable — login is disabled"));
    expect(textOf("[data-elevation]")).toContain("step-up unavailable — login is disabled");
    expect(submitBtn(HEX_B).disabled).toBe(true);
    expect(submitBtn(HEX_C).disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-new-session="mac-mini"]').disabled).toBe(true);
    expect(box(HEX_B).value).toBe("x");
  });

  it("edited text after a lost answer gets its own key (the old key would replay the old send)", async () => {
    let n = 0;
    bootConsole(fleet());
    await api().refresh();
    const base = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url !== submitPath(HEX_B)) return base(url, init);
      if (++n === 1) throw new TypeError("network down");
      return { ok: true, status: 200, json: async () => ({ outcome: "sent", at: "2026-10-17T18:03:00.000Z", message: "sent — waiting for the session" }) };
    });
    typeIn(HEX_B, "first words");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/can't reach the harness/));
    typeIn(HEX_B, "second, different words");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/^✓ sent/));
    const bodies = calls().map((c) => c.body as { text: string; key: string });
    expect(bodies.map((b) => b.text)).toEqual(["first words", "second, different words"]);
    expect(bodies[1]!.key).not.toBe(bodies[0]!.key);
  });

  it("ignores a second click while a send is in flight (one request)", async () => {
    let release: ((r: FetchReply) => void) | undefined;
    bootConsole(fleet());
    await api().refresh();
    const base = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url !== submitPath(HEX_B)) return base(url, init);
      const r = await new Promise<FetchReply>((res) => { release = res; });
      return { ok: true, status: r.status, json: async () => r.body };
    });
    typeIn(HEX_B, "once only");
    submitBtn(HEX_B).click();
    submitBtn(HEX_B).click();
    expect(submitBtn(HEX_B).getAttribute("aria-busy")).toBe("true");
    release!(replyOk("sent — waiting for the session"));
    await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(/^✓ sent/));
    expect(calls().filter((c) => c.path === submitPath(HEX_B))).toHaveLength(1);
    expect(submitBtn(HEX_B).hasAttribute("aria-busy")).toBe(false);
  });

  it("builds a v4 key from getRandomValues where randomUUID is unavailable (plain-http LAN)", async () => {
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? replyOk("sent — waiting for the session") : undefined));
    await api().refresh();
    Object.defineProperty(window, "crypto", { value: { getRandomValues: (a: Uint8Array) => a.fill(7) }, configurable: true });
    typeIn(HEX_B, "x");
    submitBtn(HEX_B).click();
    await vi.waitFor(() => expect(calls()).toHaveLength(1));
    expect((calls()[0]!.body as { key: string }).key).toBe("07070707-0707-4707-8707-070707070707");
  });

  it("renders only well-formed option ids as buttons (an id outside 1-8 of letters, digits . _ - is dropped)", async () => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", needsYou: true, needsKind: "reply_question", asksYou: true, options: ["A1", "<img src=x onerror=1>", "toolongoptionid"] }));
    bootConsole(p);
    await api().refresh();
    expect(qa(`[data-card="${HEX_D}"] [data-option]`).map((b) => b.getAttribute("data-option"))).toEqual(["A1"]);
    expect(document.querySelectorAll("img").length).toBe(0);
  });
});

// F2 Task 12 (spec §6.4): the commit approval's second step — the session's screen (masked server-side) on the card.
describe("console client: the session's screen (Task 12)", () => {
  const panePath = (id: string): string => `/console/api/cards/${id}/pane`;
  const CAPTURED = "2026-10-17T18:03:05.000Z";
  const paneOk = (tail: string, truncated = false): FetchReply => ({ status: 200, body: { tail, capturedAt: CAPTURED, truncated } });
  /** Local wall-clock HH:MM:SS of an instant — what the page shows after "at". */
  const hms = (iso: string): string => {
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };
  const commitState = (): StatePayload => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", kind: "commit_approval", needsYou: true, needsKind: "sentinel", asksYou: true, options: ["A1", "A2"] }));
    return p;
  };
  const inCard = (id: string, sel: string): HTMLElement => q(`[data-card="${id}"] ${sel}`);
  const paneCalls = (id: string): Call[] => calls().filter((c) => c.path === panePath(id));
  /** The innerHTML setter, spied on whichever prototype in the chain owns it (jsdom defines it on Element). */
  const spyInnerHtml = (): ReturnType<typeof vi.spyOn> => {
    let owner: object | null = document.body;
    while (owner && !Object.getOwnPropertyDescriptor(owner, "innerHTML")) owner = Object.getPrototypeOf(owner) as object | null;
    expect(owner).not.toBeNull();
    return vi.spyOn(owner as { innerHTML: string }, "innerHTML", "set");
  };

  it("Task 12: every commit_approval card — and only those — gets a 'Show the session's screen' button; nothing is read until it is pressed", async () => {
    const p = commitState();
    p.cards.push(
      card({ id: HEX_E, machine: "mac-mini", projectKey: "lancache", kind: "menu", needsYou: true, needsKind: "menu_on_screen", options: ["1", "2"] }),
      card({ id: HEX_F, machine: "mac-mini", projectKey: "lancache", kind: "commit_approval", createdAt: "2026-10-17T17:20:00.000Z" }) // an earlier one
    );
    bootConsole(p);
    await api().refresh();
    const owners = qa("[data-pane-show]").map((b) => b.closest("[data-card]")?.getAttribute("data-card"));
    expect(owners.sort()).toEqual([HEX_D, HEX_F].sort());
    expect(inCard(HEX_D, "[data-pane-show]").textContent).toBe("Show the session's screen");
    expect(inCard(HEX_D, "[data-pane-show]").getAttribute("aria-expanded")).toBe("false");
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(true);
    expect(calls()).toEqual([]);
  });

  it("Task 12: Show reads the screen into a <pre> as text (markup stays text, no innerHTML, nothing in localStorage or sessionStorage); a poll keeps it; Refresh reads again; Hide closes and forgets; focus follows", async () => {
    const hostile = '❯ A1\n  Staged change:\n<script>window.__pwned=1</script><img src=x onerror="window.__pwned=1">\n  Reply with the option id again';
    let n = 0;
    let state = commitState();
    bootConsole(
      () => state,
      (c) => {
        if (c.path !== panePath(HEX_D)) return undefined;
        n++;
        return n === 1 ? paneOk(hostile) : paneOk("second screen", true);
      }
    );
    await api().refresh();
    const setter = spyInnerHtml();
    const lsSet = vi.spyOn(window.localStorage, "setItem");
    const ssSet = vi.spyOn(window.sessionStorage, "setItem");
    try {
      inCard(HEX_D, "[data-pane-show]").focus();
      inCard(HEX_D, "[data-pane-show]").click();
      await vi.waitFor(() => expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(false));
      expect(inCard(HEX_D, "[data-pane-view] pre[data-pane-text]").textContent).toBe(hostile);
      expect(setter).not.toHaveBeenCalled();
      expect(inCard(HEX_D, "[data-pane-status]").textContent).toBe(`✓ the session's screen at ${hms(CAPTURED)}`);
      expect(inCard(HEX_D, "[data-pane-status]").getAttribute("data-state")).toBe("ok");
      expect(inCard(HEX_D, "[data-pane-show]").hidden).toBe(true);
      expect(inCard(HEX_D, "[data-pane-show]").getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(inCard(HEX_D, "[data-pane-refresh]")); // the pressed button went away: focus moves into the view
      // A poll that re-renders the card keeps the view open with its text (it is not read again).
      state = commitState();
      state.cards[3] = { ...state.cards[3]!, title: "Commit approval — re-rendered" };
      await api().refresh();
      expect(inCard(HEX_D, "[data-title]").textContent).toBe("Commit approval — re-rendered");
      expect(inCard(HEX_D, "[data-pane-text]").textContent).toBe(hostile);
      expect(n).toBe(1);
      // Refresh reads again.
      inCard(HEX_D, "[data-pane-refresh]").click();
      await vi.waitFor(() => expect(inCard(HEX_D, "[data-pane-text]").textContent).toBe("second screen"));
      expect(inCard(HEX_D, "[data-pane-status]").textContent).toBe(`✓ the session's screen at ${hms(CAPTURED)} — cut to its last 60 lines / 8 KiB`);
      // Hide closes the view and forgets the text; focus goes back to Show.
      inCard(HEX_D, "[data-pane-hide]").focus();
      inCard(HEX_D, "[data-pane-hide]").click();
      expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(true);
      expect(inCard(HEX_D, "[data-pane-text]").textContent).toBe("");
      expect(inCard(HEX_D, "[data-pane-status]").textContent).toBe("");
      expect(inCard(HEX_D, "[data-pane-show]").hidden).toBe(false);
      expect(document.activeElement).toBe(inCard(HEX_D, "[data-pane-show]"));
      expect(setter).not.toHaveBeenCalled();
    } finally {
      setter.mockRestore();
    }
    expect(document.querySelectorAll("[data-cards] script, [data-cards] img").length).toBe(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(paneCalls(HEX_D).map((c) => c.method)).toEqual(["GET", "GET"]);
    // R1: the screen never reaches browser storage.
    const stored = JSON.stringify([lsSet.mock.calls, ssSet.mock.calls]);
    expect(stored).not.toContain("Staged change");
    expect(stored).not.toContain("second screen");
  });

  it("Task 12: after a sent on a commit approval the card opens the screen by itself and says the next step with the sent id; the box stays EMPTY (D5); the second send of that id says it went", async () => {
    const screen = "  Staged change:\n    README.md | 40 ++++\n  Reply with the option id again (for example: A1) to confirm.";
    bootConsole(commitState(), (c) => (c.path === submitPath(HEX_D) ? replyOk("sent — waiting for the session") : c.path === panePath(HEX_D) ? paneOk(screen) : undefined));
    await api().refresh();
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await vi.waitFor(() => expect(inCard(HEX_D, "[data-pane-text]").textContent).toBe(screen));
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(false);
    expect(sendStatus(HEX_D)).toBe("⚠ Check the staged change above, then type A1 again and press Submit to confirm");
    expect(inCard(HEX_D, "[data-send-status]").getAttribute("data-state")).toBe("warn");
    expect(box(HEX_D).value).toBe(""); // D5: the second confirmation is typed — never prefilled
    expect(brief()).toEqual([`POST ${submitPath(HEX_D)}`, `GET ${panePath(HEX_D)}`]);
    // "above": the view sits before the reply box in the card.
    const view = inCard(HEX_D, "[data-pane-view]");
    expect(view.compareDocumentPosition(box(HEX_D)) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The typed second id: the screen is read again and the status says the confirmation went — no third "type it again".
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await vi.waitFor(() => expect(sendStatus(HEX_D)).toBe(`✓ A1 sent again to confirm, ${hhmm("2026-10-17T18:03:00.000Z")} — the screen above shows what the session did`));
    await vi.waitFor(() => expect(paneCalls(HEX_D)).toHaveLength(2));
    expect(box(HEX_D).value).toBe("");
    // A sent on any other card opens nothing.
    expect(document.querySelectorAll(`[data-card="${HEX_B}"] [data-pane-view]`).length).toBe(0);
  });

  it("Task 12: every error status says its reason with a glyph, a word and a colour (CC1), and a failed read leaves the view closed", async () => {
    let next: FetchReply | "network" = paneOk("a screen");
    bootConsole(commitState(), (c) => {
      if (c.path !== panePath(HEX_D)) return undefined;
      if (next === "network") throw new Error("offline");
      return next;
    });
    await api().refresh();
    const cases: ReadonlyArray<readonly [reply: FetchReply | "network", text: string, state: string]> = [
      [{ status: 400, body: { error: "unexpected card id" } }, "⚠ this card has an unexpected id — nothing was read", "warn"],
      [{ status: 404, body: { error: "no such card" } }, "⚠ this card is gone — nothing to show", "warn"],
      [{ status: 409, body: { error: "not_commit_approval" } }, "⚠ only a commit approval shows the session's screen", "warn"],
      [{ status: 409, body: { error: "not_reachable" } }, "⚠ session not reachable — its screen cannot be read from here", "warn"],
      [{ status: 502, body: { error: "unreachable", message: "mac-mini unreachable — SSH connection failed" } }, "✕ Can't show the session's screen now — mac-mini unreachable — SSH connection failed", "error"],
      [{ status: 500, body: { error: "internal_error" } }, "✕ the harness answered HTTP 500", "error"],
      [{ status: 403, body: { error: "invalid_token" } }, "✕ signed out — reload to sign in", "error"],
      ["network", "✕ Can't show the session's screen now — the harness did not answer", "error"]
    ];
    for (const [reply, text, state] of cases) {
      // An open view first: a failed read closes it.
      next = paneOk("a screen");
      inCard(HEX_D, "[data-pane-show]").click();
      await vi.waitFor(() => expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(false));
      next = reply;
      inCard(HEX_D, "[data-pane-refresh]").click();
      await vi.waitFor(() => expect(inCard(HEX_D, "[data-pane-status]").textContent).toBe(text));
      expect(inCard(HEX_D, "[data-pane-status]").getAttribute("data-state"), text).toBe(state);
      expect(inCard(HEX_D, "[data-pane-view]").hidden, text).toBe(true);
      expect(inCard(HEX_D, "[data-pane-text]").textContent, text).toBe("");
      expect(inCard(HEX_D, "[data-pane-show]").hidden, text).toBe(false);
    }
  });

  // ---- fix round 1 ----
  /** Lets the page's promise chains (fetch → apply) finish under fake timers without moving the clock. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
  };
  const NEXT_STEP_A1 = "⚠ Check the staged change above, then type A1 again and press Submit to confirm";
  /** The next step while no screen is shown (a failed read, or Hide): it points to the Claude session (fix round 3 wording). */
  const fallback = (id: string): string =>
    `⚠ CDF asks for ${id} again to confirm — the session's screen is not shown here: open the Claude session to see the staged change, then type ${id} again and press Submit`;

  it("fix round 1 (I-1): a sent starts a FRESH read — one begun before the send is never the one shown — and reads once more about 2 s later; Hide, or the card leaving the page, cancels that second read", async () => {
    vi.useFakeTimers();
    let state = commitState();
    let reads = 0;
    let releaseEarly: ((r: FetchReply) => void) | undefined;
    boot(MODEL, (url) => {
      if (STATE_RE.test(url)) return { status: 200, body: state };
      if (url === submitPath(HEX_D)) return replyOk("sent — waiting for the session");
      if (url !== panePath(HEX_D)) return { status: 404, body: { error: "not_found" } };
      reads++;
      if (reads === 1) return new Promise<FetchReply>((resolve) => (releaseEarly = resolve));
      return paneOk(`screen read ${reads}`);
    });
    await api().refresh();
    const pre = (): string => inCard(HEX_D, "[data-pane-text]").textContent ?? "";
    // Karl pressed Show before sending; that read is still in flight when the send is answered.
    inCard(HEX_D, "[data-pane-show]").click();
    await settle();
    expect(reads).toBe(1);
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await settle();
    expect(reads).toBe(2); // a fresh read for the send, not the one in flight
    expect(pre()).toBe("screen read 2");
    expect(sendStatus(HEX_D)).toBe(NEXT_STEP_A1);
    expect(inCard(HEX_D, "[data-pane-hint]").textContent).toBe("If the staged change is not shown yet, press Refresh");
    releaseEarly!(paneOk("a screen from before the send"));
    await settle();
    expect(pre()).toBe("screen read 2"); // the early answer is dropped
    // About 2 s after the send: one more read, and only one.
    await vi.advanceTimersByTimeAsync(1990);
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    await settle();
    expect(reads).toBe(3);
    expect(pre()).toBe("screen read 3");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(3);
    // Hide cancels the second read of the next send.
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await settle();
    expect(reads).toBe(4);
    inCard(HEX_D, "[data-pane-hide]").click();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(4);
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(true);
    // A card the page no longer shows skips it.
    typeIn(HEX_D, "A2");
    submitBtn(HEX_D).click();
    await settle();
    expect(reads).toBe(5);
    state = fleet(); // the card leaves the payload: the next poll renders it away
    await api().refresh();
    expect(document.querySelector(`[data-card="${HEX_D}"]`)).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(5);
  });

  it("fix round 1 (M-1): a failed or empty capture after a sent shows its labelled failure — never a tick over an empty screen — and the next step does not point 'above' until a read shows the screen", async () => {
    vi.useFakeTimers();
    let next: FetchReply = { status: 502, body: { error: "unreachable", message: "mac-mini unreachable — SSH connection failed" } };
    boot(MODEL, (url) => {
      if (STATE_RE.test(url)) return { status: 200, body: commitState() };
      if (url === submitPath(HEX_D)) return replyOk("sent — waiting for the session");
      return url === panePath(HEX_D) ? next : { status: 404, body: { error: "not_found" } };
    });
    await api().refresh();
    const status = (): HTMLElement => inCard(HEX_D, "[data-pane-status]");
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await settle();
    expect(status().textContent).toBe("✕ Can't show the session's screen now — mac-mini unreachable — SSH connection failed");
    expect(status().getAttribute("data-state")).toBe("error");
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(true);
    expect(sendStatus(HEX_D)).toBe(fallback("A1"));
    expect(sendStatus(HEX_D)).not.toContain("above");
    // The send's second read shows the screen: the next step points above again.
    next = paneOk("  Staged change:\n    README.md | 40 ++++");
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(false);
    expect(sendStatus(HEX_D)).toBe(NEXT_STEP_A1);
    // An empty capture is a failed one: a labelled warning (no tick), the view closed, no "above".
    next = paneOk("\n   \n\n");
    typeIn(HEX_D, "A2");
    submitBtn(HEX_D).click();
    await settle();
    expect(status().textContent).toBe("⚠ the session's screen came back empty — the pane may have closed");
    expect(status().getAttribute("data-state")).toBe("warn");
    expect(status().textContent).not.toContain("✓");
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(true);
    expect(inCard(HEX_D, "[data-pane-text]").textContent).toBe("");
    expect(sendStatus(HEX_D)).toBe(fallback("A2"));
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(sendStatus(HEX_D)).toBe(fallback("A2"));
  });

  it("fix round 1 (M-4, ruling T12-2): the screen <pre> lays its characters out in logical order — unicode-bidi: bidi-override; direction: ltr — so a bidi control on screen cannot reorder a line", async () => {
    const line = "  README.md\u202e | 40 ++++";
    bootConsole(commitState(), (c) => (c.path === panePath(HEX_D) ? paneOk(line) : undefined));
    await api().refresh();
    inCard(HEX_D, "[data-pane-show]").click();
    await vi.waitFor(() => expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(false));
    const pre = inCard(HEX_D, "[data-pane-text]");
    expect(pre.tagName).toBe("PRE");
    expect(pre.classList.contains("pane-text")).toBe(true);
    expect(pre.textContent).toBe("  README.md⟦U+202E⟧ | 40 ++++"); // ruling T12-3: the control itself shows as a visible mark
    const rule = /\.pane-text \{([^}]*)\}/.exec(renderConsolePage(MODEL))?.[1] ?? "";
    expect(rule).toContain("unicode-bidi: bidi-override;");
    expect(rule).toContain("direction: ltr;");
  });

  // ---- fix round 2 ----
  /** Ruling T12-3: the bidi formatting characters the screen view shows as visible marks. */
  const BIDI_CODE_POINTS = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c];
  const mark = (cp: number): string => `⟦U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟧`;
  const hasBidi = (s: string): boolean => Array.from(s).some((ch) => BIDI_CODE_POINTS.includes(ch.codePointAt(0) ?? 0));

  it("fix round 2 (ruling T12-3): the screen shows every bidi formatting character as a visible mark — RLO, RLI and RLM become ⟦U+202E⟧, ⟦U+2067⟧, ⟦U+200F⟧ — while ordinary text and a [masked] token stay as they are", async () => {
    const [RLO, RLI, RLM] = [0x202e, 0x2067, 0x200f].map((cp) => String.fromCodePoint(cp));
    let next = paneOk(`  README.md${RLO} | 40 ++++\n  ${RLI}src/a.ts | 2 +-\n  token: [masked]${RLM}\n  1 file changed, 40 insertions(+)`);
    bootConsole(commitState(), (c) => (c.path === panePath(HEX_D) ? next : undefined));
    await api().refresh();
    inCard(HEX_D, "[data-pane-show]").click();
    await vi.waitFor(() => expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(false));
    const text = (): string => inCard(HEX_D, "[data-pane-text]").textContent ?? "";
    expect(text()).toBe("  README.md⟦U+202E⟧ | 40 ++++\n  ⟦U+2067⟧src/a.ts | 2 +-\n  token: [masked]⟦U+200F⟧\n  1 file changed, 40 insertions(+)");
    expect(hasBidi(text())).toBe(false);
    // Every character of the ruling's set (U+061C padded to four digits); everything else is left as it is.
    const plain = "plain text — ✓ ⚠ ✕ … [masked] ❯ ─ é 😀";
    next = paneOk(`${BIDI_CODE_POINTS.map((cp) => `x${String.fromCodePoint(cp)}`).join(" ")}\n${plain}`);
    inCard(HEX_D, "[data-pane-refresh]").click();
    await vi.waitFor(() => expect(text()).toContain("plain text"));
    expect(text()).toBe(`${BIDI_CODE_POINTS.map((cp) => `x${mark(cp)}`).join(" ")}\n${plain}`);
    expect(text()).toContain("⟦U+061C⟧");
    expect(hasBidi(text())).toBe(false);
  });

  // ---- fix round 3 ----
  // M-1: "Check the staged change above" only while a screen read for the send is shown in the card; "… reading" until
  // that read answers; the fallback to the Claude session after Hide or a failed read. B-1: every Submit owns its card's
  // status line and screen view from its start — nothing an earlier send started writes to either afterwards.
  const AT = hhmm("2026-10-17T18:03:00.000Z"); // replyOk's `at`
  const reading = (id: string): string => `… ${id} sent, ${AT} — reading the session's screen`;
  const CHECK = "Check the staged change above";
  const STAGED = "  Staged change:\n    README.md | 40 ++++";

  it("fix round 3 (M-1 a): until the send's own read answers, the send line is the neutral '… reading' state — never 'Check the staged change above', not even over a screen read before the send (fails if the next step is written before the read answers)", async () => {
    vi.useFakeTimers();
    let reads = 0;
    let release: ((r: FetchReply) => void) | undefined;
    boot(MODEL, (url) => {
      if (STATE_RE.test(url)) return { status: 200, body: commitState() };
      if (url === submitPath(HEX_D)) return replyOk("sent — waiting for the session");
      if (url !== panePath(HEX_D)) return { status: 404, body: { error: "not_found" } };
      reads++;
      if (reads === 1) return paneOk("a screen read before the send");
      return new Promise<FetchReply>((resolve) => (release = resolve)); // a send's read answers when the test says so
    });
    await api().refresh();
    inCard(HEX_D, "[data-pane-show]").click(); // Karl opened the screen before sending
    await settle();
    expect(inCard(HEX_D, "[data-pane-text]").textContent).toBe("a screen read before the send");
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await settle();
    expect(reads).toBe(2); // the send's read is out and has not answered
    expect(sendStatus(HEX_D)).toBe(reading("A1"));
    expect(sendStatus(HEX_D)).not.toContain(CHECK);
    expect(inCard(HEX_D, "[data-send-status]").getAttribute("data-state")).toBe("info");
    expect(inCard(HEX_D, "[data-pane-status]").textContent).toBe("… reading the session's screen");
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(true); // the screen from before the send is not this send's
    expect(inCard(HEX_D, "[data-pane-text]").textContent).toBe("");
    release!(paneOk(STAGED));
    await settle();
    expect(inCard(HEX_D, "[data-pane-text]").textContent).toBe(STAGED);
    expect(sendStatus(HEX_D)).toBe(NEXT_STEP_A1); // only now, with the screen shown
    // The typed repeat: "the screen above shows what the session did" waits for its own read as well.
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await settle();
    expect(reads).toBe(3);
    expect(sendStatus(HEX_D)).toBe(`✓ A1 sent again to confirm, ${AT} — reading the session's screen`);
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(true);
    release!(paneOk("  [main abc1234] docs: the staged change"));
    await settle();
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(false);
    expect(sendStatus(HEX_D)).toBe(`✓ A1 sent again to confirm, ${AT} — the screen above shows what the session did`);
  });

  it("fix round 3 (M-1 b): Hide takes 'Check the staged change above' off the card — the next step falls back to the Claude session, and Show reads again before it points above (fails if Hide leaves the send line as it was)", async () => {
    vi.useFakeTimers();
    boot(MODEL, (url) => {
      if (STATE_RE.test(url)) return { status: 200, body: commitState() };
      if (url === submitPath(HEX_D)) return replyOk("sent — waiting for the session");
      return url === panePath(HEX_D) ? paneOk(STAGED) : { status: 404, body: { error: "not_found" } };
    });
    await api().refresh();
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await settle();
    expect(sendStatus(HEX_D)).toBe(NEXT_STEP_A1);
    inCard(HEX_D, "[data-pane-hide]").click();
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(true);
    expect(sendStatus(HEX_D)).toBe(fallback("A1"));
    expect(sendStatus(HEX_D)).not.toContain(CHECK);
    expect(inCard(HEX_D, "[data-send-status]").getAttribute("data-state")).toBe("warn");
    await vi.advanceTimersByTimeAsync(5000); // the send's second read went with the view
    expect(sendStatus(HEX_D)).toBe(fallback("A1"));
    // Show reads again: "reading" until the screen is back, then the next step points above again.
    inCard(HEX_D, "[data-pane-show]").click();
    expect(sendStatus(HEX_D)).toBe(reading("A1"));
    await settle();
    expect(sendStatus(HEX_D)).toBe(NEXT_STEP_A1);
    // The typed repeat, then Hide: it says where to look instead of "the screen above".
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await settle();
    expect(sendStatus(HEX_D)).toBe(`✓ A1 sent again to confirm, ${AT} — the screen above shows what the session did`);
    inCard(HEX_D, "[data-pane-hide]").click();
    expect(sendStatus(HEX_D)).toBe(`✓ A1 sent again to confirm, ${AT} — the session's screen is not shown here; open the Claude session to see what it did`);
  });

  it("fix round 3 (M-1 c): a failed Refresh or Show closes the view and the next step falls back to the Claude session (fails if a manual read that fails leaves 'Check the staged change above')", async () => {
    vi.useFakeTimers();
    let next: FetchReply | "network" = paneOk(STAGED);
    boot(MODEL, (url) => {
      if (STATE_RE.test(url)) return { status: 200, body: commitState() };
      if (url === submitPath(HEX_D)) return replyOk("sent — waiting for the session");
      if (url !== panePath(HEX_D)) return { status: 404, body: { error: "not_found" } };
      if (next === "network") throw new Error("offline");
      return next;
    });
    await api().refresh();
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click();
    await settle();
    expect(sendStatus(HEX_D)).toBe(NEXT_STEP_A1);
    next = { status: 502, body: { error: "unreachable", message: "mac-mini unreachable — SSH connection failed" } };
    inCard(HEX_D, "[data-pane-refresh]").click();
    expect(sendStatus(HEX_D)).toBe(NEXT_STEP_A1); // the screen stays shown while Refresh reads
    await settle();
    expect(inCard(HEX_D, "[data-pane-status]").textContent).toBe("✕ Can't show the session's screen now — mac-mini unreachable — SSH connection failed");
    expect(inCard(HEX_D, "[data-pane-view]").hidden).toBe(true);
    expect(sendStatus(HEX_D)).toBe(fallback("A1"));
    expect(sendStatus(HEX_D)).not.toContain(CHECK);
    expect(inCard(HEX_D, "[data-send-status]").getAttribute("data-state")).toBe("warn");
    // A Show that gets no answer at all: "reading" while it is out, then the same fallback.
    next = "network";
    inCard(HEX_D, "[data-pane-show]").click();
    expect(sendStatus(HEX_D)).toBe(reading("A1"));
    await settle();
    expect(inCard(HEX_D, "[data-pane-status]").textContent).toBe("✕ Can't show the session's screen now — the harness did not answer");
    expect(sendStatus(HEX_D)).toBe(fallback("A1"));
  });

  it("fix round 3 (B-1 d): a later Submit owns its card's line — the first send's second read never overwrites a confirmation that was unresolved, unconfirmed, refused, failed or lost, and the view stays closed (fails if only a sent moves the send sequence)", async () => {
    vi.useFakeTimers();
    let answer: FetchReply | "network" = replyOk("sent — waiting for the session");
    let reads = 0;
    boot(MODEL, (url) => {
      if (STATE_RE.test(url)) return { status: 200, body: commitState() };
      if (url === submitPath(HEX_D)) {
        if (answer === "network") throw new Error("offline");
        return answer;
      }
      if (url !== panePath(HEX_D)) return { status: 404, body: { error: "not_found" } };
      reads++;
      return paneOk(STAGED);
    });
    await api().refresh();
    const cases: ReadonlyArray<readonly [reply: FetchReply | "network", line: string]> = [
      [{ status: 409, body: { error: "unresolved" } }, "⚠ could not tell whether the text went in — check the Claude session"],
      [replyOk("Could not confirm the send — check the Claude session before sending again", "unconfirmed"), "⚠ Could not confirm the send — check the Claude session before sending again"],
      [replyOk("refused — a menu is on screen; answer it in the Claude session", "refused_menu_visible"), "⚠ refused — a menu is on screen; answer it in the Claude session"],
      [{ status: 500, body: { error: "internal_error" } }, "✕ the harness answered HTTP 500 — nothing was confirmed; try again to retry"],
      ["network", "✕ can't reach the harness — nothing was confirmed; try again to retry"]
    ];
    for (const [i, [reply, line]] of cases.entries()) {
      const id = `A${i + 1}`; // a new id each round, so each first send is a first send
      answer = replyOk("sent — waiting for the session");
      typeIn(HEX_D, id);
      submitBtn(HEX_D).click();
      await settle();
      expect(sendStatus(HEX_D), id).toBe(`⚠ Check the staged change above, then type ${id} again and press Submit to confirm`);
      const before = reads;
      await vi.advanceTimersByTimeAsync(500);
      answer = reply;
      typeIn(HEX_D, id); // the confirmation, typed
      submitBtn(HEX_D).click();
      await settle();
      expect(sendStatus(HEX_D), id).toBe(line);
      await vi.advanceTimersByTimeAsync(2000); // past the first send's second read
      await settle();
      expect(sendStatus(HEX_D), id).toBe(line); // still the second send's outcome
      expect(reads, id).toBe(before); // the second Submit cancelled the first send's second read
      expect(inCard(HEX_D, "[data-pane-view]").hidden, id).toBe(true); // and the view did not re-open
      expect(box(HEX_D).value, id).toBe(id); // a send that did not go keeps its text
    }
  });

  it("fix round 3 (B-1 e): the send sequence and the second read are per card — a later sent on another commit-approval card does not let the first card's re-read write into it, nor silence that re-read on the first card (fails with a page-wide sequence or one shared re-read timer)", async () => {
    vi.useFakeTimers();
    const twoCards = (): StatePayload => {
      const p = commitState();
      p.cards.push(card({ id: HEX_F, machine: "linux-dev", projectKey: "homelab", kind: "commit_approval", needsYou: true, needsKind: "sentinel", asksYou: true, options: ["A1", "A2"] }));
      return p;
    };
    const reads = { d: 0, f: 0 };
    boot(MODEL, (url) => {
      if (STATE_RE.test(url)) return { status: 200, body: twoCards() };
      if (url === submitPath(HEX_D) || url === submitPath(HEX_F)) return replyOk("sent — waiting for the session");
      if (url === panePath(HEX_D)) return paneOk(`card D screen ${++reads.d}`);
      if (url === panePath(HEX_F)) return paneOk(`card F screen ${++reads.f}`);
      return { status: 404, body: { error: "not_found" } };
    });
    await api().refresh();
    const screens = (): string[] => [HEX_D, HEX_F].map((id) => inCard(id, "[data-pane-text]").textContent ?? "");
    const NEXT_STEP_A2 = "⚠ Check the staged change above, then type A2 again and press Submit to confirm";
    typeIn(HEX_D, "A1");
    submitBtn(HEX_D).click(); // t = 0: card D's send; its second read is due at 2.0 s
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    typeIn(HEX_F, "A2");
    submitBtn(HEX_F).click(); // t = 0.5 s: a later sent on the other card; its second read is due at 2.5 s
    await settle();
    expect(screens()).toEqual(["card D screen 1", "card F screen 1"]);
    expect([sendStatus(HEX_D), sendStatus(HEX_F)]).toEqual([NEXT_STEP_A1, NEXT_STEP_A2]);
    await vi.advanceTimersByTimeAsync(1500); // t = 2.0 s: card D's second read lands on card D only
    await settle();
    expect(reads).toEqual({ d: 2, f: 1 });
    expect(screens()).toEqual(["card D screen 2", "card F screen 1"]);
    expect([sendStatus(HEX_D), sendStatus(HEX_F)]).toEqual([NEXT_STEP_A1, NEXT_STEP_A2]);
    await vi.advanceTimersByTimeAsync(500); // t = 2.5 s: card F's second read, on card F only
    await settle();
    expect(reads).toEqual({ d: 2, f: 2 });
    expect(screens()).toEqual(["card D screen 2", "card F screen 2"]);
    expect([sendStatus(HEX_D), sendStatus(HEX_F)]).toEqual([NEXT_STEP_A1, NEXT_STEP_A2]);
  });
});

describe("console client: view switch", () => {
  it("shows Cards | Claude session for a selected project; Claude session attaches ?tmux=<name>, keeps polling underneath, and keeps the terminal alive across switches", async () => {
    bootConsole(fleet());
    await api().refresh();
    expect(q("[data-view-switch]").hidden).toBe(true); // nothing to attach to while 'All projects' is selected
    q('[data-machine-tab="mac-mini"]').click();
    q('[data-project-tab="solo"]').click();
    expect(q("[data-view-switch]").hidden).toBe(false);
    expect(q('[data-view="cards"]').getAttribute("aria-pressed")).toBe("true");
    q('[data-view="claude"]').click();
    expect(q('[data-view="claude"]').getAttribute("aria-pressed")).toBe("true");
    expect(q("[data-cards]").hidden).toBe(true);
    expect(FakeWS.all.map((w) => w.url.replace(/^wss?:\/\/[^/]+/, ""))).toEqual(["/terminal/mac-mini?tmux=solo"]);
    const panel = q('[data-claude-panel="mac-mini|solo"]');
    expect(panel.hidden).toBe(false);
    const before = fetchFn.mock.calls.length;
    await api().refresh(); // the cards poll keeps running underneath
    expect(fetchFn.mock.calls.length).toBe(before + 1);
    q('[data-view="cards"]').click();
    expect(q("[data-cards]").hidden).toBe(false);
    expect(panel.hidden).toBe(true);
    q('[data-view="claude"]').click();
    expect(q('[data-claude-panel="mac-mini|solo"]')).toBe(panel); // the same panel, not rebuilt
    expect(FakeWS.all).toHaveLength(1); // no second socket
  });

  it("remembers the broker's reconnect id in sessionStorage and offers it back as ?session= after a reload", async () => {
    bootConsole(fleet());
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    q('[data-project-tab="solo"]').click();
    q('[data-view="claude"]').click();
    FakeWS.all[0]!.emit({ t: "ready", id: "reconnect-1" });
    expect(window.sessionStorage.getItem("console.term.mac-mini.claude.solo")).toBe("reconnect-1");
    FakeWS.all.length = 0;
    bootConsole(fleet()); // a reload: same sessionStorage, fresh page
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    q('[data-project-tab="solo"]').click();
    q('[data-view="claude"]').click();
    expect(FakeWS.all.map((w) => w.url.replace(/^wss?:\/\/[^/]+/, ""))).toEqual(["/terminal/mac-mini?tmux=solo&session=reconnect-1"]);
  });

  it("offers no Claude session view for a project whose tmux session is a machine shell (sh-*)", async () => {
    const p = fleet();
    p.sessions.push(session({ machine: "mac-mini", tmuxSession: "sh-mac-mini", projectKey: "scratch@mac-mini", reachable: true, status: "idle", state: "idle" }));
    bootConsole(p);
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    q('[data-project-tab="scratch@mac-mini"]').click();
    expect(q<HTMLButtonElement>('[data-view="claude"]').disabled).toBe(true);
    q('[data-view="claude"]').click();
    expect(FakeWS.all).toHaveLength(0);
  });

  it("hides the view switch and the drawer under 900 px with a one-line note (desktop only)", () => {
    const html = renderConsolePage(MODEL);
    expect(html).toMatch(/@media \(max-width: 900px\)[^}]*\[data-view-switch\][^}]*display: none/);
    expect(html).toMatch(/@media \(max-width: 900px\)[^}]*\[data-drawer-wrap\][^}]*display: none/);
    expect(html).toMatch(/data-desktop-note[^>]*>[^<]*900 px/);
  });
});

describe("console client: shell drawer", () => {
  const openDrawer = (): HTMLElement => {
    q("[data-drawer-toggle]").click();
    return q("[data-drawer]:not([hidden])");
  };

  it("opens ONE shell per machine on ?shell=1 (never tmux or create), and Ctrl+` toggles [data-minimised]", async () => {
    bootConsole(fleet());
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    const drawer = openDrawer();
    expect(FakeWS.all.map((w) => w.url.replace(/^wss?:\/\/[^/]+/, ""))).toEqual(["/terminal/mac-mini?shell=1"]);
    expect(drawer.hasAttribute("data-minimised")).toBe(false);
    keydown(document, { key: "`", ctrlKey: true });
    expect(drawer.hasAttribute("data-minimised")).toBe(true);
    keydown(document, { key: "`", ctrlKey: true });
    expect(drawer.hasAttribute("data-minimised")).toBe(false);
    q("[data-drawer-toggle]").click(); // the bar button does the same
    expect(drawer.hasAttribute("data-minimised")).toBe(true);
    expect(FakeWS.all).toHaveLength(1);
  });

  it("the same drawer element survives project-tab switches on a machine; another machine gets its own", async () => {
    bootConsole(fleet());
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    const mac = openDrawer();
    q('[data-project-tab="solo"]').click();
    q('[data-project-tab="lancache"]').click();
    expect(q("[data-drawer]:not([hidden])")).toBe(mac);
    q('[data-machine-tab="linux-dev"]').click();
    expect(mac.hidden).toBe(true); // hidden, not destroyed
    const linux = openDrawer();
    expect(linux).not.toBe(mac);
    expect(linux.getAttribute("data-machine")).toBe("linux-dev");
    q('[data-machine-tab="mac-mini"]').click();
    expect(q("[data-drawer]:not([hidden])")).toBe(mac);
    expect(FakeWS.all).toHaveLength(2); // one socket per machine, kept
  });

  it("ArrowUp / ArrowDown on the focused grip move the height by 16 px and persist it; the default is 241", async () => {
    bootConsole(fleet());
    await api().refresh();
    const grip = q("[data-drawer-grip]");
    expect(grip.getAttribute("tabindex")).toBe("0");
    expect(grip.getAttribute("aria-valuenow")).toBe("241");
    grip.focus();
    keydown(grip, { key: "ArrowUp" });
    expect(grip.getAttribute("aria-valuenow")).toBe("257");
    expect(window.localStorage.getItem("console.drawer.height")).toBe("257");
    keydown(grip, { key: "ArrowDown" });
    keydown(grip, { key: "ArrowDown" });
    expect(window.localStorage.getItem("console.drawer.height")).toBe("225");
  });

  it("restores a remembered height", async () => {
    window.localStorage.setItem("console.drawer.height", "300");
    bootConsole(fleet());
    await api().refresh();
    expect(q("[data-drawer-grip]").getAttribute("aria-valuenow")).toBe("300");
  });

  it("shows the PTY title in the bar and a labelled first 'e' frame in the panel, without reconnecting", async () => {
    bootConsole(fleet());
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    openDrawer();
    expect(textOf("[data-drawer-title]")).toBe("Shell · mac-mini");
    FakeTerm.all[0]!.titleCb!("karl@mini: ~/Projects/<b>x</b>");
    expect(textOf("[data-drawer-title]")).toBe("Shell · mac-mini · karl@mini: ~/Projects/<b>x</b>");
    expect(document.querySelector("[data-drawer-title] b")).toBeNull();
    FakeWS.all[0]!.emit({ t: "e", m: "no projects root configured for mac-mini" });
    expect(textOf("[data-drawer-status]")).toBe("[!] no projects root configured for mac-mini");
    FakeWS.all[0]!.onclose?.();
    expect(textOf("[data-drawer-status]")).toBe("[!] no projects root configured for mac-mini"); // the error is not overwritten
    expect(FakeWS.all).toHaveLength(1); // no reconnect loop
  });

  it("Esc inside the drawer minimises it and is NOT forwarded to the shell; Ctrl+` inside the terminal is claimed too; the help text names the one swallowed key", async () => {
    bootConsole(fleet());
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    const drawer = openDrawer();
    const handler = FakeTerm.all[0]!.keyHandler!;
    const esc = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    expect(handler(esc)).toBe(false); // xterm is told to drop it: the shell never sees it
    expect(drawer.hasAttribute("data-minimised")).toBe(true);
    expect(handler(new window.KeyboardEvent("keydown", { key: "`", ctrlKey: true, bubbles: true }))).toBe(false);
    expect(drawer.hasAttribute("data-minimised")).toBe(false);
    expect(handler(new window.KeyboardEvent("keydown", { key: "a", bubbles: true }))).toBe(true); // everything else goes through
    expect(textOf("[data-drawer-help]")).toMatch(/Esc.*minimises.*not sent to the shell/s);
    expect(textOf("[data-drawer-help]")).toMatch(/only key/);
  });

  it("Esc outside the drawer does nothing to it", async () => {
    bootConsole(fleet());
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    const drawer = openDrawer();
    (document.body as HTMLElement).focus();
    keydown(document.body, { key: "Escape" });
    expect(drawer.hasAttribute("data-minimised")).toBe(false);
  });
});

describe("console client: new session", () => {
  const projects = {
    root: "/Users/karl/Projects",
    projects: [
      { name: "alpha", path: "/Users/karl/Projects/alpha", running: null },
      { name: "solo", path: "/Users/karl/Projects/solo", running: "solo" }
    ],
    dropped: 0
  };
  const PROJECTS_PATH = "/console/api/machines/mac-mini/projects";
  const SESSIONS_PATH = "/console/api/machines/mac-mini/sessions";
  const opened = async (extra: Extra): Promise<void> => {
    bootConsole(fleet(), firstOf(elevated, (c) => (c.path === PROJECTS_PATH ? { status: 200, body: projects } : undefined), extra));
    await api().refresh();
    q('[data-new-session="mac-mini"]').click();
    await vi.waitFor(() => expect(qa("[data-project-row]")).toHaveLength(2));
  };

  it("lists the folders; a running one says 'running — open it' and switches to its Claude session instead of creating", async () => {
    await opened(() => undefined);
    expect(textOf('[data-project-row="solo"]')).toContain("running — open it");
    expect(textOf('[data-project-row="alpha"]')).not.toContain("running");
    q('[data-project-row="solo"]').click();
    expect(document.querySelector("[data-session-dialog]")).toBeNull();
    expect(q('[data-project-tab="solo"]').getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-view="claude"]').getAttribute("aria-pressed")).toBe("true");
    expect(calls().some((c) => c.method === "POST")).toBe(false);
  });

  it("creating from a listed folder posts { folder }, inserts the project tab at once and opens its Claude session", async () => {
    await opened((c) =>
      c.path === SESSIONS_PATH ? { status: 200, body: { tmuxSession: "alpha", path: "/Users/karl/Projects/alpha", outcome: "created_session", message: "started" } } : undefined
    );
    q('[data-project-row="alpha"]').click();
    await vi.waitFor(() => expect(document.querySelector('[data-project-tab="alpha"]')).not.toBeNull());
    expect(calls().find((c) => c.path === SESSIONS_PATH)).toEqual({ method: "POST", path: SESSIONS_PATH, body: { folder: "/Users/karl/Projects/alpha" } });
    expect(q('[data-project-tab="alpha"]').getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-view="claude"]').getAttribute("aria-pressed")).toBe("true");
    expect(FakeWS.all.map((w) => w.url.replace(/^wss?:\/\/[^/]+/, ""))).toEqual(["/terminal/mac-mini?tmux=alpha"]);
    expect(document.querySelector("[data-session-dialog]")).toBeNull();
  });

  it("a failed creation shows the server's message in the dialog and inserts nothing", async () => {
    await opened((c) =>
      c.path === SESSIONS_PATH ? { status: 200, body: { tmuxSession: "alpha", path: "/x", outcome: "failed", message: "could not start tmux on mac-mini" } } : undefined
    );
    q('[data-project-row="alpha"]').click();
    await vi.waitFor(() => expect(textOf("[data-session-status]")).toContain("could not start tmux on mac-mini"));
    expect(document.querySelector('[data-project-tab="alpha"]')).toBeNull();
    expect(document.querySelector("[data-session-dialog]")).not.toBeNull();
  });

  it("ruling T11-18: an unconfirmed start says ⚠ with the server's words (never ✕) and inserts nothing", async () => {
    const words = "Could not confirm the start — check the machine's tmux sessions";
    await opened((c) => (c.path === SESSIONS_PATH ? { status: 200, body: { tmuxSession: "alpha", path: "/Users/karl/Projects/alpha", outcome: "unconfirmed", message: words } } : undefined));
    q('[data-project-row="alpha"]').click();
    await vi.waitFor(() => expect(textOf("[data-session-status]")).toBe(`⚠ ${words}`));
    expect(q("[data-session-status]").getAttribute("data-state")).toBe("warn");
    expect(document.querySelector('[data-project-tab="alpha"]')).toBeNull();
    expect(document.querySelector("[data-session-dialog]")).not.toBeNull();
  });

  it("never renders a project tab for an sh-* tmux name the server returns", async () => {
    await opened((c) =>
      c.path === SESSIONS_PATH ? { status: 200, body: { tmuxSession: "sh-mac-mini", path: "/x", outcome: "created_session", message: "started" } } : undefined
    );
    q('[data-project-row="alpha"]').click();
    await vi.waitFor(() => expect(textOf("[data-session-status]")).toMatch(/machine shell/));
    expect(document.querySelector('[data-project-tab="sh-mac-mini"]')).toBeNull();
    expect(FakeWS.all).toHaveLength(0);
  });

  it("New project posts { newProject }; an odd name gets a hint but the server decides, and refused_name has fixed words", async () => {
    await opened((c) => (c.path === SESSIONS_PATH ? { status: 400, body: { error: "refused_name" } } : undefined));
    const name = q<HTMLInputElement>("[data-new-project-name]");
    name.value = "../x";
    name.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(textOf("[data-new-project-hint]")).toMatch(/letters, digits/);
    q("[data-new-project]").click();
    await vi.waitFor(() => expect(textOf("[data-session-status]")).toContain("that name is not allowed"));
    expect(calls().find((c) => c.path === SESSIONS_PATH)!.body).toEqual({ newProject: "../x" });
  });

  it("a good name carries no hint; created_project inserts the tab and tells the operator to answer the trust prompt in the Claude session", async () => {
    await opened((c) =>
      c.path === SESSIONS_PATH ? { status: 200, body: { tmuxSession: "my-app", path: "/Users/karl/Projects/my-app", outcome: "created_project", message: "project created" } } : undefined
    );
    const name = q<HTMLInputElement>("[data-new-project-name]");
    name.value = "my-app";
    name.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(textOf("[data-new-project-hint]")).toBe("");
    q("[data-new-project]").click();
    await vi.waitFor(() => expect(document.querySelector('[data-project-tab="my-app"]')).not.toBeNull());
    expect(q('[data-project-tab="my-app"]').getAttribute("aria-pressed")).toBe("true");
    expect(textOf("[data-claude-note]")).toContain("asking you to trust the folder — answer it in the Claude session");
  });

  it("409 no_projects_root and 502 messages are said in the dialog", async () => {
    bootConsole(fleet(), firstOf(elevated, (c) => (c.path === PROJECTS_PATH ? { status: 409, body: { error: "no_projects_root" } } : undefined)));
    await api().refresh();
    q('[data-new-session="mac-mini"]').click();
    await vi.waitFor(() => expect(textOf("[data-session-status]")).toContain("no projects root configured for this machine"));
    expect(qa("[data-project-row]")).toHaveLength(0);
  });

  it("a 502 listing failure shows the server's message", async () => {
    bootConsole(fleet(), (c) => (c.path === PROJECTS_PATH ? { status: 502, body: { error: "unreachable", message: "mac-mini unreachable — connect timed out" } } : undefined));
    await api().refresh();
    q('[data-new-session="mac-mini"]').click();
    await vi.waitFor(() => expect(textOf("[data-session-status]")).toContain("mac-mini unreachable — connect timed out"));
  });

  it("with step-up unavailable (503) New project and the folder rows are disabled", async () => {
    let asked = 0; // the page-load check answers "closed"; the check made by the folder click finds step-up unavailable
    bootConsole(fleet(), (c) => {
      if (c.path === PROJECTS_PATH) return { status: 200, body: projects };
      if (c.path === STEP_UP) return ++asked === 1 ? { status: 200, body: { elevatedUntil: null } } : { status: 503, body: { error: "step_up_unavailable" } };
      return undefined;
    });
    await api().refresh();
    q('[data-new-session="mac-mini"]').click();
    await vi.waitFor(() => expect(qa("[data-project-row]")).toHaveLength(2));
    q('[data-project-row="alpha"]').click();
    await vi.waitFor(() => expect(textOf("[data-session-status]")).toContain("step-up unavailable — login is disabled"));
    expect(q<HTMLButtonElement>("[data-new-project]").disabled).toBe(true);
    expect(qa("[data-project-row]").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(calls().some((c) => c.path === SESSIONS_PATH)).toBe(false);
  });

  it("a second '+ New session' click while a dialog is open does not stack another dialog", async () => {
    await opened(() => undefined);
    q('[data-new-session="mac-mini"]').click();
    q('[data-new-session="mac-mini"]').click();
    expect(qa("[data-session-dialog]")).toHaveLength(1);
    expect(calls().filter((c) => c.path === PROJECTS_PATH)).toHaveLength(1);
  });
});

describe("console client: fix round 1", () => {
  it("page load: a reload with an open step-up window shows 'elevated until HH:MM' and Drop elevation before any send", async () => {
    bootConsole(fleet(), elevated);
    await vi.waitFor(() => expect(textOf("[data-elevation]")).toMatch(/^✓ elevated until \d\d:\d\d/));
    expect(q("[data-drop-elevation]").textContent).toBe("Drop elevation");
    expect(q("[data-elevation]").getAttribute("data-state")).toBe("ok");
    expect(calls()).toEqual([]); // nothing was sent: the header came from the page-load check alone
  });

  it("page load: a 503 shows 'step-up unavailable — login is disabled' and disables Submit and New session before any click", async () => {
    bootConsole(fleet(), (c) => (c.path === STEP_UP ? { status: 503, body: { error: "step_up_unavailable" } } : undefined));
    await api().refresh();
    await vi.waitFor(() => expect(textOf("[data-elevation]")).toContain("step-up unavailable — login is disabled"));
    expect(q("[data-elevation]").getAttribute("data-state")).toBe("error");
    typeIn(HEX_B, "typed after the notice");
    expect(submitBtn(HEX_B).disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-new-session="mac-mini"]').disabled).toBe(true);
  });

  it("page load: a not-elevated answer says 'not elevated' without a Drop control", async () => {
    bootConsole(fleet(), (c) => (c.path === STEP_UP ? { status: 200, body: { elevatedUntil: null } } : undefined));
    await vi.waitFor(() => expect(textOf("[data-elevation]")).toBe("○ not elevated"));
    expect(document.querySelector("[data-drop-elevation]")).toBeNull();
  });

  it("a poll that adds a card keeps the reply box's text, caret and selection (mid-text selection 6-11 of 17)", async () => {
    let serving = fleet();
    bootConsole(() => serving);
    await api().refresh();
    typeIn(HEX_B, "hello brave world");
    const before = box(HEX_B);
    before.focus();
    before.setSelectionRange(6, 11);
    serving = { ...fleet(), cards: [...fleet().cards, card({ id: HEX_D, machine: "mac-mini", projectKey: "solo", title: "newer" })] };
    await api().refresh();
    const after = box(HEX_B);
    expect(after).not.toBe(before); // it really was rebuilt
    expect(document.activeElement).toBe(after);
    expect(after.value).toBe("hello brave world");
    expect([after.selectionStart, after.selectionEnd]).toEqual([6, 11]);
  });

  it("every reachable reply card has an 'Open Claude session' control that switches that project to its Claude view (ruling T9-3)", async () => {
    bootConsole(fleet());
    await api().refresh();
    const open = q<HTMLButtonElement>(`[data-card="${HEX_B}"] [data-open-claude]`);
    expect(open.textContent).toBe("Open Claude session");
    open.click();
    expect(q('[data-project-tab="lancache"]').getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-view="claude"]').getAttribute("aria-pressed")).toBe("true");
    expect(FakeWS.all.map((w) => w.url.replace(/^wss?:\/\/[^/]+/, ""))).toEqual(["/terminal/mac-mini?tmux=lancache"]);
  });

  it("an unreachable card gets no Open Claude session control", async () => {
    const p = fleet();
    p.sessions.push(session({ machine: "mac-mini", tmuxSession: "", projectKey: "tmuxless", reachable: false }));
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "tmuxless" }));
    bootConsole(p);
    await api().refresh();
    expect(document.querySelector(`[data-card="${HEX_D}"] [data-open-claude]`)).toBeNull();
  });

  it("status lines carry data-state next to their glyph and words: sent ok, refused warn, failed error, queued info", async () => {
    let reply = replyOk("sent — waiting for the session");
    bootConsole(fleet(), (c) => (c.path === submitPath(HEX_B) ? reply : undefined));
    await api().refresh();
    const run = async (r: FetchReply, text: RegExp, state: string): Promise<void> => {
      reply = r;
      typeIn(HEX_B, "go");
      submitBtn(HEX_B).click();
      await vi.waitFor(() => expect(sendStatus(HEX_B)).toMatch(text));
      expect(q(`[data-card="${HEX_B}"] [data-send-status]`).getAttribute("data-state")).toBe(state);
    };
    await run(replyOk("sent — waiting for the session"), /^✓ sent/, "ok");
    await run(replyOk("refused — a menu is on screen", "refused_menu_visible"), /^⚠ refused/, "warn");
    await run(replyOk("send failed", "failed"), /^✕ send failed/, "error");
    await run(replyOk("queued — the session is busy"), /^… queued — the session is busy, \d\d:\d\d$/, "info");
  });

  it("Submit is off, with the reason in words, while the box holds more than 4096 bytes (4097 'a')", async () => {
    bootConsole(fleet());
    await api().refresh();
    typeIn(HEX_B, "a".repeat(4096));
    expect(submitBtn(HEX_B).disabled).toBe(false);
    typeIn(HEX_B, "a".repeat(4097));
    expect(submitBtn(HEX_B).disabled).toBe(true);
    expect(textOf(`[data-card="${HEX_B}"] [data-byte-count]`)).toBe("4097 / 4096 bytes — over the limit, Submit is off until it is shorter");
  });

  it("a commit_approval card that also asks a question still gets no option buttons (D5)", async () => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", kind: "commit_approval", needsYou: true, needsKind: "reply_question", asksYou: true, options: ["A1", "A2"] }));
    bootConsole(p);
    await api().refresh();
    expect(document.querySelectorAll(`[data-card="${HEX_D}"] [data-option], [data-card="${HEX_D}"] [data-dismiss]`).length).toBe(0);
  });

  it("a ready frame without a string id stores nothing; an error frame without a string message says 'connection error'", async () => {
    bootConsole(fleet());
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    q('[data-project-tab="solo"]').click();
    q('[data-view="claude"]').click();
    FakeWS.all[0]!.emit({ t: "ready" });
    FakeWS.all[0]!.emit({ t: "ready", id: 42 });
    expect(window.sessionStorage.getItem("console.term.mac-mini.claude.solo")).toBeNull();
    FakeWS.all[0]!.emit({ t: "e", m: { not: "a string" } });
    expect(textOf("[data-claude-status]")).toBe("[!] connection error");
  });

  it("a double click on Dismiss posts once", async () => {
    const p = fleet();
    p.cards.push(card({ id: HEX_D, machine: "mac-mini", projectKey: "lancache", needsYou: true, needsKind: "reply_question", asksYou: true, options: ["A1", "A2"] }));
    let release: (() => void) | undefined;
    bootConsole(p);
    await api().refresh();
    const base = fetchFn.getMockImplementation()!;
    fetchFn.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (!url.endsWith("/dismiss")) return base(url, init);
      await new Promise<void>((res) => { release = res; });
      return { ok: true, status: 200, json: async () => ({ dismissedAt: "2026-10-17T18:05:00.000Z" }) };
    });
    const btn = q(`[data-card="${HEX_D}"] [data-dismiss]`);
    btn.click();
    btn.click();
    release!();
    await vi.waitFor(() => expect(sendStatus(HEX_D)).toBe("✓ dismissed"));
    expect(calls().filter((c) => c.path.endsWith("/dismiss"))).toHaveLength(1);
  });

  it("under 900 px (matchMedia) the Claude session view and the drawer do nothing", async () => {
    bootConsole(fleet());
    await api().refresh();
    q('[data-machine-tab="mac-mini"]').click();
    q('[data-project-tab="solo"]').click();
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({ matches: query === "(max-width: 899px)" });
    try {
      q('[data-view="claude"]').click();
      expect(q('[data-view="claude"]').getAttribute("aria-pressed")).toBe("false");
      expect(q("[data-cards]").hidden).toBe(false);
      q("[data-drawer-toggle]").click();
      keydown(document, { key: "`", ctrlKey: true });
      expect(FakeWS.all).toHaveLength(0);
      expect(document.querySelector("[data-drawer]")).toBeNull();
    } finally {
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  });
});
