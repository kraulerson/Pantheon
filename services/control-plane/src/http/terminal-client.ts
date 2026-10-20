/**
 * Browser-side terminal wiring shared by both hosts (the harness tab shell and the standalone
 * terminal page), so they cannot drift apart.
 *
 * Two operator reports (2026-08-29) shaped this:
 *
 *  - **Scroll corruption** — `convertEol` is deliberately NOT set. It rewrites a bare line feed as
 *    CR+LF, which drags the cursor to column 0 on every LF. A PTY already sends CRLF (ONLCR), while
 *    full-screen apps (tmux, the Claude CLI) use a bare LF as "index": move down, KEEP the column.
 *    Converting it made their redraws land in the wrong column as soon as the screen scrolled, and
 *    only a resize — which forces the app to repaint everything — cleared it.
 *  - **Selection and copy** — while an app grabs the mouse (tmux, any TUI), xterm forwards drags to
 *    it instead of selecting, so a drag selected nothing; and xterm draws its own selection, so the
 *    browser's native copy has nothing to take. Hence: Option-drag forces selection on macOS,
 *    right-click selects a word, finishing a selection copies it, and ⌘C / Ctrl+Shift+C copy
 *    explicitly. Plain Ctrl+C is never taken — in a terminal it interrupts the running program.
 */

import { XTERM_THEME_JS } from "./theme.js";

/** The options literal (browser JS) every hosted terminal is constructed with. */
export const TERMINAL_OPTIONS_JS = `{
    fontFamily: '"Roboto Mono", Menlo, Consolas, monospace',
    theme: ${XTERM_THEME_JS},
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: true
  }`;

/**
 * Addons every hosted terminal loads, both optional and both failing soft:
 *  - **clipboard** — honours OSC 52, the escape sequence tmux emits (with `set-clipboard on`) when
 *    you copy in its copy-mode; without it a tmux copy only ever reaches tmux's own paste buffer.
 *    The addon gets OUR provider (BUGS #48, UAT-5 #10): tmux writes the sequence with an EMPTY
 *    selection field (`ESC ] 52 ; ; <base64> BEL`) and the addon's stock provider honours only
 *    `c`, so every tmux copy was silently dropped while an app's own `52;c;…` arrived. The same
 *    provider answers a clipboard READ query (`52;c;?`) with nothing — the operator's clipboard
 *    can hold a token, and the reply would travel into the PTY of a dev machine.
 *  - **webgl** — the GPU renderer. xterm's DOM renderer visibly lags once the grid fills a large
 *    window; if WebGL is unavailable or its context is lost we fall back to the DOM renderer.
 */
export const TERMINAL_ADDONS_JS = `
  function pantheonClipboardProvider() {
    return {
      // '' is what tmux sends; 'c' is the clipboard proper. 'p' (X11 primary) stays ignored: the Mac has none.
      // Direct write only, never the execCommand fallback: a remote write carries no user gesture, so the
      // fallback could only churn the DOM and pull focus off the terminal (adversarial review, finding 1).
      writeText: function (sel, text) {
        if ((sel === '' || sel === 'c') && text && navigator.clipboard && navigator.clipboard.writeText) {
          var p = navigator.clipboard.writeText(text); if (p && p.catch) p.catch(function () {});
        }
      },
      // Never hand the clipboard to a remote program (the addon echoes this reply into the PTY).
      readText: function () { return ''; }
    };
  }
  function pantheonLoadAddons(term) {
    try {
      if (window.ClipboardAddon && window.ClipboardAddon.ClipboardAddon) term.loadAddon(new window.ClipboardAddon.ClipboardAddon(undefined, pantheonClipboardProvider()));
    } catch (e) {}
    try {
      if (window.WebglAddon && window.WebglAddon.WebglAddon) {
        var gl = new window.WebglAddon.WebglAddon();
        if (gl.onContextLoss) gl.onContextLoss(function () { try { gl.dispose(); } catch (e) {} });
        term.loadAddon(gl);
        return 'gpu';
      }
    } catch (e) {} // no WebGL (unavailable, or blocked by a privacy shield) — xterm keeps its DOM renderer
    return 'software'; // SAID in the tab: this is the path that stutters on a large window
  }
  var PANTHEON_SOFTWARE_NOTE = ' — software rendering (a large window may stutter)';
`;

