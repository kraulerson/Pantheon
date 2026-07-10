# Step 9 — Machine-auth design note (charter scope item 9)

**Status: DONE (2026-07-10).** The deliverable is a design document, not code, and it
exists: `docs/machine-auth-design.md` (commit 376b473).

**What the charter required:** "Machine-auth design note (decision F) — design only:
service-principal path on the Facade for the future Autonomy Driver. Written as
`docs/machine-auth-design.md`; built at Alden build-plan Phase 3."

**What remains for the skeleton (a constraint, not a task):** when executing step 3
(two-service split), keep the Facade's auth-guard module shaped so a fourth auth tier
can be added without modifying tiers 1–3 — i.e., the guard dispatches on auth *domain*
(operator cookie / session bearer / future machine bearer), not on a hardcoded
two-way branch. Step 3's design section carries this requirement.

**Verify:** the file exists, and step 3's implementation review confirms the auth-guard
seam. Nothing else to do in this step.
