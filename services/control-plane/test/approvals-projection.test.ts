/**
 * Shared reference-only approvals projection (D8) — M1 task 3 (TP-2 inbox) lifts it out of the
 * keycard door so the door and the operator inbox read Peta through ONE closed allow-list.
 */

import { describe, it, expect } from "vitest";
import {
  projectApprovalReference,
  approvalsArray,
  hasMoreApprovals,
  readApprovalReferences,
  readPendingApprovals,
  MAX_APPROVALS,
  MAX_FIELD_CHARS
} from "../src/approvals/projection.js";

const RAW = {
  approvalId: "ap-1", tool: "gitea_file_write", serverId: "gitea", status: "pending",
  createdAt: "2026-08-25T11:00:00.000Z", userId: "u-alden1",
  arguments: { path: "secret.txt", content: "SECRET-CONTENT" }, diff: "+SECRET-CONTENT", payload: { x: 1 }
};

describe("projectApprovalReference — closed allow-list (D8)", () => {
  it("keeps only id/tool/server/status/createdAt/requester; arguments, diff and payload never pass", () => {
    const ref = projectApprovalReference(RAW);
    expect(ref).toEqual({ id: "ap-1", tool: "gitea_file_write", server: "gitea", status: "pending", createdAt: "2026-08-25T11:00:00.000Z", requester: "u-alden1" });
    expect(JSON.stringify(ref)).not.toContain("SECRET");
  });

  it("caps every field at MAX_FIELD_CHARS and yields {} for a non-object", () => {
    const long = "x".repeat(MAX_FIELD_CHARS + 50);
    expect(projectApprovalReference({ tool: long }).tool).toHaveLength(MAX_FIELD_CHARS);
    expect(projectApprovalReference(null)).toEqual({});
    expect(projectApprovalReference("str")).toEqual({});
  });
});

describe("projectApprovalReference — display-spoofing characters are stripped", () => {
  it("removes bidi overrides, zero-width and control characters from every projected field", () => {
    const ref = projectApprovalReference({ tool: "gitea\u202Eetirw\u200B", userId: "al\u0000den\u2066-1\u2069", serverId: "s\u007F" });
    expect(ref.tool).toBe("giteaetirw");
    expect(ref.requester).toBe("alden-1");
    expect(ref.server).toBe("s");
  });
});

describe("approvalsArray / hasMoreApprovals — Peta 1.2.x shape without trusting it", () => {
  it("finds the list at top level, under a known key, or under data.<key>", () => {
    expect(approvalsArray([RAW])).toHaveLength(1);
    expect(approvalsArray({ requests: [RAW] })).toHaveLength(1);
    expect(approvalsArray({ success: true, data: { requests: [RAW], page: 1, pageSize: 50, hasMore: false } })).toHaveLength(1);
    expect(approvalsArray({ data: [RAW] })).toHaveLength(1);
    expect(approvalsArray({ success: true })).toBeUndefined();
    expect(approvalsArray("nope")).toBeUndefined();
  });

  it("reads hasMore only as a literal boolean true (top level or under data)", () => {
    expect(hasMoreApprovals({ data: { requests: [], hasMore: true } })).toBe(true);
    expect(hasMoreApprovals({ hasMore: true })).toBe(true);
    expect(hasMoreApprovals({ data: { hasMore: "true" } })).toBe(false);
    expect(hasMoreApprovals({})).toBe(false);
    expect(hasMoreApprovals(null)).toBe(false);
  });
});

describe("readApprovalReferences — bounded, labelled read", () => {
  it("returns projected references and flags truncation past MAX_APPROVALS", async () => {
    const many = Array.from({ length: MAX_APPROVALS + 1 }, (_, i) => ({ ...RAW, approvalId: `ap-${i}` }));
    const res = await readApprovalReferences({ listApprovals: async () => ({ success: true, data: { requests: many, hasMore: false } }) }, 1000);
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(res.approvals).toHaveLength(MAX_APPROVALS);
    expect(res.truncated).toBe(true);
    expect(res.more).toBe(true);
    expect(JSON.stringify(res)).not.toContain("SECRET");
  });

  it("labels an upstream failure, a timeout, and an unexpected shape — never throws", async () => {
    const failed = await readApprovalReferences({ listApprovals: async () => { throw new Error("boom"); } }, 1000);
    expect(failed).toEqual({ state: "failed", message: "the approval gate did not answer" });
    const hung = await readApprovalReferences({ listApprovals: () => new Promise(() => {}) }, 20);
    expect(hung).toEqual({ state: "failed", message: "the approval gate did not answer in time" });
    const shape = await readApprovalReferences({ listApprovals: async () => ({ success: true }) }, 1000);
    expect(shape).toEqual({ state: "failed", message: "unexpected approvals response shape" });
  });
});

