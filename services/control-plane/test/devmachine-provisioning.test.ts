/**
 * provisionMachine — Task #16(b), the one-time SSH provisioning ceremony (ADR-0005, TM-020).
 *
 * Flow: generate the harness keypair once (into custody on the Pantheon host), then install the
 * PUBLIC key on the dev machine via `ssh-copy-id` (interactive — the operator types the machine
 * password once). Key-only auth thereafter. The PRIVATE key NEVER leaves custody and is NEVER
 * passed to a command. The runner + key generator are injected so the logic is unit-tested
 * without touching a real machine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileKeyCustody } from "../src/devmachine/custody.js";
import { provisionMachine, ProvisioningError, type CommandRunner, type KeyGenerator } from "../src/devmachine/provisioning.js";

const PRIV = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-DO-NOT-LEAK\n-----END OPENSSH PRIVATE KEY-----\n";
const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEPUBLIC harness@pantheon\n";
const TARGET = { logicalName: "mac-studio", host: "192.168.1.192", port: 22, user: "karl" } as const;

function fakeRunner(exitCode = 0): CommandRunner & {
  run: ReturnType<typeof vi.fn>;
  runInteractive: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    runInteractive: vi.fn(async () => exitCode)
  };
}

function fakeKeygen(): KeyGenerator & { generate: ReturnType<typeof vi.fn> } {
  return { generate: vi.fn(async () => ({ privateKey: PRIV, publicKey: PUB })) };
}

describe("provisionMachine", () => {
  let dir: string;
  let custody: FileKeyCustody;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pantheon-prov-"));
    custody = new FileKeyCustody(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("generates the harness keypair on first provision and installs the public key via ssh-copy-id", async () => {
    const runner = fakeRunner(0);
    const keygen = fakeKeygen();
    const res = await provisionMachine(TARGET, "harness", { custody, runner, keygen });

    expect(res.generatedKeyPair).toBe(true);
    expect(res.keyHandle).toBe("harness");
    expect(keygen.generate).toHaveBeenCalledTimes(1);
    expect(await custody.hasKeyPair("harness")).toBe(true);

    // ssh-copy-id ran interactively against the right user@host:port
    expect(runner.runInteractive).toHaveBeenCalledTimes(1);
    const [cmd, args] = runner.runInteractive.mock.calls[0];
    expect(cmd).toBe("ssh-copy-id");
    expect(args).toContain("karl@192.168.1.192");
    expect(args).toContain("-p");
    expect(args).toContain("22");
    // -f (force): install the public key WITHOUT requiring the matching private key beside it —
    // the private key stays in custody, never in the scratch dir (TM-020). Without -f, macOS
    // ssh-copy-id strips `.pub`, looks for the private key in scratch, and fails (UAT-1 live bug).
    expect(args).toContain("-f");
  });

  it("reuses an existing keypair on subsequent provisions (no keygen)", async () => {
    await custody.storeKeyPair("harness", PRIV, PUB);
    const runner = fakeRunner(0);
    const keygen = fakeKeygen();
    const res = await provisionMachine(TARGET, "harness", { custody, runner, keygen });
    expect(res.generatedKeyPair).toBe(false);
    expect(keygen.generate).not.toHaveBeenCalled();
    expect(runner.runInteractive).toHaveBeenCalledTimes(1); // still installs the pubkey
  });

  it("throws and does NOT report success when ssh-copy-id exits non-zero", async () => {
    const runner = fakeRunner(1);
    await expect(provisionMachine(TARGET, "harness", { custody, runner, keygen: fakeKeygen() })).rejects.toBeInstanceOf(
      ProvisioningError
    );
  });

  it("NEVER passes the private key to any command (TM-020) — only the public key file path", async () => {
    const runner = fakeRunner(0);
    await provisionMachine(TARGET, "harness", { custody, runner, keygen: fakeKeygen() });
    const allArgs = JSON.stringify([...runner.run.mock.calls, ...runner.runInteractive.mock.calls]);
    expect(allArgs).not.toContain("SECRET-DO-NOT-LEAK");
    // ssh-copy-id is pointed at a public key file (-i <something>.pub)
    const [, args] = runner.runInteractive.mock.calls[0];
    const iIdx = (args as string[]).indexOf("-i");
    expect(iIdx).toBeGreaterThanOrEqual(0);
    expect((args as string[])[iIdx + 1]).toMatch(/\.pub$/);
  });

  it("rejects a path-traversal key handle", async () => {
    await expect(
      provisionMachine(TARGET, "../escape", { custody, runner: fakeRunner(0), keygen: fakeKeygen() })
    ).rejects.toThrow();
  });
});
