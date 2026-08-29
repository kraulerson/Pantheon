/**
 * Server-rendered Claude-CLI terminal tab (Task #16d, PROJECT_BIBLE §9 C.6, ADR-0005).
 *
 * Plain template strings (no SPA, matching config-page.ts). Loads xterm.js from the control-plane's
 * own static assets (`/assets/xterm.*`), opens a WebSocket to the broker (`/terminal/:logicalName`),
 * and renders the four §9 C.6 states COLORBLIND-SAFE: each state has a TEXT label + a shape/icon
 * glyph + `data-state`, never color alone. The SSH key never reaches the browser — the page only
 * speaks the JSON frame protocol to the server-side broker (TM-020/#14b).
 */

import { withBase } from "./base-path.js";
import { pageHead, XTERM_THEME_JS } from "./theme.js";
import { withBuild } from "./build-id.js";

export interface TerminalTabModel {
  readonly logicalName?: string;
  readonly user?: string;
  readonly host?: string;
  readonly port?: number;
  /** Whether any dev machines are configured (drives the two Empty messages). */
  readonly hasMachines: boolean;
  /** WebSocket path override; defaults to `<base>/terminal/<logicalName>`. */
  readonly wsPath?: string;
  /** Mount prefix for this request (`/harness` on the chat site, `""` on the admin site). */
  readonly base?: string;
}

/** Escape the five HTML-significant characters — fail-closed against markup injection. */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Safely embed a string into an inline <script> (escape `<` so `</script>` can't break out). */
function jsString(value: unknown): string {
  return JSON.stringify(String(value)).replace(/</g, "\\u003c");
}

function emptyTab(hasMachines: boolean, base: string): string {
  const msg = hasMachines
    ? `No dev machine selected — choose one in New Session.`
    : `No dev machines configured (add one in Configuration).`;
  const target = hasMachines ? "New Session" : "Configuration";
  return `<!DOCTYPE html><html lang="en" data-base="${esc(base)}"><head><meta charset="utf-8"><title>Terminal</title>
${pageHead(base)}
</head>
<body>
<section aria-labelledby="h-term"><h2 id="h-term">Claude CLI Terminal</h2>
<p class="empty-state" data-state="empty"><span class="glyph" aria-hidden="true">[ ]</span> ${esc(msg)}</p>
<p><a href="${withBase(base, hasMachines ? "/harness" : "/admin/config")}" data-goto="${esc(target)}">${esc(target)}</a></p>
</section>
</body></html>`;
}

export function renderTerminalTab(model: TerminalTabModel): string {
  const base = model.base ?? "";
  if (!model.logicalName) return emptyTab(model.hasMachines, base);

  const logicalName = model.logicalName;
  const wsPath = model.wsPath ?? withBase(base, `/terminal/${encodeURIComponent(logicalName)}`);
  const conn = `${esc(model.user ?? "")}@${esc(model.host ?? "")}:${esc(model.port ?? 22)}`;

  return `<!DOCTYPE html>
<html lang="en" data-base="${esc(base)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude CLI — ${esc(logicalName)}</title>
${pageHead(base)}
<link rel="stylesheet" href="${withBuild(withBase(base, "/assets/xterm.css"))}">
<style>
  body { margin: 0; display: flex; flex-direction: column; height: 100vh; }
  header { padding: .4rem .8rem; }
  #terminal { flex: 1; min-height: 0; }
  .status { display: inline-block; padding: .15rem .5rem; }
  .glyph { font-family: monospace; }
  [hidden] { display: none; }
</style>
</head>
<body>
<header>
  <strong>Claude CLI</strong> — terminal to <code>${esc(logicalName)}</code> (${conn})
  <!-- COLORBLIND-SAFE state line (CC1): text label + glyph + data-state, never color alone -->
  <span id="state-loading" class="status" data-state="loading" role="status" aria-live="polite"><span class="glyph">[~]</span> Connecting to ${esc(
    logicalName
  )} (${conn})…</span>
  <span id="state-connected" class="status" data-state="connected" role="status" aria-live="polite" hidden><span class="glyph">[✓]</span> connected to ${esc(
    logicalName
  )}</span>
  <span id="state-disconnected" class="status" data-state="disconnected" role="status" aria-live="polite" hidden><span class="glyph">[x]</span> disconnected — reconnect?</span>
  <span id="state-error" class="status banner-error" data-state="error" role="alert" hidden><span class="glyph">[!]</span> <span id="error-msg">Terminal error</span></span>
</header>
<div id="terminal" role="application" aria-label="Claude CLI terminal for ${esc(logicalName)}"></div>
<script src="${withBuild(withBase(base, "/assets/xterm.js"))}"></script>
<script src="${withBuild(withBase(base, "/assets/xterm-addon-fit.js"))}"></script>
<script>
(function () {
  var WS_PATH = ${jsString(wsPath)};
  var states = ["loading", "connected", "disconnected", "error"];
  function setState(s, msg) {
    states.forEach(function (k) {
      var el = document.getElementById("state-" + k);
      if (el) el.hidden = (k !== s);
    });
    if (s === "error" && msg) { var m = document.getElementById("error-msg"); if (m) m.textContent = msg; }
  }
  var term = new window.Terminal({ convertEol: true, fontFamily: '"Roboto Mono", Menlo, Consolas, monospace', theme: ${XTERM_THEME_JS} });
  // Fit the grid to the page (operator report 2026-08-27: the 80×24 default filled ~60% of the width and never grew).
  var fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  var host = document.getElementById("terminal");
  term.open(host);
  fit.fit();
  if (window.ResizeObserver) new window.ResizeObserver(function () { fit.fit(); }).observe(host);
  window.addEventListener("resize", function () { fit.fit(); });
  var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + WS_PATH;
  var ws = new WebSocket(url);
  setState("loading");
  ws.onmessage = function (ev) {
    var f; try { f = JSON.parse(ev.data); } catch (e) { return; }
    if (f.t === "ready") {
      setState("connected");
      fit.fit();
      // The first fit ran before the socket was open — tell the PTY the size explicitly now.
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
    }
    else if (f.t === "o") term.write(f.d);
    else if (f.t === "x") setState("disconnected");
    else if (f.t === "e") setState("error", f.m);
  };
  ws.onclose = function () { setState("disconnected"); };
  ws.onerror = function () { setState("error", "connection failed"); };
  term.onData(function (d) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "i", d: d })); });
  term.onResize(function (sz) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: "r", c: sz.cols, r: sz.rows })); });
})();
</script>
</body>
</html>`;
}
