# Security Audit — tmux copies reach the clipboard: Pantheon OSC 52 provider (BUGS #48)

**Change:** `bugs-48-tmux-clipboard-osc52` — a bug fix, not a cutline feature (the commit gate
requires a Build Loop for any source commit, so it runs under one). `services/control-plane/src/http/terminal-client.ts`:
`pantheonLoadAddons` now constructs `@xterm/addon-clipboard` 0.2.0 with a Pantheon
`IClipboardProvider` instead of the stock `BrowserClipboardProvider`. Both terminal hosts
(`harness-frame.ts`, `terminal-tab.ts`) embed the same string, so both get it.
**Date:** 2026-10-16
**Trigger:** UAT-5 scenario 10 FAIL (agent tester); Karl: Fix Now, option B1 (harness-side).
**Persona:** Senior Security Engineer (Phase 2.4). **Method:** self-audit by the implementer plus
ONE independent adversarial reviewer (fresh agent, top tier, max effort — Karl's standing rule for
security code); findings of the independent review are in the last section.
**Scope refs:** BUGS #46 (the 2026-08-30 clipboard work this corrects), #48, #49; TM-020 (the
terminal is a distinct trust surface: a program on a dev machine is not trusted with the operator's
browser); CC2 fail closed; PROJECT_BIBLE §7.

## Headline

**The change adds exactly one accepted input form (tmux's empty selection field) to a write path
a remote program could already drive with `52;c;…`, and it closes a read path the stock provider
left open.** No new server surface, no new asset, no dependency change (addon stays exact-pinned
at 0.2.0). Residual: clipboard clobbering by a remote program as a paste-hijack vector is
**pre-existing** (any `52;c;…` since 2026-08-30) and is recorded, not fixed, here.

## Root cause (verified in the pinned code, not inferred)

`node_modules/@xterm/addon-clipboard/src/ClipboardAddon.ts:80-84`:

```ts
public async writeText(selection, text) {
  if (selection !== 'c') { return Promise.resolve(); }
  return navigator.clipboard.writeText(text);
}
```

tmux writes its copies through terminfo `Ms` with an **empty** selection field
(`ESC ] 52 ; ; <base64> BEL`), so every tmux copy arrived as `52;;<base64>` and was dropped.
The tester's control test (`52;c;…` lands, `52;;…` and `52;s;…` do not) matches this exactly.

## The change

```js
function pantheonClipboardProvider() {
  return {
    writeText: function (sel, text) {
      if ((sel === '' || sel === 'c') && text && navigator.clipboard && navigator.clipboard.writeText) {
        var p = navigator.clipboard.writeText(text); if (p && p.catch) p.catch(function () {});
      }
    },
    readText:  function () { return ''; }
  };
}
term.loadAddon(new window.ClipboardAddon.ClipboardAddon(undefined, pantheonClipboardProvider()));
```

The write goes straight to `navigator.clipboard.writeText`; empty text is a no-op. It deliberately
does **not** use `pantheonCopy`'s `execCommand('copy')` fallback (the ⌘C / copy-on-select path keeps
it): a remote write carries no user gesture, so from OSC 52 the fallback could only churn the DOM and
pull focus off the terminal (independent review, finding 1 — the first draft of this fix did route
through `pantheonCopy`; corrected before deploy).

## Threats considered

| # | Threat | Control / observation | Verdict |
|---|---|---|---|
| 1 | **Paste hijack** — a program on the dev machine (or an AI agent in the session) writes a shell command to the operator's clipboard via OSC 52; the operator later pastes it into a terminal. | **Pre-existing:** the stock provider already honoured `52;c;…` from any remote program since 2026-08-30 (BUGS #46). The change adds the empty-field form, nothing else; `p` and other fields stay ignored. No new control added. | Residual, pre-existing (SEV-3, see Findings F1) |
| 2 | **Clipboard read** — a remote program sends `52;c;?`; the stock provider answered with `navigator.clipboard.readText()` (behind the browser's one-time permission prompt) and the addon echoed the base64 result **into the PTY** — a token on the clipboard reaches the dev machine. | `readText` returns `''` for every selection. The addon still replies because `_setOrReportClipboard` always answers a query; the reply is `ESC ] 52 ; <selection as sent> ; BEL` — empty clipboard payload, selection field echoed verbatim (see F2). Test: `clipboardReads === 0` and the reply is pinned to exactly `\x1b]52;c;\x07`. | Closed (was SEV-2 exposure) |
| 3 | **Clipboard clearing / clobber with empty text** — an invalid base64 payload decodes to `''`; the stock provider would `writeText('')` and clear the operator's clipboard. | `pantheonCopy` returns on empty text — a malformed or empty payload never touches the clipboard. | Improved |
| 4 | **Hostile text content** — control characters, bidi/zero-width characters, embedded newlines in the copied text. | Passes through unchanged, exactly as the `c` form always did and as ⌘C of on-screen text does; the clipboard is the operator's own. Newline-on-paste risk is threat 1. | Same as before |
| 5 | **Payload size / rate** — a remote program floods OSC 52 writes or sends a very large payload. | Each write is one `navigator.clipboard.writeText` on the operator's own machine; no server involvement, no storage. xterm's OSC parser bounds are unchanged by this change (not re-measured here — see Independent review). | Same as before |
| 6 | **Only one host fixed** — the standalone terminal page and the tab shell drift apart. | Both hosts embed `TERMINAL_CLIPBOARD_JS` then `TERMINAL_ADDONS_JS` from the single `terminal-client.ts` (`harness-frame.ts:58-59`, `terminal-tab.ts:114-115`); grep shows no other `ClipboardAddon` construction. | Covered |
| 7 | **Fix that cannot be trusted** — tests that pass without the change. | New tests drive the **real pinned addon class** through a stand-in parser; 3 of 6 new cases failed before the change for the stated reasons (empty field dropped; clipboard read reached `navigator.clipboard`; shell passed no provider). The `c` and `p` cases are regression guards and passed before, by design. | Covered |
| 8 | **Server / asset / dependency surface** | None changed. Addon served from our origin, build-versioned, exact-pinned 0.2.0 as before. | No change |

## Findings

- **F1 — SEV-3, pre-existing, recorded not fixed:** any program on a dev machine can set the
  operator's clipboard through a harness terminal (OSC 52 write). This has been true for the `c`
  form since 2026-08-30; it is the price of letting tmux copies reach the Mac, and the operator's
  shells use bracketed paste (zsh default), which shows a pasted multi-line command before running
  it. Candidate hardening for a later Build Loop: a visible "clipboard set by the session" notice
  in the tab status line, or an operator toggle per tab. Tracked under BUGS #48's row as a residual.
- **F2 — SEV-4, pre-existing, accepted (wording corrected by the independent review):** the
  addon always answers a clipboard query, so the PTY receives `ESC ] 52 ; <selection> ; BEL` with an
  empty payload. The selection field is the remote program's own string echoed verbatim (printable
  characters only — the OSC parser drops C0 controls, so no newline — up to xterm's 10,000,000-char
  OSC payload limit, terminated by the BEL the addon appends). A program can therefore make the
  terminal type a bounded amount of its own text back into its own PTY. The stock provider did the
  identical thing for every non-`c` selection, so nothing is widened. Suppressing the reply
  (`readText` returning a rejected Promise) was verified to work at the cost of one uncaught
  console exception per query; a synchronous throw or a never-settling Promise **wedges the
  terminal** and must never be used. `return ''` stays.
