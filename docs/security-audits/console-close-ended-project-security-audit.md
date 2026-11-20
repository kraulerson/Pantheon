# Security Audit: close an ended project's tab (console)

Feature: a "✕ Close" control on a console project tab whose sessions have all ended (Karl's rulings A2 and A1,
2026-11-19). Design `docs/superpowers/specs/2026-11-19-console-close-ended-project-design.md`; plan
`docs/superpowers/plans/2026-11-19-console-close-ended-project.md`. Changed: `src/console/store.ts`,
`src/console/poller.ts` (a type only), `src/http/routes/console.ts`, `src/http/routes/console-sessions.ts` (one export),
`src/http/console-page.ts`, and four test files, all under `services/control-plane/`.

Base commit 7e5e26c. One adversarial review (fresh agent, top-tier model, 2026-11-20), working in its own copy, with
headless Chrome against the real built app on loopback. Its verdict was "major concerns"; both majors are fixed below.

## Headline

**Verdict: SHIP, with the residuals below.** The review found no guard, injection or typing-into-a-machine defect. It
found one functional fault in the first build (a closed session that is resumed vanished by itself when it next ended)
and that the two "never hide" promises were not pinned by any test. Both are fixed, each with a test that failed first.

## What the feature can and cannot do

- It writes one nullable column, `console_session.closed_at`. It deletes nothing and types nothing into any machine.
- It hides: sessions that are both ended and closed, and their cards, from `GET /console/api/state` only.
- It can never hide a live session. The store refuses to close a project while any session there has not ended; the
  check and the mark run in one transaction, and the poller writes through the same synchronous connection (reviewed
  with a poll in flight: a close during the probe either marks the still-ended row and the poller's later write shows
  the session again, or answers `live`).
- A session seen alive again loses its mark (`upsertSession` clears `closed_at` when it writes `ended_at` NULL).

## Guard

`POST /console/api/machines/:name/close-project` sits behind the app-wide operator guard like Dismiss: sign-in or the
admin bearer; no passphrase step-up, because nothing is typed. Reviewed against `src/http/app.ts`, over a real socket:

| Caller | Answer |
|---|---|
| no credential | 401 `unauthenticated` |
| keycard only, or keycard plus operator cookie | 403 `invalid_token` |
| cookie with `Sec-Fetch-Site: same-site` or `cross-site` | 403 `cross_origin_rejected` |
| form body, text body, no body | 415 |
| `HEAD` | 404 |

Accepted with the feature (the approved "same guard as Dismiss"): any script running on the console's own origin with
the operator's cookie can call it. It would hide history in every browser; the traces are `closed_at` and the log line.

## Input

- Machine name: the session routes' pattern (`MACHINE_NAME_RE`, now shared, not copied).
- Project key: free text by nature, so only bounded. A string of 1 to 512 UTF-16 units, no control character, no lone
  surrogate half. 512 is above anything the poller can store (a 255-byte folder, `@`, a 64-character machine name); the
  first build's 200 left a long-named folder's tab impossible to close. A lone surrogate was refused after the review
  showed SQLite binding it as U+FFFD, which matched a different stored key than the one sent.
- SQL: every statement is parameterised; no `LIKE`, no collation. Quotes, SQL fragments, `%`, `_`, case and
  normalisation variants, an RTL override and 200 non-ASCII characters all answered 404 with no row changed.
- The key travels in the JSON body, never in a URL. The page encodes the machine name in the path.

## Page

- The control is a real `<button>`, a sibling of the tab button, with the accessible name "Close ‹project› on
  ‹machine›". It is reached with Tab like "+ New session"; arrow keys still move between tabs only.
- Hostile project keys and machine names in the state payload: no markup or script reaches the page through the label,
  the data attributes, the focus key, the error text or the request URL (jsdom and headless Chrome; 0 injected
  elements, 0 dialogs). The server's error text is shown as text, capped at 120 characters.
- In flight the control reads "✕ Closing…" and is `aria-disabled`, not `disabled`: a disabled button drops the keyboard
  (seen in real Chrome and in jsdom). A second press is ignored. After a close the keyboard moves to "All projects" when
  it was on the control or its tab, and is left alone otherwise.