/** Function declarations (hoisted) that give a terminal a working clipboard. */
export const TERMINAL_CLIPBOARD_JS = `
  function pantheonCopyFallback(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    } catch (e) {}
  }
  function pantheonCopy(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        var p = navigator.clipboard.writeText(text);
        if (p && p.catch) p.catch(function () { pantheonCopyFallback(text); });
        return;
      }
    } catch (e) {}
    pantheonCopyFallback(text);
  }
  function pantheonWireClipboard(term, host, before) {
    if (term.attachCustomKeyEventHandler) term.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      if (before && before(e) === false) return false; // the host claimed this key (the console drawer's own keys)
      var key = String(e.key || '').toLowerCase();
      var copyChord = (e.metaKey && !e.ctrlKey && !e.altKey) || (e.ctrlKey && e.shiftKey && !e.metaKey);
      if (key === 'c' && copyChord) {
        var sel = term.getSelection ? term.getSelection() : '';
        if (sel) { pantheonCopy(sel); return false; } // handled here — never forwarded to the shell
      }
      return true; // everything else, including PLAIN Ctrl+C, goes to the PTY
    });
    if (host && host.addEventListener) host.addEventListener('mouseup', function () {
      var sel = term.getSelection ? term.getSelection() : '';
      if (sel) pantheonCopy(sel); // copy on select; an empty selection never clobbers the clipboard
    });
  }
`;

/**
 * `pantheonOpenTerminal(host, wsUrl, hooks)` — the one bootstrap every hosted xterm goes through (harness tabs, and
 * the console's Claude-session view and shell drawer): construct the Terminal with the shared options, load the fit
 * and the optional addons, wire the clipboard, open the socket and bridge frames. It needs the clipboard and addon
 * snippets above in the same scope. Returns `{ term, ws, ro, fit, close }`; `term` stays null when the engine failed
 * to load (nothing is dialled then, and `hooks.status` has said so).
 *
 * hooks: `label` (shown in the connected text), `status(state, text)` (state: connected | disconnected | error —
 * every text starts with a glyph, CC1), `hidden()` (optional; a hidden host measures 0×0 and must not be fitted),
 * `keyFilter(e)` (optional; returning false claims the key before the clipboard handler and xterm see it),
 * `onReady(id)` (the broker's reconnect id), `onTitle(title)` (the PTY's window title).
 */
export const TERMINAL_OPEN_JS = `
  function pantheonOpenTerminal(host, wsUrl, hooks) {
    var h = { term: null, ws: null, ro: null, fit: null };
    var term; var fit; var state = '';
    function say(st, text) { state = st; hooks.status(st, text); }
    try {
      term = new window.Terminal(${TERMINAL_OPTIONS_JS});
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(host);
    } catch (e) {
      // Fail closed AND labeled: no engine → no socket, and the host says why.
      say('error', '[!] terminal engine failed to load — reload the page');
      return h;
    }
    h.term = term;
    // Size the grid to the host (operator report 2026-08-27: xterm's 80×24 default filled ~60% of the
    // width and never grew). Only while visible — a hidden panel measures 0×0 and would shrink the PTY.
    var renderer = pantheonLoadAddons(term); // OSC-52 clipboard + GPU renderer (operator report 2026-08-30)
    if (host.setAttribute) host.setAttribute('data-renderer', renderer);
    pantheonWireClipboard(term, host, hooks.keyFilter); // selection + ⌘C / Ctrl+Shift+C (operator report 2026-08-29)
    h.fit = function () { if (!(hooks.hidden && hooks.hidden())) fit.fit(); };
    h.fit();
    if (window.ResizeObserver) { h.ro = new window.ResizeObserver(function () { h.fit(); }); h.ro.observe(host); }
    var ws = new WebSocket(wsUrl); h.ws = ws;
    ws.onmessage = function (ev) {
      var f; try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.t === 'ready') {
        say('connected', '[✓] connected to ' + hooks.label + (renderer === 'software' ? PANTHEON_SOFTWARE_NOTE : ''));
        // The first fit ran before the socket was open, so tell the PTY the size explicitly now.
        h.fit();
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
        if (hooks.onReady && typeof f.id === 'string') hooks.onReady(f.id); // never replay ?session=undefined
      }
      else if (f.t === 'o') { term.write(f.d); }
      else if (f.t === 'x') { say('disconnected', '[x] disconnected — close tab to dismiss'); }
      else if (f.t === 'e') { say('error', typeof f.m === 'string' ? '[!] ' + f.m : '[!] connection error'); }
    };
    ws.onclose = function () {
      // A dropped socket must be SAID, not just attributed — but never over the error that explains it.
      if (state !== 'error') say('disconnected', '[x] disconnected — close tab to dismiss');
    };
    ws.onerror = function () { say('error', '[!] connection failed'); };
    term.onData(function (d) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d: d })); });
    if (term.onResize) term.onResize(function (s) { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'r', c: s.cols, r: s.rows })); });
    if (hooks.onTitle && term.onTitleChange) term.onTitleChange(function (t) { hooks.onTitle(t); });
    // The host leaves for good: end the broker-side terminal, drop the socket, free the engine.
    h.close = function () {
      if (h.ro) h.ro.disconnect();
      try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'c' })); } catch (e) {}
      try { ws.close(); } catch (e) {}
      try { if (term.dispose) term.dispose(); } catch (e) {}
    };
    return h;
  }
`;