- **F3 — SEV-4, new, FIXED before deploy (independent review, finding 1):** the first draft routed
  OSC 52 writes through `pantheonCopy`, whose `execCommand('copy')` fallback (temporary textarea +
  `select()`) became reachable from a remote program for the first time — writes from an
  unfocused window are rejected by the browser, so a loop of `printf '\e]52;;AA==\a'` would have
  churned the DOM and pulled focus off the terminal input (focus theft code-evident, not
  reproduced in jsdom). Fix: the provider writes directly to `navigator.clipboard.writeText` and
  swallows the rejection; the fallback stays reserved for ⌘C / copy-on-select, which carry a user
  gesture. Test: with `writeText` rejecting, an OSC 52 write calls `execCommand` zero times and
  leaves no textarea behind (RED before the change, GREEN after).

## Verification

- RED: `Tests 2 failed | 3 passed (5)` in `test/terminal-clipboard-osc52.test.ts` and `1 failed` in
  `test/harness-shell.test.ts` before the change, each for the expected reason; the F3 follow-up
  test failed once (`expected "spy" to not be called at all, but actually been called 1 times`)
  before its fix.
- GREEN after the follow-up: `Test Files 58 passed | 1 skipped (59)`, `Tests 678 passed | 5 skipped
  (683)`; `tsc` exit 0; `eslint` exit 0.
- Live confirmation by the operator (Ctrl-b `[`, select, copy, paste outside the browser) is owed
  after deploy and carried to UAT-6 with scenario 9.

## Independent adversarial review (fresh agent, top tier, max effort — reviewed commit `9348a52` in a scratch clone)

**Verdict: SHIP.** Method: re-ran the suite in a clone (`675 passed | 7 skipped` — the two extra
skips are environment-gated live tests, unrelated); ran the two clipboard test files verbose (66
green); `tsc` exit 0; a seven-mutation sweep on `terminal-client.ts` (drop the tmux form, drop the
app form, honour every selection, read the real clipboard, return a secret synchronously, use the
stock provider, revert to the parent commit) — **every new test has a one-line production change
that fails it**; drove the **real** `@xterm/xterm` 6.0.0 parser plus the real addon in jsdom with
tmux's bytes, a hostile program's bytes, BEL and ST terminators, `CAN` abort, extra `;` segments.

Findings, as triaged here:
1. SEV-4, new, remotely reachable — execCommand fallback reachable from OSC 52 → **F3, fixed**.
2. SEV-4, pre-existing — query reply reflects the selection field → **F2, wording corrected**;
   `return ''` confirmed as the correct default (throw / pending Promise wedge the terminal).
3. Test nit — the read test's `not.toContain` loop was vacuous when no reply exists → reply shape
   now pinned to `\x1b]52;c;\x07`.
4. Doc nits — BUGS #48 fix hash filled in; the CHANGELOG's "behind the browser's one-time
   permission prompt" claim was unverified and is reworded to the verified code path.
5. No finding — invalid or empty base64 no longer clears the clipboard (strictly less capability).

Answers: write capability **not widened** (any `52;c;…` already wrote arbitrary text, controls and
bidi included; size 10 MB per OSC and rate unchanged; the new provider returns `undefined`, so the
parser is no longer paused per write — an availability improvement). Read path **closed** against
the real parser; no other page JS reads `navigator.clipboard`. Stand-in parser **faithful** for every
tested form. Both hosts covered; the only production construction is `terminal-client.ts`.
