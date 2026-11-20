# Console: close an ended project's tab — design

Status: approved by Karl on 2026-11-19 (A2 for the approach, A1 for this design). Small change; short design.
Amended 2026-11-20 after the adversarial review, where marked: the close mark is cleared when a session is seen alive
again, the project key bound is 512, and the control reads "✕ Closing…" while a close is in flight.
Parent spec: `docs/superpowers/specs/2026-10-16-maestro-console-design.md` (§9, "Session ended").

## Intent

A project whose sessions have all ended keeps its tab in the console for ever, because the state route sends every
stored session (`src/http/routes/console.ts`, `GET /console/api/state`), the page builds a tab for each
(`src/http/console-page.ts`, `buildView`), and session rows are never removed (`src/console/store.ts`). The UAT
scratch sessions are the visible case. Karl wants to remove such a tab himself, when he chooses.

## Goals

- A "✕ Close" control on a project tab whose sessions have all ended.
- Closing takes the tab and that project's cards out of the console in every browser.
- Nothing is deleted: cards stay in the database until the existing retention (`retention.cardsDays`, 90 days).
- If a new session later starts in the same project on the same machine, the tab is back and shows that session only.
- If a closed session is itself continued (`claude --resume` keeps the session id), it is back with its cards and
  stays until the operator closes it again (amended 2026-11-20).

## Non-goals

- No reopen control and no "Closed" list (Karl A1, 2026-11-19).
- No deletion of sessions or cards.
- The parent spec's proposed automatic "ended" list after 12 hours is not built here (Karl chose the control by hand).
- No change to how a session ends, and no way to end a live session from this control.

## Anti-goals

- A live session must never disappear from the console because of this control.
- A card that needs the operator in a project that is still live must never be hidden by it.

## Approaches

1. **A `closed_at` mark on each ended session row (picked).** Added by the store's existing additive column step
   (`ensureColumn`). The state route leaves out sessions that are both ended and closed, and their cards. Smallest
   change; a new session row is unmarked, so the tab returns by itself; reversible in the database.
2. A separate table of closed projects. Rejected: it needs "closed before or after the newest session" logic to give
   the same result.
3. Delete the ended sessions and their cards. Rejected: irreversible, and against "cards kept to retention" (§9).

## Design

**Data.** `console_session.closed_at TEXT` (null = not closed), added on open by `ensureColumn`, like the F2 card
columns. `upsertSession` never sets it, and clears it when the session is seen alive again (amended 2026-11-20: as
first written the mark stayed, so a resumed session vanished by itself the moment it next ended). A session counts
as closed only while `ended_at` and `closed_at` are both set.

**Store.** One method closes a project: in one transaction it refuses when the machine and project have any session
with `ended_at` null, and otherwise sets `closed_at` on every ended, unclosed session of that machine and project and
returns how many it marked. The session and card listings used by the state route leave closed sessions and their
cards out in the query itself, so the card limit is not spent on hidden cards.

**Route.** `POST /console/api/machines/:name/close-project` with the JSON body `{"projectKey": "…"}`. The project
key travels in the body because it is free text (a tmux session name, or `<folder>@<machine>`). Same guard as
Dismiss: operator sign-in, JSON only, no HEAD, `Cache-Control: no-store`, no passphrase step-up (it types nothing
into a machine). The machine name is validated with the pattern the session routes use; the project key must be a
well-formed string of 1 to 512 characters on one line (amended 2026-11-20: above anything the poller can store, so
every tab shown can be closed). Answers: 200 with the number closed (0 when it was closed already); 404
when the machine and project have no session; 409 when a session there is still live; 400 for a malformed name or key.

**Log.** One info line per close: event `console.project_closed`, with the machine, the project, the number of
sessions marked and the correlation id, under the console's existing masking rules.

**Page.** The control is shown only on a project tab whose every session is ended, in either tab group, and never
on a pending tab. It is its own button beside the tab button (a button cannot sit inside a button), labelled
"✕ Close" in words, with an accessible name that includes the project and the machine. It is reachable by keyboard
in the tab row with Tab, like "+ New session" (arrow keys move between tabs only). While a close is in flight it
reads "✕ Closing…" and is `aria-disabled`, not disabled, so it keeps the keyboard. On success the page drops the tab at once, moves the keyboard to
"All projects" when it was on the control or its tab, and moves the selection to "All projects" if the closed
project was selected; the next poll confirms it. On refusal or failure the tab stays and the reason is shown in
words next to it.

## Left to the builder

- Method and helper names, the exact SQL, and where the control sits in the tab row's DOM and focus order.
- Whether routes that take a card id (expand, dismiss) need any change for a closed session's card; the default is none.

## Tests

- Store: the column is added to a database created without it; closing marks only ended sessions of that machine
  and project; a live session there refuses the close; closed sessions and their cards are absent from the state
  listings; a session seen alive again is listed again; a new session in a closed project is listed.
- Routes: no sign-in is refused; 400, 404 and 409 as above; 200 writes exactly one `console.project_closed` line;
  `GET /console/api/state` no longer carries the closed sessions or their cards.
- Page: the control appears only when every session of the project has ended; it is not inside the tab button; it
  has its accessible name; pressing it posts to the route; a 409 leaves the tab and shows the reason.

## Process

A new feature: full Build Loop, started after BUGS #88 is committed. It counts toward the test gate, so UAT-7 falls
due after it. The layout and keyboard behaviour need a real-browser check; jsdom has no layout.
