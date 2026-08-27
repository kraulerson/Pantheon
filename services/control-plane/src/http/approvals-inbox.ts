/**
 * Pending-Approvals inbox page (M1 task 3, TP-2 amendment) — server-rendered, admin-guarded.
 * One view over Peta's approval queue for EVERY session/identity, REFERENCE-ONLY (D8): identity,
 * tool, target, age, status. No request contents ever reach this page. Every state is a labelled
 * word, never colour alone (CC1): ok / empty / unavailable / failed.
 */

import { escapeHtml as esc } from "./config-page.js";
import type { ApprovalReference } from "../approvals/projection.js";

export type InboxState = "ok" | "empty" | "unavailable" | "failed";

export interface ApprovalsInboxModel {
  readonly state: InboxState;
  /** Pending references only (already filtered). */
  readonly approvals: readonly ApprovalReference[];
  /** Items Peta returned that are already resolved — counted, never listed. */
  readonly hiddenCount: number;
  /** Items with no reference id — counted, never listed (a row that cannot be pointed at is noise). */
  readonly unidentifiedCount: number;
  /** More approvals exist than the page shows (cap or Peta's next page). */
  readonly more: boolean;
  /** Our own label for `failed` / `unavailable` — never upstream text. */
  readonly message?: string;
  readonly nowMs: number;
}

/** Age in words from an ISO time; unparseable or missing → "unknown age" (labelled, not blank). */
export function formatAge(createdAt: string | undefined, nowMs: number): string {
  if (createdAt === undefined) return "unknown age";
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return "unknown age";
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

const cell = (v: string | undefined): string => (v === undefined ? `<span class="muted">(not given)</span>` : esc(v));

function rows(model: ApprovalsInboxModel): string {
  return model.approvals
    .map(
      (a) => `<tr data-approval-id="${esc(a.id ?? "")}">
  <td>${cell(a.requester)}</td><td>${cell(a.tool)}</td><td>${cell(a.server)}</td>
  <td>${a.createdAt ? `<time datetime="${esc(a.createdAt)}">${esc(formatAge(a.createdAt, model.nowMs))}</time>` : esc(formatAge(undefined, model.nowMs))}</td>
  <td>${cell(a.status)}</td><td class="ref">${cell(a.id)}</td>
</tr>`
    )
    .join("\n");
}

function body(model: ApprovalsInboxModel): string {
  switch (model.state) {
    case "unavailable":
      return `<p class="banner">[!] ${esc(model.message ?? "the approval gate (Peta) is not configured on this server — nothing to read")}</p>`;
    case "failed":
      return `<p class="banner">[!] Could not read the approval queue: ${esc(model.message ?? "the approval gate did not answer")}. Reload to try again.</p>`;
    case "empty":
      return `<p class="empty-state">No pending approvals — nothing is waiting on you.</p>${notes(model)}`;
    case "ok":
      return `<table>
<thead><tr><th scope="col">Identity</th><th scope="col">Tool</th><th scope="col">Target</th><th scope="col">Age</th><th scope="col">Status</th><th scope="col">Ref</th></tr></thead>
<tbody>
${rows(model)}
</tbody>
</table>${notes(model)}`;
  }
}

function notes(model: ApprovalsInboxModel): string {
  const out: string[] = [];
  const plural = (n: number): string => (n === 1 ? "" : "s");
  if (model.more) out.push(`<p data-more="true">More approvals are waiting than this page shows. Reload after some are resolved.</p>`);
  if (model.hiddenCount > 0) out.push(`<p data-hidden-count="${model.hiddenCount}">${model.hiddenCount} item${plural(model.hiddenCount)} already resolved not shown.</p>`);
  if (model.unidentifiedCount > 0) out.push(`<p data-unidentified-count="${model.unidentifiedCount}">${model.unidentifiedCount} item${plural(model.unidentifiedCount)} without a reference id not shown.</p>`);
  return out.join("\n");
}

export function renderApprovalsInbox(model: ApprovalsInboxModel): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pantheon Harness — Pending Approvals</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1.5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #aaa; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }
  .ref { font-family: monospace; }
  .banner { border: 2px solid #333; padding: 0.6rem; margin-bottom: 1rem; border-radius: 4px; }
  .empty-state { font-style: italic; }
  .muted { opacity: .75; }
</style>
</head>
<body>
<h1>Pantheon Harness — Pending Approvals</h1>
<p><a href="/harness">&larr; Harness</a> &middot; <a href="/admin/config">Configuration</a> &middot; <a href="/help">Help — user guide</a> &middot; <a href="/admin/approvals">Reload</a></p>
<p class="muted">Every request Peta reports as waiting for your decision, from every session and identity, as a reference line: who asked, which tool, which target, how long ago. No request contents are shown here.</p>
<main data-state="${model.state}">
${body(model)}
</main>
<p class="muted" data-resolution="m2-c3">Approve / reject buttons arrive with the M2 approval surface (C.3). Until then this inbox is read-only.</p>
</body>
</html>`;
}
