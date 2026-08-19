/**
 * Password-bootstrap enrollment for a DevMachine (ADR-0005, TM-020).
 *
 * Sibling of `provisioning.ts`, for the path that has no terminal. `ssh-copy-id` prompts on a TTY,
 * so it can only serve an operator sitting at the Pantheon host's console; an HTTP request has no
 * TTY, which is why setting a machine up used to require the operator to run a command on their own
 * machine. Enrollment closes that hole: the operator supplies the target's password ONCE in the
 * admin UI, this module uses it for a single ssh2 connection to append the harness PUBLIC key to
 * the target's `authorized_keys`, and then proves the result by reconnecting KEY-ONLY.
 *
 * Rules this module keeps:
 *   - The password authenticates one connection and is never persisted, logged, echoed, or placed
 *     in a remote command line (where it would land in the target's process list).
 *   - The PRIVATE key never leaves custody (TM-020/#14b); only the public half is installed.
 *   - "Provisioned" is claimed only after a key-only login actually succeeds — a successful append
 *     is not evidence that key auth works.
 *   - The remote command is built from a public key that has been checked against a strict grammar
 *     first, so nothing can break out of the shell quoting.
 */

import { type KeyCustody } from "./custody.js";
import { type SshTarget, type KeyGenerator } from "./provisioning.js";

/** One authenticated connection to the target. `exec` runs a command; `end` closes the transport. */
export interface EnrollmentSession {
  exec(command: string): Promise<{ code: number; stdout: string; stderr: string }>;
  end(): void;
}

/**
 * The two connections enrollment needs, injected as a port so the orchestration is unit-testable
 * without a live host (the real adapter wraps `ssh2.Client`, like `connection.ts` does).
 */
export interface EnrollmentSshPort {
  /** Password auth — used exactly once, to install the key. */
  connectWithPassword(target: SshTarget, password: string): Promise<EnrollmentSession>;
  /** Key auth — the verification that the install actually took. */
  connectWithKey(target: SshTarget, privateKey: string): Promise<EnrollmentSession>;
}

export interface EnrollmentDeps {
  readonly custody: KeyCustody;
  readonly keygen: KeyGenerator;
  readonly ssh: EnrollmentSshPort;
}

export interface EnrollmentResult {
  readonly keyHandle: string;
  /** True when this run created the harness keypair (false when an existing one was reused). */
  readonly generatedKeyPair: boolean;
}

/**
 * Enrollment failures. Carries NO password and no key material: the message is what the operator
 * sees in the browser, and upstream error text from ssh2 can quote the credential it was given.
 */
export class EnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrollmentError";
  }
}

/**
 * An OpenSSH public key line: type, base64 body, optional comment. Deliberately strict — this
 * value is interpolated into a single-quoted remote shell string, so a quote or newline inside it
 * would be a command-injection vector. Anything that does not match is refused before connecting.
 */
const PUBLIC_KEY_RE = /^(ssh|ecdsa)-[A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}(?: [^\r\n'"\\]*)?$/;

/** Build the remote install command. Idempotent: the key is appended only if not already present. */
function installCommand(publicKey: string): string {
  // Single-quoted throughout; PUBLIC_KEY_RE has already guaranteed the key contains no quote,
  // backslash or newline. `grep -qxF` matches the whole line literally, so a re-run is a no-op.
  return [
    "mkdir -p ~/.ssh",
    "chmod 700 ~/.ssh",
    "touch ~/.ssh/authorized_keys",
    "chmod 600 ~/.ssh/authorized_keys",
    `grep -qxF '${publicKey}' ~/.ssh/authorized_keys || printf '%s\\n' '${publicKey}' >> ~/.ssh/authorized_keys`
  ].join(" && ");
}

/**
 * Ensure the harness keypair exists, install its public half on `target` using the supplied
 * password, then verify key-only login. The caller persists `{ provisioned: true }` on success —
 * this module does not touch the registry.
 */
export async function enrollMachine(
  target: SshTarget,
  handle: string,
  password: string,
  deps: EnrollmentDeps
): Promise<EnrollmentResult> {
  const { custody, keygen, ssh } = deps;

  if (typeof password !== "string" || password === "") {
    // Refused here rather than passed on: an empty password would have ssh2 attempt other auth
    // methods, and a connection that succeeded some other way would prove nothing about the key.
    throw new EnrollmentError("a machine password is required to enroll");
  }

  let generatedKeyPair = false;
  if (!(await custody.hasKeyPair(handle))) {
    const { privateKey, publicKey } = await keygen.generate(`harness@pantheon:${handle}`);
    await custody.storeKeyPair(handle, privateKey, publicKey);
    generatedKeyPair = true;
  }

  const publicKey = (await custody.resolvePublicKey(handle)).trim();
  if (!PUBLIC_KEY_RE.test(publicKey)) {
    throw new EnrollmentError("harness public key is not a well-formed OpenSSH key — refusing to install");
  }

  // ---- 1. install, over the password-authenticated connection -------------------------------
  let session: EnrollmentSession;
  try {
    session = await ssh.connectWithPassword(target, password);
  } catch {
    // The upstream error is swallowed on purpose: ssh2 failure text can echo the credential.
    throw new EnrollmentError(
      `could not authenticate to ${target.logicalName} (${target.user}@${target.host}:${target.port}) with the supplied password`
    );
  }

  try {
    const res = await session.exec(installCommand(publicKey));
    if (res.code !== 0) {
      throw new EnrollmentError(
        `installing the harness key on ${target.logicalName} failed (exit ${res.code})`
      );
    }
  } finally {
    session.end();
  }

  // ---- 2. prove it: key-only login must now work --------------------------------------------
  const privateKey = await custody.resolvePrivateKey(handle);
  let verify: EnrollmentSession;
  try {
    verify = await ssh.connectWithKey(target, privateKey);
  } catch {
    throw new EnrollmentError(
      `the key was installed on ${target.logicalName} but key-only login still failed — not marking it provisioned`
    );
  }
  verify.end();

  return { keyHandle: handle, generatedKeyPair };
}
