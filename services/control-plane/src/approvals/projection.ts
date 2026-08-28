/**
 * Reference-only projection of Peta's approval queue (D8) — shared by the keycard door
 * (`GET /keycard/v1/approvals`, M1 task 2) and the operator's Pending-Approvals inbox
 * (`GET /admin/approvals`, M1 task 3). ONE closed allow-list of fields; nothing else passes —
 * never arguments, diff or payload. Bounded: `MAX_APPROVALS` items, `MAX_FIELD_CHARS` per field,
 * a caller-set upstream timeout. Every outcome is labelled; nothing here throws (CC2).
 */

/** Filter Peta's LIST_APPROVALS (9201) understands: status vocabulary is Peta's (`PENDING`), 1-based page. */
export interface ApprovalsListFilter {
  readonly status?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

/** The narrowest Peta surface a reader may hold — the decide verb is structurally out of reach. */
export interface ApprovalsReader {
  listApprovals(filter?: ApprovalsListFilter): Promise<unknown>;
}

/** Reference-only projection of an approval (D8): a closed allow-list of fields, nothing else passes. */
export interface ApprovalReference {
  readonly id?: string;
  readonly tool?: string;
  readonly server?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly requester?: string;
  /** Which approval store answered (BUGS #42) — stamped by {@link readPendingFromSources}. */
  readonly source?: string;
}

export const MAX_APPROVALS = 200;
export const MAX_FIELD_CHARS = 256;

/**
 * Code points that can reorder or hide text on a page without being markup: C0/C1 controls, zero-width
 * and bidi-control characters, BOM. Stripped from every projected field (display-spoofing hardening,
 * audit 2026-08-26) — the HTML escaper only handles the five metacharacters.
 */
const isSpoofingCodePoint = (c: number): boolean =>
  c <= 0x1f ||
  (c >= 0x7f && c <= 0x9f) ||
  (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2060 && c <= 0x2064) ||
  (c >= 0x2066 && c <= 0x2069) ||
  c === 0xfeff;

const clean = (v: string): string => {
  let out = "";
  for (const ch of v) {
    if (out.length >= MAX_FIELD_CHARS) break;
    if (!isSpoofingCodePoint(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
};

const pickString = (o: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return clean(v);
  }
  return undefined;
};

/** A time field: an ISO/free string as-is (cleaned), or a finite epoch number (ms, or s when small) as ISO. */
const pickTime = (o: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return clean(v);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) {
      try {
        return new Date(v >= 1e11 ? v : v * 1000).toISOString();
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
};

export function projectApprovalReference(raw: unknown): ApprovalReference {
  if (typeof raw !== "object" || raw === null) return {};
  const o = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  const set = (k: keyof ApprovalReference, v: string | undefined): void => {
    if (v !== undefined) out[k] = v;
  };
  set("id", pickString(o, "approvalId", "requestId", "id"));
  set("tool", pickString(o, "tool", "toolName"));
  set("server", pickString(o, "serverId", "serverName", "server"));
  set("status", pickString(o, "status", "state"));
  set("createdAt", pickTime(o, "createdAt", "requestedAt", "timestamp"));
  set("requester", pickString(o, "userId", "requester", "identity"));
  return out;
}

const LIST_KEYS = ["requests", "approvals", "items", "pending"] as const;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;

/**
 * Find the approvals array in Peta's response without trusting its shape. Peta 1.2.x answers
 * `LIST_APPROVALS` as `{ success, data: { requests: [...], page, pageSize, hasMore } }` (seen live
 * 2026-08-25); older/other shapes put the list at the top level. Two levels, closed key list.
 */
export function approvalsArray(res: unknown): unknown[] | undefined {
  if (Array.isArray(res)) return res;
  const o = asRecord(res);
  if (!o) return undefined;
  for (const k of LIST_KEYS) if (Array.isArray(o[k])) return o[k] as unknown[];
  const data = o["data"];
  if (Array.isArray(data)) return data;
  const d = asRecord(data);
  if (d) for (const k of LIST_KEYS) if (Array.isArray(d[k])) return d[k] as unknown[];
  return undefined;
}

/** Peta's own "there is another page" flag — only a literal boolean `true` counts. */
export function hasMoreApprovals(res: unknown): boolean {
  const o = asRecord(res);
  if (!o) return false;
  if (o["hasMore"] === true) return true;
  const d = asRecord(o["data"]);
  return d?.["hasMore"] === true;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error("upstream failed"));
      }
    );
  });
}

/** The ONLY texts a failed read may carry — never upstream text (TM-008). */
export type ReadFailureLabel =
  | "the approval gate did not answer"
  | "the approval gate did not answer in time"
  | "unexpected approvals response shape";

