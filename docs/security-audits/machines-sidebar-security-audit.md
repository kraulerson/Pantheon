# Security Audit — Machines sidebar (Feature 12)

**Feature:** `machines-sidebar` — the harness frame's launch bar replaced by a collapsible left
sidebar: a **Chat** entry, then one collapsible group per registered dev machine (ready: plain-shell
button, live tmux list, Refresh, new-session form; not ready: reason + Configuration link). The
sidebar and each group remember open/closed in `localStorage`.
**Date:** 2026-08-28
**Persona:** Senior Security Engineer (Phase 2.4). **Method deviation, recorded honestly:** the
parallel independent auditor terminated on a model usage limit before reporting, so this is a
**single-auditor (self) review** of the diff against the lenses that agent was given (injection via
machine names, localStorage, CC1/accessibility, regressions, test honesty). Two findings were fixed
test-first; the reduced independence is itself a residual — the UI is operator-only, client-side, and
adds no server route, which is why the deviation was accepted rather than blocking.
**Scope refs:** ADR-0005 (single entry point); BUGS #22 (controls persist while a tab is open), #16
(Configuration always reachable), #29 (no CSP — unchanged); M1 task 1 audit (SSH-dial amplifier);
CC1. **Components:** `src/http/harness-frame.ts` (render + inline client), `src/http/theme.ts`.
**No server route, auth path, or data model changed.**

## Threats considered

| # | Threat | Control | Verdict |
|---|---|---|---|
| 1 | **Markup/attribute injection via a machine name** (`data-machine-group`, `data-machine-toggle`, `id`/`aria-controls`, button text, storage key). | Two independent barriers: the registry refuses anything but `^[A-Za-z0-9_][A-Za-z0-9._-]*$` (`src/registry/service.ts:103` — no quote, `<`, space or `/`), and every interpolation passes the frame's `esc()`. Render test asserts an escaped hostile name. | **PASS** |
| 2 | **`id` / `aria-controls` collisions** breaking the aria wiring or letting one group drive another. | `logicalName` is unique in the registry (`service.ts:285`), so `machine-<name>` ids are unique; the client never uses `querySelector('#id')` (it walks `closest('[data-machine-group]')` → `[data-machine-body]`), so a name containing `.` or `-` cannot become a CSS-selector hazard. Test: `mac.mini-1` group, `aria-controls` === body id. | **PASS** |
| 3 | **`localStorage` under the shared chat origin** (the console and LibreChat now share an origin). | Keys are namespaced `pantheon.sidebar` / `pantheon.sidebar.machine.<name>`; only the literal values `open`/`closed` are honoured (anything else falls through to the server-rendered default); values are never rendered into the page. No LibreChat key is read or written. | **PASS** |
| 4 | **SSH-dial amplification** — every ready machine's tmux list fetched at page load, including groups the operator keeps collapsed. | **FOUND AND FIXED (SEV-3):** remembered open/closed is now applied *before* the first dial; the boot loop skips slots inside a hidden group; a group loads its list the first time it is unfolded and never re-dials on later folds (the existing per-machine coalescing / 3 s cache / 4-dial cap still apply). Tests cover all three. | **FIXED** |
| 5 | **CC1 — state by colour alone.** | Every machine group carries words + glyph + `data-state`: `[✓] ready`, `[ ] not provisioned`, `[x] disabled`; the tmux list keeps its `[~]/[✓]/[–]/[!]` text states and its live region; the toggle carries `aria-expanded`. No colour conveys anything. | **PASS** |
| 6 | **Keyboard / assistive tech.** | Toggles are real `<button>`s with `aria-expanded` + `aria-controls`; the collapsed sidebar is `display:none` (removed from the a11y tree) while its `☰` toggle lives in the header, outside it, so it is always reachable; collapsing via a toggle leaves focus on that toggle. Residual (SEV-4, accepted): collapsing the whole sidebar while focus sits *inside* it drops focus to `body` — no trap, no loss of function. | **PASS (1 residual)** |
| 7 | **Regressions.** | BUGS #22 invariant re-pinned on the sidebar (render + behaviour tests: controls persist while a tab is open); BUGS #16 Configuration link present in the empty state *and* in every not-ready group; `slotFor` still resolves via `.machine-launch` (Refresh + new-session tests green); the welcome section still hides on first tab; the standalone terminal page untouched; folding the sidebar re-fits the active terminal (guard test added — a coverage gap this review found). | **PASS** |
| 8 | **Server surface.** | None: no route, guard, cookie, header or model changed; the sidebar is rendered by the same guarded `/harness` handler. | **PASS** |

## Findings

- **SEV-3 (FIXED):** collapsed groups were dialled at every page load — the amplifier the M1 task-1
  audit closed. Fix: apply remembered state first, skip hidden slots, load on first unfold.
- **SEV-4 (FIXED):** no test covered "folding the sidebar re-fits the terminal"; guard added.
- **SEV-4 (accepted):** focus falls to `body` when the sidebar is collapsed while focus is inside it.
- **SEV-4 (pre-existing, unchanged):** the page's first heading is an `h2` (no `h1`); the sidebar adds
  another `h2` ("Machines") to that existing pattern. Cosmetic a11y, tracked with the page chrome.
- **Method residual:** single-auditor review (see above).

**Verification:** suite 637 passed / 5 skips (+8 for this feature), `tsc` clean, `eslint` clean.
