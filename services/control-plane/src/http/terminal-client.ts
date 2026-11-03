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
 *    browser's native copy has nothing to take. Hence: right-click selects a word, finishing a
 *    selection copies it, and ⌘C / Ctrl+Shift+C copy explicitly.
 *
 * BUGS #84 (2026-10-29) made every terminal copy like a standard one, whatever the remote tmux's
 * `mouse` setting: the remote's mouse-tracking requests are swallowed (a plain drag, double- and
 * triple-click select in the browser) but remembered, so the wheel is still reported and tmux
 * history still scrolls. Given up for it: tmux's own mouse highlight, click-to-pick a pane,
 * dragging pane borders and tmux's right-click menu. On a Mac plain Ctrl+C always interrupts; on
 * Linux/Windows it copies a highlight (and clears it, so the next one interrupts).
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
  // The same test xterm makes (its Platform.ts), so the copy chord and xterm's own Mac handling can never disagree.
  function pantheonIsMac() {
    return ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'].indexOf(String(navigator.platform)) !== -1;
  }
  // BUGS #84: xterm never enters mouse-reporting mode, so the mouse always selects in the browser. The remote's
  // DECSET/DECRST mouse modes are swallowed and recorded; the wheel is then reported here, in the encoding the remote
  // asked for (SGR only), through the same path as typed data (term.input → onData → the socket).
  function pantheonWireMouse(term) {
    var TRACKING = [9, 1000, 1002, 1003]; // X10, VT200, button-event, any-event (xterm: the last one set wins)
    var ENCODINGS = [1005, 1006, 1015]; // UTF-8, SGR, urxvt — xterm ignores 1005/1015 (it honours 1006, and 1016, left alone here)
    var remote = { tracking: 0, sgr: false };
    var partial = 0; // wheel travel below one line, carried to the next event
    function onMode(set) {
      return function (params) {
        var rest = []; var mouse = false;
        for (var i = 0; i < params.length; i++) {
          var p = params[i];
          if (typeof p !== 'number') continue; // a sub-parameter list: DECSET ignores those
          if (TRACKING.indexOf(p) !== -1) { mouse = true; remote.tracking = set ? p : 0; }
          else if (ENCODINGS.indexOf(p) !== -1) { mouse = true; if (p === 1006) remote.sgr = set; }
          else rest.push(p);
        }
        if (!mouse) return false; // xterm applies it as usual
        // A mixed sequence (CSI ? 1000 ; 25 h): the other modes are re-issued without the mouse ones. They land after
        // whatever output is already queued — the price of xterm's public parser API, which cannot edit params.
        if (rest.length) term.write('\\x1b[?' + rest.join(';') + (set ? 'h' : 'l'));
        return true;
      };
    }
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, onMode(true));
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, onMode(false));
    // RIS (ESC c) resets xterm's mouse state; forget the remote's request with it, and let xterm reset as usual.
    term.parser.registerEscHandler({ final: 'c' }, function () { remote.tracking = 0; remote.sgr = false; partial = 0; return false; });
    term.attachCustomWheelEventHandler(function (ev) {
      // Not asked for (or X10, which has no wheel): xterm's own wheel path, unchanged — it scrolls the scrollback,
      // or on a screen without one (tmux's alternate screen) sends ↑/↓ arrow keys.
      if (remote.tracking === 0 || remote.tracking === 9) return true;
      // Tracked from here on. xterm's own mouse-mode listener cancelled the event (cancel(ev, true)); a custom handler
      // that returns false skips that, so cancel it here or the page scrolls under the terminal and Ctrl+wheel zooms.
      ev.preventDefault();
      ev.stopPropagation();
      // Every return below is false: no arrow-key fallback. (In the normal buffer xterm's Viewport sees the wheel
      // before this handler and may scroll; under tmux — the alternate screen, no scrollback — it has nothing to scroll.)
      if (ev.deltaY === 0 || ev.shiftKey) return false; // xterm reports neither
      var r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
      var cellH = r.height / term.rows;
      var lines;
      if (ev.deltaMode === 1) lines = ev.deltaY; // DOM_DELTA_LINE
      else if (ev.deltaMode === 2) lines = ev.deltaY * term.rows; // DOM_DELTA_PAGE
      else {
        // Pixels, as xterm measures them (CoreMouseService.consumeWheelEvent): a trackpad's small deltas are damped
        // and accumulate, and one event sends at most one report, so a mouse notch scrolls tmux as it did before.
        partial += (ev.deltaY / cellH) * (Math.abs(ev.deltaY) < 50 ? 0.3 : 1);
        lines = Math.floor(Math.abs(partial)) * (partial > 0 ? 1 : -1);
        partial %= 1;
      }
      if (lines === 0) return false;
      var col = Math.min(Math.max(Math.floor((ev.clientX - r.left) / (r.width / term.cols)), 0), term.cols - 1) + 1;
      var row = Math.min(Math.max(Math.floor((ev.clientY - r.top) / cellH), 0), term.rows - 1) + 1;
      var code = (ev.deltaY < 0 ? 64 : 65) | (ev.altKey ? 8 : 0) | (ev.ctrlKey ? 16 : 0);
      // SGR only: xterm sent the default (X10) encoding through onBinary, which no host subscribes to, so an X10
      // report never reached the PTY — sending one now would widen what does.
      if (remote.sgr) term.input('\\x1b[<' + code + ';' + col + ';' + row + 'M', false);
      return false;
    });
  }
  function pantheonWireClipboard(term, host, before) {
    var mac = pantheonIsMac();
    pantheonWireMouse(term);
    if (term.attachCustomKeyEventHandler) term.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      if (before && before(e) === false) return false; // the host claimed this key (the console drawer's own keys)
      var key = String(e.key || '').toLowerCase();
      var copyChord = (e.metaKey && !e.ctrlKey && !e.altKey) || (e.ctrlKey && e.shiftKey && !e.metaKey);
      // Linux/Windows: plain Ctrl+C copies a highlight, then clears it so the next Ctrl+C interrupts. Never on a Mac.
      var pcCopy = !mac && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
      if (key === 'c' && (copyChord || pcCopy)) {
        var sel = term.getSelection ? term.getSelection() : '';
        if (sel) { pantheonCopy(sel); if (pcCopy) term.clearSelection(); return false; } // handled here — never forwarded to the shell
      }
      return true; // everything else, including Ctrl+C with nothing highlighted (and always on a Mac), goes to the PTY
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
    pantheonWireClipboard(term, host, hooks.keyFilter); // selection, wheel + copy chords (2026-08-29, BUGS #84)
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
