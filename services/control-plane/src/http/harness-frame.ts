/**
 * Server-rendered harness frame (Task #16e, PROJECT_BIBLE §9 C.1/C.6, ADR-0005 — amends ADR-0001).
 *
 * A SINGLE-PAGE tabbed shell behind #9 auth hosting both modalities: Claude-CLI xterm terminal tabs
 * and (future) chat tabs. The New Session popup (AI SYSTEM × IDENTITY) and the per-machine shortcuts
 * open terminals as IN-APP, closeable tabs (NOT new browser windows) — each embeds an xterm terminal
 * and a WebSocket to the broker (`/terminal/:logicalName`, cookie-authed). Switching/closing tabs is
 * client-side; closing a terminal tab disconnects its WebSocket. The SSH key never reaches the browser.
 *
 * The interactive client is {@link HARNESS_CLIENT_JS} (plain browser JS, behavior-tested in jsdom),
 * shipped inline so the page is self-contained.
 */

import type { DevMachine } from "../registry/types.js";

export interface HarnessFrameModel {
  readonly devMachines: readonly DevMachine[];
  /** LibreChat URL for the chat modality (optional until LibreChat is deployed). */
  readonly chatUrl?: string;
}

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Browser client: tab manager + per-terminal xterm/WebSocket wiring. No DOM types (plain JS). */
export const HARNESS_CLIENT_JS = `
(function () {
  var doc = document;
  var tabbar = doc.querySelector('[data-tabbar]');
  var panels = doc.querySelector('[data-panels]');
  var welcome = doc.querySelector('[data-welcome]');
  var dialog = doc.getElementById('new-session');
  var tabs = {}; var seq = 0; var active = null;

  function wsUrl(name) {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + '/terminal/' + encodeURIComponent(name);
  }
  function switchTo(id) {
    Object.keys(tabs).forEach(function (k) {
      tabs[k].panel.hidden = (k !== id);
      tabs[k].btn.setAttribute('aria-selected', k === id ? 'true' : 'false');
    });
    active = id;
    if (welcome) welcome.hidden = (id !== null);
  }
  function closeTab(id) {
    var t = tabs[id]; if (!t) return;
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
  function openTerminalTab(name) {
    var t = addTab('CLI: ' + name, 'terminal');
    var status = doc.createElement('div');
    status.className = 'term-status'; status.setAttribute('data-state', 'loading');
    status.setAttribute('role', 'status'); status.textContent = '[~] Connecting to ' + name + '…';
    t.panel.appendChild(status);
    var host = doc.createElement('div'); host.className = 'term-host'; t.panel.appendChild(host);
    var term = new window.Terminal({ convertEol: true });
    term.open(host); t.term = term;
    var ws = new WebSocket(wsUrl(name)); t.ws = ws;
    ws.onmessage = function (ev) {
      var f; try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.t === 'ready') { status.setAttribute('data-state', 'connected'); status.textContent = '[✓] connected to ' + name; }
      else if (f.t === 'o') { term.write(f.d); }
      else if (f.t === 'x') { status.setAttribute('data-state', 'disconnected'); status.textContent = '[x] disconnected — close tab to dismiss'; }
      else if (f.t === 'e') { status.setAttribute('data-state', 'error'); status.textContent = '[!] ' + f.m; }
    };
    ws.onclose = function () { if (status.getAttribute('data-state') !== 'error') status.setAttribute('data-state', 'disconnected'); };
    ws.onerror = function () { status.setAttribute('data-state', 'error'); status.textContent = '[!] connection failed'; };
    term.onData(function (d) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d: d })); });
    if (term.onResize) term.onResize(function (s) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: s.cols, r: s.rows })); });
    return t;
  }
  function openChatTab(label) {
    var t = addTab(label || 'Chat', 'chat');
    var p = doc.createElement('p');
    p.textContent = 'Chat backend not wired yet — use a Claude CLI terminal for now.';
    t.panel.appendChild(p);
    return t;
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

  switchTo(null);
  window.__harness = { openTerminalTab: openTerminalTab, openChatTab: openChatTab,
    tabIds: function () { return Object.keys(tabs); }, active: function () { return active; } };
})();
`;