describe("readPendingApprovals — asks Peta for PENDING only and walks its pages, bounded", () => {
  const row = (id: string) => ({ ...RAW, approvalId: id, status: "PENDING" });
  const pageOf = (ids: string[], hasMore: boolean, page: number) => ({ success: true, data: { requests: ids.map(row), page, pageSize: ids.length, hasMore } });

  it("sends { status: 'PENDING', page: 1, pageSize: 100 } and follows hasMore until Peta says there is no more", async () => {
    const calls: unknown[] = [];
    const reader = { listApprovals: async (f?: unknown) => { calls.push(f); const p = (f as { page: number }).page; return p === 1 ? pageOf(["a", "b"], true, 1) : pageOf(["c"], false, 2); } };
    const res = await readPendingApprovals(reader, 1000);
    expect(calls).toEqual([{ status: "PENDING", page: 1, pageSize: 100 }, { status: "PENDING", page: 2, pageSize: 100 }]);
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(res.approvals.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(res.more).toBe(false);
    expect(res.truncated).toBe(false);
  });

  it("stops when a page brings nothing new (Peta ignoring `page`) and flags more", async () => {
    let n = 0;
    const reader = { listApprovals: async () => { n++; return pageOf(["a", "b"], true, 1); } };
    const res = await readPendingApprovals(reader, 1000);
    expect(n).toBe(2);
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(res.approvals.map((a) => a.id)).toEqual(["a", "b"]);
    expect(res.more).toBe(true);
  });

  it("caps the walk at MAX_APPROVALS items / a page budget and flags more", async () => {
    let page = 0;
    const reader = { listApprovals: async () => { page++; return pageOf(Array.from({ length: 50 }, (_, i) => `p${page}-${i}`), true, page); } };
    const res = await readPendingApprovals(reader, 1000);
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(res.approvals).toHaveLength(MAX_APPROVALS);
    expect(res.more).toBe(true);
    expect(page).toBeLessThanOrEqual(MAX_APPROVALS / 50 + 1);
  });

  it("the budget covers the WHOLE walk — a slow second page fails the read with the timeout label", async () => {
    const reader = { listApprovals: (f?: unknown) => (f as { page: number }).page === 1 ? Promise.resolve(pageOf(["a"], true, 1)) : new Promise<unknown>(() => {}) };
    const res = await readPendingApprovals(reader, 40);
    expect(res).toEqual({ state: "failed", message: "the approval gate did not answer in time" });
  });

  it("a failing later page fails the whole read (fail closed, never a partial list presented as complete)", async () => {
    const reader = { listApprovals: async (f?: unknown) => { if ((f as { page: number }).page === 1) return pageOf(["a"], true, 1); throw new Error("boom"); } };
    expect(await readPendingApprovals(reader, 1000)).toEqual({ state: "failed", message: "the approval gate did not answer" });
  });

  it("accepts a numeric epoch createdAt (ms or s) and renders it as ISO; free-form values are still dropped", () => {
    const T = Date.parse("2026-08-26T12:00:00.000Z");
    expect(projectApprovalReference({ createdAt: T }).createdAt).toBe("2026-08-26T12:00:00.000Z");
    expect(projectApprovalReference({ createdAt: T / 1000 }).createdAt).toBe("2026-08-26T12:00:00.000Z");
    expect(projectApprovalReference({ createdAt: Number.NaN }).createdAt).toBeUndefined();
    expect(projectApprovalReference({ createdAt: { $date: 1 } }).createdAt).toBeUndefined();
  });
});
