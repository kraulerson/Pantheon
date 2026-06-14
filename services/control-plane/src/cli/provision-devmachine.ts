/**
 * Provisioning CLI (Task #16b, ADR-0005) — run on the Pantheon host, at the console/keyboard.
 *
 *   node dist/cli/provision-devmachine.js <logicalName>
 *
 * Generates the harness keypair once (into custody on this host), installs its PUBLIC key on the
 * named dev machine via `ssh-copy-id` (the operator types the machine password ONCE), then records
 * `provisioned=true` + the key handle on the registry row. Every Claude-CLI terminal session after
 * this connects key-only. The private key never leaves custody (TM-020/#14b).
 *
 * Config via env:
 *   PANTHEON_DB         — path to the control-plane SQLite DB (default ./data/control-plane.db)
 *   PANTHEON_KEY_DIR    — harness key custody dir (default ~/.pantheon/keys)
 *   PANTHEON_KEY_HANDLE — custody handle of the shared harness keypair (default "harness")
 *
 * Wiring only — the orchestration it calls (provisionMachine / provisionAndRecord) is unit-tested.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SqliteRegistry } from "../registry/sqlite-repository.js";
import { RegistryService } from "../registry/service.js";
import {
  ChildProcessRunner,
  FileKeyCustody,
  SshKeygenGenerator,
  defaultKeyDir,
  provisionAndRecord,
  provisionMachine,
  type ProvisionResult,
  type SshTarget
} from "../devmachine/index.js";

/** Recognised env keys: PANTHEON_DB, PANTHEON_KEY_DIR, PANTHEON_KEY_HANDLE. */
export type CliEnv = Record<string, string | undefined>;

export async function main(argv: string[], env: CliEnv): Promise<number> {
  const logicalName = argv[0];
  if (!logicalName || logicalName === "--help" || logicalName === "-h") {
    console.error("usage: provision-devmachine <logicalName>");
    console.error("  (the machine must already be registered via the Configuration page)");
    return logicalName ? 0 : 2;
  }

  const dbPath = env["PANTHEON_DB"] ?? resolve("data/control-plane.db");
  const keyDir = env["PANTHEON_KEY_DIR"] ?? defaultKeyDir();
  const keyHandle = env["PANTHEON_KEY_HANDLE"] ?? "harness";

  const registry = new RegistryService(new SqliteRegistry(dbPath));
  const custody = new FileKeyCustody(keyDir);
  const runner = new ChildProcessRunner();
  const keygen = new SshKeygenGenerator(runner);

  const provision = (target: SshTarget, handle: string): Promise<ProvisionResult> =>
    provisionMachine(target, handle, { custody, runner, keygen });

  console.error(`Provisioning '${logicalName}' (key custody: ${keyDir}, handle: ${keyHandle})…`);
  console.error("You will be prompted for the dev machine's password ONCE (ssh-copy-id).");

  const machine = await provisionAndRecord(logicalName, { registry, provision, keyHandle });
  console.error(
    `✓ '${machine.logicalName}' provisioned (${machine.user}@${machine.host}:${machine.port}). ` +
      `Future sessions connect key-only.`
  );
  return 0;
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(`✗ provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
