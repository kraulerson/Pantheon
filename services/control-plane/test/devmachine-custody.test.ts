/**
 * FileKeyCustody — Task #16(b), the MVP custody for the harness's own SSH keypair on the Pantheon
 * host (PROJECT_BIBLE §7, TM-020/#14b). The harness is the SSH *client*; its PRIVATE key lives on
 * the Pantheon VM, resolved server-side by opaque handle at connect time, NEVER sent to the
 * browser/terminal/logs. ssh-copy-id installs only the PUBLIC half on the dev machine.
 *
 * Security invariants under test:
 *   - private key files are written 0600 and REFUSED if group/world-readable (fail closed);
 *   - the handle is a safe filename — path traversal out of the key dir is rejected;
 *   - resolving an unknown handle throws (no silent empty key).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, chmodSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyCustody } from "../src/devmachine/custody.js";

const PRIV = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEKEYMATERIAL\n-----END OPENSSH PRIVATE KEY-----\n";
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEPUBLIC harness@pantheon\n";

describe("FileKeyCustody", () => {
  let dir: string;
  let custody: FileKeyCustody;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pantheon-keys-"));
    custody = new FileKeyCustody(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no keypair before one is stored, and yes afterwards", async () => {
    expect(await custody.hasKeyPair("harness")).toBe(false);
    await custody.storeKeyPair("harness", PRIV, PUB);
    expect(await custody.hasKeyPair("harness")).toBe(true);
  });

  it("round-trips the private and public key by handle", async () => {
    await custody.storeKeyPair("harness", PRIV, PUB);
    expect(await custody.resolvePrivateKey("harness")).toBe(PRIV);
    expect(await custody.resolvePublicKey("harness")).toBe(PUB);
  });

  it("writes the private key file with 0600 permissions (owner-only)", async () => {
    await custody.storeKeyPair("harness", PRIV, PUB);
    const mode = statSync(join(dir, "harness")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("REFUSES to resolve a private key that is group/world-readable (fail closed)", async () => {
    await custody.storeKeyPair("harness", PRIV, PUB);
    chmodSync(join(dir, "harness"), 0o644); // someone loosened perms
    await expect(custody.resolvePrivateKey("harness")).rejects.toThrow(/permission|0600|readable/i);
  });

  it("REFUSES to resolve a private key reached through a symlink (no following)", async () => {
    await custody.storeKeyPair("realkey", PRIV, PUB);
    symlinkSync(join(dir, "realkey"), join(dir, "harness")); // harness -> realkey (0600)
    await expect(custody.resolvePrivateKey("harness")).rejects.toThrow();
  });

  it("rejects a path-traversal handle on every operation (stays inside the key dir)", async () => {
    for (const evil of ["../escape", "../../etc/passwd", "a/b", "foo/../bar", "."]) {
      await expect(custody.resolvePrivateKey(evil)).rejects.toThrow();
      await expect(custody.hasKeyPair(evil)).rejects.toThrow();
      await expect(custody.storeKeyPair(evil, PRIV, PUB)).rejects.toThrow();
    }
  });

  it("throws when resolving an unknown handle (no silent empty key)", async () => {
    await expect(custody.resolvePrivateKey("missing")).rejects.toThrow();
    await expect(custody.resolvePublicKey("missing")).rejects.toThrow();
  });
});
