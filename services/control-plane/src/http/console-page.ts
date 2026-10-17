/**
 * Maestro Console page (plan Task 11; spec §6.1–6.5, §9; ADR-0010). A server-rendered shell plus a plain
 * browser client, built the way every harness page is: `pageHead(base)`, `<html data-base>`, build-versioned
 * assets, every URL through `withBase`. Task 10 serves it at `GET /console` together with the two JSON
 * routes the client reads:
 *
 *   GET BASE/console/api/state            → { machines, sessions, cards, settings | { disabled, entry } }
 *   GET BASE/console/api/cards/:id/expand → ExpandResult (200 ok/changed; 400/404/409/502 labelled states)
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
.status-line { margin: 0; padding: 4px var(--console-pad); font-size: .8em; color: var(--console-text2); border-top: 1px solid var(--console-border); background: var(--console-surface2); display: flex; flex-wrap: wrap; gap: .8em; }
[data-poll-status][data-state="error"], [data-poll-status][data-state="signed_out"], [data-poll-status][data-state="disabled"] { color: var(--console-need); }
.glyph { font-size: var(--console-glyph); }
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
    });
  }
  function projectTab(p) {
    var b = tabButton('project', 'project:' + p.machine + SEP + p.key, p.key, p.display, p.glyph);
    b.setAttribute('data-machine', p.machine);
    b.setAttribute('data-state', p.worst);
    b.setAttribute('data-border', p.border);
    var v = p.worstView;
    b.appendChild(mk('span', 'st', v ? v.glyph + ' ' + v.word + (p.live > 1 ? ' · ' + p.live + ' sessions' : '') : '– NO SESSIONS'));
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
      var tabs = Array.prototype.filter.call(nav.querySelectorAll('button'), function (b) { return !b.disabled; });
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
  function uiFor(id) { if (!has(cardUi, id)) cardUi[id] = { open: {}, view: null, status: '', fetching: null }; return cardUi[id]; }
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
    var tldr = mk('div', 'tldr', str(c.tldrMasked, 1024)); tldr.setAttribute('data-tldr', ''); art.appendChild(tldr);
    if (c.needsYou === true) art.appendChild(mk('p', 'hint', 'Answer it in the terminal — this page is read-only.'));
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
    applyCardUi(art, ui);
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
  function restoreFocus(key) {
    if (!key) return;
    var all = doc.querySelectorAll('[data-focus-key]');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute('data-focus-key') !== key) continue;
      // keep the keyboard place without yanking the page to it (an engine without the options object falls back)
      try { all[i].focus({ preventScroll: true }); } catch (e) { try { all[i].focus(); } catch (e2) {} }
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
    var focusKey = focusedKey();
    var now = Date.now();
    renderMachineTabs(); renderProjectTabs(); renderMachineBanners(); renderCards(now); renderSummary();
    doc.title = (view.all.needsYou > 0 ? '(' + view.all.needsYou + ') ' : '') + 'Console';
    restoreFocus(focusKey);
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

  wireRow(el.machineTabs); wireRow(el.projectTabs);
  win.addEventListener('focus', onWake);
  doc.addEventListener('visibilitychange', function () { if (!doc.hidden) onWake(); });
  win.__console = { refresh: refresh, select: select, expand: expand, stop: stop };
  if (q('[data-console-disabled]')) { stopped = true; setStatus('disabled', '✕ console disabled — not polling'); }
  else if (typeof fetch !== 'function') { stopped = true; setStatus('error', '✕ live updates are unavailable in this browser'); }
  else refresh();
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
  <p class="hint">Cards are read-only in this step: answer in the terminal (Open terminal ↗). Text from the machines is masked and shown as text.</p>
</aside>
<main class="cards" data-cards aria-label="Cards"><p class="empty" data-empty>… loading</p></main>
</div>
<div class="status-line"><span data-poll-status role="status" aria-live="polite" data-state="loading">… loading</span> <span data-poll-heartbeat aria-live="off"></span></div>
<script>${CONSOLE_CLIENT_JS}</script>
</body>
</html>`;
}
