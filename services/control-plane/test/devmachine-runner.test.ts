/**
 * ChildProcessRunner / SshKeygenGenerator — Task #16(b) edge adapters (the real, side-effecting
 * implementations of the provisioning ports). Tested with deterministic local subprocesses; the
 * ssh-keygen test is guarded on the binary being present.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { ChildProcessRunner } from "../src/devmachine/runner.js";
import { SshKeygenGenerator } from "../src/devmachine/keygen.js";

function has(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("ChildProcessRunner", () => {
  const runner = new ChildProcessRunner();

  it("captures stdout and a zero exit code", async () => {
    const r = await runner.run("node", ["-e", "process.stdout.write('hello')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hello");
  });

  it("reports a non-zero exit code", async () => {
    const r = await runner.run("node", ["-e", "process.exit(3)"]);
    expect(r.code).toBe(3);
  });

  it("runInteractive resolves the child exit code", async () => {
    expect(await runner.runInteractive("node", ["-e", "process.exit(0)"])).toBe(0);
    expect(await runner.runInteractive("node", ["-e", "process.exit(5)"])).toBe(5);
  });
});

describe("SshKeygenGenerator", () => {
  it.runIf(has("ssh-keygen"))("generates an OpenSSH ed25519 keypair with no passphrase", async () => {
    const keygen = new SshKeygenGenerator(new ChildProcessRunner());
    const { privateKey, publicKey } = await keygen.generate("harness@pantheon:test");
    expect(privateKey).toMatch(/BEGIN OPENSSH PRIVATE KEY/);
    expect(publicKey).toMatch(/^ssh-ed25519 /);
    expect(publicKey).toContain("harness@pantheon:test");
  });
});
