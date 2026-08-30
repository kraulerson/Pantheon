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
 *  - **webgl** — the GPU renderer. xterm's DOM renderer visibly lags once the grid fills a large
 *    window; if WebGL is unavailable or its context is lost we fall back to the DOM renderer.
 */
export const TERMINAL_ADDONS_JS = `
  function pantheonLoadAddons(term) {
    try {
      if (window.ClipboardAddon && window.ClipboardAddon.ClipboardAddon) term.loadAddon(new window.ClipboardAddon.ClipboardAddon());
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
  function pantheonWireClipboard(term, host) {
    if (term.attachCustomKeyEventHandler) term.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
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
