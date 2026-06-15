/**
 * register-devmachine CLI (Task #16f) — register a DevMachine row directly in the control-plane DB,
 * so the operator can add a machine and then provision it without first standing up the guarded API.
 *
 *   node dist/cli/register-devmachine.js --name mac-studio --host 192.168.1.192 --user karl [--port 22]
 *
 * Then: `node dist/cli/provision-devmachine.js mac-studio` (installs the harness public key).
 * Config via env: PANTHEON_DB (default ./data/control-plane.db).
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SqliteRegistry } from "../registry/sqlite-repository.js";
import { RegistryService } from "../registry/service.js";
import { type NewDevMachine } from "../registry/types.js";

export interface RegisterArgs {
  readonly logicalName: string;
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly enabled: true;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function parseRegisterArgs(argv: string[]): RegisterArgs {
  const logicalName = flag(argv, "name");
  const host = flag(argv, "host");
  const user = flag(argv, "user");
  if (!logicalName) throw new Error("missing required --name <logicalName>");
  if (!host) throw new Error("missing required --host <ip/hostname>");
  if (!user) throw new Error("missing required --user <ssh-user>");
  const portStr = flag(argv, "port");
  let port = 22;
  if (portStr !== undefined) {
    port = Number(portStr);
    if (!Number.isInteger(port)) throw new Error(`--port must be an integer: ${portStr}`);
  }
  return { logicalName, host, user, port, enabled: true };
}

export function main(argv: string[], env: Record<string, string | undefined>): number {
  let args: RegisterArgs;
  try {
    args = parseRegisterArgs(argv);
  } catch (err) {
    console.error(`usage: register-devmachine --name <n> --host <h> --user <u> [--port 22]`);
    console.error(String(err instanceof Error ? err.message : err));
    return 2;
  }
  const dbPath = env["PANTHEON_DB"] ?? resolve("data/control-plane.db");
  const registry = new RegistryService(new SqliteRegistry(dbPath));
  const input: NewDevMachine = { logicalName: args.logicalName, host: args.host, user: args.user, port: args.port, enabled: true };
  const m = registry.createDevMachine(input);
  console.error(`✓ registered '${m.logicalName}' (${m.user}@${m.host}:${m.port}). Next: provision-devmachine ${m.logicalName}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2), process.env));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
