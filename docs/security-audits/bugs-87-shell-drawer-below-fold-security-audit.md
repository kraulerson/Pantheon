# Security Audit: BUGS #87 — the shell drawer opened below the fold; new shortcut

Finding: the Maestro console's machine-shell drawer sat in page flow after the card list, so on a long list its
shortcut opened it thousands of pixels below the fold with no scroll and no focus move, and the key looked dead
(BUGS #87, found in the agent's Chrome re-run of UAT-6 v3, 2026-11-12). Karl's triage (A1, 2026-11-12): Fix Now,
after #86 and #49. On 2026-11-17 Karl added that the shortcut itself must change: its label, "Ctrl+`", read as "Ctrl+"
and nothing, and he had been pressing Ctrl and +. Ruling A2 (2026-11-17): Ctrl + semicolon, labelled in words.

Base commit 21c78e2. Change: `src/http/console-page.ts` (stylesheet, client script, drawer help text); tests in
`test/console-page.test.ts`; a fixture fix in `test/server-ssh-pool-wiring.test.ts`; `docs/user-guide.html`,
FEATURES.md, PROJECT_BIBLE.md, CHANGELOG.md.

## Headline

**Verdict: SHIP, with the residuals below.** One adversarial review (sonnet, fresh agent, 2026-11-17) of the first
version of the fix (pin the drawer, focus the shell on open) returned major concerns: the fix introduced two
regressions and exposed one existing hazard. All are fixed. The change has no server side: it is a stylesheet rule
and client script in the console page. The one security-relevant item is finding 2.

The reviewer was run on sonnet, not the top tier at max effort, because the change has no authorization, custody
or enforcement surface. The shortcut change (Ctrl + semicolon) was made after that review and is covered by the
author's tests, mutations and a real-browser run only.

## Findings and dispositions

| # | Severity | Finding | Reachability | Disposition |
|---|---|---|---|---|
| 1 | Major | With the drawer pinned, a control reached with Tab could sit underneath it: the browser's scroll-into-view does not know about the overlay. Reviewer's Tab walk on a 60-card page: 24 of 160 stops hidden with the drawer closed, 90 of 160 with it open, including reply boxes (WCAG 2.4.11) | Every keyboard walk down a long list | **Fixed.** The page keeps `scroll-padding-bottom` equal to the pinned height plus 8 px, updated on every drawer render, height change and window resize. Author's Tab walk in real Chrome with the drawer open: 101 stops, none entirely hidden, 1 partly covered (35 px of an 88 px reply box) |
| 2 | Major (security) | The shortcut worked while the passphrase dialog was open. With the new focus-on-open it moved the keyboard into the shell behind the dialog; the reviewer reproduced a typed passphrase arriving at the fake shell. The restore path already did this in the live build when a minimised drawer existed | Low probability, plausible: the dialog appears on the first Submit of each elevation window | **Fixed.** The document-level handler ignores the shortcut while any dialog is open. Two tests (no drawer; minimised drawer); real Chrome: focus stayed in the dialog field, the field stayed empty, nothing was sent |
| 3 | Minor | After Esc in the shell, focus fell to the page body and the next Tab jumped to the top | Normal use once focus-on-open exists | **Fixed.** The drawer remembers where the keyboard was (the element, or its focus key after a re-render) and gives it back on Esc or on the shortcut from inside the shell; failing both, focus goes to the drawer's own button. Two tests |
| 4 | Minor | A drawer height chosen in a tall window was not re-clamped when the window got shorter, and could fill it | Uncommon (window resize or zoom) | **Fixed.** The height is re-clamped and applied on `resize`; the stored preference is kept. One test |

## The shortcut change

- Exactly Ctrl + semicolon: with Shift, Alt or Cmd the key is not claimed. `event.code` covers a layout that reports
  another character for that key. The old Ctrl + backtick does nothing.
- xterm 6.0.0 maps nothing to Ctrl + semicolon (`Keyboard.ts`, the Ctrl branch handles letters, space, 3 to 8 and
  the bracket keys), so a terminal that does not claim it sends nothing to its machine. Inside the drawer shell the
  key is claimed and `preventDefault` is called, so the browser cannot type a ";" into the shell either.
- Real Chrome against a local fixture (the real page and real xterm, a fake terminal backend that logs every frame):
  the shortcut opened the drawer with its bottom edge on the window's bottom edge and the keyboard in the shell;
  from inside the shell it minimised the drawer; from the Claude-session terminal it restored the drawer. In all
  three cases the backend's log showed only the letters typed on purpose ("l", "s", "h", "i") and no ";".
- Not verified: Zen (Firefox-based) and macOS. Whether Zen or the system keeps Ctrl + semicolon for itself is
  checked with Karl on the live page; the bar button is unaffected either way.

## Residuals (not fixed)

| # | Finding | Why left |
|---|---|---|
| 5 | In the Claude-session view the open drawer covers the lower part of that terminal at the top of the page (about 240 px at the default height); a page scroll of about 310 px clears it. Spec 14.2, item 3, says the drawer sits beneath both views | Not permanent; minimising the drawer or scrolling reveals it. A layout change to that view is a separate piece of work |
| 6 | xterm's scrollbar (z-index 11, no stacking context) could paint above the drawer's z-index 5 while the Claude terminal overlaps it. Reasoned only | Cosmetic; not triggered in the review |
| 7 | Only Chromium was tested. Sticky positioning in a flex-column body is standard in Firefox but unconfirmed in Zen | Checked live with Karl |
| 8 | The stylesheet test reads the first `.drawer-wrap` rule only; a later overriding rule would not fail it | No such rule exists; the real-browser check is the evidence for layout |
| — | In one scripted run (synthetic clicks; the browser automation detached when the password field appeared) focus was seen on the reply box while the dialog was open. With real mouse and keyboard input, focus was in the dialog's field. Not reproduced and not explained | Recorded in case it is seen again; the dialog's own focus handling is unchanged by this fix |
| — | Holding Ctrl and pressing ; in a text box now toggles the drawer instead of doing nothing | By design of a global shortcut |

## Checked and found sound (reviewer)

- No ancestor of the drawer has `overflow`, so `position: sticky` has a working containing block; the drawer's
  bottom edge is exactly on the viewport's bottom edge at the top and in the middle of a long page, and at the end of
  the page it sits above the status line with the last card visible.
- The dialog overlay's z-index is 50, above the drawer's 5; nothing else in the console is positioned.
- Under 900 px the drawer is hidden and the shortcut returns before opening anything.
- Focusing the terminal inside `openDrawer` is not premature: the host is attached and visible when the terminal
  opens. A handle with no terminal is guarded. A re-render keeps focus in the terminal.
- Switching machines does not move focus into another machine's drawer (unchanged).

## Verification (2026-11-17, this session)

- `npx vitest run`: 78 files passed, 1 skipped; 1502 tests passed, 5 skipped, 1 todo.
- `npx tsc -p tsconfig.json --noEmit`: exit 0. `npx eslint .`: exit 0.
- Mutations killed (13): key still backtick; Shift allowed; Alt allowed; Ctrl not required; no `code` fallback; no
  `preventDefault` in the shell; no dialog guard; label not worded; no scroll padding; no resize clamp; no focus
  return; no focus on open; not sticky.
- `test/server-ssh-pool-wiring.test.ts`: the fixture now redraws a key pair ssh2's own parser refuses (seen 1 run in
  5); 20 consecutive runs passed.
- Not yet verified: the live page on VM 1093, and Zen.
