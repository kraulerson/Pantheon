/**
 * provisionAndRecord — Task #16(b), the bridge between the SSH provisioning ceremony and the
 * registry. It provisions a known DevMachine and, ONLY on success, records `provisioned=true` and
 * the key handle on the registry row. A provisioning failure must leave the row unprovisioned.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SqliteRegistry } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";
import { provisionAndRecord } from "../src/devmachine/provision-and-record.js";

function freshRegistry(): RegistryService {
  return new RegistryService(new SqliteRegistry(":memory:"));
}

describe("provisionAndRecord", () => {
  let registry: RegistryService;
  beforeEach(() => {
    registry = freshRegistry();
    registry.createDevMachine({ logicalName: "mac-studio", host: "192.168.1.192", user: "karl", enabled: true });
  });

  it("provisions a known machine and records provisioned=true + the key handle", async () => {
    const provision = vi.fn(async () => ({ keyHandle: "harness", generatedKeyPair: true }));
    const updated = await provisionAndRecord("mac-studio", { registry, provision, keyHandle: "harness" });

    expect(updated.provisioned).toBe(true);
    expect(updated.sshKeyHandle).toBe("harness");
    // persisted, not just returned
    const reloaded = registry.getDevMachineByLogicalName("mac-studio");
    expect(reloaded?.provisioned).toBe(true);
    expect(reloaded?.sshKeyHandle).toBe("harness");

    // provisioning was invoked against the machine's connection details
    const [target, handle] = provision.mock.calls[0];
    expect(target).toMatchObject({ logicalName: "mac-studio", host: "192.168.1.192", port: 22, user: "karl" });
    expect(handle).toBe("harness");
  });

  it("throws for an unknown logicalName and never calls provision", async () => {
    const provision = vi.fn(async () => ({ keyHandle: "harness", generatedKeyPair: false }));
    await expect(provisionAndRecord("ghost", { registry, provision, keyHandle: "harness" })).rejects.toThrow();
    expect(provision).not.toHaveBeenCalled();
  });

  it("leaves the row UNPROVISIONED when provisioning fails", async () => {
    const provision = vi.fn(async () => {
      throw new Error("ssh-copy-id failed");
    });
    await expect(provisionAndRecord("mac-studio", { registry, provision, keyHandle: "harness" })).rejects.toThrow();
    const reloaded = registry.getDevMachineByLogicalName("mac-studio");
    expect(reloaded?.provisioned).toBe(false);
    expect(reloaded?.sshKeyHandle).toBe("");
  });
});
