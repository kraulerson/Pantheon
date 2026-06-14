/**
 * DevMachine registry — Task #16(a), PROJECT_BIBLE §5 (DevMachine entity), ADR-0005, TM-020.
 *
 * A DevMachine is a Claude-CLI SSH-terminal target. The security-load-bearing invariants under
 * test here:
 *   - `logicalName` is the IMMUTABLE handle identities bind against (#14a): editable host/IP must
 *     NOT change it, and there is no operation that mutates it after creation.
 *   - `sshKeyHandle` is an OPAQUE vault custody reference (#14b / TM-020 / Principle 1): the
 *     registry NEVER accepts or stores raw private-key material — fail closed, no partial write.
 *   - All writes validate first and fail closed (§10 #3) with no partial persistence.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SqliteRegistry } from "../src/registry/sqlite-repository.js";
import { RegistryService, ValidationError } from "../src/registry/service.js";

function freshService(): RegistryService {
  return new RegistryService(new SqliteRegistry(":memory:"));
}

const VALID = {
  logicalName: "mac-studio",
  host: "192.168.1.192",
  port: 22,
  user: "karl",
  enabled: true
} as const;

describe("RegistryService — DevMachine CRUD", () => {
  let svc: RegistryService;
  beforeEach(() => {
    svc = freshService();
  });

  it("creates a dev machine and reads it back, unprovisioned with empty key handle", () => {
    const m = svc.createDevMachine({ ...VALID });
    expect(m.id).toMatch(/.+/);
    expect(m.logicalName).toBe("mac-studio");
    expect(m.host).toBe("192.168.1.192");
    expect(m.port).toBe(22);
    expect(m.user).toBe("karl");
    // A freshly-registered machine is NOT yet provisioned and holds no key handle.
    expect(m.provisioned).toBe(false);
    expect(m.sshKeyHandle).toBe("");
    expect(m.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.updatedAt).toBe(m.createdAt);
    expect(svc.getDevMachine(m.id)).toEqual(m);
    expect(svc.listDevMachines().map((x) => x.id)).toContain(m.id);
  });

  it("defaults port to 22 when omitted and honors an explicit port", () => {
    const a = svc.createDevMachine({ logicalName: "a", host: "10.0.0.1", user: "u", enabled: true });
    expect(a.port).toBe(22);
    const b = svc.createDevMachine({ logicalName: "b", host: "10.0.0.2", port: 2222, user: "u", enabled: true });
    expect(b.port).toBe(2222);
  });

  it("looks a machine up by its logical name (the identity-binding handle)", () => {
    const m = svc.createDevMachine({ ...VALID });
    expect(svc.getDevMachineByLogicalName("mac-studio")?.id).toBe(m.id);
    expect(svc.getDevMachineByLogicalName("does-not-exist")).toBeUndefined();
  });

  it("edits host/IP, port, user and enabled, bumping updatedAt — logicalName unchanged", () => {
    const m = svc.createDevMachine({ ...VALID });
    const u = svc.updateDevMachine(m.id, { host: "192.168.1.250", port: 2200, user: "ops", enabled: false });
    expect(u.host).toBe("192.168.1.250");
    expect(u.port).toBe(2200);
    expect(u.user).toBe("ops");
    expect(u.enabled).toBe(false);
    expect(u.logicalName).toBe("mac-studio"); // immutable handle survives an IP change (#14a)
    expect(u.createdAt).toBe(m.createdAt);
  });

  it("markProvisioned records provisioned=true + the key handle (the generic update cannot)", () => {
    const m = svc.createDevMachine({ ...VALID });
    const u = svc.markProvisioned(m.id, "harness");
    expect(u.provisioned).toBe(true);
    expect(u.sshKeyHandle).toBe("harness");
  });

  it("resets provisioned + clears the key handle when a connectivity field (host) changes", () => {
    const m = svc.createDevMachine({ ...VALID });
    svc.markProvisioned(m.id, "harness");
    const moved = svc.updateDevMachine(m.id, { host: "192.168.1.250" });
    expect(moved.provisioned).toBe(false); // the new host has no key installed
    expect(moved.sshKeyHandle).toBe("");
  });

  it("keeps provisioned when a non-connectivity field (enabled) changes", () => {
    const m = svc.createDevMachine({ ...VALID });
    svc.markProvisioned(m.id, "harness");
    const u = svc.updateDevMachine(m.id, { enabled: false });
    expect(u.provisioned).toBe(true);
    expect(u.sshKeyHandle).toBe("harness");
  });

  it("deletes a dev machine", () => {
    const m = svc.createDevMachine({ ...VALID });
    svc.deleteDevMachine(m.id);
    expect(svc.getDevMachine(m.id)).toBeUndefined();
  });
});

describe("RegistryService — DevMachine fail-closed validation", () => {
  let svc: RegistryService;
  beforeEach(() => {
    svc = freshService();
  });

  it("rejects an empty logicalName with no write", () => {
    expect(() => svc.createDevMachine({ ...VALID, logicalName: "  " })).toThrow(ValidationError);
    expect(svc.listDevMachines()).toHaveLength(0);
  });

  it("rejects a logicalName containing whitespace or junk (must be a stable handle)", () => {
    for (const bad of ["has space", "tab\there", "weird/slash", "semi;colon"]) {
      expect(() => svc.createDevMachine({ ...VALID, logicalName: bad })).toThrow(ValidationError);
    }
    expect(svc.listDevMachines()).toHaveLength(0);
  });

  it("rejects a logicalName or user beginning with '-' (ssh option-injection guard)", () => {
    expect(() => svc.createDevMachine({ ...VALID, logicalName: "-evil" })).toThrow(ValidationError);
    expect(() => svc.createDevMachine({ ...VALID, user: "-oProxyCommand" })).toThrow(ValidationError);
    expect(svc.listDevMachines()).toHaveLength(0);
  });

  it("rejects a duplicate logicalName with no second write (unique binding handle)", () => {
    svc.createDevMachine({ ...VALID });
    expect(() => svc.createDevMachine({ ...VALID, host: "10.9.9.9" })).toThrow(ValidationError);
    expect(svc.listDevMachines()).toHaveLength(1);
  });

  it("rejects a malformed host (port baked in / scheme / spaces) with no write", () => {
    for (const bad of ["192.168.1.1:22", "ssh://host", "has space", ""]) {
      expect(() => svc.createDevMachine({ ...VALID, host: bad })).toThrow(ValidationError);
    }
    expect(svc.listDevMachines()).toHaveLength(0);
  });

  it("rejects a port out of range with no write", () => {
    for (const bad of [0, -1, 65536, 1.5]) {
      expect(() => svc.createDevMachine({ ...VALID, port: bad })).toThrow(ValidationError);
    }
    expect(svc.listDevMachines()).toHaveLength(0);
  });

  it("rejects an empty user or a user with whitespace with no write", () => {
    for (const bad of ["", "  ", "bad user"]) {
      expect(() => svc.createDevMachine({ ...VALID, user: bad })).toThrow(ValidationError);
    }
    expect(svc.listDevMachines()).toHaveLength(0);
  });

  it("updating a non-existent machine throws ValidationError", () => {
    expect(() => svc.updateDevMachine("nope", { enabled: false })).toThrow(ValidationError);
  });

  it("a malformed update leaves the stored row unchanged (no partial write)", () => {
    const m = svc.createDevMachine({ ...VALID });
    expect(() => svc.updateDevMachine(m.id, { host: "garbage:22" })).toThrow(ValidationError);
    const after = svc.getDevMachine(m.id);
    expect(after?.host).toBe("192.168.1.192");
    expect(after?.updatedAt).toBe(m.updatedAt);
  });
});

describe("RegistryService — DevMachine SSH-key custody (TM-020 / #14b / Principle 1)", () => {
  let svc: RegistryService;
  beforeEach(() => {
    svc = freshService();
  });

  // A realistic raw private key — exactly what must NEVER reach the registry.
  const RAW_PRIVATE_KEY = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt",
    "ZWQyNTUxOQAAACDExampleExampleExampleExampleExampleExampleExampleAAAA",
    "-----END OPENSSH PRIVATE KEY-----"
  ].join("\n");

  it("rejects a raw private key passed as the key handle at create (no write)", () => {
    expect(() => svc.createDevMachine({ ...VALID, sshKeyHandle: RAW_PRIVATE_KEY })).toThrow(ValidationError);
    expect(svc.listDevMachines()).toHaveLength(0);
  });

  it("rejects a raw private key passed to markProvisioned (machine stays unprovisioned)", () => {
    const m = svc.createDevMachine({ ...VALID });
    expect(() => svc.markProvisioned(m.id, RAW_PRIVATE_KEY)).toThrow(ValidationError);
    const after = svc.getDevMachine(m.id);
    expect(after?.provisioned).toBe(false);
    expect(after?.sshKeyHandle).toBe("");
  });

  it("rejects a key handle with path separators or traversal (filename-safe only, matches custody)", () => {
    for (const bad of ["a/b", "../escape", "vault:ssh/harness"]) {
      expect(() =>
        svc.createDevMachine({ ...VALID, logicalName: `m-${bad.length}`, sshKeyHandle: bad })
      ).toThrow(ValidationError);
    }
    expect(svc.listDevMachines()).toHaveLength(0);
  });

  it("rejects a multi-line / whitespace-bearing handle (a handle is a single opaque token)", () => {
    for (const bad of ["line one\nline two", "has space", "-----BEGIN", "tab\tchar"]) {
      expect(() => svc.createDevMachine({ ...VALID, logicalName: `m-${Math.abs(bad.length)}`, sshKeyHandle: bad })).toThrow(
        ValidationError
      );
    }
    expect(svc.listDevMachines()).toHaveLength(0);
  });
});
