/**
 * Mount-aware URLs (design 2026-08-27 — "the harness under the chat address").
 *
 * On the chat site the VM's Caddy serves the console under `/harness` (`handle_path` strips the
 * prefix and says so in `X-Forwarded-Prefix`); on the admin site the console sits at the root and
 * the header is absent. Every link, form action, asset, redirect, client fetch and WebSocket URL is
 * built through {@link withBase} with the base {@link basePathFrom} read for THIS request — so the
 * root mount is byte-for-byte unchanged and the prefixed mount never emits an escaping URL.
 *
 * The service is reachable only through Caddy (docker-bridge bind), so the header is Caddy's, not a
 * client's; it is still validated (lower-case segments, ≤ 3, no trailing slash, nothing else) and
 * anything unclean fails closed to the root mount (CC2).
 */

import type { IncomingHttpHeaders } from "node:http";

export const BASE_PATH_HEADER = "x-forwarded-prefix";

const CLEAN_PREFIX = /^(\/[a-z0-9-]+){1,3}$/;

/** The validated mount prefix for this request, or `""` for the root mount. */
export function basePathFrom(headers: IncomingHttpHeaders | Record<string, unknown>): string {
  const v = (headers as Record<string, unknown>)[BASE_PATH_HEADER];
  if (typeof v !== "string") return "";
  return CLEAN_PREFIX.test(v) ? v : "";
}

export const requestBase = (req: { readonly headers: IncomingHttpHeaders }): string => basePathFrom(req.headers);

/** `base + path` for an ABSOLUTE console path; a relative path would silently escape the base. */
export function withBase(base: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`withBase: path must be absolute and single-slash (got ${JSON.stringify(path)})`);
  }
  return base + path;
}
