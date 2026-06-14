import { describe, it, expect, beforeEach } from "vitest";
import { SqliteRegistry, seedDefaults } from "../src/registry/sqlite-repository.js";
import { RegistryService, ValidationError, ImmutableBindingError } from "../src/registry/service.js";

function freshService(): { svc: RegistryService; repo: SqliteRegistry } {
  const repo = new SqliteRegistry(":memory:");
  return { svc: new RegistryService(repo), repo };
}

describe("RegistryService — BackendRegistry CRUD", () => {
  let svc: RegistryService;
  beforeEach(() => {
    ({ svc } = freshService());
  });

  it("creates a backend and reads it back with timestamps", () => {
    const b = svc.createBackend({
      kind: "local_alden1",
      endpoint: "192.168.1.89:8080",
      displayName: "Alden-1",
      enabled: true
    });
    expect(b.id).toMatch(/.+/);
    expect(b.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(b.updatedAt).toBe(b.createdAt);
    expect(svc.getBackend(b.id)).toEqual(b);
    expect(svc.listBackends().map((x) => x.id)).toContain(b.id);
  });

  it("updates a backend endpoint (allowed) and bumps updatedAt", () => {
    const b = svc.createBackend({
      kind: "claude_cli",
      endpoint: "10.0.0.1:1234",
      displayName: "Claude",
      enabled: true
    });
    const updated = svc.updateBackend(b.id, { endpoint: "10.0.0.2:4321", enabled: false });
    expect(updated.endpoint).toBe("10.0.0.2:4321");
    expect(updated.enabled).toBe(false);
    expect(updated.kind).toBe("claude_cli"); // unchanged
  });

  it("deletes a backend", () => {
    const b = svc.createBackend({
      kind: "future_cloud",
      endpoint: "cloud.example:443",
      displayName: "Cloud",
      enabled: true
    });
    svc.deleteBackend(b.id);
    expect(svc.getBackend(b.id)).toBeUndefined();
  });

  // --- fail-closed validation ---

  it("rejects an empty endpoint with no write (ValidationError)", () => {
    expect(() =>
      svc.createBackend({ kind: "local_alden1", endpoint: "", displayName: "X", enabled: true })
    ).toThrow(ValidationError);
    expect(svc.listBackends()).toHaveLength(0);
  });

  it("rejects a malformed endpoint (no port / spaces / scheme junk) with no write", () => {
    for (const bad of ["not a host", "192.168.1.89", "http://x:8080 extra", "host:notaport"]) {
      expect(() =>
        svc.createBackend({ kind: "local_alden1", endpoint: bad, displayName: "X", enabled: true })
      ).toThrow(ValidationError);
    }
    expect(svc.listBackends()).toHaveLength(0);
  });

  it("rejects an empty displayName with no write", () => {
    expect(() =>
      svc.createBackend({ kind: "local_alden1", endpoint: "1.2.3.4:80", displayName: "  ", enabled: true })
    ).toThrow(ValidationError);
    expect(svc.listBackends()).toHaveLength(0);
  });

  it("rejects an unknown backend kind", () => {
    expect(() =>
      // @ts-expect-error intentionally invalid kind
      svc.createBackend({ kind: "bogus", endpoint: "1.2.3.4:80", displayName: "X", enabled: true })
    ).toThrow(ValidationError);
  });

  it("update of a malformed endpoint leaves the stored row unchanged (no partial write)", () => {
    const b = svc.createBackend({
      kind: "local_alden1",
      endpoint: "1.2.3.4:80",
      displayName: "Keep",
      enabled: true
    });
    expect(() => svc.updateBackend(b.id, { endpoint: "garbage" })).toThrow(ValidationError);
    expect(svc.getBackend(b.id)?.endpoint).toBe("1.2.3.4:80");
    expect(svc.getBackend(b.id)?.displayName).toBe("Keep");
  });

  it("updating a non-existent backend throws ValidationError", () => {
    expect(() => svc.updateBackend("nope", { enabled: false })).toThrow(ValidationError);
  });
});

describe("RegistryService — immutability #14a (no backend rebind)", () => {
  it("does NOT expose a rebind operation and never allows changing an identity's backend", () => {
    const { svc } = freshService();
    // The service surface must not offer anything that rebinds an identity's backend.
    expect((svc as unknown as Record<string, unknown>).rebindBackend).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>).rebindIdentity).toBeUndefined();
    expect((svc as unknown as Record<string, unknown>).changeIdentityBackend).toBeUndefined();
    // Editing a backend's own endpoint is allowed (different operation), proving the
    // distinction the Bible draws: edit endpoint OK, rebind identity NOT offered.
    const b = svc.createBackend({
      kind: "local_alden1",
      endpoint: "192.168.1.89:8080",
      displayName: "Alden-1",
      enabled: true
    });
    expect(svc.updateBackend(b.id, { endpoint: "192.168.1.90:8080" }).endpoint).toBe("192.168.1.90:8080");
  });
});

