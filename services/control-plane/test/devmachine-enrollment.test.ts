/**
 * Password-bootstrap enrollment (BUGS/FEATURE 2026-08-19) — ADR-0005, TM-020.
 *
 * Setting a machine up must be doable entirely from the harness UI: no operator at a terminal.
 * `ssh-copy-id` cannot serve that path (it needs a TTY to prompt), so enrollment authenticates
 * ONE ssh2 connection with the machine password supplied by the operator in the browser, appends
 * the harness PUBLIC key to the target's authorized_keys, and then proves the result by
 * reconnecting KEY-ONLY. The password is used for that single connection and never persisted,
 * logged, or echoed; the private key never leaves custody.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  enrollMachine,
  EnrollmentError,
  type EnrollmentSshPort,
  type EnrollmentSession
} from "../src/devmachine/enrollment.js";
import type { KeyCustody } from "../src/devmachine/custody.js";
import type { SshTarget, KeyGenerator } from "../src/devmachine/provisioning.js";

const TARGET: SshTarget = { logicalName: "mac-mini", host: "192.168.1.192", port: 22, user: "karl" };
const PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialForTests harness@pantheon:mac-mini";
const PRIVKEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----";
const PASSWORD = "the-operators-machine-password";

function fakeCustody(over: Partial<KeyCustody> = {}): KeyCustody {
  return {
    hasKeyPair: vi.fn(async () => true),
    storeKeyPair: vi.fn(async () => undefined),
    resolvePrivateKey: vi.fn(async () => PRIVKEY),
    resolvePublicKey: vi.fn(async () => PUBKEY),
    ...over
  };
}

function fakeKeygen(): KeyGenerator {
  return { generate: vi.fn(async () => ({ privateKey: PRIVKEY, publicKey: PUBKEY })) };
}

/** Records every remote command so tests can assert what enrollment actually ran. */
function fakeSession(exec?: EnrollmentSession["exec"]): EnrollmentSession & { commands: string[]; ended: boolean } {
  const commands: string[] = [];
  const session = {
    commands,
    ended: false,
    async exec(cmd: string) {
      commands.push(cmd);
      return exec ? await exec(cmd) : { code: 0, stdout: "", stderr: "" };
    },
    end() {
      session.ended = true;
    }
  };
  return session;
}

function fakeSsh(over: Partial<EnrollmentSshPort> = {}): EnrollmentSshPort & {
  passwordSessions: ReturnType<typeof fakeSession>[];
  keySessions: ReturnType<typeof fakeSession>[];
  passwordsSeen: string[];
} {
  const passwordSessions: ReturnType<typeof fakeSession>[] = [];
  const keySessions: ReturnType<typeof fakeSession>[] = [];
  const passwordsSeen: string[] = [];
  return {
    passwordSessions,
    keySessions,
    passwordsSeen,
    async connectWithPassword(_target: SshTarget, password: string) {
      passwordsSeen.push(password);
      const s = fakeSession();
      passwordSessions.push(s);
      return s;
    },
    async connectWithKey() {
      const s = fakeSession();
      keySessions.push(s);
      return s;
    },
    ...over
  } as EnrollmentSshPort & {
    passwordSessions: ReturnType<typeof fakeSession>[];
    keySessions: ReturnType<typeof fakeSession>[];
    passwordsSeen: string[];
  };
}

