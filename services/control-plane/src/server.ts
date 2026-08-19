/**
 * Control-plane server entrypoint (Task #16f). Composes the whole app into one runnable Fastify
 * instance and (when invoked directly) listens — so `npm start` serves the Config page, the harness
 * frame, and Claude-CLI terminal tabs.
 *
 * Config via env (see {@link configFromEnv}):
 *   ADMIN_API_TOKEN  (required)  — the admin bearer guard (API/headless)
 *   PANTHEON_OPERATOR_PASSWORD   (optional)    — enables #9 browser login (/login) + cookie auth
 *   PANTHEON_SECURE_COOKIES=true (behind HTTPS) — add Secure to the session cookie
 *   PANTHEON_DB      (./data/control-plane.db) — registry SQLite path (persistent)
 *   PANTHEON_KEY_DIR (~/.pantheon/keys)        — harness SSH key custody dir
 *   PETA_URL + PETA_ADMIN_TOKEN  (optional)    — Peta admin API for MCP-server registration
 *   PORT (8088) / HOST (0.0.0.0)
 *
 * Terminal sessions connect key-only via the custodied harness key (TM-020/#14b); the key never
 * reaches the browser. The chat pre-processor (`/v1/chat/completions`) is a later wiring seam and is
 * intentionally not mounted here yet.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./http/app.js";
import { SqliteRegistry, seedDefaults } from "./registry/sqlite-repository.js";
import { RegistryService } from "./registry/service.js";
import { McpRegistrationService, type PetaServerAdmin } from "./registry/mcp-registration.js";
import { PetaAdminClient } from "./peta/index.js";
import { registerTerminalRoute } from "./http/routes/terminal.js";
import { registerEnrollmentRoute } from "./http/routes/enrollment.js";
import { enrollMachine } from "./devmachine/enrollment.js";
import { ssh2EnrollmentPort } from "./devmachine/enrollment-ssh.js";
import { ChildProcessRunner, SshKeygenGenerator } from "./devmachine/index.js";
import {
  FileKeyCustody,
  TerminalRegistry,
  connectTerminal,
  defaultKeyDir,
  type SshTarget
} from "./devmachine/index.js";

export interface ServerConfig {
  readonly adminToken: string;
  readonly dbPath: string;
  readonly keyDir: string;
  readonly peta?: { readonly url: string; readonly token: string };
  /** Operator passphrase for #9 browser login (§7). When set, /login is enabled. */
  readonly operatorPassword?: string;
  /** Add `Secure` to the session cookie (set true behind HTTPS/your reverse proxy). */
  readonly secureCookies?: boolean;
  /** Custody handle of the shared harness keypair (PANTHEON_KEY_HANDLE, default "harness"). */
  readonly keyHandle: string;
  /** Injected fetch for the Peta client (tests). */
  readonly fetchFn?: typeof fetch;
}

/** A PetaServerAdmin that fails clearly when Peta isn't configured (the Config page shows a banner). */
function unconfiguredPeta(): PetaServerAdmin {
  const fail = async (): Promise<never> => {
    throw new Error("Peta is not configured (set PETA_URL + PETA_ADMIN_TOKEN)");
  };
  return { createServer: fail, getServers: fail };
}

/** Build the fully-wired control-plane app (does NOT listen). */
export async function createServer(cfg: ServerConfig): Promise<FastifyInstance> {
  if (!cfg.adminToken) throw new Error("ADMIN_API_TOKEN is required");

  const repo = new SqliteRegistry(cfg.dbPath);
  seedDefaults(repo);
  const registry = new RegistryService(repo);

  const petaAdmin: PetaServerAdmin = cfg.peta
    ? new PetaAdminClient(cfg.peta.url, cfg.peta.token, cfg.fetchFn)
    : unconfiguredPeta();
  const mcp = new McpRegistrationService(petaAdmin);

  const app = buildApp({
    adminToken: cfg.adminToken,
    registry,
    mcp,
    ...(cfg.operatorPassword ? { operatorPassword: cfg.operatorPassword } : {}),
    ...(cfg.secureCookies !== undefined ? { secureCookies: cfg.secureCookies } : {})
  });

  // Terminal modality (ADR-0005): key-only SSH brokered server-side from custody.
  const custody = new FileKeyCustody(cfg.keyDir);
  const terminals = new TerminalRegistry();
  const connect = (target: SshTarget, handle: string) => connectTerminal(target, handle, { custody });
  await registerTerminalRoute(app, { registry, terminals, connect });

  // One-time enrollment from the Configuration page (ADR-0005): the operator supplies the target
  // machine's password in the browser, the server installs the harness PUBLIC key and verifies a
  // key-only login. Setting a machine up must not require the operator to run anything locally.
  const keygen = new SshKeygenGenerator(new ChildProcessRunner());
  const enrollSsh = ssh2EnrollmentPort();
  registerEnrollmentRoute(app, {
    registry,
    enroll: (target, handle, password) =>
      enrollMachine(target, handle, password, { custody, keygen, ssh: enrollSsh }),
    keyHandle: cfg.keyHandle
  });

  return app;
}

export function configFromEnv(env: Record<string, string | undefined>): ServerConfig {
  const adminToken = env["ADMIN_API_TOKEN"] ?? "";
  const peta =
    env["PETA_URL"] && env["PETA_ADMIN_TOKEN"]
      ? { url: env["PETA_URL"], token: env["PETA_ADMIN_TOKEN"] }
      : undefined;
  return {
    adminToken,
    dbPath: env["PANTHEON_DB"] ?? resolve("data/control-plane.db"),
    keyDir: env["PANTHEON_KEY_DIR"] ?? defaultKeyDir(),
    keyHandle: env["PANTHEON_KEY_HANDLE"] ?? "harness",
    ...(peta ? { peta } : {}),
    ...(env["PANTHEON_OPERATOR_PASSWORD"] ? { operatorPassword: env["PANTHEON_OPERATOR_PASSWORD"] } : {}),
    ...(env["PANTHEON_SECURE_COOKIES"] === "true" ? { secureCookies: true } : {})
  };
}

async function main(): Promise<void> {
  const cfg = configFromEnv(process.env);
  const app = await createServer(cfg);
  const port = Number(process.env["PORT"] ?? "8088");
  const host = process.env["HOST"] ?? "0.0.0.0";
  await app.listen({ port, host });
  console.error(`pantheon control-plane listening on http://${host}:${port}  (harness: /harness)`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err: unknown) => {
    console.error(`server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
