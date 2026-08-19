/**
 * The operator-facing user guide, served at `/help`.
 *
 * The guide is authored as HTML in the repo (`docs/user-guide.html`) rather than rendered from
 * Markdown at runtime: it is a static document we control, and adding a Markdown parser to the
 * runtime would be new supply-chain surface for no benefit. Read once at startup, like the xterm
 * assets — the file is committed, so a missing file is a build/deploy fault worth failing on.
 *
 * PUBLIC by operator ruling (2026-08-19): reachable without signing in, so the chat page's
 * Help link always opens it. It documents layout and admin functions but contains no
 * credentials, key material, or tokens — keep it that way.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved relative to this module so it works identically from `src/` (tests) and `dist/` (built):
// both live two levels below the service root, four below the repo root.
const GUIDE_PATH = fileURLToPath(new URL("../../../../docs/user-guide.html", import.meta.url));

export const USER_GUIDE_HTML: string = readFileSync(GUIDE_PATH, "utf8");

/** Route path, exported so the guard's public-path allowlist and the route stay in step. */
export const USER_GUIDE_PATH = "/help";
