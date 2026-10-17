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

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { URL as NodeURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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
    needsYou: false, needsKind: null, dismissedAt: null, purgeAfter: "2027-01-15T00:00:00.000Z", version: 1, updatedAt: "2026-10-17T17:50:00.000Z",
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
function stubFetch(handler: (url: string) => FetchReply | Promise<FetchReply>): void {
  fetchFn = vi.fn(async (url: string) => {
    const r = await handler(url);
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

function boot(model: ConsolePageModel, handler: (url: string) => FetchReply | Promise<FetchReply>): void {
  document.documentElement.setAttribute("data-base", model.base);
  document.body.innerHTML = bodyOf(renderConsolePage(model)); // <script> set via innerHTML stays inert
  stubFetch(handler);
  window.eval(CONSOLE_CLIENT_JS); // the same code the page ships inline
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

afterEach(() => {
  const c = (window as unknown as { __console?: ConsoleApi }).__console;
  if (c) c.stop();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.title = "";
  document.documentElement.removeAttribute("data-base");
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
    stubFetch(async (url) => {
      if (mode === "down") throw new TypeError("network down");
      if (mode === "bad") return { status: 502, body: { error: "bad gateway" } };
      return serve(fleet())(url);
    });
    document.body.innerHTML = bodyOf(renderConsolePage(MODEL));
    window.eval(CONSOLE_CLIENT_JS);
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