describe("enrollMachine — password bootstrap, key-only afterwards", () => {
  let ssh: ReturnType<typeof fakeSsh>;
  beforeEach(() => {
    ssh = fakeSsh();
  });

  it("installs the PUBLIC key on the target and verifies with a key-only reconnect", async () => {
    const custody = fakeCustody();
    const result = await enrollMachine(TARGET, "harness", PASSWORD, { custody, keygen: fakeKeygen(), ssh });

    expect(result.keyHandle).toBe("harness");
    expect(ssh.passwordSessions).toHaveLength(1);
    expect(ssh.keySessions).toHaveLength(1); // the verification connection actually happened
    const installed = ssh.passwordSessions[0]!.commands.join("\n");
    expect(installed).toContain(PUBKEY);
    expect(installed).toContain("authorized_keys");
  });

  it("never sends the PRIVATE key to the target", async () => {
    const custody = fakeCustody();
    await enrollMachine(TARGET, "harness", PASSWORD, { custody, keygen: fakeKeygen(), ssh });
    const everything = ssh.passwordSessions.flatMap((s) => s.commands).join("\n");
    expect(everything).not.toContain("PRIVATE KEY");
    expect(everything).not.toContain(PRIVKEY);
  });

  it("never puts the password into a remote command", async () => {
    const custody = fakeCustody();
    await enrollMachine(TARGET, "harness", PASSWORD, { custody, keygen: fakeKeygen(), ssh });
    const everything = ssh.passwordSessions.flatMap((s) => s.commands).join("\n");
    expect(everything).not.toContain(PASSWORD);
  });

  it("generates the harness keypair on first enrollment, reuses it afterwards", async () => {
    const first = fakeCustody({ hasKeyPair: vi.fn(async () => false) });
    const r1 = await enrollMachine(TARGET, "harness", PASSWORD, { custody: first, keygen: fakeKeygen(), ssh });
    expect(r1.generatedKeyPair).toBe(true);
    expect(first.storeKeyPair).toHaveBeenCalledOnce();

    const second = fakeCustody();
    const r2 = await enrollMachine(TARGET, "harness", PASSWORD, { custody: second, keygen: fakeKeygen(), ssh: fakeSsh() });
    expect(r2.generatedKeyPair).toBe(false);
    expect(second.storeKeyPair).not.toHaveBeenCalled();
  });

  it("is idempotent: re-enrolling does not append a duplicate key", async () => {
    // The remote install is a single guarded command; assert the guard is part of it rather than
    // a blind append, so a second run cannot grow authorized_keys without bound.
    const custody = fakeCustody();
    await enrollMachine(TARGET, "harness", PASSWORD, { custody, keygen: fakeKeygen(), ssh });
    const cmd = ssh.passwordSessions[0]!.commands.join("\n");
    expect(cmd).toMatch(/grep .*authorized_keys/);
  });

  it("closes both connections even when the remote command fails", async () => {
    const failing = fakeSsh({
      async connectWithPassword() {
        return fakeSession(async () => ({ code: 1, stdout: "", stderr: "Permission denied" }));
      }
    });
    const custody = fakeCustody();
    await expect(
      enrollMachine(TARGET, "harness", PASSWORD, { custody, keygen: fakeKeygen(), ssh: failing })
    ).rejects.toBeInstanceOf(EnrollmentError);
  });

  it("fails when the password is rejected — and the error carries no password", async () => {
    const denied = fakeSsh({
      async connectWithPassword() {
        throw new Error(`All configured authentication methods failed for ${PASSWORD}`);
      }
    });
    const custody = fakeCustody();
    const err = await enrollMachine(TARGET, "harness", PASSWORD, {
      custody,
      keygen: fakeKeygen(),
      ssh: denied
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EnrollmentError);
    expect(String((err as Error).message)).not.toContain(PASSWORD);
  });

  it("fails when the key-only verification does not work (no false 'provisioned')", async () => {
    const noKeyLogin = fakeSsh({
      async connectWithKey() {
        throw new Error("key rejected");
      }
    });
    const custody = fakeCustody();
    await expect(
      enrollMachine(TARGET, "harness", PASSWORD, { custody, keygen: fakeKeygen(), ssh: noKeyLogin })
    ).rejects.toBeInstanceOf(EnrollmentError);
  });

  it("refuses a public key that could break out of the remote shell quoting", async () => {
    const custody = fakeCustody({
      resolvePublicKey: vi.fn(async () => "ssh-ed25519 AAAA'; rm -rf ~; echo 'pwned")
    });
    await expect(
      enrollMachine(TARGET, "harness", PASSWORD, { custody, keygen: fakeKeygen(), ssh })
    ).rejects.toBeInstanceOf(EnrollmentError);
    expect(ssh.passwordSessions).toHaveLength(0); // rejected BEFORE any connection is made
  });

  it("refuses an empty password rather than attempting an anonymous connection", async () => {
    const custody = fakeCustody();
    await expect(
      enrollMachine(TARGET, "harness", "", { custody, keygen: fakeKeygen(), ssh })
    ).rejects.toBeInstanceOf(EnrollmentError);
    expect(ssh.passwordSessions).toHaveLength(0);
  });
});
