# Security Audit: BUGS #84 (standard-terminal copy in Pantheon's browser terminals)

Finding: in UAT-6 Karl reported that copying from a Pantheon terminal needs Option-drag. Mac-Mini's tmux runs `mouse on`,
so tmux asks the terminal for every mouse event (DECSET 1006, 1000, 1002, sent as separate sequences) and xterm.js 6.0.0
handed plain drags to tmux. Karl approved in chat (2026-10-29) standard-terminal copy for every Pantheon terminal: plain
drag / double / triple-click highlight in the browser, the wheel still scrolls tmux history, ⌘C copies on a Mac (Ctrl+C
there always interrupts), Ctrl+C on Windows/Linux copies while something is highlighted and then clears it, Ctrl+Shift+C
copies everywhere, copy on release stays, no change to tmux on the machines.

Base commit d2c3b99. Ledger: `.superpowers/sdd/2026-10-29-bugs-84-terminal-copy/progress.md` (git-ignored).

## Headline

**Verdict: SHIP.** The change is client-side only (`services/control-plane/src/http/terminal-client.ts`, the shared
bootstrap of all four terminal hosts). It adds no new input path to the PTY: wheel reports go through `term.input(…, false)`
→ `onData` → the same `{t:'i'}` socket frame as typing, and only on a real wheel event. One adversarial review (opus/max)
ran the change in headless Chromium against tmux 3.6a's real attach bytes; its one major finding (the wheel's browser
default no longer cancelled) and its X10 widening finding were fixed, and its browser re-check of the fixed tree passed.

## Fix

- The remote's DEC private mouse modes — tracking 9, 1000, 1002, 1003 and encodings 1005, 1006, 1015 — are swallowed by
  `term.parser.registerCsiHandler({prefix:'?', final:'h'|'l'})` and recorded; xterm never enters mouse-reporting mode, so the
  mouse always selects. Non-mouse modes in the same sequence are re-issued with `term.write`. RIS (ESC c) clears the record.
- A custom wheel handler reports the wheel to the remote in SGR (`ESC[<64|65;col;rowM`, Ctrl/Alt bits as xterm sets them)
  when the remote asked for tracking with 1006, then calls `preventDefault()` + `stopPropagation()` and returns false. With
  tracking on and no 1006 it sends nothing (as before: xterm's X10 reports went to `onBinary`, which no host subscribes to).
  With tracking off it returns true and xterm behaves exactly as before.
- Copy chords: ⌘C and Ctrl+Shift+C copy a highlight (unchanged); plain Ctrl+C on a non-Mac (xterm's own platform list)
  copies a highlight and calls `clearSelection()`, otherwise goes to the PTY; Ctrl+Alt+C (AltGr) is never copy; the host's
  `before` key hook (the console drawer's Esc) still runs first.

## Threat review

| Question | Answer | Evidence |
|---|---|---|
| Can remote output now make the browser send input it did not send before? | No. Remote bytes only change the recorded mode; a report needs a real wheel event from the operator. Re-issued modes are numeric DECSETs on the output side. | Review: "remote output cannot cause input without a real wheel" |
| Does anything new reach the PTY? | Only SGR wheel reports, which xterm already sent under tmux before the change (byte-identical: 64/65, Ctrl = 80, 1-based coordinates). X10 reports were removed. | Review browser runs; test "without SGR … nothing is sent" |
| Can plain Ctrl+C fail to interrupt? | Only on Windows/Linux while a highlight exists in that terminal, and the highlight is then cleared, so the next Ctrl+C interrupts. On a Mac never. | Tests per platform; review: Mac Ctrl+C sends `\u0003` |
| Is selection text logged or sent anywhere new? | No. It goes only to the clipboard (`pantheonCopy`). | Code read; review |
| Page scroll / zoom hijack under the terminal? | Fixed in round 1: tracked wheel events are cancelled; page scrollTop 100→100 with the drawer open (was 100→182). | Review re-check |

## Verification

- `npx vitest run test/terminal-standard-copy.test.ts` → `Tests 31 passed (31)`; RED before the change: 16 failed of 28 (round 0), 2 failed of 31 (round 1).
- Full control-plane suite → `Tests 1411 passed | 5 skipped | 1 todo (1417)`; lint, `tsc --noEmit` and build exit 0 (reproduced by the controller).
- Mutations: 16 (round 0) and 4 (round 1) by the implementer, 7 by the reviewer on the final tree — all caught.

## Residuals (recorded, not fixed)

- A mouse-aware program in a terminal's normal screen without tmux (e.g. fzf `--height` run outside tmux) gets no wheel
  reports: xterm's Viewport scrolls local scrollback first. Every Pantheon terminal attaches tmux (alternate screen), so it is
  not reachable today.
- A sequence mixing mouse and screen modes from a non-tmux program (e.g. `CSI ? 1000 ; 1049 h`) applies the screen switch
  after already-queued output. tmux 3.6a sends each mode separately (verified on attach, option change and detach).
- Ctrl/Alt+wheel is not multiplied by xterm's `fastScrollSensitivity`. DECRQM reports the mouse modes as off; 1016
  (SGR-pixels) is not intercepted. tmux uses none of these.
- On Linux-Dev (`mouse off`) the wheel still becomes ↑/↓ keys in tmux's alternate screen, exactly as before.
