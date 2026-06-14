/**
 * SSH key custody for the harness's own keypair (PROJECT_BIBLE §7, TM-020/#14b, ADR-0005).
 *
 * The Pantheon control-plane is the SSH *client*. Its PRIVATE key lives on the Pantheon host and is
 * resolved server-side, by opaque handle, at connect time — it NEVER reaches the browser, the
 * terminal buffer, any session context, or the logs. `ssh-copy-id` installs only the PUBLIC half on
 * each dev machine. This is the MVP file-backed custody; a vault implementation is a later drop-in
 * swap behind {@link KeyCustody} (the seam mirrors the existing gitignored-secret pattern).
 */

import { constants as FS } from "node:fs";
import { access, chmod, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Custody seam: resolve/store an SSH keypair by opaque handle. No raw key ever crosses to a client. */
export interface KeyCustody {
  hasKeyPair(handle: string): Promise<boolean>;
  /** Store a freshly generated keypair under a handle. Private key persisted owner-only (0600). */
  storeKeyPair(handle: string, privatePem: string, publicKey: string): Promise<void>;
  /** Resolve the PEM/OpenSSH private key for an ssh2 connection. Server-side only. */
  resolvePrivateKey(handle: string): Promise<string>;
  /** Resolve the public key (for `ssh-copy-id`). Public keys are not secret. */
  resolvePublicKey(handle: string): Promise<string>;
}

/** Custody/permission failures. Carries no key material. */
export class CustodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustodyError";
  }
}

/** A handle must be a bare, safe filename — no path separators, traversal, or hidden-only names. */
const HANDLE_RE = /^[A-Za-z0-9._-]+$/;

function assertHandle(handle: string): string {
  if (typeof handle !== "string" || !HANDLE_RE.test(handle) || handle === "." || handle === "..") {
    throw new CustodyError(`invalid key handle: ${String(handle)}`);
  }
  return handle;
}

export class FileKeyCustody implements KeyCustody {
  /** `keyDir` defaults to `~/.pantheon/keys`; tests pass a temp dir. */
  constructor(private readonly keyDir: string) {}

  private privPath(handle: string): string {
    return join(this.keyDir, assertHandle(handle));
  }
  private pubPath(handle: string): string {
    return `${join(this.keyDir, assertHandle(handle))}.pub`;
  }

  async hasKeyPair(handle: string): Promise<boolean> {
    const p = this.privPath(handle);
    try {
      await access(p, FS.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async storeKeyPair(handle: string, privatePem: string, publicKey: string): Promise<void> {
    const priv = this.privPath(handle);
    const pub = this.pubPath(handle);
    // Key dir owner-only — re-assert even if it pre-existed with looser perms (umask-proof).
    await mkdir(this.keyDir, { recursive: true, mode: 0o700 });
    await chmod(this.keyDir, 0o700);
    // Open the file, tighten to 0600 BEFORE writing any key bytes (closes the umask/pre-existing-mode
    // window where the secret could briefly sit group/world-readable).
    const fh = await open(priv, "w", 0o600);
    try {
      await fh.chmod(0o600);
      await fh.writeFile(privatePem);
    } finally {
      await fh.close();
    }
    await writeFile(pub, publicKey, { mode: 0o644 });
  }

  async resolvePrivateKey(handle: string): Promise<string> {
    const p = this.privPath(handle);
    // O_NOFOLLOW: refuse if the final component is a symlink (no following to an attacker target).
    // Reading mode via fstat on the SAME fd we read from closes the stat→read TOCTOU window.
    let fh;
    try {
      fh = await open(p, FS.O_RDONLY | FS.O_NOFOLLOW);
    } catch {
      throw new CustodyError(`no usable private key for handle: ${handle} (missing or a symlink)`);
    }
    try {
      const info = await fh.stat();
      if (!info.isFile()) {
        throw new CustodyError(`private key for '${handle}' is not a regular file — refusing`);
      }
      // Fail closed if anyone but the owner can read the private key.
      if ((info.mode & 0o077) !== 0) {
        throw new CustodyError(
          `private key for '${handle}' is group/world-readable — refusing to use it (expected 0600 permission)`
        );
      }
      return await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  }

  async resolvePublicKey(handle: string): Promise<string> {
    try {
      return await readFile(this.pubPath(handle), "utf8");
    } catch {
      throw new CustodyError(`no public key for handle: ${handle}`);
    }
  }
}

/** Default key directory on the Pantheon host: `~/.pantheon/keys`. */
export function defaultKeyDir(home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "."): string {
  return join(home, ".pantheon", "keys");
}
