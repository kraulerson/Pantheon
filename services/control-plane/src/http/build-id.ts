/**
 * Which build is running (operator report 2026-08-28: "were the updates deployed?").
 *
 * A server-rendered console page carries no version, so a stale browser copy is indistinguishable
 * from a failed deploy. Every response now carries `X-Pantheon-Build`, the harness header shows the
 * same stamp, and every asset URL is suffixed with it — so a cached stylesheet can never mask a
 * release, and `curl -I` answers the question in one line.
 *
 * Value: `PANTHEON_BUILD` when set (a deploy may pass the commit), else the mtime of this module in
 * `dist/` — which `npm run build` rewrites on every deploy — else `dev`.
 */

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SAFE = /^[A-Za-z0-9._-]{1,40}$/;

function computeBuildId(): string {
  const fromEnv = process.env["PANTHEON_BUILD"];
  if (fromEnv !== undefined && SAFE.test(fromEnv)) return fromEnv;
  try {
    const mtime = statSync(fileURLToPath(import.meta.url)).mtime;
    return mtime.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  } catch {
    return "dev";
  }
}

export const BUILD_ID: string = computeBuildId();
export const BUILD_HEADER = "X-Pantheon-Build";

/** Append the build to an asset URL so a browser fetches the new copy after every deploy. */
export const withBuild = (url: string): string => `${url}${url.includes("?") ? "&" : "?"}b=${BUILD_ID}`;
