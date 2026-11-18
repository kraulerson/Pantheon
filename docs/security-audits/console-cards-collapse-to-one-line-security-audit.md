# Security Audit: console cards collapse to one line

Request (Karl, 2026-11-17): "all the cards need to collapse to a single line except for the latest one that is
active." Ruling A1 (2026-11-18): the newest card of each project whose session is still running stays open; every
other card is one line (its mark such as NEEDS YOU, project, title, age) and opens with a click.

Base commit 1273efb. Change: `src/http/console-page.ts` (stylesheet and client script); tests in
`test/console-page.test.ts`; `docs/user-guide.html`, FEATURES.md, PROJECT_BIBLE.md, CHANGELOG.md.

## Headline

**Verdict: SHIP, with the residuals below.** The change is page styling and client script only: no route, no
stored data, no authorization or custody surface. Nothing a session wrote is sent anywhere by it. One adversarial
review (sonnet, fresh agent, 2026-11-18; the model was chosen for a UI change with no enforcement surface) returned
"minor concerns, do not commit as is" with two findings it rated major. All findings it recommended fixing are
fixed. The fixes were made after the review and are covered by the author's tests, mutations and real-browser
measurements only.

The one property with a safety flavour: a card that needs the operator must never become invisible. It does not.
Such a card is still pinned on top, keeps its "! …" mark as text and its coloured edge, and the project tabs, the
summary and the page title still count it. It is one line unless it is its project's newest.

## Findings and dispositions

| # | Severity | Finding | Reachability | Disposition |
|---|---|---|---|---|
| 1 | Major | The one-line row lost its title on windows narrower than about 1300 px: the head (machine, session chip, tool-call text) kept its width and the title got what was left. Reviewer's measurements: title 51–84 px at 1280 px, 0 px at 1024 px | Any window under about 1300 px | **Fixed.** A collapsed line shows the mark, project, title and age only; the machine, the session chip and the rest of the meta are hidden; the title has a floor (`min-width: 8em`) and a tooltip with the full text. Author's measurements in real Chrome with long project names and titles: title 658–770 px at 1440, 498–610 px at 1280, 242–354 px at 1024; all marks, projects and ages visible; no horizontal overflow; rows 44 px. Under 760 px the row is two lines (80 px): mark, project, age and control, then the title |
| 2 | Major, low reachability | "Not collapsed under the operator" failed on some paths: an option button waiting on the passphrase dialog (the dialog takes the keyboard and no send is in flight yet); a commit approval with the session's screen open; a dismiss in flight; the outcome line of a send hidden within one poll when a newer card already existed | A newer card of the same project arriving mid-interaction | **Fixed.** A card is held open while: its box holds unsent text; a send or dismiss is in flight; its outcome line is less than a minute old; it still needs the operator and its screen view or next step is showing; its option button is waiting on the passphrase dialog; or the keyboard is inside it. The dialog case uses an explicit flag, not the focused element, because a button clicked with the mouse does not take focus in every browser. One test per clause |
| 3 | Minor | "Fold all", "Expand all" and "Collapse" stored a permanent choice per card; a stored "closed" then hid a card that later needed the operator | Normal use of "Fold all" | **Fixed.** Nothing is stored: choices last for the page load. A card collapsed by hand opens again if it starts to need the operator |
| 4 | Minor | The keyboard resting on a collapsed card's own control counted as "inside the card" and popped it open on the next poll | Keyboard use | **Fixed.** The card's own control is excluded |
| 5 | Minor | Selecting text on a collapsed line opened the card | Normal use | **Fixed.** A click with a text selection does not open |
| 6 | Minor | Every old card of a session that needs the operator carried the orange edge and "! NEEDS YOU" chip, so 59 lines looked urgent | Normal use | **Fixed.** The chip is hidden on a collapsed line, and a collapsed card that does not itself need the operator has no state colour |
| 8 | Minor | Eleven mutations survived the first test set (the busy guard, focus-key shapes, same key on two machines, ties, a remembered "closed" versus unsent text, the button label sync, layout declarations) | — | **Fixed.** Tests added; 40 of 40 mutations are now killed |

## Residuals (not fixed)

| # | Finding | Why left |
|---|---|---|
| 7 | A card that needs the operator is one line when its project has a newer card (for example a second live session of the same project) | This is ruling A1 as written (A3 would have kept such cards open). The line is pinned on top with its mark and edge |
| 9 | Old `console.fold.<id>` keys from the previous fold stay in the browser's localStorage, unused | Harmless; a few bytes per card |
| — | An expanded section ("full text", "why", "what it did") does not keep its card open when a newer card arrives, unless the keyboard is on it; opening the card again shows the section still expanded | Holding it open would leave every card ever read expanded |
| — | The one-minute hold on an outcome line is read at render time: with no further render the card simply stays open | Harmless |
| — | Layout is pinned in tests only as stylesheet text; the measurements above are the evidence that it works | jsdom has no layout |
| — | Not verified: Zen (Firefox-based) and the live page | Checked with Karl after deploy |

## Checked and found sound (reviewer, before the fixes)

- Newest-per-project is keyed by machine and project; cards of ended sessions, of sessions the page no longer
  knows and of hidden projects are never the open one; ties are deterministic.
- A poll that differs only in ages keeps the DOM, and the age on a collapsed line still updates.
- A card with unsent text, or whose reply box or link holds the keyboard when a render begins, stays open, and
  the box keeps its text and caret.
- On a collapsed line the only element the Tab key reaches is its control; the hide rule covers every other
  direct child of the card.
- Project tabs, the summary and the page title count projects and sessions, not visible cards.

## Verification (2026-11-18, this session)

- `npx vitest run`: 78 files passed, 1 skipped; 1521 tests passed, 5 skipped, 1 todo.
- `npx tsc -p tsconfig.json --noEmit`: exit 0. `npx eslint .`: exit 0.
- Mutations: 40 of 40 killed (defaults, each "in the middle of something" clause, focus keys, ended and unknown
  sessions, ties, machine scoping, the news rule for cards that start to need the operator, storage, the row click
  and its guards, labels, and each stylesheet rule).
- Real Chrome against a local fixture (the real page, a fake backend). Before the review fixes: 60 cards on one
  running project rendered as 1 open card and 59 lines of 44 px, page height 3732 px (17636 px with the old fold),
  and a click on a line opened it and its control collapsed it. After the fixes, with 20 cards and long names: the
  widths in finding 1, lines still 44 px.
