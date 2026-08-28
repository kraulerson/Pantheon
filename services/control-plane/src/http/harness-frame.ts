/**
 * Server-rendered harness frame (Task #16e, PROJECT_BIBLE §9 C.1/C.6, ADR-0005 — amends ADR-0001).
 *
 * A SINGLE-PAGE tabbed shell behind #9 auth hosting both modalities: Claude-CLI xterm terminal tabs
 * and (future) chat tabs. The New Session popup (AI SYSTEM × IDENTITY) and the per-machine shortcuts
 * open terminals as IN-APP, closeable tabs (NOT new browser windows) — each embeds an xterm terminal
 * and a WebSocket to the broker (`/terminal/:logicalName`, cookie-authed). Switching/closing tabs is
 * client-side; closing a terminal tab disconnects its WebSocket. The SSH key never reaches the browser.
 *
 * tmux-aware launcher (M1 task 1): for every READY machine the launch bar also shows the machine's
 * LIVE tmux sessions — fetched asynchronously from `GET /harness/tmux/:logicalName` so an unreachable
 * machine never blocks the page — as one button per session (`<machine> · <session> (N win[, attached])`)
 * that opens a tab ATTACHED to that session (`?tmux=<name>`), plus a "new tmux session" form
 * (`&create=1`). Every list state is text + icon (`[~]` loading, `[–]` empty, `[✓] N` ready, `[!]`
 * error — CC1); the status text lives in its own `role="status"` element and the buttons beside it.
 * Session names are rendered via `textContent` only, must be strings, and are re-checked against the
 * allow-list client-side before they become a button (the server validates again before any SSH
 * command runs). Anything the machine sent (`remoteDetail`) is labelled "machine said" — it is
 * `trusted:false`, never first-party prose. One list request per machine is in flight at a time,
 * with a 15 s client-side timeout, and a signed-out answer is named as such.
 *
 * The interactive client is {@link HARNESS_CLIENT_JS} (plain browser JS, behavior-tested in jsdom),
 * shipped inline so the page is self-contained.
 */

import type { DevMachine } from "../registry/types.js";
import { withBase } from "./base-path.js";
import { pageHead, XTERM_THEME_JS } from "./theme.js";

export interface HarnessFrameModel {
  readonly devMachines: readonly DevMachine[];
  /** LibreChat URL for the chat modality (optional until LibreChat is deployed). */
  readonly chatUrl?: string;
  /** When true, render the Log out control (POST /logout exists only when a passphrase is set). */
  readonly loginEnabled?: boolean;
  /** Mount prefix for this request (`/harness` on the chat site, `""` on the admin site). */
  readonly base?: string;
}

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Same allow-list as `src/devmachine/tmux.ts` (kept literal here: this string ships to the browser). */
const TMUX_NAME_PATTERN = "[A-Za-z0-9_][A-Za-z0-9_-]{0,63}";