function machineOption(m: DevMachine): string {
  return `<option value="${esc(m.logicalName)}">${esc(m.logicalName)} (${esc(m.user)}@${esc(m.host)})</option>`;
}

function shortcuts(machines: readonly DevMachine[]): string {
  const ready = machines.filter((m) => m.provisioned && m.enabled);
  const notReady = machines.filter((m) => !(m.provisioned && m.enabled));
  if (machines.length === 0) {
    return `<p class="empty-state" data-state="empty">No dev machines configured. Add one in <a href="/admin/config">Configuration</a>.</p>`;
  }
  const readyHtml = ready
    .map(
      (m) =>
        `<button type="button" data-open-terminal="${esc(m.logicalName)}" data-action="open-terminal">Claude CLI → ${esc(
          m.logicalName
        )}</button>`
    )
    .join(" ");
  const notReadyHtml = notReady
    .map(
      (m) =>
        `<span data-state="unavailable">Claude CLI → ${esc(m.logicalName)} — <em>${esc(
          m.enabled ? "not provisioned" : "disabled"
        )}</em></span>`
    )
    .join(" ");
  return `<div class="shortcuts">${readyHtml}${notReadyHtml ? ` <div class="muted">${notReadyHtml}</div>` : ""}</div>`;
}

export function renderHarnessFrame(model: HarnessFrameModel): string {
  const ready = model.devMachines.filter((m) => m.provisioned && m.enabled);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pantheon Harness</title>
<link rel="stylesheet" href="/assets/xterm.css">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; }
  header { padding: .4rem .8rem; border-bottom: 1px solid #888; display: flex; gap: 1rem; align-items: center; }
  nav.tabs { display: flex; gap: .25rem; padding: .25rem .5rem; border-bottom: 1px solid #ccc; overflow-x: auto; }
  nav.tabs [role="tab"] { padding: .25rem .6rem; }
  nav.tabs [role="tab"][aria-selected="true"] { font-weight: 700; text-decoration: underline; }
  [data-close] { margin-left: .4rem; cursor: pointer; }
  main { flex: 1; min-height: 0; overflow: hidden; position: relative; }
  [data-tab-panel] { position: absolute; inset: 0; padding: .25rem; display: flex; flex-direction: column; }
  [data-tab-panel][hidden] { display: none; }
  .term-host { flex: 1; min-height: 0; }
  .term-status { font-family: monospace; padding: .2rem .4rem; }
  .glyph, .term-status { font-family: monospace; }
  dialog { border: 1px solid #888; border-radius: 6px; }
  .muted { color: #666; font-size: .9em; }
  form { margin: 0; }
</style>
</head>
<body>
<header><strong>Pantheon Harness</strong>
  <button type="button" data-action="new-session">+ New Session</button>
  <!-- Configuration lives in the page chrome, NOT inside the empty-state message: it used to
       appear only when the registry was empty, so registering the first machine removed the
       operator's only route back to the page that provisions it (BUGS #16). -->
  <a href="/admin/config" data-nav="config">Configuration</a>
  <a href="/help" data-nav="help">Help</a>
</header>

<!-- Tab bar: terminal/chat tabs are added here at runtime -->
<nav class="tabs" data-tabbar role="tablist" aria-label="Open sessions"></nav>

<main data-panels>
  <section data-welcome>
    <h2>Start a session</h2>
    <p>Use <strong>New Session</strong>, or a shortcut below. Sessions open as tabs above; close a tab with its ✕.</p>
    ${shortcuts(model.devMachines)}
  </section>
</main>

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

${model.chatUrl !== undefined ? `<!-- chat: ${esc(model.chatUrl)} -->` : ""}
<script src="/assets/xterm.js"></script>
<script>${HARNESS_CLIENT_JS}</script>
</body>
</html>`;
}
