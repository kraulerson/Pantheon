# Step 8 — LibreChat deploy-and-verify spike (charter item 8, decision B)

**Commit type: `build:` + an APPROVAL_LOG ruling for the verdict.** Time-boxed: 1–2 days
(the ruling's own time box). NOT a Build Loop — this is an evaluation with a decision
tree, not cutline feature work.
**Preconditions:** steps 1–7 (stack up, Facade complete: chat, streaming, meter, queue).

## Goal

Answer decision B empirically: **can the trust-labeled Grounding Inspector (C.2) render
inside LibreChat?** LibreChat is already running (step 1 brought the container up); this
step wires it to the Facade and runs the decision tree.

## Do

1. **Wire the custom endpoint.** `deploy/librechat.yaml` is pre-staged: baseURL
   `http://host.docker.internal:8089/v1`, `directEndpoint: true`, static
   `x-pantheon-identity: alden-1` header for the skeleton. Restart the container after
   edits (`docker compose restart librechat`).
2. **Smoke the pipe:** a LibreChat conversation reaches the Facade (correlation IDs in
   the Facade log — step 4), streams (step 5), meters (step 6), queues under load
   (step 7).
3. **Resolve the identity-header uncertainty** (the load-bearing unknown flagged in the
   landscape re-validation §81): test which `librechat.yaml` header placeholders exist
   in the pinned build (`{{LIBRECHAT_USER_ID}}`, `{{LIBRECHAT_USER_EMAIL}}`, …) and
   whether any is per-conversation. Record findings — they decide whether
   per-conversation sessions need LibreChat metadata or a Facade-side mapping.
4. **Run the decision tree (the spike's whole point):** attempt to surface the C.2
   inspector inside LibreChat — candidate paths: LibreChat's message-attachment/HTML
   rendering, an iframe-able inspector URL, or a link-out artifact. Judge against C.2's
   hard ACs (trusted/untrusted distinguished by LABEL+ICON+POSITION, never color;
   per-source toggles reachable).
   - **Renders acceptably** → ADR-0001 CONFIRMED; record the ruling in APPROVAL_LOG.
   - **Does not** → invoke Investigation A's documented fallback: the inspector ships
     as a **separate control-plane-served view** (the `/inspector/:sessionId/latest`
     route already exists and is admin-guarded — `src/http/routes/inspector.ts:12–27`);
     write the ADR-0001 amendment ADR; record the ruling.
   - **Operational weight verdict** (the ruling's other exit): if LibreChat itself
     proves unreasonable to operate, record THAT — the pre-authorized response is the
     fallback view, not a UI-plane re-evaluation.
5. **Auth check (#9):** LibreChat login gates the UI on `pantheon.lan`; logged-out =
   login only, no metadata leak (Bible §7 tier 1).

5. **Collapse the two front doors (operator ruling 2026-08-19 — "everything should be under
   the harness").** Once chat reaches the Facade, the harness frame must become the single place
   work starts: chat sessions open as tabs in the frame alongside terminal tabs (ADR-0005's
   "single entry point ... presents both modalities"), and the operator does not visit a second
   address to begin. Decide and record HOW: LibreChat embedded in the frame, the frame linking
   into it as a tab, or the frame replacing it as the landing page — the spike's rendering
   findings (item 4) determine which is feasible. **Naming falls out of this:** the working
   surface stops being addressed as `pantheon-admin`; setup/Configuration may keep an admin name.
   Until this lands, the operator works behind a door labelled "admin", which is a labelling
   accident from the 2026-08-19 intake run, not a design decision.

## Verify (this step IS the verification)

- **Single front door:** starting BOTH a chat session and a terminal session is possible from
  the harness frame alone, without visiting a second address. This is a charter acceptance box.

- The full acceptance smoke test now runs end-to-end: **one identity, one brain, one
  conversation, one `dangerLevel:2` write held for approval and executed on approve —
  LibreChat (or fallback UI) → Facade → Peta → downstream**; denied tool call returns
  `-32602` and provably does not execute (write-evidence pattern).
- Colorblind pass on every skeleton-visible surface (decision I3 — acceptance item):
  config page, harness tabs, C.7 signal, inspector (wherever it landed).
- Inspector verdict RECORDED in APPROVAL_LOG (acceptance item).

## Rollback

LibreChat is compose-managed and stateless toward the harness (its Mongo holds only its
own chat history): `docker compose stop librechat` removes the UI plane without
touching the Facade. The fallback inspector view exists regardless.

## Acceptance mapping

Closes the remaining acceptance items: smoke test, `-32602` denial, streaming-in-UI,
inspector verdict, colorblind pass. When this step's checklist is green, the charter's
exit applies: record the freeze-lift ruling, archive results to `docs/test-results/`.