/** Browser client: tab manager + per-terminal xterm/WebSocket wiring + live tmux lists. No DOM types (plain JS). */
export const HARNESS_CLIENT_JS = `
(function () {
  var doc = document;
  // Mount prefix + chat address, rendered on <html> by the server (design 2026-08-27).
  var BASE = doc.documentElement.getAttribute('data-base') || '';
  var CHAT_URL = doc.documentElement.getAttribute('data-chat-url') || '';
  var tabbar = doc.querySelector('[data-tabbar]');
  var panels = doc.querySelector('[data-panels]');
  var welcome = doc.querySelector('[data-welcome]');
  var dialog = doc.getElementById('new-session');
  var tabs = {}; var seq = 0; var active = null;
  var TMUX_NAME_RE = /^${TMUX_NAME_PATTERN}$/;
  var TMUX_LIST_TIMEOUT_MS = 15000;
  var TMUX_REFRESH_AFTER_CREATE_MS = 3500; // just past the server's per-machine cache window

  function wsUrl(name, tmux) {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var url = proto + location.host + BASE + '/terminal/' + encodeURIComponent(name);
    if (tmux) {
      url += '?tmux=' + encodeURIComponent(tmux.session);
      if (tmux.create) url += '&create=1';
    }
    return url;
  }
  function switchTo(id) {
    Object.keys(tabs).forEach(function (k) {
      tabs[k].panel.hidden = (k !== id);
      tabs[k].btn.setAttribute('aria-selected', k === id ? 'true' : 'false');
    });
    active = id;
    if (welcome) welcome.hidden = (id !== null);
    // A panel that was hidden measured 0×0 — size its terminal now that it is visible.
    if (id !== null && tabs[id] && tabs[id].fit) tabs[id].fit();
  }
  function closeTab(id) {
    var t = tabs[id]; if (!t) return;
    if (t.ro) t.ro.disconnect();
    // Explicit close ENDS the session server-side (BUGS #33): a closed tmux tab must not leave a
    // ghost tmux client attached on the machine. A dropped socket (no frame) only detaches.
    try { if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ t: 'c' })); } catch (e) {}
    try { if (t.ws) t.ws.close(); } catch (e) {}
    try { if (t.term && t.term.dispose) t.term.dispose(); } catch (e) {}
    if (t.btn.parentNode) t.btn.parentNode.removeChild(t.btn);
    if (t.panel.parentNode) t.panel.parentNode.removeChild(t.panel);
    delete tabs[id];
    var keys = Object.keys(tabs);
    switchTo(keys.length ? keys[keys.length - 1] : null);
  }
  function addTab(label, kind) {
    var id = 't' + (++seq);
    var btn = doc.createElement('button');
    btn.type = 'button'; btn.setAttribute('role', 'tab'); btn.setAttribute('data-tab', id);
    btn.appendChild(doc.createTextNode(label + ' '));
    var x = doc.createElement('span');
    x.textContent = '✕'; x.setAttribute('data-close', id);
    x.setAttribute('role', 'button'); x.setAttribute('aria-label', 'Close ' + label);
    btn.appendChild(x);
    btn.addEventListener('click', function (e) {
      if (e.target === x) closeTab(id); else switchTo(id);
    });
    tabbar.appendChild(btn);
    var panel = doc.createElement('section');
    panel.setAttribute('data-tab-panel', id); panel.setAttribute('data-kind', kind);
    panel.setAttribute('aria-label', label);
    panels.appendChild(panel);
    tabs[id] = { id: id, btn: btn, panel: panel };
    switchTo(id);
    return tabs[id];
  }
  // tmux: optional { session: <name>, create: <bool> } — attach the tab to that tmux session.
  function openTerminalTab(name, tmux) {
    var label = tmux ? (name + ' · ' + tmux.session) : ('CLI: ' + name);
    var t = addTab(label, 'terminal');
    var status = doc.createElement('div');
    status.className = 'term-status'; status.setAttribute('data-state', 'loading');
    status.setAttribute('role', 'status'); status.textContent = '[~] Connecting to ' + label + '…';
    t.panel.appendChild(status);
    var host = doc.createElement('div'); host.className = 'term-host'; t.panel.appendChild(host);
    var term; var fit;
    try {
      term = new window.Terminal({ convertEol: true, fontFamily: '"Roboto Mono", Menlo, Consolas, monospace', theme: ${XTERM_THEME_JS} });
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(host);
    } catch (e) {
      // Fail closed AND labeled: no engine → no socket, and the tab says why.
      status.setAttribute('data-state', 'error');
      status.textContent = '[!] terminal engine failed to load — reload the page';
      return t;
    }
    t.term = term;
    // Size the grid to the host (operator report 2026-08-27: xterm's 80×24 default filled ~60% of the
    // width and never grew). Only while visible — a hidden panel measures 0×0 and would shrink the PTY.
    t.fit = function () { if (!t.panel.hidden) fit.fit(); };
    t.fit();
    if (window.ResizeObserver) { t.ro = new window.ResizeObserver(function () { t.fit(); }); t.ro.observe(host); }
    var ws = new WebSocket(wsUrl(name, tmux)); t.ws = ws;
    ws.onmessage = function (ev) {
      var f; try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.t === 'ready') {
        status.setAttribute('data-state', 'connected'); status.textContent = '[✓] connected to ' + label;
        // The first fit ran before the socket was open, so tell the PTY the size explicitly now.
        t.fit();
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
      }
      else if (f.t === 'o') { term.write(f.d); }
      else if (f.t === 'x') { status.setAttribute('data-state', 'disconnected'); status.textContent = '[x] disconnected — close tab to dismiss'; }
      else if (f.t === 'e') { status.setAttribute('data-state', 'error'); status.textContent = '[!] ' + f.m; }
    };
    ws.onclose = function () {
      // A dropped socket must be SAID, not just attributed: keystrokes are silently dropped otherwise.
      if (status.getAttribute('data-state') !== 'error') {
        status.setAttribute('data-state', 'disconnected');
        status.textContent = '[x] disconnected — close tab to dismiss';
      }
    };
    ws.onerror = function () { status.setAttribute('data-state', 'error'); status.textContent = '[!] connection failed'; };
    term.onData(function (d) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d: d })); });
    if (term.onResize) term.onResize(function (s) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: s.cols, r: s.rows })); });
    return t;
  }
  function openChatTab(label) {
    var t = addTab(label || 'Chat', 'chat');
    if (BASE) {
      // Served under the chat address: the chat page is same-origin, so it can live in a tab here
      // (the chat site answers X-Frame-Options: SAMEORIGIN — a cross-site embed would be refused
      // and its sign-in cookie blocked as third-party).
      var f = doc.createElement('iframe');
      f.setAttribute('src', '/'); f.setAttribute('title', 'Chat'); f.className = 'chat-host';
      t.panel.appendChild(f);
    } else {
      var p = doc.createElement('p');
      p.textContent = 'Chat lives on the chat address; it appears as a tab here when the harness is opened from that address.';
      if (CHAT_URL) {
        p.appendChild(doc.createTextNode(' '));
        var a = doc.createElement('a'); a.href = CHAT_URL; a.textContent = 'Open chat'; a.target = '_blank'; a.rel = 'noopener';
        p.appendChild(a);
      }
      t.panel.appendChild(p);
    }
    return t;
  }

  window.addEventListener('resize', function () {
    if (active !== null && tabs[active] && tabs[active].fit) tabs[active].fit();
  });

  // ---- live tmux session lists (one slot per ready machine) ----
  var tmuxLoads = {}; // machine → { gen, inflight }
  function sessionButton(machine, s) {
    var nm = s.name;
    var b = doc.createElement('button');
    b.type = 'button';
    b.setAttribute('data-tmux-attach', machine);
    b.setAttribute('data-tmux-session', nm);
    var detail = (s.windows | 0) + ' win' + (s.attached ? ', attached elsewhere' : '');
    b.appendChild(doc.createTextNode(machine + ' · ' + nm + ' (' + detail + ')'));
    b.title = detail;
    b.addEventListener('click', function () { openTerminalTab(machine, { session: nm }); });
    return b;
  }
  function renderTmux(machine, slot, statusEl, listEl, body, set) {
    var sessions = (body && body.state === 'ok' && Array.isArray(body.sessions)) ? body.sessions : null;
    if (!sessions) {
      var why = (body && typeof body.message === 'string') ? body.message : 'tmux list unavailable';
      // Anything the machine itself said is trusted:false — label its provenance, cap it.
      var said = (body && typeof body.remoteDetail === 'string' && body.remoteDetail)
        ? ' — machine said: "' + body.remoteDetail.slice(0, 140) + '"' : '';
      set('error', '[!] ' + machine + ': ' + why + said);
      return;
    }
    var notes = [];
    if ((body.ignoredLines | 0) > 0) notes.push((body.ignoredLines | 0) + ' unrecognised line(s) ignored');
    if (body.truncated === true) notes.push('list truncated');
    var noteText = notes.length ? ' (' + notes.join('; ') + ')' : '';
    if (sessions.length === 0) { set('empty', '[–] no tmux sessions on ' + machine + noteText); return; }
    if (!set('ready', '[✓] ' + sessions.length + ' tmux session(s) on ' + machine + ':' + noteText)) return;
    sessions.forEach(function (s) {
      var named = s && typeof s.name === 'string';
      // Defense in depth: the server already marks unsafe names; re-check here before offering a button.
      if (named && s.attachable === true && TMUX_NAME_RE.test(s.name)) {
        listEl.appendChild(sessionButton(machine, s));
      } else {
        var sp = doc.createElement('span');
        sp.setAttribute('data-tmux-unattachable', machine);
        sp.textContent = named
          ? s.name.slice(0, 64) + ' (not attachable: unsupported characters in name)'
          : '(unnamed session — not attachable)';
        listEl.appendChild(sp);
      }
      listEl.appendChild(doc.createTextNode(' '));
    });
  }
  function loadTmux(slot) {
    if (!slot) return;
    var machine = slot.getAttribute('data-tmux-list');
    var statusEl = slot.querySelector('[data-tmux-status]');
    var listEl = slot.querySelector('[data-tmux-sessions]');
    if (!machine || !statusEl || !listEl) return;
    var st = tmuxLoads[machine] || (tmuxLoads[machine] = { gen: 0, inflight: false });
    if (st.inflight) return; // one request per machine at a time — a mashed Refresh is one dial
    var gen = ++st.gen; st.inflight = true;
    var current = function () { return gen === st.gen; };
    var set = function (state, text) {
      if (!current()) return false;
      slot.setAttribute('data-state', state);
      statusEl.textContent = text;
      listEl.textContent = '';
      return true;
    };
    var done = function () { if (current()) st.inflight = false; };
    set('loading', '[~] listing tmux sessions on ' + machine + '…');
    if (typeof fetch !== 'function') { set('error', '[!] ' + machine + ': tmux listing unavailable in this browser'); done(); return; }
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, TMUX_LIST_TIMEOUT_MS);
    var opts = { credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (ctl) opts.signal = ctl.signal;
    var p;
    try {
      p = fetch(BASE + '/harness/tmux/' + encodeURIComponent(machine), opts);
    } catch (e) {
      clearTimeout(timer);
      set('error', '[!] ' + machine + ': tmux list request failed'); done(); return;
    }
    var signedOut = false;
    Promise.resolve(p)
      .then(function (r) {
        if (r.status === 401 || r.status === 403) { signedOut = true; throw new Error('signed out'); }
        return r.json();
      })
      .then(function (body) { renderTmux(machine, slot, statusEl, listEl, body, set); })
      .catch(function () {
        if (signedOut) set('error', '[!] ' + machine + ': you are signed out — reload the page to sign in');
        else if (ctl && ctl.signal.aborted) set('error', '[!] ' + machine + ': tmux list timed out — press Refresh to retry');
        else set('error', '[!] ' + machine + ': tmux list request failed');
      })
      .then(function () { clearTimeout(timer); done(); });
  }
  function slotFor(el) {
    var box = el.closest ? el.closest('.machine-launch') : null;
    return box ? box.querySelector('[data-tmux-list]') : null;
  }

  var newBtn = doc.querySelector('[data-action="new-session"]');
  if (newBtn && dialog) newBtn.addEventListener('click', function () {
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  });
  var form = doc.querySelector('[data-form="new-session"]');
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var aiEl = doc.querySelector('[name="aiSystem"]');
    var ai = aiEl ? aiEl.value : '';
    if (ai === 'claude_cli') {
      var sel = doc.querySelector('[name="devMachine"]');
      var name = sel ? sel.value : '';
      if (name) openTerminalTab(name);
    } else {
      openChatTab(ai);
    }
    if (dialog) { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); }
  });
  Array.prototype.forEach.call(doc.querySelectorAll('[data-open-terminal]'), function (b) {
    b.addEventListener('click', function () { openTerminalTab(b.getAttribute('data-open-terminal')); });
  });
  Array.prototype.forEach.call(doc.querySelectorAll('[data-tmux-refresh]'), function (b) {
    b.addEventListener('click', function () { loadTmux(slotFor(b)); });
  });
  Array.prototype.forEach.call(doc.querySelectorAll('[data-tmux-new]'), function (f) {
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var machine = f.getAttribute('data-tmux-new');
      var input = f.querySelector('[name="session"]');
      var status = f.querySelector('[data-tmux-new-status]');
      var nm = input ? String(input.value).trim() : '';
      if (!TMUX_NAME_RE.test(nm)) {
        if (status) status.textContent = '[!] use 1–64 letters, digits, _ or - (no leading -)';
        return;
      }
      if (status) status.textContent = '';
      openTerminalTab(machine, { session: nm, create: true });
      if (input) input.value = '';
      // The list is a snapshot: re-read it once the server's short cache window has passed.
      var slot = slotFor(f);
      if (slot) setTimeout(function () { loadTmux(slot); }, TMUX_REFRESH_AFTER_CREATE_MS);
    });
  });
  // ---- sidebar: fold/unfold the whole thing and each machine; remembered per browser ----
  function remember(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function recall(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  var aside = doc.querySelector('[data-sidebar]');
  var sideToggle = doc.querySelector('[data-sidebar-toggle]');
  function setSidebar(open) {
    if (!aside) return;
    if (open) aside.removeAttribute('data-collapsed'); else aside.setAttribute('data-collapsed', '');
    if (sideToggle) sideToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (active !== null && tabs[active] && tabs[active].fit) tabs[active].fit(); // the workspace just changed width
  }
  if (aside) setSidebar(recall('pantheon.sidebar') !== 'closed');
  if (sideToggle) sideToggle.addEventListener('click', function () {
    var open = !!(aside && aside.hasAttribute('data-collapsed'));
    setSidebar(open); remember('pantheon.sidebar', open ? 'open' : 'closed');
  });
  Array.prototype.forEach.call(doc.querySelectorAll('[data-machine-toggle]'), function (t) {
    var name = t.getAttribute('data-machine-toggle');
    var group = t.closest ? t.closest('[data-machine-group]') : null;
    var body = group ? group.querySelector('[data-machine-body]') : null;
    if (!body) return;
    var apply = function (open) { body.hidden = !open; t.setAttribute('aria-expanded', open ? 'true' : 'false'); };
    var stored = recall('pantheon.sidebar.machine.' + name);
    if (stored === 'open' || stored === 'closed') apply(stored === 'open');
    t.addEventListener('click', function () {
      var open = body.hidden;
      apply(open);
      remember('pantheon.sidebar.machine.' + name, open ? 'open' : 'closed');
      // A collapsed group is never dialled (SSH-dial amplifier, M1 task 1 audit); load it the FIRST
      // time it is unfolded, then leave it to Refresh like any other list.
      if (open) loadTmuxIfNew(body.querySelector('[data-tmux-list]'));
    });
  });
  var chatBtn = doc.querySelector('[data-open-chat]');
  if (chatBtn) chatBtn.addEventListener('click', function () { openChatTab('Chat'); });

  function loadTmuxIfNew(slot) {
    if (!slot) return;
    var st = tmuxLoads[slot.getAttribute('data-tmux-list')];
    if (!st || st.gen === 0) loadTmux(slot);
  }
  function slotVisible(slot) {
    var body = slot.closest ? slot.closest('[data-machine-body]') : null;
    return !body || !body.hidden;
  }
  Array.prototype.forEach.call(doc.querySelectorAll('[data-tmux-list]'), function (s) { if (slotVisible(s)) loadTmux(s); });

  switchTo(null);
  window.__harness = { openTerminalTab: openTerminalTab, openChatTab: openChatTab, loadTmux: loadTmux,
    tabIds: function () { return Object.keys(tabs); }, active: function () { return active; } };
})();
`;

