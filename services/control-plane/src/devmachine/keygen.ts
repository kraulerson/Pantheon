/**
 * SshKeygenGenerator — the real {@link KeyGenerator} (Task #16b). Shells out to `ssh-keygen` to
 * mint the harness ed25519 keypair, reads both halves, and removes the scratch files. The private
 * key is returned to the caller (which hands it straight to custody) and never persisted outside
 * custody by this module.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandRunner, type KeyGenerator } from "./provisioning.js";

export class SshKeygenGenerator implements KeyGenerator {
  constructor(private readonly runner: CommandRunner) {}

  async generate(comment: string): Promise<{ privateKey: string; publicKey: string }> {
    const scratch = await mkdtemp(join(tmpdir(), "pantheon-keygen-"));
    const keyPath = join(scratch, "id_ed25519");
    try {
      // -N "" : no passphrase (key-only auth, custody protects at rest). -q : quiet.
      const r = await this.runner.run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyPath, "-q"]);
      if (r.code !== 0) {
        throw new Error(`ssh-keygen failed (exit ${r.code})`);
      }
      const [privateKey, publicKey] = await Promise.all([
        readFile(keyPath, "utf8"),
        readFile(`${keyPath}.pub`, "utf8")
      ]);
      return { privateKey, publicKey };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