- A refusal's reason is one stable `role="alert"` node per project. It is dropped once the project is gone or live
  again; the first build kept it for the page load and showed it again, untrue, when the project next ended.
- No meaning is carried by colour alone: the control and every message are words with a mark.

## Migration

`closed_at` is added on open by the store's additive column step. Reviewed with the previous build: a file it created
opens, gains the column (`schema_version` 15 → 16), keeps its rows and cards, and a second open changes nothing; the
previous build then opens the migrated file and works (it selects named columns). To undo a close by hand:
`UPDATE console_session SET closed_at = NULL WHERE machine = ? AND project_key = ?`.

## Tests

Each task's tests failed before its code existed (store 9, routes 3, page 7). The review then ran mutants against the
full suite; twelve survived. After the fix pass:

- Pinned now, each proven to fail under its mutant or written to fail first: a resumed session keeps its cards and
  stays until closed again; the mark is not carried to another project by a re-key; hiding is by machine and session
  together; the page never hides a live session of a just-closed project; the page stops hiding once a poll no longer
  carries the closed sessions; no control on a pending tab; the machine name is encoded in the path; NUL, TAB and lone
  surrogates are refused; a refusal's reason does not come back; the in-flight words.
- Three tests that claimed "survives a redraw" served an identical payload, which the page deduplicates, so nothing was
  redrawn. They now change a card title first and assert the new title is on the page.
- Still unpinned (mutants that survive): the log line's masking of the key; the 120-character cap on the error text;
  the selection roll-back after a render that throws; the single stable alert node. `exposeHeadRoute: false` is inert on
  a POST route, as on Dismiss; the `HEAD` → 404 assertion holds either way.

## Verification

- Controller, working tree: build and lint exit 0; `npm test` with the two live bridge tests skipped:
  `Test Files 79 passed | 1 skipped (80)`, `Tests 1572 passed | 7 skipped | 1 todo (1580)`.
- Real browser (installed Chrome, headless, the real app behind a loopback proxy, an in-memory store): control 78×30 px
  beside its tab; focus ring `solid 3px`; Tab reaches each control after its tab; Enter closes;
  `POST /console/api/machines/Linux-Dev/close-project {"projectKey":"uat6v3-scratch"}` → `200 {"closed":1}`; the keyboard
  lands on "All projects"; the tab is still gone one poll later and in a second page. Ten tabs with six controls take two
  rows at 1440 px and three at 900 px (the ten tabs alone are 1672 px wide); no sideways page overflow.
- Not verified: Zen (Gecko) and Safari; a screen reader; the live console; a real `claude --resume` (the review relied
  on the CLI's help text, which says the session id is reused unless `--fork-session` is given).

## Residual

1. **A request that never answers leaves the control reading "✕ Closing…" until reload.** The page's write helper has
   no time limit, for this control as for Submit and Dismiss.
2. **An ended project's "Claude session" terminal stays connected after its tab is closed**, until the page is
   reloaded (its WebSocket and tmux client). New with this feature, because a project tab never went away before. No
   access is gained. Candidate BUGS row.
3. The page hides a just-closed project by project key, not by session, until a poll stops sending its closed
   sessions. A different, unclosed ended session of that project arriving inside that window stays hidden on that page
   until it is reloaded. The review could not construct an everyday path to it.
4. The alert node leaves and re-enters the document on each redraw of the tab row (redraws happen only when the state
   really changes). Whether a screen reader repeats it was not testable here.
5. A machine that is no longer polled (removed, disabled, unprovisioned) never has its sessions ended, so its tabs
   cannot be closed: the store answers `live`. Older than this feature; it now has a visible consequence.
6. The cross-site check compares `Sec-Fetch-Site` to exact lower-case words (older than this feature). Browsers send
   lower case and scripts cannot set the header, so no browser path was found.
7. `docs/api and interfaces/` has no console page; the new route is described in the route file's header, the design
   and the changelog, as the other console routes are.
8. The parent spec's proposed automatic "ended" list after 12 hours is still not built.
