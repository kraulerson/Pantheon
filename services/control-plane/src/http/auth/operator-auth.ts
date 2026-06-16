/**
 * Operator browser auth (#9, PROJECT_BIBLE §7 tier-1). Control-plane-native login: the operator
 * passphrase mints a server-side session whose id rides in an httpOnly, SameSite=Lax cookie. The
 * guard accepts that cookie OR the admin bearer token, so browsers (which can't set an Authorization
 * header — including on the same-origin WebSocket handshake) authenticate by cookie, while scripts
 * keep using the bearer. The D6 privileged step-up (passkey/WebAuthn) is a separate future layer.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminGuard } from "../app.js";
import { SessionStore } from "./session.js";

export const SESSION_COOKIE = "pantheon_session";
/** Routes reachable while logged out (added to the app's guard exemptions). */
export const AUTH_PUBLIC_PATHS: readonly string[] = ["/login", "/logout"];

/** Constant-time compare of two secrets via fixed-length digests (no length leak). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function setCookie(reply: FastifyReply, value: string, maxAgeSec: number, secure: boolean): void {
  const attrs = [`${SESSION_COOKIE}=${value}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${maxAgeSec}`];
  if (secure) attrs.push("Secure");
  reply.header("set-cookie", attrs.join("; "));
}

/**
 * Admin-tier guard accepting EITHER the admin bearer token OR a valid operator session cookie.
 * Mirrors the bearer semantics (wrong bearer → 403) so existing API behavior is unchanged; a
 * missing/!valid credential → 401 (the onRequest hook turns that into a /login redirect for browsers).
 */
export function operatorGuard(adminToken: string, sessions?: SessionStore): AdminGuard {
  return (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      const presented = header.slice("Bearer ".length);
      const ab = Buffer.from(presented);
      const bb = Buffer.from(adminToken);
      if (ab.length === bb.length && timingSafeEqual(ab, bb)) return { ok: true };
      return { ok: false, status: 403, reason: "invalid_token" };
    }
    if (sessions) {
      const sid = parseSessionCookie(req.headers.cookie);
      if (sid && sessions.validate(sid)) return { ok: true };
    }
    return { ok: false, status: 401, reason: "unauthenticated" };
  };
}

function renderLoginPage(error = false): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pantheon Harness — Login</title>
<style>body{font-family:system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem}label{display:block;margin:.5rem 0}input{width:100%;padding:.4rem}</style></head>
<body>
<h1>Pantheon Harness</h1>
${error ? `<p role="alert"><strong>Incorrect password.</strong></p>` : ""}
<form method="post" action="/login">
  <label>Operator password <input type="password" name="password" autocomplete="current-password" autofocus required></label>
  <button type="submit">Log in</button>
</form>
</body>
</html>`;
}

export interface AuthRoutesOptions {
  readonly operatorPassword: string;
  readonly sessions: SessionStore;
  /** Add the `Secure` cookie attribute (set true when served over HTTPS). */
  readonly secureCookies?: boolean;
  readonly sessionTtlSec?: number;
}

/** Mount the public /login (GET form, POST authenticate) and /logout routes. */
export function registerAuthRoutes(app: FastifyInstance, opts: AuthRoutesOptions): void {
  const ttl = opts.sessionTtlSec ?? 12 * 60 * 60;

  app.get("/login", async (_req, reply) => {
    reply.type("text/html").send(renderLoginPage(false));
  });

  app.post("/login", async (req, reply) => {
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== "string" || !timingSafeEqualStr(password, opts.operatorPassword)) {
      reply.code(401).type("text/html").send(renderLoginPage(true));
      return;
    }
    const id = opts.sessions.create();
    setCookie(reply, id, ttl, opts.secureCookies ?? false);
    reply.redirect("/harness");
  });

  app.post("/logout", async (req, reply) => {
    const sid = parseSessionCookie(req.headers.cookie);
    if (sid) opts.sessions.destroy(sid);
    setCookie(reply, "", 0, opts.secureCookies ?? false);
    reply.redirect("/login");
  });
}
