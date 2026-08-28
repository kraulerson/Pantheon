/**
 * Extra approval stores (BUGS #42, UAT-4 #14). The household's identities run behind Alden's
 * capability gateway, which has its OWN Peta; this host's Peta held no ticket while Alden's did.
 * The inbox and the keycard door therefore read a LIST of stores: this host's Peta ("Pantheon")
 * plus whatever `PANTHEON_APPROVAL_SOURCES` names — JSON `[{ label, url, token }]`, tokens only ever
 * in the env. A malformed value fails LOUD at startup: silently reading fewer stores is exactly the
 * failure this exists to fix (CC2).
 */

/** Label of this host's own Peta; reserved — an extra source may not reuse it. */
export const LOCAL_SOURCE_LABEL = "Pantheon";

export interface ApprovalSourceConfig {
  readonly label: string;
  /** Origin only (`http(s)://host[:port]`) — the client appends `/admin`. */
  readonly url: string;
  readonly token: string;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

const fail = (what: string): never => {
  throw new Error(`PANTHEON_APPROVAL_SOURCES: ${what}`);
};

/** Parse the env value. Never echoes a token in an error. */
export function approvalSourcesFrom(raw: string | undefined): readonly ApprovalSourceConfig[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("not valid JSON (expected a list of { label, url, token })");
  }
  if (!Array.isArray(parsed)) return fail("must be a JSON list of { label, url, token }");
  const out: ApprovalSourceConfig[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, i) => {
    const o = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : fail(`entry ${i + 1} is not an object`);
    const label = o["label"];
    if (typeof label !== "string" || !LABEL_RE.test(label)) fail(`entry ${i + 1}: label must be 1–40 letters, digits, space, '.', '_' or '-'`);
    const lbl = label as string;
    if (lbl === LOCAL_SOURCE_LABEL) fail(`entry ${i + 1}: label "${LOCAL_SOURCE_LABEL}" is reserved for this host's own Peta`);
    if (seen.has(lbl)) fail(`entry ${i + 1}: duplicate label "${lbl}"`);
    const url = o["url"];
    if (typeof url !== "string" || !ORIGIN_RE.test(url)) fail(`entry ${i + 1} ("${lbl}"): url must be an origin like http://host:port (no path)`);
    const token = o["token"];
    if (typeof token !== "string" || token.length === 0) fail(`entry ${i + 1} ("${lbl}"): token must be a non-empty string`);
    seen.add(lbl);
    out.push({ label: lbl, url: url as string, token: token as string });
  });
  return out;
}