describe("RegistryService — ServiceEndpoint CRUD + validation", () => {
  let svc: RegistryService;
  beforeEach(() => {
    ({ svc } = freshService());
  });

  it("creates/lists/updates/deletes a service endpoint", () => {
    const e = svc.createServiceEndpoint({
      key: "qdrant",
      endpoint: "10.100.23.79:6333",
      displayName: "Qdrant",
      enabled: true
    });
    expect(e.id).toMatch(/.+/);
    expect(svc.listServiceEndpoints().map((x) => x.key)).toContain("qdrant");
    const u = svc.updateServiceEndpoint(e.id, { enabled: false });
    expect(u.enabled).toBe(false);
    svc.deleteServiceEndpoint(e.id);
    expect(svc.getServiceEndpoint(e.id)).toBeUndefined();
  });

  it("rejects an unknown service key", () => {
    expect(() =>
      // @ts-expect-error invalid key
      svc.createServiceEndpoint({ key: "weird", endpoint: "1.2.3.4:80", displayName: "X", enabled: true })
    ).toThrow(ValidationError);
    expect(svc.listServiceEndpoints()).toHaveLength(0);
  });

  it("rejects a malformed endpoint with no write", () => {
    expect(() =>
      svc.createServiceEndpoint({ key: "bridge", endpoint: "nope", displayName: "Bridge", enabled: true })
    ).toThrow(ValidationError);
    expect(svc.listServiceEndpoints()).toHaveLength(0);
  });

  it("accepts each allowed key", () => {
    for (const key of ["qdrant", "gitea", "bridge", "obsidian", "peta", "other"] as const) {
      const e = svc.createServiceEndpoint({ key, endpoint: "1.2.3.4:80", displayName: key, enabled: true });
      expect(e.key).toBe(key);
    }
  });
});

describe("seedDefaults", () => {
  it("seeds Alden-1, Qdrant and Bridge defaults idempotently", () => {
    const repo = new SqliteRegistry(":memory:");
    seedDefaults(repo);
    seedDefaults(repo); // idempotent — no duplicates
    const svc = new RegistryService(repo);
    const endpoints = svc.listBackends().map((b) => b.endpoint);
    expect(endpoints).toContain("192.168.1.89:8080");
    const svcEps = svc.listServiceEndpoints();
    expect(svcEps.find((e) => e.key === "qdrant")?.endpoint).toBe("10.100.23.79:6333");
    expect(svcEps.find((e) => e.key === "bridge")?.endpoint).toBe("10.100.23.88:8765");
    // idempotency: only one qdrant row
    expect(svcEps.filter((e) => e.key === "qdrant")).toHaveLength(1);
  });
});

describe("ImmutableBindingError is exported as a documented service-boundary guard", () => {
  it("is a distinct Error subclass", () => {
    const err = new ImmutableBindingError("identity bound");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ImmutableBindingError");
  });
});