function machineOption(m: DevMachine): string {
  return `<option value="${esc(m.logicalName)}">${esc(m.logicalName)} (${esc(m.user)}@${esc(m.host)})</option>`;
}

type MachineState = "ready" | "unprovisioned" | "disabled";
const machineState = (m: DevMachine): MachineState => (!m.enabled ? "disabled" : !m.provisioned ? "unprovisioned" : "ready");
const STATE_GLYPH: Record<MachineState, string> = { ready: "[✓]", unprovisioned: "[ ]", disabled: "[x]" };
const STATE_TEXT: Record<MachineState, string> = { ready: "ready", unprovisioned: "not provisioned", disabled: "disabled" };

/**
 * One collapsible sidebar group per registered machine (operator request 2026-08-27). READY machines
 * open by default with their controls — plain shell, live tmux list, Refresh, new-session form (the
 * same data-attributes the client wires); not-ready ones start closed with the reason in words and a
 * Configuration link (registering stays there). The client re-applies the operator's remembered
 * open/closed choice per machine. Every state is text + glyph (CC1).
 */
function machineGroup(m: DevMachine, base: string): string {
  const n = esc(m.logicalName);
  const state = machineState(m);
  const open = state === "ready";
  const body =
    state === "ready"
      ? `<button type="button" data-open-terminal="${n}" data-action="open-terminal" class="shell-btn">Claude CLI → ${n} (new shell)</button>
    <div class="tmux-list" data-tmux-list="${n}" data-state="loading">
      <span data-tmux-status role="status" aria-live="polite">[~] listing tmux sessions on ${n}…</span>
      <div data-tmux-sessions class="tmux-sessions"></div>
    </div>
    <button type="button" data-tmux-refresh="${n}" class="tmux-refresh">Refresh tmux list (${n})</button>
    <form data-tmux-new="${n}" class="tmux-new" novalidate>
      <label>New tmux session <input name="session" pattern="${TMUX_NAME_PATTERN}" maxlength="64" placeholder="session-name" required></label>
      <button type="submit">+ tmux session on ${n}</button> <span data-tmux-new-status role="status"></span>
    </form>`
      : `<p class="muted"><em>${STATE_TEXT[state]}</em> — set it up in <a href="${withBase(base, "/admin/config")}">Configuration</a>.</p>`;
  return `<section class="machine" data-machine-group="${n}" data-state="${state}">
  <button type="button" class="machine-toggle" data-machine-toggle="${n}" aria-expanded="${open ? "true" : "false"}" aria-controls="machine-${n}"><span class="glyph" aria-hidden="true">${STATE_GLYPH[state]}</span> ${n} <span class="muted">${STATE_TEXT[state]}</span></button>
  <div class="machine-launch" data-machine-body id="machine-${n}"${open ? "" : " hidden"}>
    ${body}
  </div>
</section>`;
}