export type ApprovalsReadResult =
  | {
      readonly state: "ok";
      readonly approvals: readonly ApprovalReference[];
      /** More than MAX_APPROVALS came back; the list is cut. */
      readonly truncated: boolean;
      /** `truncated` OR Peta says another page exists (or the page walk stopped early). */
      readonly more: boolean;
    }
  | { readonly state: "failed"; readonly message: ReadFailureLabel };

const failureLabel = (err: unknown): ReadFailureLabel =>
  err instanceof Error && err.message === "timeout" ? "the approval gate did not answer in time" : "the approval gate did not answer";

/** Bounded, labelled read of the queue. Upstream text is never echoed — only our own labels. */
export async function readApprovalReferences(reader: ApprovalsReader, timeoutMs: number): Promise<ApprovalsReadResult> {
  let res: unknown;
  try {
    res = await withTimeout(reader.listApprovals(), timeoutMs);
  } catch (err) {
    return { state: "failed", message: failureLabel(err) };
  }
  const items = approvalsArray(res);
  if (!items) return { state: "failed", message: "unexpected approvals response shape" };
  const truncated = items.length > MAX_APPROVALS;
  return {
    state: "ok",
    approvals: items.slice(0, MAX_APPROVALS).map(projectApprovalReference),
    truncated,
    more: truncated || hasMoreApprovals(res)
  };
}


/** Page budget for the pending walk (Peta caps pageSize at 100 — verified live 2026-08-26 — so 2 pages cover MAX_APPROVALS; 10 is slack). */
export const MAX_PENDING_PAGES = 10;
/** Peta's maximum page size (a larger request is silently clamped to 100 — verified live). */
export const PENDING_PAGE_SIZE = 100;

/**
 * The inbox read (M1 task 3): ask Peta for PENDING items only and walk its pages until it reports no
 * more — bounded by `timeoutMs` for the WHOLE walk, MAX_PENDING_PAGES, and MAX_APPROVALS items.
 * Duplicates (by id) are dropped; a page that adds nothing new ends the walk with `more:true`
 * (a Peta that ignores `page` cannot spin us). Any page failing fails the whole read (CC2 — a partial
 * list is never presented as complete). Audit 2026-08-26 (SEV-2: first unfiltered page only).
 */
export async function readPendingApprovals(reader: ApprovalsReader, timeoutMs: number): Promise<ApprovalsReadResult> {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  const out: ApprovalReference[] = [];
  let truncated = false;
  let more = false;
  for (let page = 1; page <= MAX_PENDING_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: "failed", message: "the approval gate did not answer in time" };
    let res: unknown;
    try {
      res = await withTimeout(reader.listApprovals({ status: "PENDING", page, pageSize: PENDING_PAGE_SIZE }), remaining);
    } catch (err) {
      return { state: "failed", message: failureLabel(err) };
    }
    const items = approvalsArray(res);
    if (!items) return { state: "failed", message: "unexpected approvals response shape" };
    let added = 0;
    for (const raw of items) {
      const ref = projectApprovalReference(raw);
      if (ref.id !== undefined) {
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
      }
      if (out.length >= MAX_APPROVALS) {
        truncated = true;
        break;
      }
      out.push(ref);
      added++;
    }
    if (truncated) {
      more = true;
      break;
    }
    if (!hasMoreApprovals(res)) break;
    if (added === 0 || page === MAX_PENDING_PAGES) {
      more = true;
      break;
    }
  }
  return { state: "ok", approvals: out, truncated, more };
}

/** One approval store the inbox / door reads: a label and a reader (this host's Peta, Alden's gateway, …). */
export interface ApprovalSource {
  readonly label: string;
  readonly reader: ApprovalsReader;
}

export interface SourceRead {
  readonly label: string;
  readonly result: ApprovalsReadResult;
}

/**
 * Read EVERY store in parallel (BUGS #42): each gets the same bounded PENDING walk, so a hung store
 * costs one timeout for the whole read, not one per store; each reference is stamped with its
 * source; a failing store is reported by label while the others still answer. Never throws.
 */
export async function readPendingFromSources(sources: readonly ApprovalSource[], timeoutMs: number): Promise<readonly SourceRead[]> {
  return Promise.all(
    sources.map(async (src): Promise<SourceRead> => {
      const result = await readPendingApprovals(src.reader, timeoutMs);
      if (result.state !== "ok") return { label: src.label, result };
      return { label: src.label, result: { ...result, approvals: result.approvals.map((a) => ({ ...a, source: src.label })) } };
    })
  );
}
