# UAT Session 4 — completeness, consolidation, triage (2026-08-28)

**Submission:** `submissions/test-session-4-v1-results.md` (Karl, 2026-08-28).

## Completeness
- 16 PASS / 3 FAIL / 1 SKIP (#15 legitimately skipped — depends on #14). #16 failed without a note;
  the tester's actual output was requested. Agent results: suite 617/5, tsc + eslint clean.

## Investigation (read-only, 2026-08-28)
- **#14:** the Alden-2 pane shows the gateway minted approval `2a2749b3-f26e-40ed-890e-7b3bb53a343a`
  (`gitea_file_write` as alden-1, expiry ~12 min, "approving requires DECIDE_APPROVAL as root on the
  gateway VM — there's no UI"). Pantheon's Peta (VM 1093, `PETA_URL` local) answers `LIST_APPROVALS`
  with **0 requests for ALL statuses**. → Two separate Peta instances: Alden's gateway Peta holds the
  ticket; the inbox reads Pantheon's. **Root cause: the inbox has one approval source and it is not
  the one the household's identities use today.** → BUGS #42 (SEV-2).
- **#16 / #19:** reproduced with a throwaway keycard (`uat4-repro`, revoked): `/keycard/v1/approvals`
  → `200 {"approvals":[],"truncated":false}` on BOTH addresses; keycard on `/harness/admin/approvals`
  → `403 invalid_token`. `http://…` (not https) → **308** to https — the only way to get a 308 on
  that URL. → Not reproducible as a defect; most likely a pasted-URL/scheme issue. Held for the
  tester's #16 output; template will carry a "must be https" note.

## Consolidated defects
- **#42 (new, SEV-2):** Pending-Approvals inbox reads only Pantheon's Peta; approvals minted by
  Alden's capability gateway (its own Peta) are invisible. Acceptance "every pending approval across
  ALL sessions" not met for the household's live identities.
- #16/#19: no defect confirmed (see above).

## Triage — Karl's dispositions (2026-08-28)
- **#42 — Fix Now, option A:** multi-source inbox (`PANTHEON_APPROVAL_SOURCES`), rows labelled by
  source, empty state names the sources checked, per-source failure labelled; Alden's gateway Peta
  added as a source once the Alden infra side hands over a token (cross-project — prompt delivered).
- **#16 / #19 — not reproducible (procedure):** 308 = `http://`; future templates say "must be https";
  re-test in UAT-5. Tester's #16 output still not provided.
- #15 — skipped by dependency; re-test in UAT-5.
