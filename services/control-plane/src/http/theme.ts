/**
 * LibreChat-matched theme (ruling 2026-08-27: "match the LibreChat theme so it feels contiguous").
 *
 * ONE shared stylesheet, served from our origin as a public asset, carrying LibreChat v0.8.7's own
 * token VALUES (read from its built stylesheet on 2026-08-27 — greys, surfaces, text, borders,
 * font stacks) and the console's component styles on top. Not linked from LibreChat's hashed bundle
 * (that changes per release); copied values, no runtime coupling.
 *
 * The boot script follows LibreChat's own switch: `localStorage["color-theme"]` ∈ dark | light |
 * system (same-origin under the chat address), falling back to the OS preference, and applies the
 * `dark` class on <html> exactly as LibreChat does. Colour is decoration only — every state on every
 * page stays words + glyph + `data-state` (CC1).
 */

import { withBase } from "./base-path.js";

export const THEME_ASSET_PATH = "/assets/harness.css";

export const HARNESS_THEME_CSS = `/* Pantheon Harness — LibreChat v0.8.7 token values (light) */
:root {
  --gray-50: #f7f7f8; --gray-100: #ececec; --gray-200: #e3e3e3; --gray-300: #cdcdcd; --gray-400: #999696;
  --gray-500: #595959; --gray-600: #424242; --gray-700: #2f2f2f; --gray-800: #212121; --gray-850: #171717; --gray-900: #0d0d0d;
  --green-700: #047857; --green-800: #065f46; --red-600: #dc2626; --red-700: #b91c1c; --red-800: #991b1b; --amber-500: #f59e0b;
  --surface-primary: #fff; --surface-primary-alt: #f7f7f8; --surface-secondary: #f7f7f8; --surface-tertiary: #ececec;
  --surface-hover: #e3e3e3; --surface-dialog: #fff; --surface-submit: #047857; --surface-submit-hover: #065f46;
  --surface-destructive: #b91c1c; --surface-destructive-hover: #991b1b; --header-primary: #fff;
  --text-primary: #212121; --text-secondary: #424242; --text-tertiary: #595959; --text-warning: #f59e0b; --text-destructive: #dc2626;
  --border-light: #e3e3e3; --border-medium: #cdcdcd; --border-heavy: #999696;
  --font-sans: system-ui, Inter, "Söhne Circle", -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", sans-serif;
  --font-mono: "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --radius: .5rem;
  color-scheme: light;
}
/* LibreChat v0.8.7 token values (dark) */
html.dark {
  --surface-primary: #0d0d0d; --surface-primary-alt: #171717; --surface-secondary: #212121; --surface-tertiary: #2f2f2f;
  --surface-hover: #424242; --surface-dialog: #171717; --surface-submit: #047857; --surface-submit-hover: #065f46;
  --surface-destructive: #991b1b; --surface-destructive-hover: #7f1d1d; --header-primary: #2f2f2f;
  --text-primary: #ececec; --text-secondary: #cdcdcd; --text-tertiary: #999696; --text-warning: #f59e0b; --text-destructive: #dc2626;
  --border-light: #2f2f2f; --border-medium: #424242; --border-heavy: #595959;
  color-scheme: dark;
}

html { background: var(--surface-primary); }
body { background: var(--surface-primary); color: var(--text-primary); font-family: var(--font-sans); font-size: .9375rem; line-height: 1.45; -webkit-font-smoothing: antialiased; }
a { color: var(--text-primary); text-decoration: underline; text-underline-offset: 2px; }
a:hover { color: var(--text-secondary); }
code, pre, kbd, .glyph, .mono, .ref { font-family: var(--font-mono); font-size: .875em; }
h1 { font-size: 1.125rem; font-weight: 600; margin: 0 0 .75rem; }
h2 { font-size: 1rem; font-weight: 600; margin: 0 0 .5rem; }
h3 { font-size: .9375rem; font-weight: 600; margin: .75rem 0 .35rem; }
p { margin: .5rem 0; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: var(--surface-tertiary); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius); padding: .35rem .75rem; cursor: pointer; }
button:hover { background: var(--surface-hover); }
button[type="submit"], button.primary { background: var(--surface-submit); border-color: transparent; color: #fff; }
button[type="submit"]:hover, button.primary:hover { background: var(--surface-submit-hover); }
button.danger, [data-form="revoke-keycard"] button, [data-action="remove"] { background: var(--surface-destructive); border-color: transparent; color: #fff; }
input, select, textarea { background: var(--surface-primary); border: 1px solid var(--border-medium); border-radius: var(--radius); padding: .35rem .5rem; }
input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, a:focus-visible, [role="tab"]:focus-visible { outline: 2px solid var(--border-heavy); outline-offset: 1px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--border-light); padding: .4rem .6rem; text-align: left; vertical-align: top; }
th { background: var(--surface-secondary); color: var(--text-secondary); font-weight: 600; }
section { background: var(--surface-primary-alt); border: 1px solid var(--border-light); border-radius: var(--radius); padding: 1rem; margin-bottom: 1rem; }
.banner { background: var(--surface-secondary); border: 1px solid var(--border-heavy); border-radius: var(--radius); padding: .6rem .8rem; margin-bottom: 1rem; }
.banner-error, .warn, [role="alert"] { border-color: var(--text-destructive); }
.muted { color: var(--text-tertiary); }
.empty-state { color: var(--text-secondary); font-style: italic; }
dialog { background: var(--surface-dialog); color: var(--text-primary); border: 1px solid var(--border-medium); border-radius: var(--radius); padding: 1rem 1.25rem; }
dialog::backdrop { background: rgba(0, 0, 0, .55); }
/* console chrome (harness frame, standalone terminal page) */
body > header { background: var(--surface-secondary); border-bottom: 1px solid var(--border-light); }
nav.launch-bar { background: var(--surface-primary-alt); border-bottom: 1px solid var(--border-light); color: var(--text-secondary); }
nav.tabs { background: var(--surface-primary-alt); border-bottom: 1px solid var(--border-light); }
nav.tabs [role="tab"] { background: transparent; border: 1px solid transparent; border-bottom: 0; border-radius: var(--radius) var(--radius) 0 0; color: var(--text-secondary); }
nav.tabs [role="tab"]:hover { background: var(--surface-hover); }
nav.tabs [role="tab"][aria-selected="true"] { background: var(--surface-primary); border-color: var(--border-light); color: var(--text-primary); font-weight: 600; text-decoration: underline; }
.term-status, .status { color: var(--text-secondary); font-family: var(--font-mono); font-size: .875em; }
.term-host, #terminal { background: #0d0d0d; }
.chat-host { flex: 1; min-height: 0; width: 100%; border: 0; background: var(--surface-primary); }
/* sidebar (harness frame): LibreChat's conversation-list look */
.sidebar { background: var(--surface-primary-alt); border-right: 1px solid var(--border-light); }
.side-heading { font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-tertiary); margin: .6rem .5rem .2rem; }
.side-item, .machine-toggle { display: flex; align-items: center; gap: .5rem; width: 100%; text-align: left; background: transparent; border: 1px solid transparent; border-radius: var(--radius); padding: .45rem .6rem; color: var(--text-primary); cursor: pointer; }
.side-item:hover, .machine-toggle:hover { background: var(--surface-hover); }
.machine-toggle[aria-expanded="true"] { background: var(--surface-secondary); }
.machine[data-state="ready"] .machine-toggle .glyph { color: var(--text-primary); }
.machine-launch .shell-btn { width: 100%; text-align: left; }
.tmux-sessions button { width: 100%; }
`;

