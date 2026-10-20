/**
 * Maestro Console page (plan Task 11; spec §6.1–6.5, §9; ADR-0010). A server-rendered shell plus a plain
 * browser client, built the way every harness page is: `pageHead(base)`, `<html data-base>`, build-versioned
 * assets, every URL through `withBase`. Task 10 serves it at `GET /console` together with the two JSON
 * routes the client reads:
 *
 *   GET BASE/console/api/state            → { machines, sessions, cards, settings | { disabled, entry } }
 *   GET BASE/console/api/cards/:id/expand → ExpandResult (200 ok/changed; 400/404/409/502 labelled states)
 *   GET BASE/console/api/cards/:id/pane   → { tail, capturedAt, truncated } — a commit approval's session screen,
 *                                           masked server-side (F2 Task 12; 400/404/409/502 labelled states)
 *
 * TRUST BOUNDARY. Everything the client renders — titles, TL;DRs, status values, reasons, machine problems,
 * the expand view — was written by Claude sessions on dev machines (`trusted:false`, masked server-side).
 * The client therefore builds the DOM with createElement + textContent ONLY: no innerHTML,
 * insertAdjacentHTML, document.write, eval or Function; `href` is built from BASE and fixed paths; a card id
 * is re-checked against /^[0-9a-f]{32}$/ before it is put in a URL; maps are prototype-less so a hostile
 * key cannot pollute them. Markdown in a reply is shown as the text it is (a sanitised renderer is F2+).
 *
 * STATES (CC1): every state is a glyph AND a word, colour is decoration on top — `! NEEDS YOU`,
 * `⟳ WORKING`, `✓ IDLE`, `$ IN SHELL`, `? UNKNOWN STATUS ‹value›`, `○ ENDED`, `✕ UNREACHABLE since HH:MM`,
 * `⚠ CAN'T READ — format changed (N lines)`, `… no data yet`. Tab rows are real buttons with aria-pressed,
 * arrow keys move focus along a row, and focus survives a poll (the focused control is found again by key).
 *
 * Rulings carried in (controller, Tasks 6–9): NEEDS YOU comes from the SESSION row (`state`, `stateReason`);
 * a card's `needsYou`/`needsKind` only pins it and names its kind, `card.kind` is history otherwise; a row
 * with `endedAt` is `○ ENDED` whatever its state; no `sh-*` special case (the poller re-keys a session in an
 * F2 machine shell to `<cwd basename>@<machine>`, unreachable, so it lands in the not-reachable group);
 * hidden projects are omitted; unconfigured keys read "new — not set up"; `reachable: false` keys sit under
 * "not reachable — start it in tmux"; health `pending` reads "no data yet"; `unreachable` keeps its cards;
 * a `disabled` settings payload renders the banner naming the entry and stops polling; a 401/403 says
 * "signed out — reload to sign in" and stops polling; the tab title carries the needs-you count.
 *
 * LOOK (Karl's Console Style Lab pick, relayed 2026-10-17; console-scoped, the harness theme is untouched):
 * "Deep navy" tokens, Lexend 18px / 1.45 SELF-HOSTED from `/assets/` (SIL OFL 1.1 — THIRD_PARTY_NOTICES.md;
 * no Google Fonts request), the harness mono stack for code and the tool trail, compact spacing, an 80ch
 * measure for long text, orange / grey / blue state edges (solid / dashed / solid) always with glyph + word,
 * project glyphs at 0.9× and the per-project border styles from the settings file.
 */

import { withBase } from "./base-path.js";
import { pageHead } from "./theme.js";
import { BUILD_ID, withBuild } from "./build-id.js";
import { TERMINAL_CLIPBOARD_JS, TERMINAL_ADDONS_JS, TERMINAL_OPEN_JS } from "./terminal-client.js";

export interface ConsolePageModel {
  /** Mount prefix for this request (`/harness` on the chat site, `""` on the admin site). */
  readonly base: string;
  /** When true, render the Log out control (POST /logout exists only when a passphrase is set). */
  readonly loginEnabled: boolean;
  /** Set when the console settings file was refused: the page shows the banner naming the entry and never polls. */
  readonly disabled?: { readonly entry: string };
}

export interface ConsoleFontAsset {
  /** Public URL path (added to the harness's public asset paths; served cacheable, build-versioned by `withBuild`). */
  readonly path: string;
  /** File name under `services/control-plane/assets/fonts/`. */
  readonly file: string;
  readonly weight: 400 | 600;
  /** SHA-256 of the vendored file; the asset route refuses to start on a mismatch. */
  readonly sha256: string;
}

/**
 * Lexend, vendored from github.com/googlefonts/lexend at commit 7894f02b2e7eabc48595f1d4eff3b17b48c6e651
 * (`fonts/lexend/webfonts/`, name-table version "Version 1.008"), SIL Open Font License 1.1. Two static
 * instances (regular + semibold, ~37 KB each) rather than the 240 KB two-axis variable TTF.
 */
export const CONSOLE_FONT_ASSETS: readonly ConsoleFontAsset[] = [
  { path: "/assets/lexend-regular.woff2", file: "Lexend-Regular.woff2", weight: 400, sha256: "dc9905cb55fde950de4e2c1c3240a9ece5ab7b3a7db8d8840322236705e0c017" },
  { path: "/assets/lexend-semibold.woff2", file: "Lexend-SemiBold.woff2", weight: 600, sha256: "90341b5a4388f312327333c82fae2a9a3951e75f8f7e71568f25779fb6211a43" }
];

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Console-scoped styles: the design tokens, the two tab rows, the left panel, the cards and their details. */
const CONSOLE_CSS = `:root {
  --console-bg: #152035; --console-surface: #1b2943; --console-surface2: #233350; --console-border: #435a80;
  --console-text: #e9f0f8; --console-text2: #bfcde0;
  --console-need: #ff9f40; --console-work: #a8a8a8; --console-idle: #5aa9ff;
  --console-edge: 6px; --console-pad: 7px; --console-gap: 7px; --console-glyph: 0.9em;
}
html, body { background: var(--console-bg); }
body { margin: 0; color: var(--console-text); font-family: "Lexend", var(--font-sans); font-size: 18px; line-height: 1.45; display: flex; flex-direction: column; min-height: 100vh; }
a { color: var(--console-text); }
a:hover { color: var(--console-text2); }
code, pre, kbd, .mono, .trail { font-family: var(--font-mono); }
button { background: var(--console-bg); color: var(--console-text); border: 1px solid var(--console-border); }
button:hover { background: var(--console-surface2); }
button:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid var(--console-text); outline-offset: 2px; }
header.console-header { background: var(--console-surface2); border-bottom: 1px solid var(--console-border); padding: .4rem .8rem; display: flex; flex-wrap: wrap; gap: .8rem; align-items: center; font-size: .9em; }
header .current { font-weight: 600; }
.build { margin-left: auto; font-size: .7rem; color: var(--console-text2); }
.logout + .build { margin-left: .6rem; }
.banners { display: flex; flex-direction: column; gap: var(--console-gap); }
.banners:not(:empty) { padding: var(--console-pad) var(--console-pad) 0; }
.banner { background: var(--console-surface); border: 1px solid var(--console-border); border-left: var(--console-edge) solid var(--console-need); color: var(--console-text); margin: 0; padding: var(--console-pad) 10px; font-weight: 600; }
.banner[data-health="pending"] { border-left-color: var(--console-work); border-left-style: dashed; font-weight: 400; }
.banner .said { font-weight: 400; color: var(--console-text2); }
details.problems { font-size: .85em; color: var(--console-text2); }
details.problems summary { cursor: pointer; }
details.problems ol { margin: 4px 0 0; padding-left: 1.4em; }
/* state → colour + line style; the glyph and the word carry the meaning, this only paints it */
[data-state="needs_you"] { --state-colour: var(--console-need); --state-style: solid; --state-text: var(--console-need); }
[data-state="working"] { --state-colour: var(--console-work); --state-style: dashed; --state-text: var(--console-work); }
[data-state="idle"] { --state-colour: var(--console-idle); --state-style: solid; --state-text: var(--console-idle); }
[data-state="shell"], [data-state="unknown"], [data-state="ended"], [data-state="none"] { --state-colour: var(--console-border); --state-style: solid; --state-text: var(--console-text2); }
nav.tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px var(--console-pad) 0; background: var(--console-surface2); border-bottom: 1px solid var(--console-border); align-items: stretch; }
nav.tabs.machines { background: var(--console-surface); }
.rowlabel, .group-label { align-self: center; color: var(--console-text2); font-size: .8em; padding: 0 6px 8px 0; }
.group { display: flex; flex-wrap: wrap; gap: 6px; align-items: stretch; border-left: 1px dashed var(--console-border); padding-left: 8px; }
.tab { padding: 6px 12px 8px; border: 1px solid var(--console-border); border-bottom: none; border-radius: 8px 8px 0 0; background: var(--console-bg); white-space: normal; overflow-wrap: anywhere; max-width: 100%; color: var(--console-text); text-align: left; cursor: pointer; font: inherit;
  border-top-width: var(--console-edge); border-top-color: var(--state-colour, var(--console-border)); border-top-style: var(--state-style, solid); }
.tab:hover { background: var(--console-surface); }
.tab[aria-pressed="true"] { outline: 2px solid var(--console-text); outline-offset: -2px; font-weight: 600; }
.tab .st { display: block; font-size: .72em; font-weight: 600; letter-spacing: .05em; margin-top: 2px; color: var(--state-text, var(--console-text2)); }
.tab .where, .tab .note { display: block; font-size: .72em; color: var(--console-text2); font-weight: 400; }
.tab[data-border="dashed"] { border-left-style: dashed; border-right-style: dashed; }
.tab[data-border="dotted"] { border-left-style: dotted; border-right-style: dotted; }
.tab[data-border="double"] { border-left-style: double; border-right-style: double; border-left-width: 3px; border-right-width: 3px; }
.tab[data-border="thick-left"] { border-left-width: 5px; }
.body { display: grid; grid-template-columns: minmax(0, 240px) minmax(0, 1fr); flex: 1; }
@media (max-width: 760px) { .body { grid-template-columns: minmax(0, 1fr); } .side { border-right: 0; border-bottom: 1px solid var(--console-border); } }
.side { padding: var(--console-pad); border-right: 1px solid var(--console-border); background: var(--console-surface); display: grid; gap: var(--console-gap); align-content: start; font-size: .85em; }
.side h2 { margin: 0; font-size: .8em; letter-spacing: .07em; text-transform: uppercase; color: var(--console-text2); font-weight: 600; }
.side p { margin: 0; }
.side ul { margin: 0; padding: 0; list-style: none; }
.side li { padding: 2px 0; color: var(--console-text2); }
.side li .glyph { color: var(--state-text, var(--console-text)); font-weight: 600; }
main.cards { padding: var(--console-pad); display: grid; gap: var(--console-gap); align-content: start; min-width: 0; }
.card { border: 1px solid var(--console-border); border-radius: 8px; padding: var(--console-pad); background: var(--console-surface); display: grid; gap: calc(var(--console-gap) * .7); min-width: 0;
  border-left-width: var(--console-edge); border-left-style: var(--state-style, solid); border-left-color: var(--state-colour, var(--console-border)); }
.card[data-border="dashed"] { border-top-style: dashed; border-right-style: dashed; border-bottom-style: dashed; }
.card[data-border="dotted"] { border-top-style: dotted; border-right-style: dotted; border-bottom-style: dotted; }
.card[data-border="double"] { border-top-style: double; border-right-style: double; border-bottom-style: double; border-top-width: 3px; border-right-width: 3px; border-bottom-width: 3px; }
.card[data-border="thick-left"] { border-left-width: calc(var(--console-edge) + 3px); }
.card .head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
.tag { font-weight: 600; padding: 0 7px; border: 1px solid var(--console-border); border-radius: 4px; font-size: .85em; }
.kind { font-size: .78em; font-weight: 600; letter-spacing: .05em; color: var(--state-text, var(--console-text2)); }
.chip, .meta, .where { font-size: .82em; color: var(--console-text2); }
.card h3 { margin: 0; font-size: 1em; font-weight: 600; overflow-wrap: anywhere; }
.reason, .hint { margin: 0; font-size: .85em; color: var(--console-text2); overflow-wrap: anywhere; }
/* a face may run to 1024 chars: clip it to six lines, the buttons below fetch the rest */
.tldr { white-space: pre-wrap; overflow-wrap: anywhere; max-width: 80ch; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 6; overflow: hidden; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.actions button { font: inherit; font-size: .9em; padding: 4px 10px; border-radius: 6px; border: 1px dashed var(--console-border); background: transparent; color: var(--console-text); cursor: pointer; }
.actions button[aria-expanded="true"] { border-style: solid; background: var(--console-bg); }
.actions a { font-size: .9em; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--console-border); text-decoration: none; }
.expand-status { margin: 0; font-size: .85em; color: var(--console-text2); overflow-wrap: anywhere; }
.expand-status:empty { display: none; }
.detail { background: transparent; border: 0; border-left: 2px solid var(--console-border); border-radius: 0; padding: 0 0 0 10px; margin: 0; max-width: 80ch; }
.detail h4 { margin: 0 0 4px; font-size: .78em; letter-spacing: .05em; text-transform: uppercase; color: var(--console-text2); font-weight: 600; }
.detail .prose { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: 1em; }
.trail { font-size: .85em; background: var(--console-bg); border: 1px solid var(--console-border); border-radius: 6px; padding: 8px 8px 8px 2em; margin: 0; color: var(--console-text2); overflow-x: auto; }
.trail li { white-space: pre-wrap; overflow-wrap: anywhere; padding: 2px 0; }
.trail .tool { color: var(--console-text); font-weight: 600; }
.empty { color: var(--console-text2); font-style: italic; margin: 0; }
/* F2 Task 12: a commit approval's session screen — terminal text, kept as laid out, scrolled sideways inside the card */
.pane, .pane > * { min-width: 0; }
.pane { display: grid; gap: calc(var(--console-gap) * .7); }
.pane .detail { max-width: none; }
/* ruling T12-2: characters in logical order, as the terminal shows them — a bidi control on screen cannot reorder a line */
.pane-text { margin: 0; font-size: .8em; line-height: 1.3; white-space: pre; overflow-x: auto; background: var(--console-bg); color: var(--console-text); border: 1px solid var(--console-border); border-radius: 6px; padding: 8px; unicode-bidi: bidi-override; direction: ltr; }
.pane-text:focus-visible { outline: 3px solid var(--console-text); outline-offset: 2px; }
.status-line { margin: 0; padding: 4px var(--console-pad); font-size: .8em; color: var(--console-text2); border-top: 1px solid var(--console-border); background: var(--console-surface2); display: flex; flex-wrap: wrap; gap: .8em; }
[data-poll-status][data-state="error"], [data-poll-status][data-state="signed_out"], [data-poll-status][data-state="disabled"] { color: var(--console-need); }
.glyph { font-size: var(--console-glyph); }
/* F2: the work area (view switch + cards or Claude session), fold, reply box, modals and the shell drawer */
.work { display: flex; flex-direction: column; min-width: 0; }
.work main.cards { flex: 1; }
.cards-head { display: flex; flex-wrap: wrap; gap: var(--console-gap); align-items: center; padding: var(--console-pad) var(--console-pad) 0; }
.cards-head button, .view-switch button, .tab-action, .fold-toggle, .reply button, .modal button, .elev button, .drawer-bar button { font: inherit; font-size: .85em; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--console-border); cursor: pointer; }
.view-switch { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.view-switch button[aria-pressed="true"] { outline: 2px solid var(--console-text); outline-offset: -2px; font-weight: 600; }
.view-switch button:disabled, .reply button:disabled, .tab-action:disabled, .modal button:disabled { opacity: .55; cursor: not-allowed; border-style: dashed; }
.tab-action { align-self: end; margin-bottom: 8px; background: transparent; }
.desktop-note { display: none; margin: 0; padding: var(--console-pad); font-size: .8em; color: var(--console-text2); }
.fold-toggle { background: transparent; justify-self: start; }
.reply { display: grid; gap: calc(var(--console-gap) * .7); border-top: 1px dashed var(--console-border); padding-top: var(--console-gap); }
.reply textarea { width: 100%; box-sizing: border-box; min-height: 4.2em; max-width: 80ch; font: inherit; font-size: .95em; color: var(--console-text); background: var(--console-bg); border: 1px solid var(--console-border); border-radius: 6px; padding: 6px 8px; resize: vertical; }
.reply textarea:disabled { opacity: .6; border-style: dashed; }
.reply textarea:focus-visible { outline: 3px solid var(--console-text); outline-offset: 2px; }
.reply-row, .options { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.byte-count { font-size: .8em; color: var(--console-text2); font-family: var(--font-mono); }
.send-status { margin: 0; font-size: .85em; color: var(--console-text2); overflow-wrap: anywhere; }
.send-status:empty { display: none; }
/* status lines: the leading glyph and the words carry the state; data-state only paints it (CC1) */
.send-status[data-state="ok"], .elev[data-state="ok"] { color: #6ad39a; }
.send-status[data-state="warn"] { color: var(--console-need); }
.send-status[data-state="error"], .elev[data-state="error"] { color: #ff8a8a; }
.send-status[data-state="info"], .elev[data-state="info"] { color: var(--console-text2); }
.elev { font-size: .85em; color: var(--console-text2); display: inline-flex; gap: 6px; align-items: center; }
.modal-overlay { position: fixed; inset: 0; background: rgba(8, 14, 26, .75); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { background: var(--console-surface); color: var(--console-text); border: 1px solid var(--console-border); border-radius: 8px; padding: 14px 16px; width: min(560px, 92vw); max-height: 85vh; overflow: auto; display: grid; gap: var(--console-gap); }
.modal h2 { margin: 0; font-size: 1.05em; }
.modal label { display: grid; gap: 4px; font-size: .9em; }
.modal input { font: inherit; color: var(--console-text); background: var(--console-bg); border: 1px solid var(--console-border); border-radius: 6px; padding: 6px 8px; }
.modal .modal-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.modal .project-list { display: grid; gap: 6px; }
.modal .project-row { text-align: left; background: transparent; }
.claude-panels { display: flex; flex-direction: column; flex: 1; min-height: 60vh; padding: var(--console-pad); }
.claude-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; gap: 6px; }
.term-status { margin: 0; font-family: var(--font-mono); font-size: .8em; color: var(--console-text2); }
.term-host { flex: 1; min-height: 50vh; }
.drawer-wrap { border-top: 1px solid var(--console-border); background: var(--console-surface2); }
.drawer-grip { height: 8px; cursor: ns-resize; background: var(--console-border); }
.drawer-grip:focus-visible { outline: 3px solid var(--console-text); outline-offset: -3px; }
.drawer-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 4px var(--console-pad); font-size: .85em; }
.drawer-bar .hint { margin-left: auto; }
.drawer-panels { overflow: hidden; }
.drawer { display: flex; flex-direction: column; height: 100%; padding: 0 var(--console-pad); }
.drawer .term-host { min-height: 0; }
@media (max-width: 900px) {
  [data-view-switch], [data-drawer-wrap] { display: none !important; }
  .desktop-note { display: block; }
}
[hidden] { display: none !important; }`;