function sidebar(machines: readonly DevMachine[], base: string): string {
  const groups =
    machines.length === 0
      ? `<p class="empty-state" data-state="empty">No dev machines configured. Add one in <a href="${withBase(base, "/admin/config")}">Configuration</a>.</p>`
      : machines.map((m) => machineGroup(m, base)).join("\n");
  return `<aside class="sidebar" data-sidebar id="sidebar" aria-label="Chat and machines">
  <button type="button" class="side-item" data-open-chat><span class="glyph" aria-hidden="true">[💬]</span> Chat</button>
  <h2 class="side-heading">Machines</h2>
  ${groups}
</aside>`;
}

export function renderHarnessFrame(model: HarnessFrameModel): string {
  const ready = model.devMachines.filter((m) => m.provisioned && m.enabled);
  const base = model.base ?? "";
  return `<!DOCTYPE html>
<html lang="en" data-base="${esc(base)}"${model.chatUrl !== undefined ? ` data-chat-url="${esc(model.chatUrl)}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pantheon Harness</title>
${pageHead(base)}
<link rel="stylesheet" href="${withBase(base, "/assets/xterm.css")}">
<style>
  body { margin: 0; display: flex; flex-direction: column; height: 100vh; }
  header { padding: .4rem .8rem; display: flex; gap: 1rem; align-items: center; }
  .shell { display: flex; flex: 1; min-height: 0; }
  .sidebar { width: 17rem; flex: none; overflow: auto; padding: .5rem; display: flex; flex-direction: column; gap: .25rem; }
  .sidebar[data-collapsed] { display: none; }
  .workspace { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .machine-launch { display: flex; flex-direction: column; gap: .35rem; padding: .25rem .25rem .5rem 1.4rem; }
  .tmux-list { font-family: monospace; font-size: .85em; }
  .tmux-sessions { display: flex; flex-direction: column; gap: .2rem; margin-top: .2rem; }
  .tmux-list button { font-family: monospace; text-align: left; }
  .tmux-new { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
  .tmux-new input { width: 9em; }
  nav.tabs { display: flex; gap: .25rem; padding: .25rem .5rem 0; overflow-x: auto; }
  nav.tabs [role="tab"] { padding: .3rem .7rem; }
  [data-close] { margin-left: .4rem; cursor: pointer; }
  main { flex: 1; min-height: 0; overflow: hidden; position: relative; }
  [data-tab-panel] { position: absolute; inset: 0; padding: .25rem; display: flex; flex-direction: column; }
  [data-tab-panel][hidden] { display: none; }
  .term-host { flex: 1; min-height: 0; }
  .chat-host { flex: 1; min-height: 0; width: 100%; border: 0; }
  .term-status { font-family: monospace; padding: .2rem .4rem; }
  .glyph, .term-status { font-family: monospace; }
  .muted { font-size: .9em; }
  form { margin: 0; }
</style>
</head>
<body>
<header><button type="button" data-sidebar-toggle aria-expanded="true" aria-controls="sidebar" title="Show or hide the sidebar">☰</button> <strong>Pantheon Harness</strong>
  <button type="button" data-action="new-session">+ New Session</button>
  <!-- Configuration lives in the page chrome, NOT inside the empty-state message: it used to
       appear only when the registry was empty, so registering the first machine removed the
       operator's only route back to the page that provisions it (BUGS #16). -->
  <a href="${withBase(base, "/admin/config")}" data-nav="config">Configuration</a>
  <a href="${withBase(base, "/admin/approvals")}" data-nav="approvals">Approvals</a>
  <a href="${withBase(base, "/help")}" data-nav="help">Help</a>
  ${model.loginEnabled ? `<form method="post" action="${withBase(base, "/logout")}" class="logout" style="display:inline;margin-left:auto"><button type="submit">Log out</button></form>` : ""}
</header>

<!-- Persistent launch bar (BUGS #22): the per-machine terminal shortcuts live HERE, in the page
     chrome, NOT inside the welcome section — switchTo() hides the welcome section when a tab opens,
     which used to hide the shortcuts too and blocked opening a second terminal. The live tmux
     session buttons (M1 task 1) live here for the same reason. -->
<div class="shell">
${sidebar(model.devMachines, base)}
<div class="workspace">

<!-- Tab bar: terminal/chat tabs are added here at runtime -->
<nav class="tabs" data-tabbar role="tablist" aria-label="Open sessions"></nav>

<main data-panels>
  <section data-welcome>
    <h2>Start a session</h2>
    <p>Use <strong>New Session</strong>, or a shortcut in the launch bar above: <strong>Claude CLI → machine</strong> opens a fresh shell; a <strong>machine · session</strong> button attaches to that live tmux session. Sessions open as tabs above; close a tab with its ✕.</p>
  </section>
</main>
</div>
</div>

<!-- New Session: AI SYSTEM × IDENTITY (§9 C.1) + Claude CLI → dev machine (C.6) -->
<dialog id="new-session" aria-labelledby="h-new">
  <form data-form="new-session">
    <h2 id="h-new">New Session</h2>
    <label>AI System
      <select name="aiSystem" data-field="ai-system">
        <option value="claude_cli">Claude CLI (terminal)</option>
        <option value="local_alden1">Alden-1 (chat)</option>
      </select>
    </label>
    <label>Identity <input name="identity" data-field="identity" placeholder="persona"></label>
    <label>Dev machine (for Claude CLI)
      <select name="devMachine" data-field="dev-machine">
        ${ready.map(machineOption).join("")}
      </select>
    </label>
    <menu>
      <button type="button" data-action="cancel" onclick="this.closest('dialog').close()">Cancel</button>
      <button type="submit">Start</button>
    </menu>
  </form>
</dialog>

<script src="${withBase(base, "/assets/xterm.js")}"></script>
<script src="${withBase(base, "/assets/xterm-addon-fit.js")}"></script>
<script>${HARNESS_CLIENT_JS}</script>
</body>
</html>`;
}