/** Applies LibreChat's stored choice (or the OS preference) as the \`dark\` class, and keeps following it. */
export const THEME_BOOT_JS = `(function () {
  function prefersDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  // LibreChat's ThemeProvider writes the raw word; its jotai storage form is JSON-quoted ("dark"). Accept both.
  function read() { try { var v = window.localStorage.getItem('color-theme'); return v ? v.replace(/^"|"$/g, '') : v; } catch (e) { return null; } }
  function apply(v) { var dark = v === 'dark' || (v !== 'light' && prefersDark()); document.documentElement.classList.toggle('dark', dark); }
  apply(read());
  window.addEventListener('storage', function (e) { if (e.key === 'color-theme') apply(e.newValue); });
  if (window.matchMedia) { var mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq && mq.addEventListener) mq.addEventListener('change', function () { apply(read()); }); }
})();`;

/**
 * Console pages are never meant to live inside a frame. CSP `frame-ancestors 'self'` already refuses
 * every cross-origin ancestor; a SAME-origin ancestor (the chat tab's footer link loading the console
 * inside the embedded chat page — audit 2026-08-27 B/F-A) is allowed through and then busted here to
 * the top window, which is what the operator asked for by clicking "Terminals".
 */
export const FRAME_BUST_JS = `if (window.top !== window.self) { try { window.top.location.replace(window.location.href); } catch (e) {} }`;

/** The <head> lines every console page carries: the shared stylesheet, the theme boot, the frame-bust. */
export function pageHead(base: string): string {
  return `<link rel="stylesheet" href="${withBase(base, THEME_ASSET_PATH)}">\n<script>${FRAME_BUST_JS}</script>\n<script>${THEME_BOOT_JS}</script>`;
}

/**
 * xterm.js colours: LibreChat's DARK surface in BOTH themes — xterm's default ANSI palette (Claude
 * Code's yellows/bright greens) is unreadable on white (audit 2026-08-27 B/F-D), and a dark terminal
 * panel inside a light page is the convention every editor follows.
 */
export const XTERM_THEME_JS = `{ background: '#0d0d0d', foreground: '#ececec', cursor: '#ececec', cursorAccent: '#0d0d0d', selectionBackground: '#424242' }`;