/**
 * Browser client: polls the state, renders the two tab rows, the machine banners, the left-panel summary and
 * the cards, fetches a card's expand view once on demand. Plain ES5-style JS, no DOM types; the DOM is built
 * with createElement + textContent only. Exposes `window.__console = { refresh, select, expand, stop }`.
 */
export const CONSOLE_CLIENT_JS = `
(function () {
  'use strict';
  var doc = document;
  var win = window;
${TERMINAL_CLIPBOARD_JS}
${TERMINAL_ADDONS_JS}
${TERMINAL_OPEN_JS}
  // A client already running in this window (a re-boot) must stop dialling before this one starts.
  if (win.__console && typeof win.__console.stop === 'function') { try { win.__console.stop(); } catch (e) {} }
  var BASE = doc.documentElement.getAttribute('data-base') || '';
  var ID_RE = /^[0-9a-f]{32}$/;
  var DEFAULT_POLL_S = 5, MIN_POLL_S = 2, MAX_POLL_S = 60, FOCUS_THROTTLE_MS = 1000;
  var RANK = { needs_you: 6, unknown: 5, working: 4, shell: 3, idle: 2, ended: 1, none: 0 };
  var GLYPH = { needs_you: '!', unknown: '?', working: '⟳', shell: '$', idle: '✓', ended: '○', none: '–' };
  var WORD = { needs_you: 'NEEDS YOU', unknown: 'UNKNOWN STATUS', working: 'WORKING', shell: 'IN SHELL', idle: 'IDLE', ended: 'ENDED', none: 'NO SESSIONS' };
  var COUNT_ORDER = ['needs_you', 'unknown', 'working', 'shell', 'idle'];
  var HEALTH = {
    pending: { glyph: '…', word: 'no data yet', role: 'status' },
    unreachable: { glyph: '✕', word: 'UNREACHABLE', role: 'alert' },
    cant_read: { glyph: '⚠', word: "CAN'T READ", role: 'alert' },
    failed: { glyph: '⚠', word: 'PROBE FAILED', role: 'alert' },
    not_connectable: { glyph: '✕', word: 'NOT CONNECTABLE', role: 'alert' }
  };
  var BORDERS = { solid: 1, dashed: 1, double: 1, dotted: 1, 'thick-left': 1 };
  var SECTIONS = [{ id: 'full', label: 'full text' }, { id: 'why', label: 'why' }, { id: 'what', label: 'what it did' }];
  var SEP = '|'; // machine names cannot contain it (registry allow-list), so machine|key never collides
  var MAX_REPLY_BYTES = 4096;
  var OPTION_ID_RE = /^[A-Za-z0-9._-]{1,8}$/;
  var TMUX_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
  var PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/; // mirrors the server's rule for the HINT only; the server decides
  var DRAWER_DEFAULT_H = 241, DRAWER_MIN_H = 96, DRAWER_STEP = 16;
  var SUBMIT_400 = {
    empty: 'nothing to send',
    too_long: 'too long — ' + MAX_REPLY_BYTES + ' bytes max',
    control_char: 'the text contains characters that cannot be sent',
    escape: 'the text contains characters that cannot be sent',
    invalid_utf8: 'the text contains characters that cannot be sent',
    not_text: 'that is not text — nothing was sent',
    invalid_key: 'the request key was refused — press Submit again',
    'unexpected card id': 'this card has an unexpected id — nothing was sent'
  };
  var SUBMIT_409 = {
    not_reachable: 'session not reachable',
    menu_card: 'this is a menu — open the Claude session',
    unresolved: 'could not tell whether the text went in — check the Claude session'
  };

  function q(sel) { return doc.querySelector(sel); }
  var el = {
    machineTabs: q('[data-machine-tabs]'), projectTabs: q('[data-project-tabs]'), machineBanners: q('[data-machine-banners]'),
    banners: q('[data-banners]'), cards: q('[data-cards]'), summary: q('[data-selection-summary]'), status: q('[data-poll-status]'), heartbeat: q('[data-poll-heartbeat]')
  };

  // ---- DOM helpers: text only ----
  function mk(tag, cls, txt) { var e = doc.createElement(tag); if (cls) e.className = cls; if (txt !== undefined && txt !== null) e.textContent = String(txt); return e; }
  function tx(s) { return doc.createTextNode(String(s)); }
  function clear(node) { if (!node) return; while (node.firstChild) node.removeChild(node.firstChild); }
  function str(v, max) { if (typeof v !== 'string') return ''; return v.length > max ? v.slice(0, max) + '…' : v; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function has(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function map() { return Object.create(null); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(iso) {
    if (typeof iso !== 'string') return '(unknown time)'; // a null must not read as the epoch
    var d = new Date(iso); if (isNaN(d.getTime())) return '(unknown time)';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function hhmmss(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function age(iso, now) {
    var t = new Date(iso).getTime(); if (isNaN(t)) return 'unknown time';
    var s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60); if (h < 24) return h + ' h ' + (m % 60) + ' min ago';
    return Math.floor(h / 24) + ' d ago';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function glyphSpan(g) { var s = mk('span', 'glyph', g); s.setAttribute('aria-hidden', 'true'); return s; }
  // The status is a live region: write it only on a real transition, so a heartbeat is never announced.
  function setStatus(state, text) {
    if (!el.status) return;
    if (el.status.getAttribute('data-state') !== state) el.status.setAttribute('data-state', state);
    if (el.status.textContent !== text) el.status.textContent = text;
  }
  function beat() { if (el.heartbeat) el.heartbeat.textContent = 'updated ' + hhmmss(new Date()); }

  // ---- state ----
  var payload = null, lastKey = '', view = null;
  var sel = { machine: '*', project: null };
  var cardUi = map();
  var stepUp = { until: null, known: false, unavailable: false, note: '', timer: null, modal: null, sessionModal: null };
  var viewMode = map(); // machine|key → 'cards' | 'claude' (per project, this page load)
  var pending = map(); // machine|tmux → a project tab inserted before the poll has seen its session
  var claudeTerms = map(); // machine|tmux → { panel, status, note, handle }
  var drawers = map(); // machine → { machine, el, status, handle, minimised, title }
  var drawerH = DRAWER_DEFAULT_H, modals = [], modalSeq = 0;
  var timer = null, inflight = null, stopped = false, lastFetchAt = 0, pollMs = DEFAULT_POLL_S * 1000;

  // ---- view model ----
  function sessionView(s) {
    if (s.endedAt !== null && s.endedAt !== undefined) return { state: 'ended', glyph: '○', word: 'ENDED', reason: '' };
    var st = s.state;
    if (st === 'needs_you') return { state: st, glyph: '!', word: 'NEEDS YOU', reason: str(s.stateReason, 200) };
    if (st === 'working' || st === 'idle' || st === 'shell') return { state: st, glyph: GLYPH[st], word: WORD[st], reason: '' };
    // "unknown" shows the status value; an unexpected state string is itself the value. Never idle.
    var value = st === 'unknown' ? str(s.status, 40) : str(typeof st === 'string' ? st : '', 40);
    return { state: 'unknown', glyph: '?', word: 'UNKNOWN STATUS ' + (value === '' ? '(missing)' : value), reason: '' };
  }
  // Settings lookups take the settings object explicitly: buildView reads the INCOMING payload before it is
  // adopted (a render that throws must not leave half-adopted state behind); render-time code reads the current one.
  function projectSettingsIn(settings, key) {
    var ps = settings && typeof settings === 'object' ? settings.projects : null;
    return has(ps, key) && ps[key] && typeof ps[key] === 'object' ? ps[key] : null;
  }
  function isHiddenKey(settings, key) { var ps = projectSettingsIn(settings, key); return !!(ps && ps.hidden === true); }
  // A glyph is one or two visible characters: count code points, so a two-emoji glyph stays whole.
  function glyphOf(ps) { var g = ps && typeof ps.glyph === 'string' ? Array.from(ps.glyph).slice(0, 2).join('') : ''; return g || '·'; }

  function buildView(body) {
    var settings = body.settings;
    var machines = map(), machineOrder = [], projects = [], byId = map(), sessionsById = map(), excluded = map();
    function machineOf(name) {
      if (!has(machines, name)) { machines[name] = { name: name, health: null, projects: [], counts: {}, worst: 'none' }; machineOrder.push(name); }
      return machines[name];
    }
    (Array.isArray(body.machines) ? body.machines : []).forEach(function (h) { if (h && typeof h.machine === 'string') machineOf(h.machine).health = h; });
    // No sh-* special case (re-ruled): the poller re-keys a session in an sh-* tmux session to
    // <cwd basename>@<machine> with reachable:false, so it lands in the "not reachable" group like any other.
    (Array.isArray(body.sessions) ? body.sessions : []).forEach(function (s) {
      if (!s || typeof s.machine !== 'string' || typeof s.projectKey !== 'string' || typeof s.sessionId !== 'string') return;
      var sid = s.machine + SEP + s.sessionId;
      if (isHiddenKey(settings, s.projectKey)) { excluded[sid] = true; return; }
      var v = sessionView(s);
      var entry = { row: s, view: v };
      sessionsById[sid] = entry;
      var m = machineOf(s.machine);
      var pid = s.machine + SEP + s.projectKey;
      var p = has(byId, pid) ? byId[pid] : null;
      if (!p) {
        var ps = projectSettingsIn(settings, s.projectKey);
        p = { machine: s.machine, key: s.projectKey, display: (ps && str(ps.display, 40)) || str(s.projectKey, 60), glyph: glyphOf(ps),
          border: ps && has(BORDERS, ps.border) ? ps.border : 'solid', configured: !!ps, reachable: false, sessions: [], worst: 'none', worstView: null, live: 0, tmux: '' };
        byId[pid] = p; projects.push(p); m.projects.push(p);
      }
      p.sessions.push(entry);
      if (s.reachable !== false) { p.reachable = true; if (typeof s.tmuxSession === 'string' && s.tmuxSession) p.tmux = s.tmuxSession; }
      if (v.state !== 'ended') p.live++;
      if (RANK[v.state] > RANK[p.worst]) { p.worst = v.state; p.worstView = v; }
    });
    // A project tab inserted by New session stays until the poll shows a project with that tmux session (or key).
    Object.keys(pending).forEach(function (pk) {
      var pp = pending[pk];
      var m = machineOf(pp.machine);
      var seen = m.projects.some(function (x) { return x.tmux === pp.tmux || x.key === pp.key; });
      if (seen) { delete pending[pk]; return; }
      var pid = pp.machine + SEP + pp.key;
      byId[pid] = pp; projects.push(pp); m.projects.push(pp);
    });
    var all = { counts: {}, worst: 'none', needsYou: 0 };
    machineOrder.forEach(function (name) {
      var m = machines[name];
      m.projects.forEach(function (p) {
        m.counts[p.worst] = (m.counts[p.worst] | 0) + 1;
        all.counts[p.worst] = (all.counts[p.worst] | 0) + 1;
        if (RANK[p.worst] > RANK[m.worst]) m.worst = p.worst;
      });
      if (RANK[m.worst] > RANK[all.worst]) all.worst = m.worst;
    });
    all.needsYou = all.counts.needs_you | 0;
    return { machines: machines, machineOrder: machineOrder, projects: projects, byId: byId, sessionsById: sessionsById, excluded: excluded, all: all };
  }

  function countsText(counts) {
    var parts = [];
    COUNT_ORDER.forEach(function (k) {
      var n = counts[k] | 0; if (n === 0) return;
      parts.push(GLYPH[k] + ' ' + n + ' ' + (k === 'needs_you' ? (n === 1 ? 'NEEDS YOU' : 'NEED YOU') : WORD[k]));
    });
    if (parts.length) return parts.join(' · ');
    var e = counts.ended | 0;
    return e > 0 ? '○ ' + e + ' ENDED' : 'no sessions';
  }
  function healthText(h) {
    if (!h || h.state === 'ok') return '';
    var hv = has(HEALTH, h.state) ? HEALTH[h.state] : { glyph: '?', word: 'UNKNOWN HEALTH ' + str(String(h.state), 40) };
    var t = hv.glyph + ' ' + hv.word;
    if (h.state === 'unreachable') t += ' since ' + hhmm(h.since);
    if (h.state === 'cant_read') t += ' — format changed (' + num(h.ignoredLines) + ' lines)';
    return t;
  }
  function machineStatusText(m) {
    var parts = [];
    var h = m.health;
    var ht = healthText(h);
    if (ht) parts.push(ht);
    else if (h && num(h.ignoredLines) > 0) parts.push(num(h.ignoredLines) + ' lines ignored');
    if (!(h && h.state === 'pending' && m.projects.length === 0)) parts.push(countsText(m.counts));
    return parts.join(' · ');
  }
  function projectsInScope() { return view.projects.filter(function (p) { return sel.machine === '*' || p.machine === sel.machine; }); }
  function machinesInScope() { return view.machineOrder.filter(function (n) { return sel.machine === '*' || n === sel.machine; }); }
  function byWorstThenName(a, b) {
    var d = RANK[b.worst] - RANK[a.worst]; if (d) return d;
    var an = a.display.toLowerCase(), bn = b.display.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  function projectSelected(p) { return sel.project !== null && sel.project.key === p.key && (sel.project.machine === '*' || sel.project.machine === p.machine); }
  function cardsInScope() {
    var list = Array.isArray(payload.cards) ? payload.cards : [];
    return list.filter(function (c) {
      if (!c || typeof c.id !== 'string' || typeof c.machine !== 'string' || typeof c.projectKey !== 'string') return false;
      if (isHiddenKey(payload.settings, c.projectKey)) return false;
      if (typeof c.sessionId === 'string' && has(view.excluded, c.machine + SEP + c.sessionId)) return false;
      if (sel.machine !== '*' && c.machine !== sel.machine) return false;
      if (sel.project !== null && (c.projectKey !== sel.project.key || (sel.project.machine !== '*' && c.machine !== sel.project.machine))) return false;
      return true;
    }).sort(function (a, b) {
      var pin = (b.needsYou === true ? 1 : 0) - (a.needsYou === true ? 1 : 0); if (pin) return pin;
      var at = String(a.createdAt), bt = String(b.createdAt);
      return at < bt ? 1 : at > bt ? -1 : 0; // ISO timestamps: newest first
    });
  }

  // ---- tab rows ----
  function tabButton(kind, focusKey, key, nameText, glyph) {
    var b = mk('button', 'tab'); b.type = 'button';
    b.setAttribute(kind === 'machine' ? 'data-machine-tab' : 'data-project-tab', key);
    b.setAttribute('data-focus-key', focusKey);
    var name = mk('span', 'name');
    if (glyph !== undefined) { name.appendChild(glyphSpan(glyph)); name.appendChild(tx(' ' + nameText)); } else name.textContent = nameText;
    b.appendChild(name);
    return b;
  }
  function pressed(b, on) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  function renderMachineTabs() {
    var nav = el.machineTabs; clear(nav);
    var all = tabButton('machine', 'machine:*', '*', '◎ All machines');
    all.setAttribute('data-state', view.all.worst);
    all.appendChild(mk('span', 'st', countsText(view.all.counts)));
    pressed(all, sel.machine === '*');
    all.addEventListener('click', function () { select('*', null); });
    nav.appendChild(all);
    view.machineOrder.forEach(function (name) {
      var m = view.machines[name];
      var b = tabButton('machine', 'machine:' + name, name, str(name, 60));
      b.setAttribute('data-state', m.worst);
      b.setAttribute('data-health', m.health && typeof m.health.state === 'string' ? m.health.state : 'none');
      b.appendChild(mk('span', 'st', machineStatusText(m)));
      pressed(b, sel.machine === name);
      b.addEventListener('click', function () { select(name, null); });
      nav.appendChild(b);
      var ns = mk('button', 'tab-action', '+ New session'); ns.type = 'button';
      ns.setAttribute('data-new-session', name); ns.setAttribute('data-focus-key', 'newsession:' + name);
      ns.setAttribute('aria-label', 'New session on ' + str(name, 60));
      ns.disabled = stepUp.unavailable;
      ns.addEventListener('click', function () { openSessionDialog(name); });
      nav.appendChild(ns);
    });
  }
  function projectTab(p) {
    var b = tabButton('project', 'project:' + p.machine + SEP + p.key, p.key, p.display, p.glyph);
    b.setAttribute('data-machine', p.machine);
    b.setAttribute('data-state', p.worst);
    b.setAttribute('data-border', p.border);
    var v = p.worstView;
    b.appendChild(mk('span', 'st', v ? v.glyph + ' ' + v.word + (p.live > 1 ? ' · ' + p.live + ' sessions' : '') : (p.pending ? '… STARTING — not seen by the poll yet' : '– NO SESSIONS')));
    if (sel.machine === '*') b.appendChild(mk('span', 'where', 'on ' + p.machine));
    if (!p.configured) b.appendChild(mk('span', 'note', 'new — not set up'));
    pressed(b, projectSelected(p));
    b.addEventListener('click', function () { select(p.machine, p.key); });
    return b;
  }
  function renderProjectTabs() {
    var nav = el.projectTabs; clear(nav);
    var scopeName = sel.machine === '*' ? 'all machines' : sel.machine;
    var all = tabButton('project', 'project:*', '*', '◎ All projects');
    all.appendChild(mk('span', 'st', 'on ' + scopeName));
    pressed(all, sel.project === null);
    all.addEventListener('click', function () { select(sel.machine, null); });
    nav.appendChild(all);
    var ps = projectsInScope();
    var reachable = ps.filter(function (p) { return p.reachable; }).sort(byWorstThenName);
    var unreachable = ps.filter(function (p) { return !p.reachable; }).sort(byWorstThenName);
    reachable.forEach(function (p) { nav.appendChild(projectTab(p)); });
    if (unreachable.length) {
      var g = mk('div', 'group'); g.setAttribute('data-unreachable-group', '');
      g.appendChild(mk('span', 'group-label', 'not reachable — start it in tmux:'));
      unreachable.forEach(function (p) { g.appendChild(projectTab(p)); });
      nav.appendChild(g);
    }
    if (ps.length === 0) {
      var m = sel.machine !== '*' && has(view.machines, sel.machine) ? view.machines[sel.machine] : null;
      var pending = !!(m && m.health && m.health.state === 'pending');
      nav.appendChild(mk('span', 'rowlabel', pending ? '… no data yet from ' + sel.machine : 'no Claude sessions found on ' + scopeName));
    }
  }
  function wireRow(nav) {
    if (!nav) return;
    nav.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Home' && k !== 'End') return;
      var tabs = Array.prototype.filter.call(nav.querySelectorAll('button.tab'), function (b) { return !b.disabled; });
      if (!tabs.length) return;
      var i = tabs.indexOf(doc.activeElement); if (i < 0) return;
      var n = k === 'Home' ? 0 : k === 'End' ? tabs.length - 1 : (i + (k === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      e.preventDefault();
      tabs[n].focus();
    });
  }

  // ---- machine banners: ONE stable node per machine, rewritten only when its text changes (a live region
  // re-created or rewritten every poll would be announced every poll); the problems fold keeps its open
  // state per machine across renders, as cardUi does for cards ----
  var bannerUi = map(); // machine → { p, text, details, listText, open }
  function bannerUiFor(name) { if (!has(bannerUi, name)) bannerUi[name] = { p: null, text: null, details: null, listText: null, open: false }; return bannerUi[name]; }
  function bannerFor(name, h) {
    var ht = healthText(h);
    if (!ht) return null;
    var ui = bannerUiFor(name);
    var hv = has(HEALTH, h.state) ? HEALTH[h.state] : { role: 'alert' };
    var bits = [ht + ' — ' + name];
    if (h.state === 'unreachable') bits.push('showing its last known cards; retrying every poll' + (typeof h.lastOkAt === 'string' ? ' (last read ' + hhmm(h.lastOkAt) + ')' : ''));
    if (h.state === 'pending') bits.push('first poll not finished yet');
    if (typeof h.message === 'string' && h.message) bits.push(str(h.message, 300));
    var said = typeof h.remoteDetail === 'string' && h.remoteDetail ? 'machine said: "' + str(h.remoteDetail, 140) + '"' : '';
    var text = bits.join(' · ') + (said ? ' · ' + said : '');
    var p = ui.p;
    if (!p) { p = mk('p', 'banner'); p.setAttribute('data-machine-banner', name); ui.p = p; }
    if (p.getAttribute('data-health') !== String(h.state)) p.setAttribute('data-health', String(h.state));
    if (p.getAttribute('role') !== (hv.role || 'alert')) p.setAttribute('role', hv.role || 'alert');
    if (ui.text !== text) {
      clear(p);
      p.appendChild(tx(bits.join(' · ')));
      if (said) {
        // the machine's own stderr is trusted:false — label its provenance, cap it
        p.appendChild(tx(' · '));
        var sp = mk('span', 'said', said); sp.setAttribute('data-trusted', 'false'); p.appendChild(sp);
      }
      ui.text = text;
    }
    return p;
  }
  function problemsFor(name, h) {
    var problems = Array.isArray(h.problems) ? h.problems.filter(function (x) { return typeof x === 'string'; }).slice(-20) : [];
    if (!problems.length) return null;
    var ui = bannerUiFor(name);
    var d = ui.details;
    if (!d) {
      d = mk('details', 'problems'); d.setAttribute('data-machine-problems', name);
      d.appendChild(mk('summary', null, ''));
      d.appendChild(mk('ol'));
      d.addEventListener('toggle', function () { ui.open = !!d.open; }); // the browser folds; we only remember
      ui.details = d;
    }
    var listText = problems.join(SEP);
    if (ui.listText !== listText) {
      d.firstChild.textContent = plural(problems.length, 'problem', 'problems') + ' on ' + name + ' (newest last)';
      var ol = d.lastChild; clear(ol);
      problems.forEach(function (t) { ol.appendChild(mk('li', null, str(t, 300))); });
      ui.listText = listText;
    }
    if (d.open !== ui.open) d.open = ui.open;
    return d;
  }
  // Puts exactly the wanted nodes, in order, into the box: a node is moved only when its position differs, the rest are removed.
  function placeChildren(box, wanted) {
    for (var i = 0; i < wanted.length; i++) { if (box.childNodes[i] !== wanted[i]) box.insertBefore(wanted[i], box.childNodes[i] || null); }
    while (box.childNodes.length > wanted.length) box.removeChild(box.lastChild);
  }
  function renderMachineBanners() {
    var box = el.machineBanners; if (!box) return;
    var wanted = [];
    machinesInScope().forEach(function (name) {
      var m = view.machines[name]; var h = m.health;
      if (!h) return;
      var p = bannerFor(name, h); if (p) wanted.push(p);
      var d = problemsFor(name, h); if (d) wanted.push(d);
    });
    placeChildren(box, wanted);
  }

  // ---- cards ----
  function sessionFor(c) { var k = c.machine + SEP + c.sessionId; return has(view.sessionsById, k) ? view.sessionsById[k] : null; }
  function projectFor(c) { var k = c.machine + SEP + c.projectKey; return has(view.byId, k) ? view.byId[k] : null; }
  function projectOf(machine, key) { var k = machine + SEP + key; return view && has(view.byId, k) ? view.byId[k] : null; }
  function uiFor(id) {
    if (!has(cardUi, id)) cardUi[id] = { open: {}, view: null, status: '', fetching: null, text: '', key: null, keyText: null, busy: false, dismissing: false, sendStatus: '', fold: null, needsYou: false, pane: null, paneStatus: '', paneFetching: null, paneGen: 0, paneTimer: null, sendSeq: 0, confirmText: null, nextStep: null };
    return cardUi[id];
  }
  function findCard(id) {
    var list = el.cards ? el.cards.querySelectorAll('[data-card]') : [];
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute('data-card') === id) return list[i];
    return null;
  }
  function kindLabel(c) {
    if (c.needsYou === true) {
      if (c.needsKind === 'waiting') return '! WAITING FOR YOU';
      if (c.needsKind === 'menu_on_screen') return '! MENU ON SCREEN';
      if (c.needsKind === 'sentinel') return c.kind === 'commit_approval' ? '! COMMIT APPROVAL' : '! PENDING APPROVAL';
      return '! NEEDS YOU';
    }
    if (c.kind === 'commit_approval') return 'COMMIT APPROVAL · earlier';
    if (c.kind === 'menu') return 'MENU · earlier';
    return 'REPLY';
  }
  function metaText(c, now) {
    var meta = [age(c.createdAt, now)];
    if (num(c.toolCallCount) > 0) meta.push(plural(num(c.toolCallCount), 'tool call', 'tool calls'));
    if (num(c.thinkingChars) > 0) meta.push('with reasoning');
    // M-2 (ruling T11-20): the stored answer time, so it survives a reload and shows on every device.
    if (typeof c.answeredAt === 'string' && c.answeredAt) meta.push('answered ' + hhmm(c.answeredAt));
    if (typeof c.dismissedAt === 'string' && c.dismissedAt) meta.push('dismissed');
    return meta.join(' · ');
  }
  function renderCard(c, now) {
    var ui = uiFor(c.id);
    var ses = sessionFor(c); var sv = ses ? ses.view : null;
    var p = projectFor(c);
    var art = mk('article', 'card');
    art.setAttribute('data-card', c.id);
    art.setAttribute('data-state', c.needsYou === true ? 'needs_you' : (sv ? sv.state : 'none'));
    art.setAttribute('data-kind', typeof c.kind === 'string' ? str(c.kind, 20) : 'unknown');
    art.setAttribute('data-border', p ? p.border : 'solid');
    if (c.needsYou === true) art.setAttribute('data-needs-you', '');
    var head = mk('div', 'head');
    var tag = mk('span', 'tag'); tag.appendChild(glyphSpan(p ? p.glyph : '·')); tag.appendChild(tx(' ' + (p ? p.display : c.projectKey))); head.appendChild(tag);
    if (sel.machine === '*') head.appendChild(mk('span', 'where', 'on ' + c.machine));
    var kind = mk('span', 'kind', kindLabel(c)); kind.setAttribute('data-kind-label', ''); head.appendChild(kind);
    if (sv) { var chip = mk('span', 'chip', sv.glyph + ' ' + sv.word); chip.setAttribute('data-session-state', sv.state); head.appendChild(chip); }
    var metaEl = mk('span', 'meta', metaText(c, now)); metaEl.setAttribute('data-age', '');
    var when = new Date(c.createdAt); if (!isNaN(when.getTime())) metaEl.title = when.toLocaleString();
    head.appendChild(metaEl);
    art.appendChild(head);
    var title = mk('h3', 'title', str(c.title, 120) || '(untitled)'); title.setAttribute('data-title', ''); art.appendChild(title);
    if (sv && sv.reason) { var r = mk('p', 'reason', 'waiting for: ' + sv.reason); r.setAttribute('data-reason', ''); art.appendChild(r); }
    ui.needsYou = c.needsYou === true;
    var fold = mk('button', 'fold-toggle'); fold.type = 'button'; fold.setAttribute('data-fold-toggle', ''); fold.setAttribute('data-focus-key', 'fold:' + c.id);
    fold.addEventListener('click', function () { setFold(c.id, !foldOpen(c.id)); syncFoldAll(); });
    art.appendChild(fold);
    var tldr = mk('div', 'tldr', str(c.tldrMasked, 1024)); tldr.setAttribute('data-tldr', ''); art.appendChild(tldr);
    if (p && !p.reachable) art.appendChild(mk('p', 'hint', 'not reachable — this session has no tmux pane; start it in tmux to reach it from here.'));
    var actions = mk('div', 'actions');
    SECTIONS.forEach(function (s) {
      var b = mk('button'); b.type = 'button'; b.setAttribute('data-expand', s.id); b.setAttribute('data-focus-key', 'expand:' + c.id + ':' + s.id);
      b.addEventListener('click', function () { expand(c.id, s.id); });
      actions.appendChild(b);
    });
    var a = mk('a', 'open-terminal', 'Open terminal ↗');
    a.href = BASE + '/harness';
    a.setAttribute('data-open-terminal-link', c.machine);
    a.setAttribute('data-focus-key', 'open:' + c.id);
    a.title = 'Opens the Terminals tab — attach to ' + c.machine + ' · ' + ((p && p.tmux) || (ses && typeof ses.row.tmuxSession === 'string' && ses.row.tmuxSession) || c.projectKey) + ' there';
    actions.appendChild(a);
    art.appendChild(actions);
    var status = mk('p', 'expand-status'); status.setAttribute('data-expand-status', ''); status.setAttribute('role', 'status'); art.appendChild(status);
    SECTIONS.forEach(function (s) {
      var sec = mk('section', 'detail'); sec.setAttribute('data-section', s.id); sec.setAttribute('aria-label', s.label); art.appendChild(sec);
    });
    if (c.kind === 'commit_approval') renderPane(art, c); // F2 Task 12: above the reply box (the next step says "above")
    if (c.kind === 'menu') renderMenuActions(art, c, p); else renderReplyBox(art, c, ses);
    applyCardUi(art, ui);
    applyFold(art, c.id);
    return art;
  }
  function applyCardUi(art, ui) {
    SECTIONS.forEach(function (s) {
      var b = art.querySelector('[data-expand="' + s.id + '"]');
      var sec = art.querySelector('[data-section="' + s.id + '"]');
      var open = !!ui.open[s.id] && !!ui.view;
      var busy = !!ui.open[s.id] && !ui.view && !!ui.fetching; // the pressed section, while its fetch is in flight
      if (b) {
        b.textContent = (open ? '▾ ' : '▸ ') + s.label; b.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (busy) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
      }
      if (sec) {
        sec.hidden = !open;
        if (open && !sec.hasAttribute('data-filled')) { fillSection(sec, s.id, ui.view); sec.setAttribute('data-filled', ''); }
      }
    });
    var st = art.querySelector('[data-expand-status]'); if (st) st.textContent = ui.status;
  }
  function refreshCardUi(id) { var art = findCard(id); if (art) applyCardUi(art, uiFor(id)); }
  function fillSection(sec, id, v) {
    clear(sec);
    if (id === 'full') {
      sec.appendChild(mk('h4', null, 'Full text'));
      var t = typeof v.fullText === 'string' ? v.fullText : '';
      sec.appendChild(mk('pre', 'prose', t === '' ? '(no text in this turn)' : t));
      return;
    }
    if (id === 'why') {
      sec.appendChild(mk('h4', null, 'Why'));
      var w = typeof v.why === 'string' ? v.why : '';
      sec.appendChild(mk('pre', 'prose', w === '' ? '(no reasoning recorded for this turn)' : w));
      return;
    }
    sec.appendChild(mk('h4', null, 'What it did'));
    var calls = Array.isArray(v.whatItDid) ? v.whatItDid : [];
    var runs = num(v.agentRuns);
    if (calls.length === 0 && runs === 0) { sec.appendChild(mk('p', 'empty', '(no tool calls in this turn)')); return; }
    var ol = mk('ol', 'trail');
    calls.forEach(function (call) {
      if (!call || typeof call !== 'object') return;
      var li = mk('li');
      li.appendChild(mk('span', 'tool', str(call.tool, 60) || '(tool)'));
      var input = str(call.inputSummary, 2048), output = str(call.outputSummary, 2048);
      if (input) li.appendChild(tx(' ' + input));
      if (output) { li.appendChild(tx(' → ')); li.appendChild(mk('span', 'out', output)); }
      ol.appendChild(li);
    });
    if (runs > 0) ol.appendChild(mk('li', 'agents', plural(runs, 'agent run', 'agent runs') + ' (not expanded)'));
    sec.appendChild(ol);
  }

  // ---- expand: one fetch per card, shared by the three sections; a failure is said and not cached ----
  function closeAll(ui) { SECTIONS.forEach(function (s) { ui.open[s.id] = false; }); }
  function expand(id, section) {
    if (typeof id !== 'string' || !findCard(id)) return Promise.resolve();
    var known = false; SECTIONS.forEach(function (s) { if (s.id === section) known = true; });
    if (!known) return Promise.resolve();
    var ui = uiFor(id);
    if (ui.open[section]) { ui.open[section] = false; refreshCardUi(id); return Promise.resolve(); }
    ui.open[section] = true;
    if (ui.view) { refreshCardUi(id); return Promise.resolve(); }
    return loadExpand(id);
  }
  function loadExpand(id) {
    var ui = uiFor(id);
    if (ui.fetching) return ui.fetching;
    if (!ID_RE.test(id)) { ui.status = '⚠ this card has an unexpected id — nothing was fetched'; closeAll(ui); refreshCardUi(id); return Promise.resolve(); }
    ui.status = '… loading from the machine';
    var p = request(BASE + '/console/api/cards/' + encodeURIComponent(id) + '/expand').then(function (r) {
      if (r.signedOut) { ui.status = '✕ signed out — reload to sign in'; closeAll(ui); return; }
      var b = r.body;
      if (b && b.state === 'ok' && b.view && typeof b.view === 'object') { ui.view = b.view; ui.status = ''; return; }
      var msg = b && typeof b.message === 'string' && b.message ? str(b.message, 300) : 'the harness answered HTTP ' + r.status;
      var st = b && typeof b.state === 'string' ? b.state : 'failed';
      ui.status = st === 'unreachable' ? "✕ Can't load the full text now — " + msg : (st === 'changed' ? '⚠ changed — ' + msg : '⚠ failed — ' + msg);
      closeAll(ui);
    }).catch(function () {
      ui.status = "✕ Can't load the full text now — the harness did not answer"; closeAll(ui);
    }).then(function () { ui.fetching = null; refreshCardUi(id); });
    ui.fetching = p;
    refreshCardUi(id); // shows "loading" and aria-busy on the pressed button
    return p;
  }

  // ---- the commit approval's second step (F2 Task 12, spec §6.4): the session's screen, read on demand ----
  // CDF answers the first id by showing the question, the staged change and the hooks in the session, then asks for the
  // id again. The server masks and caps the screen; it is shown as text in a <pre> and held only while the view is open
  // (never in localStorage / sessionStorage — R1). A failed or empty read closes the view and says why (CC1: glyph +
  // words). CDF's render appears only once every UserPromptSubmit hook on the machine has finished, so a send reads the
  // screen afresh and once more PANE_REREAD_MS later (fix round 1, I-1).
  var PANE_409 = { not_commit_approval: "only a commit approval shows the session's screen", not_reachable: 'session not reachable — its screen cannot be read from here' };
  var PANE_REREAD_MS = 2000;
  // Ruling T12-3: every bidi formatting character on the screen shows as a visible mark (⟦U+202E⟧), so none can reorder
  // a line whatever the style does (an RLO inside bidi-override still opens an override of its own). Display only: the
  // server's masked text is unchanged. The class is written with escapes, never the characters themselves.
  var BIDI_RE = /[\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u061C]/g;
  function bidiMarks(s) {
    return s.replace(BIDI_RE, function (ch) { return '⟦U+' + ('000' + ch.charCodeAt(0).toString(16).toUpperCase()).slice(-4) + '⟧'; });
  }
  function renderPane(art, c) {
    var wrap = mk('div', 'pane'); wrap.setAttribute('data-pane', '');
    var row = mk('div', 'actions');
    var show = mk('button', null, "Show the session's screen"); show.type = 'button';
    show.setAttribute('data-pane-show', ''); show.setAttribute('data-focus-key', 'pane-show:' + c.id); show.setAttribute('aria-controls', 'pane-' + c.id);
    show.addEventListener('click', function () { showPane(c.id); });
    row.appendChild(show); wrap.appendChild(row);
    wrap.appendChild(statusLine('data-pane-status', 'status').node);
    var sec = mk('section', 'detail'); sec.id = 'pane-' + c.id; sec.setAttribute('data-pane-view', ''); sec.setAttribute('aria-label', "The session's screen");
    sec.appendChild(mk('h4', null, "The session's screen (masked)"));
    var pre = mk('pre', 'pane-text'); pre.setAttribute('data-pane-text', ''); pre.setAttribute('tabindex', '0'); sec.appendChild(pre);
    var hint = mk('p', 'hint', 'If the staged change is not shown yet, press Refresh'); hint.setAttribute('data-pane-hint', ''); sec.appendChild(hint);
    var acts = mk('div', 'actions');
    var rb = mk('button', null, 'Refresh'); rb.type = 'button'; rb.setAttribute('data-pane-refresh', ''); rb.setAttribute('data-focus-key', 'pane-refresh:' + c.id);
    rb.addEventListener('click', function () { showPane(c.id); });
    var hb = mk('button', null, 'Hide'); hb.type = 'button'; hb.setAttribute('data-pane-hide', ''); hb.setAttribute('data-focus-key', 'pane-hide:' + c.id);
    hb.addEventListener('click', function () { hidePane(c.id); });
    acts.appendChild(rb); acts.appendChild(hb); sec.appendChild(acts);
    wrap.appendChild(sec);
    art.appendChild(wrap);
    applyPane(wrap, uiFor(c.id));
  }
  function applyPane(box, ui) {
    var open = !!ui.pane;
    var show = box.querySelector('[data-pane-show]'), refreshBtn = box.querySelector('[data-pane-refresh]');
    var sec = box.querySelector('[data-pane-view]'), pre = box.querySelector('[data-pane-text]'), st = box.querySelector('[data-pane-status]');
    show.hidden = open; show.setAttribute('aria-expanded', open ? 'true' : 'false');
    [show, refreshBtn].forEach(function (b) { if (ui.paneFetching) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy'); });
    sec.hidden = !open;
    var t = open ? ui.pane.tail : '';
    if (pre.textContent !== t) pre.textContent = t;
    if (st.textContent !== ui.paneStatus) st.textContent = ui.paneStatus;
    st.setAttribute('data-state', stateOf(ui.paneStatus));
  }
  // Applies the card's pane state and re-words the send's next step to match it (M-1, nextStepText); when the pressed
  // button goes away (Show as the view opens, Refresh / Hide as it closes) the keyboard's place moves to the one that
  // replaced it.
  function refreshPane(id) {
    var ui = uiFor(id), next = nextStepText(ui);
    if (next !== null) setSend(id, next);
    var art = findCard(id), box = art ? art.querySelector('[data-pane]') : null;
    if (!box) return;
    var a = doc.activeElement, inside = !!(a && box.contains(a));
    applyPane(box, ui);
    if (!inside || !a.closest('[hidden]')) return;
    var to = box.querySelector(ui.pane ? '[data-pane-refresh]' : '[data-pane-show]');
    if (to) { try { to.focus({ preventScroll: true }); } catch (e) { to.focus(); } }
  }
  function clock(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? '(unknown time)' : hhmmss(d); }
  function paneFailure(r) {
    var st = r.status, b = r.body && typeof r.body === 'object' ? r.body : null;
    if (r.signedOut) return '✕ signed out — reload to sign in';
    if (st === 400) return '⚠ this card has an unexpected id — nothing was read';
    if (st === 404) return '⚠ this card is gone — nothing to show';
    if (st === 409) return '⚠ ' + (b && has(PANE_409, b.error) ? PANE_409[b.error] : 'refused — ' + str(String(b ? b.error : ''), 40));
    if (st === 502) return "✕ Can't show the session's screen now — " + (b && typeof b.message === 'string' && b.message ? str(b.message, 300) : 'the machine did not answer');
    return '✕ the harness answered HTTP ' + st;
  }
  // M-1: a commit approval's next step follows the view. It points "above" only while a screen read for this send is
  // shown, says "reading" while that read is out, and otherwise points to the Claude session (the view hidden, or the
  // read failed). ui.nextStep is set when the send is answered sent, and cleared when the card's next Submit starts (B-1).
  function nextStepText(ui) {
    var n = ui.nextStep;
    if (!n) return null;
    var view = ui.pane ? 'shown' : ui.paneFetching ? 'reading' : 'closed';
    if (n.repeat) return '✓ ' + n.text + ' sent again to confirm, ' + n.at + (view === 'shown' ? ' — the screen above shows what the session did' : view === 'reading' ? " — reading the session's screen" : " — the session's screen is not shown here; open the Claude session to see what it did");
    if (view === 'shown') return '⚠ Check the staged change above, then type ' + n.text + ' again and press Submit to confirm';
    if (view === 'reading') return '… ' + n.text + ' sent, ' + n.at + " — reading the session's screen";
    return '⚠ CDF asks for ' + n.text + " again to confirm — the session's screen is not shown here: open the Claude session to see the staged change, then type " + n.text + ' again and press Submit';
  }
  // Show and Refresh read the screen again; one read at a time per card, except that a send's read is FRESH: a read
  // already in flight began before it, so its answer is dropped (I-1). A read belongs to the view and to the send it
  // began under (B-1): once a fresh read replaces it, Hide closes the view or the card's next Submit starts, its answer
  // writes nothing — neither the screen view nor a status line.
  function showPane(id, fresh) {
    var ui = uiFor(id);
    if (ui.paneFetching && !fresh) return ui.paneFetching;
    if (!ID_RE.test(id)) { ui.pane = null; ui.paneStatus = '⚠ this card has an unexpected id — nothing was read'; refreshPane(id); return Promise.resolve(); }
    if (ui.paneFetching) ui.paneGen++;
    var gen = ui.paneGen, seq = ui.sendSeq;
    var current = function () { return gen === ui.paneGen && seq === ui.sendSeq; };
    ui.paneStatus = "… reading the session's screen";
    var p = request(BASE + '/console/api/cards/' + encodeURIComponent(id) + '/pane').then(function (r) {
      if (!current()) return;
      var b = r.body;
      var answered = !r.signedOut && r.status === 200 && b && typeof b === 'object' && typeof b.tail === 'string' && typeof b.capturedAt === 'string' && typeof b.truncated === 'boolean';
      // M-1: an empty capture is a failed one — never a tick over an empty screen.
      if (answered && b.tail.trim() !== '') {
        ui.pane = { tail: bidiMarks(str(b.tail, 8192)) }; // the clip first, so it never splits a mark
        ui.paneStatus = "✓ the session's screen at " + clock(b.capturedAt) + (b.truncated ? ' — cut to its last 60 lines / 8 KiB' : '');
        return;
      }
      ui.pane = null;
      ui.paneStatus = answered ? "⚠ the session's screen came back empty — the pane may have closed" : paneFailure(r);
    }).catch(function () {
      if (!current()) return;
      ui.pane = null;
      ui.paneStatus = "✕ Can't show the session's screen now — the harness did not answer";
    }).then(function () {
      if (!current()) return; // dropped: whatever made it stale owns the view and the status lines now
      if (ui.paneFetching === p) ui.paneFetching = null;
      refreshPane(id); // the screen (or why not), and the next step that goes with it
    });
    ui.paneFetching = p;
    refreshPane(id); // "reading" and aria-busy while the machine answers
    return p;
  }
  function clearPaneTimer(ui) { if (ui.paneTimer !== null) { clearTimeout(ui.paneTimer); ui.paneTimer = null; } }
  // Hide closes the view, forgets the text, drops an answer still in flight and cancels a send's second read. Every send
  // starts with it too (newSend, paneAfterSend), so nothing read for an earlier send stays on the card.
  function hidePane(id) {
    var ui = uiFor(id);
    clearPaneTimer(ui);
    ui.paneGen++; ui.paneFetching = null; ui.pane = null; ui.paneStatus = '';
    refreshPane(id);
  }
  // A send's reads (I-1): the view starts empty (a screen or a read from before the send is not this send's — M-1), then
  // a fresh read now and one more PANE_REREAD_MS later — skipped when the card is no longer on the page, cancelled by
  // Hide or by the card's next Submit (B-1). next is this send's next step; nextStepText words it from the view.
  function paneAfterSend(id, next) {
    var ui = uiFor(id), seq = ui.sendSeq;
    hidePane(id);
    ui.nextStep = next;
    showPane(id, true);
    ui.paneTimer = setTimeout(function () {
      ui.paneTimer = null;
      if (seq === ui.sendSeq && findCard(id)) showPane(id, true);
    }, PANE_REREAD_MS);
  }

  // ---- per-viewer storage: every access guarded (a private window or blocked site data throws) ----
  function lsGet(k) { try { return win.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { win.localStorage.setItem(k, v); } catch (e) {} }
  function ssGet(k) { try { return win.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { win.sessionStorage.setItem(k, v); } catch (e) {} }

  // ---- fold (trial finding 4): needs-you cards open, the rest folded; the choice is remembered per card ----
  function foldOpen(id) {
    var ui = uiFor(id);
    if (ui.fold === 'open') return true;
    if (ui.fold === 'closed') return false;
    var s = lsGet('console.fold.' + id);
    if (s === 'open') return true;
    if (s === 'closed') return false;
    return ui.needsYou;
  }
  function applyFold(art, id) {
    var open = foldOpen(id);
    var t = art.querySelector('[data-tldr]'); if (t) t.hidden = !open;
    var b = art.querySelector('[data-fold-toggle]');
    if (b) { b.textContent = (open ? '▾ ' : '▸ ') + 'TL;DR'; b.setAttribute('aria-expanded', open ? 'true' : 'false'); }
  }
  function setFold(id, open) {
    var ui = uiFor(id); ui.fold = open ? 'open' : 'closed';
    lsSet('console.fold.' + id, ui.fold);
    var art = findCard(id); if (art) applyFold(art, id);
  }
  function syncFoldAll() {
    var b = q('[data-fold-all]'); if (!b) return;
    var list = cardsInScope();
    b.textContent = list.some(function (c) { return foldOpen(c.id); }) ? 'Fold all' : 'Expand all'; // the label names the NEXT action
    b.disabled = list.length === 0;
  }
  function foldAll() {
    var list = cardsInScope();
    var anyOpen = list.some(function (c) { return foldOpen(c.id); });
    list.forEach(function (c) { setFold(c.id, !anyOpen); });
    syncFoldAll();
  }

  // ---- writes: JSON in, { status, body } out; a rejection means no answer at all ----
  function send(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return new Promise(function (resolve, reject) {
      var p; try { p = fetch(url, opts); } catch (e) { reject(e); return; }
      Promise.resolve(p).then(resolve, reject);
    }).then(function (r) {
      if (r.status === 204) return { status: 204, body: null };
      return Promise.resolve().then(function () { return r.json(); }).then(
        function (b) { return { status: r.status, body: b }; },
        function () { return { status: r.status, body: null }; });
    });
  }
  function newKey() {
    var c = win.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    // randomUUID needs a secure context; the console may be opened over plain http on the LAN
    var b = new Uint8Array(16); c.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function utf8Len(s) { return new TextEncoder().encode(s).length; }

  // ---- modal: focus trapped, Esc dismisses, focus goes back to whatever opened it ----
  var FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  function openModal(attr, title, onClose) {
    var opener = doc.activeElement;
    var openerKey = opener && opener.getAttribute ? opener.getAttribute('data-focus-key') : null;
    var overlay = mk('div', 'modal-overlay');
    var dlg = mk('div', 'modal');
    dlg.setAttribute(attr, ''); dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true');
    var h = mk('h2', null, title); h.id = 'console-modal-' + (++modalSeq); dlg.setAttribute('aria-labelledby', h.id);
    dlg.appendChild(h); overlay.appendChild(dlg); doc.body.appendChild(overlay);
    var m = { overlay: overlay, dlg: dlg, closed: false, onDismiss: null };
    m.close = function () {
      if (m.closed) return;
      m.closed = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      var i = modals.indexOf(m); if (i >= 0) modals.splice(i, 1);
      if (onClose) onClose();
      if (opener && opener.isConnected && typeof opener.focus === 'function') { try { opener.focus(); } catch (e) {} }
      else restoreFocus(openerKey); // the opener was re-rendered meanwhile: find its twin
    };
    m.dismiss = function () { m.close(); if (m.onDismiss) m.onDismiss(); };
    dlg.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); m.dismiss(); return; }
      if (e.key !== 'Tab') return;
      var f = Array.prototype.filter.call(dlg.querySelectorAll(FOCUSABLE), function (x) { return !x.hidden; });
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1], a = doc.activeElement;
      if (e.shiftKey && (a === first || !dlg.contains(a))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (a === last || !dlg.contains(a))) { e.preventDefault(); first.focus(); }
    });
    modals.push(m);
    return m;
  }

  // ---- step-up: a passphrase opens a short window in which the console may type; the header says when it ends ----
  var STEP_UP_URL = BASE + '/console/api/step-up';
  function elevatedNow() { return typeof stepUp.until === 'string' && Date.parse(stepUp.until) > Date.now(); }
  function stepUpWords(kind) {
    if (kind === 'unavailable') return '✕ step-up unavailable — login is disabled';
    if (kind === 'cookie_only') return '✕ step-up needs a signed-in browser session — a bearer token cannot elevate';
    if (kind === 'cancelled') return '⚠ step-up cancelled — nothing was sent';
    if (kind === 'busy') return '⚠ a step-up prompt is already open — finish it first';
    if (kind === 'signed_out') return '✕ signed out — reload to sign in';
    if (kind === 'network') return "✕ can't reach the harness — step-up not checked, nothing was sent";
    return '✕ step-up failed — nothing was sent';
  }
  function renderElevation() {
    var box = q('[data-elevation]'); if (!box) return;
    clear(box);
    box.setAttribute('data-state', stepUp.unavailable ? 'error' : elevatedNow() ? 'ok' : 'info');
    if (stepUp.unavailable) { box.appendChild(tx('✕ step-up unavailable — login is disabled')); return; }
    if (!stepUp.known) return;
    if (elevatedNow()) {
      box.appendChild(tx('✓ elevated until ' + hhmm(stepUp.until)));
      var d = mk('button', null, 'Drop elevation'); d.type = 'button'; d.setAttribute('data-drop-elevation', ''); d.setAttribute('data-focus-key', 'drop-elevation');
      d.addEventListener('click', dropElevation);
      box.appendChild(d);
    } else box.appendChild(tx('○ not elevated'));
    if (stepUp.note) box.appendChild(tx(' · ' + stepUp.note));
  }
  function clearStepUpTimer() { if (stepUp.timer !== null) { clearTimeout(stepUp.timer); stepUp.timer = null; } }
  function setElevation(until) {
    stepUp.known = true; stepUp.unavailable = false; stepUp.note = '';
    stepUp.until = typeof until === 'string' ? until : null;
    clearStepUpTimer();
    if (elevatedNow()) stepUp.timer = setTimeout(function () { stepUp.timer = null; renderElevation(); }, Math.min(Date.parse(stepUp.until) - Date.now() + 250, 2147000000));
    renderElevation(); syncGates();
  }
  function markUnavailable() {
    stepUp.unavailable = true; stepUp.until = null; clearStepUpTimer();
    renderElevation(); syncGates();
  }
  function dropElevation() {
    send('POST', STEP_UP_URL, { revoke: true }).then(function (r) {
      if (r.status === 204 || r.status === 200) setElevation(null);
      else { stepUp.note = 'could not drop it — HTTP ' + r.status; renderElevation(); }
    }, function () { stepUp.note = "could not drop it — can't reach the harness"; renderElevation(); });
  }
  // Page load: learn whether a window is already open (after a reload) or step-up is unavailable, before any send.
  // Same branches as ensureElevated, but it never opens the dialog; an unreadable answer leaves the header as it was.
  function checkStepUp() {
    send('GET', STEP_UP_URL).then(function (r) {
      if (r.status === 503) { markUnavailable(); return; }
      if (r.status === 403 && r.body && r.body.error === 'step_up_cookie_only') { stepUp.known = true; stepUp.note = 'step-up needs a signed-in browser session'; renderElevation(); return; }
      if (r.status === 200 && r.body && typeof r.body === 'object') setElevation(r.body.elevatedUntil);
    }, function () {});
  }
  // Runs then() with a step-up window open: straight away when one is, else after the passphrase dialog. declined(kind) otherwise.
  function ensureElevated(then, declined) {
    var fail = typeof declined === 'function' ? declined : function () {};
    if (stepUp.unavailable) { fail('unavailable'); return; }
    send('GET', STEP_UP_URL).then(function (r) {
      if (r.status === 503) { markUnavailable(); fail('unavailable'); return; }
      if (r.status === 401) { fail('signed_out'); return; }
      if (r.status === 403 && r.body && r.body.error === 'step_up_cookie_only') { fail('cookie_only'); return; }
      if (r.status !== 200 || !r.body || typeof r.body !== 'object') { fail('error'); return; }
      setElevation(r.body.elevatedUntil);
      if (elevatedNow()) then(); else openStepUpDialog(then, fail);
    }, function () { fail('network'); });
  }
  function openStepUpDialog(then, fail) {
    if (stepUp.modal) { fail('busy'); return; }
    var m = openModal('data-stepup-dialog', 'Confirm it is you', function () { stepUp.modal = null; });
    stepUp.modal = m;
    m.onDismiss = function () { fail('cancelled'); };
    var form = mk('form'); form.setAttribute('novalidate', '');
    var lab = mk('label', null, 'Passphrase');
    var input = mk('input'); input.type = 'password'; input.name = 'passphrase'; input.setAttribute('autocomplete', 'current-password');
    lab.appendChild(input);
    var stl = statusLine('data-stepup-status', 'alert'), st = stl;
    var actions = mk('div', 'modal-actions');
    var ok = mk('button', null, 'Confirm'); ok.type = 'submit'; ok.setAttribute('data-stepup-confirm', '');
    var no = mk('button', null, 'Cancel'); no.type = 'button'; no.setAttribute('data-stepup-cancel', '');
    no.addEventListener('click', function () { m.dismiss(); });
    actions.appendChild(ok); actions.appendChild(no);
    form.appendChild(lab); form.appendChild(stl.node); form.appendChild(actions);
    m.dlg.appendChild(form);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var pass = input.value; input.value = ''; // never kept: the field is emptied before the request leaves
      if (pass === '') { st.textContent = '⚠ enter the passphrase'; input.focus(); return; }
      ok.disabled = true; st.textContent = '… checking';
      send('POST', STEP_UP_URL, { passphrase: pass }).then(function (r) {
        pass = ''; ok.disabled = false;
        if (r.status === 200 && r.body && typeof r.body === 'object') { setElevation(r.body.elevatedUntil); m.close(); then(); return; }
        if (r.status === 403 && r.body && r.body.error === 'step_up_cookie_only') { m.close(); fail('cookie_only'); return; }
        if (r.status === 403) { st.textContent = '✕ passphrase refused — try again'; input.focus(); return; }
        if (r.status === 503) { markUnavailable(); m.close(); fail('unavailable'); return; }
        st.textContent = '✕ the harness answered HTTP ' + r.status;
      }, function () { pass = ''; ok.disabled = false; st.textContent = "✕ can't reach the harness — try again"; });
    });
    input.focus();
  }
  // POST; a 403 step_up_required opens the dialog and retries ONCE with the same body (so the same key).
  function postWithStepUp(url, body) {
    return send('POST', url, body).then(function (r) {
      var e = r.status === 403 && r.body && typeof r.body === 'object' ? r.body.error : '';
      if (e !== 'step_up_required' && e !== 'step_up_cookie_only') return { status: r.status, body: r.body, retried: false, declined: null };
      return new Promise(function (resolve, reject) {
        ensureElevated(function () {
          send('POST', url, body).then(function (r2) { resolve({ status: r2.status, body: r2.body, retried: true, declined: null }); }, reject);
        }, function (kind) { resolve({ status: 0, body: null, retried: false, declined: kind }); });
      });
    });
  }

  // ---- reply box ----
  function claudeAttachable(p) { return !!p && p.reachable === true && TMUX_NAME_RE.test(p.tmux) && p.tmux.indexOf('sh-') !== 0; }
  function replyReason(ses) {
    if (!ses) return 'not reachable — the poll does not know this session';
    var t = ses.row.tmuxSession;
    if (typeof t === 'string' && t.indexOf('sh-') === 0) return 'this is a machine shell — replies are not sent to it';
    if (ses.view.state === 'ended') return 'the session has ended — nothing to reply to';
    if (ses.row.reachable === false || typeof t !== 'string' || t === '') return 'not reachable — start it in tmux to reply from here';
    // M-1 (ruling T11-20): a session showing a prompt is answered in the Claude session — the server refuses the send.
    if (ses.row.status === 'waiting') return 'the session is showing a prompt — answer it in the Claude session';
    return '';
  }
  function optionIds(c) { return Array.isArray(c.options) ? c.options.filter(function (o) { return typeof o === 'string' && OPTION_ID_RE.test(o); }) : []; }
  function syncReply(art, id) {
    var ui = uiFor(id);
    var ta = art.querySelector('[data-reply-box]'); if (!ta) return;
    var n = utf8Len(ui.text);
    var cnt = art.querySelector('[data-byte-count]');
    if (cnt) cnt.textContent = n + ' / ' + MAX_REPLY_BYTES + ' bytes' + (n > MAX_REPLY_BYTES ? ' — over the limit, Submit is off until it is shorter' : '');
    var sb = art.querySelector('[data-submit]');
    // Not disabled while a send is in flight (a disabled button drops the keyboard's place, and the step-up dialog
    // hands focus back to it): submit() ignores a second click while ui.busy, and aria-busy says so.
    if (sb) {
      sb.disabled = ta.disabled || stepUp.unavailable || ui.text.trim() === '' || n > MAX_REPLY_BYTES;
      if (ui.busy) sb.setAttribute('aria-busy', 'true'); else sb.removeAttribute('aria-busy');
    }
    Array.prototype.forEach.call(art.querySelectorAll('[data-option]'), function (b) {
      b.disabled = ta.disabled || (b.getAttribute('data-sends') === 'true' && stepUp.unavailable);
    });
  }
  function syncById(id) { var art = findCard(id); if (art) syncReply(art, id); }
  function syncGates() {
    Array.prototype.forEach.call(doc.querySelectorAll('[data-card]'), function (art) { syncReply(art, art.getAttribute('data-card')); });
    Array.prototype.forEach.call(doc.querySelectorAll('[data-new-session], [data-new-project], [data-project-row]'), function (b) { b.disabled = stepUp.unavailable; });
  }
  // CC1: a status line says its state in a glyph + words AND in data-state (the theme colours it); the glyph leads the text.
  function stateOf(text) { var g = String(text).charAt(0); return g === '✓' ? 'ok' : g === '⚠' ? 'warn' : g === '✕' ? 'error' : 'info'; }
  function statusLine(attr, role) {
    var node = mk('p', 'send-status'); node.setAttribute(attr, ''); node.setAttribute('role', role); node.setAttribute('data-state', 'info');
    return { node: node, set textContent(t) { node.textContent = t; node.setAttribute('data-state', stateOf(t)); } };
  }
  function setSend(id, text) {
    var ui = uiFor(id); ui.sendStatus = text;
    var art = findCard(id); var s = art ? art.querySelector('[data-send-status]') : null;
    if (s && s.textContent !== text) s.textContent = text;
    if (s) s.setAttribute('data-state', stateOf(text));
  }
  function setBoxText(id, text) {
    var ui = uiFor(id); ui.text = text;
    var art = findCard(id); var ta = art ? art.querySelector('[data-reply-box]') : null;
    if (ta && ta.value !== text) ta.value = text;
    if (art) syncReply(art, id);
  }
  // Reply-question buttons only COPY the id into the box (TM-020: nothing a session wrote is sent back by a click).
  function copyLetter(id, optionId) {
    var t = uiFor(id).text;
    setBoxText(id, t === '' ? optionId : (/\\s$/.test(t) ? t + optionId : t + ' ' + optionId));
    var art = findCard(id); var ta = art ? art.querySelector('[data-reply-box]') : null; if (ta) ta.focus();
  }
  function renderReplyBox(art, c, ses) {
    var ui = uiFor(c.id);
    var reason = replyReason(ses);
    var opts = optionIds(c);
    var isQuestion = c.asksYou === true && opts.length > 0 && c.kind !== 'commit_approval'; // D5: a commit approval never gets buttons
    var isSentinel = c.kind === 'reply' && c.needsKind === 'sentinel' && opts.length > 0;
    var wrap = mk('div', 'reply'); wrap.setAttribute('data-reply', '');
    if (reason) { var why = mk('p', 'hint', '⚠ ' + reason); why.setAttribute('data-reply-disabled', ''); wrap.appendChild(why); }
    if (isQuestion || isSentinel) {
      var row = mk('div', 'options'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', isSentinel ? 'Answer options (a click sends)' : 'Answer options (a click copies)');
      opts.forEach(function (oid) {
        var b = mk('button', null, oid); b.type = 'button';
        b.setAttribute('data-option', oid); b.setAttribute('data-focus-key', 'opt:' + c.id + ':' + oid);
        if (isSentinel) { b.setAttribute('data-sends', 'true'); b.title = 'Sends ' + oid + ' to the session'; }
        else b.title = 'Copies ' + oid + ' into the box — nothing is sent until you press Submit';
        b.addEventListener('click', function () { if (isSentinel) sendSentinel(c.id, oid); else copyLetter(c.id, oid); });
        row.appendChild(b);
      });
      wrap.appendChild(row);
      wrap.appendChild(mk('p', 'hint', isSentinel ? 'A button sends only its option id.' : 'A button copies its id into the box; you press Submit.'));
    }
    var ta = mk('textarea'); ta.setAttribute('data-reply-box', ''); ta.setAttribute('data-focus-key', 'box:' + c.id);
    ta.setAttribute('maxlength', String(MAX_REPLY_BYTES)); ta.setAttribute('rows', '3'); ta.setAttribute('aria-label', 'Reply to: ' + str(c.title, 80));
    ta.value = ui.text; ta.disabled = reason !== '';
    ta.addEventListener('input', function () { ui.text = ta.value; syncReply(art, c.id); });
    wrap.appendChild(ta);
    var line = mk('div', 'reply-row');
    var cnt = mk('span', 'byte-count'); cnt.setAttribute('data-byte-count', ''); line.appendChild(cnt);
    var sb = mk('button', null, 'Submit'); sb.type = 'button'; sb.setAttribute('data-submit', ''); sb.setAttribute('data-focus-key', 'submit:' + c.id);
    sb.addEventListener('click', function () { submit(c.id, ui.text); });
    line.appendChild(sb);
    if (reason === '') line.appendChild(openClaudeButton(c, projectFor(c))); // ruling T9-3: every reachable non-menu card can jump to its session
    // Ruling T11-19 (I-1): Dismiss on any card that asks — buttons or none — while neither dismissed nor answered (D5: never a commit approval).
    var dismissable = c.asksYou === true && c.kind !== 'commit_approval' && !(typeof c.dismissedAt === 'string' && c.dismissedAt) && !(typeof c.answeredAt === 'string' && c.answeredAt);
    if (dismissable) {
      var db = mk('button', null, 'Dismiss'); db.type = 'button'; db.setAttribute('data-dismiss', ''); db.setAttribute('data-focus-key', 'dismiss:' + c.id);
      db.addEventListener('click', function () { dismiss(c.id); });
      line.appendChild(db);
    }
    wrap.appendChild(line);
    var st = statusLine('data-send-status', 'status'); st.textContent = ui.sendStatus;
    wrap.appendChild(st.node);
    art.appendChild(wrap);
    syncReply(art, c.id);
  }
  // A menu answers on screen: its options are shown, read-only, and the button opens the Claude session.
  function renderMenuActions(art, c, p) {
    var opts = optionIds(c);
    var wrap = mk('div', 'reply');
    if (opts.length) { var ro = mk('p', 'hint', 'Options on screen (read-only): ' + opts.join(' · ')); ro.setAttribute('data-options-readonly', ''); wrap.appendChild(ro); }
    wrap.appendChild(openClaudeButton(c, p));
    art.appendChild(wrap);
  }
  function openClaudeButton(c, p) {
    var b = mk('button', null, 'Open Claude session'); b.type = 'button'; b.setAttribute('data-open-claude', ''); b.setAttribute('data-focus-key', 'openclaude:' + c.id);
    b.disabled = !claudeAttachable(p);
    if (b.disabled) b.title = 'this session has no tmux pane to attach to';
    b.addEventListener('click', function () { openClaude(c.machine, c.projectKey); });
    return b;
  }

  // ---- submit: the key is fresh after a 2xx or 4xx answer and kept across silence and a 5xx (rulings T9-1, T11-10) ----
  // B-1: every Submit starts a new send of its card, whatever its outcome. The earlier send's next step stops, its
  // second read is cancelled, a read still in flight is dropped and the view closes, so nothing begun for an earlier
  // send can re-word this send's status line or re-open the view.
  function newSend(id) {
    var ui = uiFor(id);
    ui.sendSeq++; ui.nextStep = null;
    hidePane(id);
  }
  function submit(id, text) {
    var ui = uiFor(id);
    if (ui.busy) return Promise.resolve();
    newSend(id); // from here this Submit owns the card's status line and its screen view
    if (!ID_RE.test(id)) { setSend(id, '⚠ ' + SUBMIT_400['unexpected card id']); return Promise.resolve(); }
    // The key belongs to the text it first carried: edited text is a different send, so it gets its own key.
    if (ui.key === null || ui.keyText !== text) { ui.key = newKey(); ui.keyText = text; }
    ui.busy = true; setSend(id, '… sending'); syncById(id);
    return postWithStepUp(BASE + '/console/api/cards/' + id + '/submit', { text: text, key: ui.key }).then(function (res) {
      ui.busy = false;
      if (res.declined) { ui.key = null; setSend(id, stepUpWords(res.declined)); } else showOutcome(id, text, res);
      syncById(id);
    }, function () {
      ui.busy = false; // no answer: the key stays, so the server can recognise a retry of a send whose answer was lost
      setSend(id, "✕ can't reach the harness — nothing was confirmed; try again to retry");
      syncById(id);
    });
  }
  function cardById(id) {
    var list = payload && Array.isArray(payload.cards) ? payload.cards : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function showOutcome(id, text, res) {
    var ui = uiFor(id), st = res.status, b = res.body && typeof res.body === 'object' ? res.body : {};
    // Ruling T11-10: a 5xx proves nothing about the paste, so the key stays — exactly as after a lost answer — and a
    // retry meets the server's unresolved 409 instead of a second paste. Any 2xx or 4xx answer was final: a fresh key.
    if (st < 500) ui.key = null;
    if (st === 200 && typeof b.outcome === 'string') {
      var msg = str(b.message, 300) || b.outcome;
      var c = cardById(id);
      if (b.outcome === 'sent') {
        if (c && c.kind === 'commit_approval') {
          // Ruling T11-20 (I-3) + F2 Task 12 (spec §6.4): CDF answers the first id by showing the question, the staged change
          // and the hooks, then asks for the id again — the card opens the session's screen and says the next step. The box
          // is NOT prefilled (D5: the second confirmation is typed). This page tells the first id from its typed repeat by
          // its own sends; after a reload the repeat reads as a first id again, and the screen shows which it was. The
          // next step follows the view (M-1): nextStepText words it each time the view changes, until the next Submit.
          var repeat = ui.confirmText === text;
          ui.confirmText = repeat ? null : text;
          paneAfterSend(id, { text: str(text, 80), at: hhmm(b.at), repeat: repeat });
        } else {
          // "queued" is not a confirmation yet: a neutral glyph, not the tick
          setSend(id, (msg.indexOf('queued') === 0 ? '… ' : '✓ ') + msg + ', ' + hhmm(b.at));
        }
        if (ui.text === text) setBoxText(id, '');
        refresh(); // the card's own state (answered, dismissed) comes from the poll
      } else setSend(id, (b.outcome === 'failed' ? '✕ ' : '⚠ ') + msg); // unconfirmed and refusals: ⚠, the text stays in the box
      return;
    }
    if (st === 400) { setSend(id, '⚠ ' + (has(SUBMIT_400, b.error) ? SUBMIT_400[b.error] : 'refused — ' + str(String(b.error), 40))); return; }
    if (st === 403 && b.error === 'step_up_cookie_only') { setSend(id, stepUpWords('cookie_only')); return; }
    if (st === 403 && b.error === 'step_up_required') { setSend(id, '⚠ step-up expired — confirm again, then press Submit'); return; }
    if (st === 401 || st === 403) { setSend(id, '✕ signed out — reload to sign in'); return; }
    if (st === 404) { setSend(id, '⚠ this card is gone — nothing was sent'); return; }
    if (st === 409) { setSend(id, '⚠ ' + (typeof b.message === 'string' && b.message ? str(b.message, 300) : (has(SUBMIT_409, b.error) ? SUBMIT_409[b.error] : 'refused — ' + str(String(b.error), 40)))); return; }
    if (st === 503) { markUnavailable(); setSend(id, stepUpWords('unavailable')); return; }
    setSend(id, '✕ the harness answered HTTP ' + st + (st >= 500 ? ' — nothing was confirmed; try again to retry' : ''));
  }
  // A sentinel button sends ONLY its option id, and only inside a step-up window.
  function sendSentinel(id, optionId) {
    if (uiFor(id).busy) return;
    ensureElevated(function () { submit(id, optionId); }, function (kind) { setSend(id, stepUpWords(kind)); });
  }
  function dismiss(id) {
    var ui = uiFor(id);
    if (!ID_RE.test(id) || ui.dismissing) return; // a double click posts once
    ui.dismissing = true;
    // Ruling T11-15: the console's POST routes take JSON only, so Dismiss sends an empty JSON object.
    send('POST', BASE + '/console/api/cards/' + id + '/dismiss', {}).then(function (r) {
      ui.dismissing = false;
      if (r.status === 200) { setSend(id, '✓ dismissed'); refresh(); }
      else setSend(id, '⚠ could not dismiss — HTTP ' + r.status);
    }, function () { ui.dismissing = false; setSend(id, "✕ can't reach the harness — not dismissed"); });
  }

  // ---- view switch: Cards | Claude session for the selected project; the poll keeps running underneath ----
  function wsUrl(machine, o) {
    var url = (win.location.protocol === 'https:' ? 'wss://' : 'ws://') + win.location.host + BASE + '/terminal/' + encodeURIComponent(machine);
    var qs = [];
    if (o.shell) qs.push('shell=1'); else if (o.session) qs.push('tmux=' + encodeURIComponent(o.session));
    if (o.resume) qs.push('session=' + encodeURIComponent(o.resume));
    return qs.length ? url + '?' + qs.join('&') : url;
  }
  function selectedProject() {
    if (sel.project === null || !view) return null;
    for (var i = 0; i < view.projects.length; i++) if (projectSelected(view.projects[i])) return view.projects[i];
    return null;
  }
  // The CSS hides the view switch and the drawer under 900 px; the script agrees (the note under the cards says why).
  function narrow() { return typeof win.matchMedia === 'function' && win.matchMedia('(max-width: 899px)').matches; }
  function modeOf(p) { return !narrow() && p && has(viewMode, p.machine + SEP + p.key) && viewMode[p.machine + SEP + p.key] === 'claude' && claudeAttachable(p) ? 'claude' : 'cards'; }
  function showClaude(p) {
    var key = p.machine + SEP + p.tmux;
    var root = q('[data-claude-panels]');
    var t = has(claudeTerms, key) ? claudeTerms[key] : null;
    if (!t) {
      var panel = mk('div', 'claude-panel'); panel.setAttribute('data-claude-panel', key);
      var status = mk('p', 'term-status', '[~] Connecting to ' + p.machine + ' · ' + p.tmux + '…'); status.setAttribute('role', 'status'); status.setAttribute('data-claude-status', '');
      var note = mk('p', 'hint'); note.setAttribute('data-claude-note', '');
      var host = mk('div', 'term-host');
      panel.appendChild(note); panel.appendChild(status); panel.appendChild(host);
      if (root) root.appendChild(panel); // in the page before the terminal measures its host
      t = claudeTerms[key] = { panel: panel, status: status, note: note, handle: null };
      var rk = 'console.term.' + p.machine + '.claude.' + p.tmux;
      t.handle = pantheonOpenTerminal(host, wsUrl(p.machine, { session: p.tmux, resume: ssGet(rk) }), {
        label: p.machine + ' · ' + p.tmux,
        hidden: function () { return panel.hidden || (root ? root.hidden : false); },
        status: function (state, text) { status.setAttribute('data-state', state); status.textContent = text; },
        onReady: function (id) { ssSet(rk, id); }
      });
    }
    t.panel.hidden = false;
    if (t.handle && t.handle.fit) t.handle.fit();
  }
  function applyView() {
    var p = selectedProject();
    var mode = modeOf(p);
    var bar = q('[data-view-switch]');
    if (bar) {
      bar.hidden = !p;
      var bc = bar.querySelector('[data-view="cards"]'), bl = bar.querySelector('[data-view="claude"]'), note = bar.querySelector('[data-view-note]');
      if (bc) pressed(bc, mode === 'cards');
      if (bl) { pressed(bl, mode === 'claude'); bl.disabled = !!p && !claudeAttachable(p); }
      if (note) note.textContent = p && !claudeAttachable(p) ? 'no Claude session to attach to — it has no tmux pane (or is a machine shell)' : '';
    }
    if (el.cards) el.cards.hidden = mode === 'claude';
    var fa = q('[data-fold-all]'); if (fa) fa.hidden = mode === 'claude';
    var root = q('[data-claude-panels]'); if (root) root.hidden = mode !== 'claude';
    Object.keys(claudeTerms).forEach(function (k) { claudeTerms[k].panel.hidden = true; });
    if (mode === 'claude') showClaude(p);
  }
  function setViewMode(mode) {
    var p = selectedProject(); if (!p) return;
    viewMode[p.machine + SEP + p.key] = mode;
    applyView();
  }
  function openClaude(machine, key) {
    viewMode[machine + SEP + key] = 'claude';
    select(machine, key);
  }
  function rebuildView() { if (!payload) return; view = buildView(payload); render(); }

  // ---- shell drawer (spec 14.2): one per machine, kept alive while hidden; Esc inside it is the one swallowed key ----
  function drawerOf(machine) { return has(drawers, machine) ? drawers[machine] : null; }
  function currentDrawer() { return sel.machine === '*' ? null : drawerOf(sel.machine); }
  function isToggleKey(e) { return !!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '\\x60' || e.code === 'Backquote'); }
  function maxDrawerH() { return Math.max(DRAWER_MIN_H, (win.innerHeight || 800) - 160); }
  function applyDrawerHeight() {
    var panels = q('[data-drawer-panels]'); if (panels) panels.style.height = drawerH + 'px';
    var grip = q('[data-drawer-grip]');
    if (grip) { grip.setAttribute('aria-valuenow', String(drawerH)); grip.setAttribute('aria-valuemax', String(maxDrawerH())); }
  }
  function setDrawerHeight(h) {
    drawerH = Math.min(maxDrawerH(), Math.max(DRAWER_MIN_H, Math.round(h)));
    lsSet('console.drawer.height', String(drawerH));
    applyDrawerHeight();
    var d = currentDrawer(); if (d && !d.minimised && d.handle && d.handle.fit) d.handle.fit();
  }
  function renderDrawerBar() {
    var title = q('[data-drawer-title]'), btn = q('[data-drawer-toggle]'); if (!title || !btn) return;
    var d = currentDrawer();
    title.textContent = sel.machine === '*' ? 'Shell · choose a machine' : 'Shell · ' + str(sel.machine, 60) + (d && d.title ? ' · ' + d.title : '');
    btn.disabled = sel.machine === '*';
    btn.textContent = !d ? 'Open shell' : (d.minimised ? '▴ Restore' : '▾ Minimise');
    btn.setAttribute('aria-expanded', d && !d.minimised ? 'true' : 'false');
  }
  function renderDrawers() {
    var panels = q('[data-drawer-panels]'); if (!panels) return;
    var cur = currentDrawer();
    Object.keys(drawers).forEach(function (m) {
      var d = drawers[m];
      d.el.hidden = d !== cur;
      if (d.minimised) d.el.setAttribute('data-minimised', ''); else d.el.removeAttribute('data-minimised');
    });
    panels.hidden = !cur || cur.minimised;
    applyDrawerHeight();
    renderDrawerBar();
    if (cur && !cur.minimised && cur.handle && cur.handle.fit) cur.handle.fit();
  }
  function setMinimised(d, on) {
    d.minimised = on;
    renderDrawers();
    if (!on && d.handle && d.handle.term && d.handle.term.focus) d.handle.term.focus();
  }
  // Keys xterm offers before the shell sees them. Returning false drops the key: the shell never receives it.
  function drawerKey(d, e) {
    if (isToggleKey(e)) { e.stopPropagation(); setMinimised(d, !d.minimised); return false; }
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { e.stopPropagation(); setMinimised(d, true); return false; }
    return true;
  }
  function openDrawer(machine) {
    var panels = q('[data-drawer-panels]'); if (!panels) return null;
    var d = { machine: machine, el: mk('div', 'drawer'), status: mk('p', 'term-status', '[~] Connecting to a shell on ' + machine + '…'), handle: null, minimised: false, title: '' };
    d.el.setAttribute('data-drawer', ''); d.el.setAttribute('data-machine', machine);
    d.status.setAttribute('data-drawer-status', ''); d.status.setAttribute('role', 'status');
    var host = mk('div', 'term-host');
    d.el.appendChild(d.status); d.el.appendChild(host);
    panels.appendChild(d.el);
    drawers[machine] = d;
    panels.hidden = false; // shown before the terminal measures its host
    applyDrawerHeight();
    var rk = 'console.term.' + machine + '.shell';
    d.handle = pantheonOpenTerminal(host, wsUrl(machine, { shell: true, resume: ssGet(rk) }), {
      label: 'a shell on ' + machine,
      hidden: function () { return d.el.hidden || d.minimised; },
      status: function (state, text) { d.status.setAttribute('data-state', state); d.status.textContent = text; },
      keyFilter: function (e) { return drawerKey(d, e); },
      onReady: function (id) { ssSet(rk, id); },
      onTitle: function (t) { d.title = str(t, 120); renderDrawerBar(); }
    });
    renderDrawers();
    return d;
  }
  function toggleDrawer() {
    if (sel.machine === '*' || narrow()) return;
    var d = drawerOf(sel.machine);
    if (!d) openDrawer(sel.machine); else setMinimised(d, !d.minimised);
  }
  function onDocKey(e) {
    if (isToggleKey(e)) { e.preventDefault(); toggleDrawer(); return; }
    if (e.key === 'Escape' && modals.length === 0) {
      var d = currentDrawer();
      if (d && !d.minimised && d.el.contains(doc.activeElement)) { e.preventDefault(); setMinimised(d, true); }
    }
  }

  // ---- new session / new project ----
  function addPendingProject(machine, tmux, path) {
    var segs = typeof path === 'string' ? path.split('/').filter(function (s) { return s !== ''; }) : [];
    pending[machine + SEP + tmux] = { machine: machine, key: tmux, display: str(segs.length ? segs[segs.length - 1] : tmux, 40), glyph: '·', border: 'solid', configured: false,
      reachable: true, sessions: [], worst: 'none', worstView: null, live: 0, tmux: tmux, pending: true };
    viewMode[machine + SEP + tmux] = 'claude';
    sel.machine = machine; sel.project = { key: tmux, machine: machine };
    rebuildView();
  }
  function sessionOutcome(machine, m, status, res) {
    var b = res.body && typeof res.body === 'object' ? res.body : {}, st = res.status;
    if (st === 200 && (b.outcome === 'created_session' || b.outcome === 'created_project')) {
      var tmux = b.tmuxSession;
      if (typeof tmux !== 'string' || !TMUX_NAME_RE.test(tmux) || tmux.indexOf('sh-') === 0) {
        status.textContent = '⚠ the server named a machine shell or an unusable session — it is not opened as a project';
        return;
      }
      m.close();
      addPendingProject(machine, tmux, b.path);
      if (b.outcome === 'created_project' && has(claudeTerms, machine + SEP + tmux)) {
        claudeTerms[machine + SEP + tmux].note.textContent = 'The new session is asking you to trust the folder — answer it in the Claude session.';
      }
      return;
    }
    // Ruling T11-18: an unconfirmed start may have happened — ⚠, never ✕.
    if (st === 200) { status.textContent = (b.outcome === 'unconfirmed' ? '⚠ ' : '✕ ') + (str(b.message, 300) || 'the session could not be started'); return; }
    if (st === 400) {
      status.textContent = b.error === 'refused_root' ? '⚠ that folder is outside the projects root — refused'
        : b.error === 'refused_name' ? '⚠ that name is not allowed — use letters, digits, space, . _ or - (64 characters at most)'
        : '⚠ the request was malformed — nothing was started';
      return;
    }
    if (st === 409 && b.error === 'no_projects_root') { status.textContent = '⚠ no projects root configured for this machine'; return; }
    if (st === 409 || st === 502) { status.textContent = '✕ ' + (typeof b.message === 'string' && b.message ? str(b.message, 300) : 'the machine is not connectable'); return; }
    if (st === 403 && b.error === 'step_up_cookie_only') { status.textContent = stepUpWords('cookie_only'); return; }
    if (st === 403 && b.error === 'step_up_required') { status.textContent = '⚠ step-up expired — confirm again, then try again'; return; }
    if (st === 401 || st === 403) { status.textContent = '✕ signed out — reload to sign in'; return; }
    if (st === 503) { markUnavailable(); status.textContent = stepUpWords('unavailable'); return; }
    status.textContent = '✕ the harness answered HTTP ' + st;
  }
  function createSession(machine, m, status, body) {
    var url = BASE + '/console/api/machines/' + encodeURIComponent(machine) + '/sessions';
    status.textContent = '… starting';
    ensureElevated(function () {
      postWithStepUp(url, body).then(function (res) {
        if (res.declined) status.textContent = stepUpWords(res.declined); else sessionOutcome(machine, m, status, res);
      }, function () { status.textContent = "✕ can't reach the harness — nothing was confirmed"; });
    }, function (kind) { status.textContent = stepUpWords(kind); });
  }
  function openSessionDialog(machine) {
    if (stepUp.sessionModal) return; // one dialog at a time
    var m = openModal('data-session-dialog', 'New session on ' + str(machine, 60), function () { stepUp.sessionModal = null; });
    stepUp.sessionModal = m;
    var status = statusLine('data-session-status', 'status');
    var list = mk('div', 'project-list'); list.setAttribute('data-project-list', '');
    var form = mk('form'); form.setAttribute('novalidate', '');
    var lab = mk('label', null, 'New project (a folder under the projects root)');
    var name = mk('input'); name.type = 'text'; name.setAttribute('data-new-project-name', ''); name.setAttribute('maxlength', '64'); name.setAttribute('autocomplete', 'off');
    lab.appendChild(name);
    var hint = mk('p', 'hint'); hint.setAttribute('data-new-project-hint', '');
    var actions = mk('div', 'modal-actions');
    var create = mk('button', null, 'Create project'); create.type = 'submit'; create.setAttribute('data-new-project', ''); create.disabled = stepUp.unavailable;
    var close = mk('button', null, 'Close'); close.type = 'button'; close.addEventListener('click', function () { m.dismiss(); });
    actions.appendChild(create); actions.appendChild(close);
    form.appendChild(lab); form.appendChild(hint); form.appendChild(actions);
    name.addEventListener('input', function () {
      hint.textContent = name.value === '' || PROJECT_NAME_RE.test(name.value) ? '' : 'Names start with a letter or digit, then letters, digits, space, . _ or - (64 characters at most) — the server decides.';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (name.value === '') { status.textContent = '⚠ enter a project name'; name.focus(); return; }
      createSession(machine, m, status, { newProject: name.value });
    });
    m.dlg.appendChild(status.node); m.dlg.appendChild(list); m.dlg.appendChild(form);
    status.textContent = '… listing folders on ' + machine;
    name.focus();
    send('GET', BASE + '/console/api/machines/' + encodeURIComponent(machine) + '/projects').then(function (r) {
      var b = r.body && typeof r.body === 'object' ? r.body : {};
      if (r.status === 200 && Array.isArray(b.projects)) {
        status.textContent = b.projects.length ? 'Pick a folder to start Claude in, or create a project:' : 'No folders under the projects root yet — create a project:';
        b.projects.forEach(function (pr) {
          if (!pr || typeof pr.name !== 'string' || typeof pr.path !== 'string') return;
          var running = typeof pr.running === 'string' && pr.running ? pr.running : null;
          var btn = mk('button', 'project-row'); btn.type = 'button';
          btn.setAttribute('data-project-row', pr.name); btn.setAttribute('data-path', pr.path);
          btn.appendChild(mk('strong', null, str(pr.name, 64)));
          btn.appendChild(tx(running ? ' — ● running — open it' : ' — ○ start Claude here'));
          btn.disabled = stepUp.unavailable;
          btn.addEventListener('click', function () {
            if (running === null) { createSession(machine, m, status, { folder: pr.path }); return; }
            if (!projectOf(machine, running)) { status.textContent = '⚠ it is running as ' + str(running, 60) + ', which the poll has not shown yet — try again in a moment'; return; }
            m.close();
            openClaude(machine, running);
          });
          list.appendChild(btn);
        });
        return;
      }
      if (r.status === 409 && b.error === 'no_projects_root') { status.textContent = '⚠ no projects root configured for this machine'; return; }
      if (r.status === 401 || r.status === 403) { status.textContent = '✕ signed out — reload to sign in'; return; }
      status.textContent = '✕ ' + (typeof b.message === 'string' && b.message ? str(b.message, 300) : 'the harness answered HTTP ' + r.status);
    }, function () { status.textContent = "✕ can't reach the harness — nothing was listed"; });
  }

  // ---- transport ----
  function request(url) {
    var opts = { credentials: 'same-origin', headers: { accept: 'application/json' } };
    return new Promise(function (resolve, reject) {
      var p; try { p = fetch(url, opts); } catch (e) { reject(e); return; }
      Promise.resolve(p).then(resolve, reject);
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) return { status: r.status, signedOut: true, body: null };
      return Promise.resolve().then(function () { return r.json(); }).then(
        function (b) { return { status: r.status, signedOut: false, body: b }; },
        function () { return { status: r.status, signedOut: false, body: null }; });
    });
  }

  // ---- render ----
  function focusedKey() { var a = doc.activeElement; return a && a.getAttribute ? a.getAttribute('data-focus-key') : null; }
  // A focused reply box is rebuilt by a render: its selection (caret = start == end) is carried over to the new one.
  function focusedSelection() {
    var a = doc.activeElement;
    if (!a || a.tagName !== 'TEXTAREA' || typeof a.selectionStart !== 'number') return null;
    return { start: a.selectionStart, end: a.selectionEnd, dir: a.selectionDirection };
  }
  function restoreFocus(key, selection) {
    if (!key) return;
    var all = doc.querySelectorAll('[data-focus-key]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-focus-key') !== key) continue;
      // keep the keyboard place without yanking the page to it (an engine without the options object falls back)
      try { all[i].focus({ preventScroll: true }); } catch (e) { try { all[i].focus(); } catch (e2) {} }
      if (selection && all[i].tagName === 'TEXTAREA') { try { all[i].setSelectionRange(selection.start, selection.end, selection.dir || 'none'); } catch (e3) {} }
      return;
    }
  }
  function renderCards(now) {
    var main = el.cards; clear(main);
    var list = cardsInScope();
    if (list.length === 0) { var e = mk('p', 'empty', 'no cards for this selection yet'); e.setAttribute('data-empty', ''); main.appendChild(e); return; }
    list.forEach(function (c) { main.appendChild(renderCard(c, now)); });
  }
  function renderSummary() {
    if (!el.summary) return;
    var scope = sel.machine === '*' ? 'All machines' : sel.machine;
    var ps = projectsInScope(); var counts = {};
    ps.forEach(function (p) { counts[p.worst] = (counts[p.worst] | 0) + 1; });
    var shown = cardsInScope().length;
    el.summary.textContent = scope + (sel.project ? ' · ' + sel.project.key : '') + ' · ' + plural(ps.length, 'project', 'projects') + ': ' + countsText(counts) + ' · ' + plural(shown, 'card', 'cards') + ' shown';
  }
  function render() {
    var focusKey = focusedKey(), focusSel = focusedSelection();
    var now = Date.now();
    renderMachineTabs(); renderProjectTabs(); renderMachineBanners(); renderCards(now); renderSummary();
    applyView(); renderDrawers(); syncFoldAll(); syncGates();
    doc.title = (view.all.needsYou > 0 ? '(' + view.all.needsYou + ') ' : '') + 'Console';
    restoreFocus(focusKey, focusSel);
  }
  // Fields that change on every tick without changing what the page shows (final review M6). A poll that differs
  // from the adopted one only in these keeps the DOM (focus, an open fold, a text selection): the card ages are
  // brought up to date in place and the heartbeat still beats. A machine's since only moves with its state, which stays.
  var CHURN = { sessions: ['lastSeenAt', 'updatedAt', 'version'], cards: ['version', 'updatedAt'], machines: ['lastOkAt', 'since'] };
  function withoutKeys(o, keys) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return o;
    var out = map();
    Object.keys(o).forEach(function (k) { if (keys.indexOf(k) < 0) out[k] = o[k]; });
    return out;
  }
  function dedupKey(body) {
    var out = map();
    Object.keys(body).forEach(function (k) {
      var v = body[k];
      out[k] = has(CHURN, k) && Array.isArray(v) ? v.map(function (x) { return withoutKeys(x, CHURN[k]); }) : v;
    });
    return JSON.stringify(out);
  }
  function refreshAges() {
    if (!el.cards || !payload) return;
    var byId = map();
    (Array.isArray(payload.cards) ? payload.cards : []).forEach(function (c) { if (c && typeof c.id === 'string') byId[c.id] = c; });
    var now = Date.now();
    var arts = el.cards.querySelectorAll('[data-card]');
    for (var i = 0; i < arts.length; i++) {
      var id = arts[i].getAttribute('data-card'), meta = arts[i].querySelector('[data-age]');
      if (!meta || !has(byId, id)) continue;
      var t = metaText(byId[id], now);
      if (meta.textContent !== t) meta.textContent = t;
    }
  }
  function renderDisabled(entry) {
    if (!el.banners) return;
    var old = el.banners.querySelector('[data-console-disabled]');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var p = mk('p', 'banner banner-error'); p.setAttribute('role', 'alert'); p.setAttribute('data-console-disabled', entry);
    p.textContent = '⚠ Console disabled — the console settings entry ' + entry + ' is invalid. Fix the settings file and restart the service; terminals, approvals and the rest of the harness keep running. This page stopped polling.';
    el.banners.insertBefore(p, el.banners.firstChild);
  }
  function select(machine, project) {
    sel.machine = machine === null || machine === undefined || machine === '*' ? '*' : String(machine);
    sel.project = project === null || project === undefined ? null : { key: String(project), machine: sel.machine };
    if (view) render();
  }
  function apply(body) {
    var s = body.settings;
    if (s && typeof s === 'object' && s.disabled === true) {
      stop();
      renderDisabled(typeof s.entry === 'string' ? str(s.entry, 120) : '(unknown entry)');
      setStatus('disabled', '✕ console disabled — not polling');
      return;
    }
    var ps = s && typeof s.pollSeconds === 'number' && isFinite(s.pollSeconds) ? s.pollSeconds : DEFAULT_POLL_S;
    pollMs = Math.min(MAX_POLL_S, Math.max(MIN_POLL_S, ps)) * 1000;
    var key = dedupKey(body);
    if (key === lastKey && view !== null) { refreshAges(); return; } // only per-tick churn changed: leave the DOM (and the operator's focus) alone
    var nextView = buildView(body);
    var prevPayload = payload, prevView = view;
    payload = body; view = nextView;
    try { render(); } catch (e) { payload = prevPayload; view = prevView; throw e; }
    lastKey = key; // adopted only once the render succeeded, so a throw is never masked by the dedup
  }

  // ---- poll loop ----
  function schedule() { if (stopped) return; if (timer !== null) clearTimeout(timer); timer = setTimeout(function () { timer = null; refresh(); }, pollMs); }
  function stop() { stopped = true; if (timer !== null) { clearTimeout(timer); timer = null; } }
  function every() { return ' — retrying every ' + (pollMs / 1000) + ' s'; }
  function refresh() {
    if (stopped) return Promise.resolve();
    if (inflight) return inflight;
    lastFetchAt = Date.now();
    inflight = request(BASE + '/console/api/state').then(function (r) {
      if (r.signedOut) { stop(); setStatus('signed_out', '✕ signed out — reload to sign in'); return; }
      if (r.status !== 200 || !r.body || typeof r.body !== 'object') { setStatus('error', '✕ the harness answered HTTP ' + r.status + every()); schedule(); return; }
      var ok = true;
      try { apply(r.body); } catch (e) { ok = false; }
      if (stopped) return;
      if (!ok) { setStatus('error', '✕ the page could not render this state' + every()); schedule(); return; }
      setStatus('ok', '✓ live · every ' + (pollMs / 1000) + ' s'); beat(); // the timestamp lives outside the live region
      schedule();
    }).catch(function () {
      if (!stopped) { setStatus('error', "✕ can't reach the harness" + every()); schedule(); }
    }).then(function () { inflight = null; });
    return inflight;
  }
  function onWake() {
    if (stopped || inflight) return;
    if (Date.now() - lastFetchAt < FOCUS_THROTTLE_MS) return; // a focus right after a poll is not another dial
    refresh();
  }

  // The public stop() also lets go of everything this client attached: the document key handler, timers, terminals, modals.
  function shutdown() {
    stop();
    doc.removeEventListener('keydown', onDocKey);
    clearStepUpTimer();
    Object.keys(cardUi).forEach(function (k) { clearPaneTimer(cardUi[k]); });
    Object.keys(claudeTerms).forEach(function (k) { var h = claudeTerms[k].handle; if (h && h.close) h.close(); });
    Object.keys(drawers).forEach(function (k) { var h = drawers[k].handle; if (h && h.close) h.close(); });
    modals.slice().forEach(function (m) { m.close(); });
  }

  wireRow(el.machineTabs); wireRow(el.projectTabs);
  win.addEventListener('focus', onWake);
  doc.addEventListener('visibilitychange', function () { if (!doc.hidden) onWake(); });
  doc.addEventListener('keydown', onDocKey);
  (function wireControls() {
    var fa = q('[data-fold-all]'); if (fa) fa.addEventListener('click', foldAll);
    var vc = q('[data-view="cards"]'), vl = q('[data-view="claude"]');
    if (vc) vc.addEventListener('click', function () { setViewMode('cards'); });
    if (vl) vl.addEventListener('click', function () { setViewMode('claude'); });
    var tg = q('[data-drawer-toggle]'); if (tg) tg.addEventListener('click', toggleDrawer);
    var stored = parseInt(lsGet('console.drawer.height'), 10);
    if (isFinite(stored)) drawerH = Math.min(maxDrawerH(), Math.max(DRAWER_MIN_H, stored));
    applyDrawerHeight();
    var grip = q('[data-drawer-grip]');
    if (!grip) return;
    grip.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setDrawerHeight(drawerH + DRAWER_STEP); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setDrawerHeight(drawerH - DRAWER_STEP); }
    });
    grip.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var startY = e.clientY, startH = drawerH;
      function move(ev) { setDrawerHeight(startH + (startY - ev.clientY)); }
      function up() { doc.removeEventListener('mousemove', move); doc.removeEventListener('mouseup', up); }
      doc.addEventListener('mousemove', move); doc.addEventListener('mouseup', up);
    });
  })();
  win.__console = { refresh: refresh, select: select, expand: expand, stop: shutdown };
  if (q('[data-console-disabled]')) { stopped = true; setStatus('disabled', '✕ console disabled — not polling'); }
  else if (typeof fetch !== 'function') { stopped = true; setStatus('error', '✕ live updates are unavailable in this browser'); }
  else { refresh(); checkStepUp(); }
})();
`;

