/**
 * One-time SSH provisioning for a DevMachine (Task #16b, ADR-0005, TM-020).
 *
 * Generate the harness keypair once (into custody on the Pantheon host), then install the PUBLIC
 * key on the dev machine with `ssh-copy-id` — which prompts for the machine password ONCE,
 * interactively (the operator is at the keyboard / console of the Pantheon host). Every connection
 * afterwards is key-only. The PRIVATE key never leaves custody and is never handed to a command;
 * only the public key (written to a scratch file) is passed to `ssh-copy-id`.
 *
 * The runner + key generator are injected (ports), so the orchestration is fully unit-testable and
 * the real, side-effecting implementations live at the edges (a CLI wires the interactive runner).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type KeyCustody } from "./custody.js";

/** Runs shell commands. `runInteractive` inherits stdio so `ssh-copy-id` can prompt for a password. */
export interface CommandRunner {
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Returns the child's exit code; inherits the parent's stdio (TTY) for interactive prompts. */
  runInteractive(cmd: string, args: string[]): Promise<number>;
}

/** Generates an SSH keypair (OpenSSH format). MVP impl shells out to `ssh-keygen`. */
export interface KeyGenerator {
  generate(comment: string): Promise<{ privateKey: string; publicKey: string }>;
}

export interface SshTarget {
  readonly logicalName: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

export interface ProvisionDeps {
  readonly custody: KeyCustody;
  readonly runner: CommandRunner;
  readonly keygen: KeyGenerator;
}

export interface ProvisionResult {
  readonly keyHandle: string;
  /** True when this run created a new harness keypair (false when an existing one was reused). */
  readonly generatedKeyPair: boolean;
}

/** Provisioning failures (keygen or `ssh-copy-id`). Carries no key material. */
export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/**
 * Ensure the harness keypair exists in custody, then install its public half on `target` via
 * `ssh-copy-id`. The caller persists `{ provisioned: true, sshKeyHandle: handle }` to the registry
 * on success — provisioning here does not touch the DB.
 */
export async function provisionMachine(target: SshTarget, handle: string, deps: ProvisionDeps): Promise<ProvisionResult> {
  const { custody, runner, keygen } = deps;

  let generatedKeyPair = false;
  if (!(await custody.hasKeyPair(handle))) {
    const { privateKey, publicKey } = await keygen.generate(`harness@pantheon:${handle}`);
    await custody.storeKeyPair(handle, privateKey, publicKey);
    generatedKeyPair = true;
  }

  // Public key only (not secret) — written to a 0700 scratch dir for `ssh-copy-id -i`.
  const publicKey = await custody.resolvePublicKey(handle);
  const scratch = await mkdtemp(join(tmpdir(), "pantheon-copyid-"));
  const pubFile = join(scratch, `${handle}.pub`);
  try {
    await writeFile(pubFile, publicKey, { mode: 0o644 });
    const code = await runner.runInteractive("ssh-copy-id", [
      "-i",
      pubFile,
      "-p",
      String(target.port),
      `${target.user}@${target.host}`
    ]);
    if (code !== 0) {
      throw new ProvisioningError(
        `ssh-copy-id failed for ${target.logicalName} (${target.user}@${target.host}:${target.port}), exit ${code}`
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  return { keyHandle: handle, generatedKeyPair };
}