const LEGEND = `<ul class="legend" aria-label="What the marks mean">
    <li data-state="needs_you"><span class="glyph" aria-hidden="true">!</span> NEEDS YOU — a session is waiting for you (orange, solid edge)</li>
    <li data-state="working"><span class="glyph" aria-hidden="true">⟳</span> WORKING (grey, dashed edge)</li>
    <li data-state="idle"><span class="glyph" aria-hidden="true">✓</span> IDLE (blue, solid edge)</li>
    <li data-state="shell"><span class="glyph" aria-hidden="true">$</span> IN SHELL — a shell, not Claude</li>
    <li data-state="unknown"><span class="glyph" aria-hidden="true">?</span> UNKNOWN STATUS ‹value› — never shown as idle</li>
    <li><span class="glyph" aria-hidden="true">✕</span> UNREACHABLE since HH:MM — last known cards kept</li>
    <li><span class="glyph" aria-hidden="true">⚠</span> CAN'T READ — format changed (N lines)</li>
    <li data-state="ended"><span class="glyph" aria-hidden="true">○</span> ENDED — cards kept to retention</li>
    <li><span class="glyph" aria-hidden="true">…</span> no data yet — first poll pending</li>
  </ul>`;

export function renderConsolePage(model: ConsolePageModel): string {
  const base = model.base;
  const fonts = CONSOLE_FONT_ASSETS.map(
    (a) => `@font-face { font-family: "Lexend"; src: url("${withBuild(withBase(base, a.path))}") format("woff2"); font-weight: ${a.weight}; font-style: normal; font-display: swap; }`
  ).join("\n");
  const disabled = model.disabled
    ? `<p class="banner banner-error" role="alert" data-console-disabled="${esc(model.disabled.entry)}">⚠ Console disabled — the console settings entry <code>${esc(model.disabled.entry)}</code> is invalid. Fix the settings file and restart the service; terminals, approvals and the rest of the harness keep running. This page is not polling.</p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en" data-base="${esc(base)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Console</title>
${pageHead(base)}
<link rel="stylesheet" href="${withBuild(withBase(base, "/assets/xterm.css"))}">
<style>
${fonts}
${CONSOLE_CSS}
</style>
</head>
<body>
<header class="console-header">
  <strong>Pantheon Harness</strong> <span class="current" aria-current="page">Console</span>
  <a href="${withBase(base, "/harness")}" data-nav="harness">Terminals</a>
  <a href="${withBase(base, "/admin/config")}" data-nav="config">Configuration</a>
  <a href="${withBase(base, "/admin/approvals")}" data-nav="approvals">Approvals</a>
  <a href="${withBase(base, "/help")}" data-nav="help">Help</a>
  <span class="elev" data-elevation role="status" aria-live="polite"></span>
  ${model.loginEnabled ? `<form method="post" action="${withBase(base, "/logout")}" class="logout" style="display:inline;margin-left:auto"><button type="submit">Log out</button></form>` : ""}
  <span class="muted build" data-build="${esc(BUILD_ID)}" title="The build this page came from — quote it if something looks out of date">build ${esc(BUILD_ID)}</span>
</header>
<div class="banners" data-banners>${disabled}</div>
<nav class="tabs machines" data-machine-tabs aria-label="Machines"><span class="rowlabel">… loading machines</span></nav>
<nav class="tabs projects" data-project-tabs aria-label="Projects"></nav>
<div class="banners" data-machine-banners></div>
<div class="body">
<aside class="side" data-left-panel aria-label="This view, and what the marks mean">
  <h2>This view</h2>
  <p data-selection-summary>… loading</p>
  <h2>Marks</h2>
  ${LEGEND}
  <p class="hint">Reply from a card: type in its box and press Submit (the first send asks for your passphrase). Option buttons on a question only copy the id into the box. Text from the machines is masked and shown as text.</p>
</aside>
<div class="work">
  <div class="cards-head" data-cards-head>
    <div class="view-switch" data-view-switch role="group" aria-label="View of the selected project" hidden>
      <button type="button" data-view="cards" aria-pressed="true">Cards</button>
      <button type="button" data-view="claude" aria-pressed="false">Claude session</button>
      <span class="hint" data-view-note></span>
    </div>
    <button type="button" data-fold-all>Fold all</button>
  </div>
  <p class="desktop-note" data-desktop-note>The Claude session view and the shell drawer need a window at least 900 px wide.</p>
  <main class="cards" data-cards aria-label="Cards"><p class="empty" data-empty>… loading</p></main>
  <section class="claude-panels" data-claude-panels aria-label="Claude session" hidden></section>
</div>
</div>
<section class="drawer-wrap" data-drawer-wrap aria-label="Machine shell">
  <div class="drawer-grip" data-drawer-grip role="separator" aria-orientation="horizontal" aria-label="Resize the shell drawer" aria-valuemin="96" aria-valuenow="241" tabindex="0" aria-describedby="drawer-help"></div>
  <div class="drawer-bar">
    <strong data-drawer-title>Shell · choose a machine</strong>
    <button type="button" data-drawer-toggle aria-expanded="false" disabled>Open shell</button>
    <span class="hint" id="drawer-help" data-drawer-help><kbd>Ctrl</kbd>+<kbd>&#96;</kbd> shows or hides the shell. <kbd>Esc</kbd> inside the shell minimises it and is not sent to the shell — it is the only key this drawer swallows.</span>
  </div>
  <div class="drawer-panels" data-drawer-panels hidden></div>
</section>
<div class="status-line"><span data-poll-status role="status" aria-live="polite" data-state="loading">… loading</span> <span data-poll-heartbeat aria-live="off"></span></div>
<script src="${withBuild(withBase(base, "/assets/xterm.js"))}"></script>
<script src="${withBuild(withBase(base, "/assets/xterm-addon-fit.js"))}"></script>
<script src="${withBuild(withBase(base, "/assets/xterm-addon-clipboard.js"))}"></script>
<script src="${withBuild(withBase(base, "/assets/xterm-addon-webgl.js"))}"></script>
<script>${CONSOLE_CLIENT_JS}</script>
</body>
</html>`;
}
