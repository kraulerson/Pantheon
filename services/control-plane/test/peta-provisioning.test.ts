import { describe, it, expect } from "vitest";
import { webcrypto as wc } from "node:crypto";
import { registerExistingIdentity, type ProvisioningDeps } from "../src/peta/provisioning.js";
import type { EncryptedPayload } from "../src/peta/crypto.js";
import { PetaError } from "../src/peta/client.js";

const te = new TextEncoder();
const td = new TextDecoder();
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

async function decrypt(payload: EncryptedPayload, key: string): Promise<string> {
  const base = await wc.subtle.importKey("raw", te.encode(key), "PBKDF2", false, ["deriveKey"]);
  const ck = await wc.subtle.deriveKey(
    { name: "PBKDF2", salt: fromB64(payload.salt), iterations: 100000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const data = fromB64(payload.data);
  const tag = fromB64(payload.tag);
  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data, 0);
  combined.set(tag, data.length);
  return td.decode(await wc.subtle.decrypt({ name: "AES-GCM", iv: fromB64(payload.iv) }, ck, combined));
}

const ADMIN = "4e9fcab8b13241fcd6153352381b201db3c40117d5f1d0b2";

describe("registerExistingIdentity — mint Peta user (role=3)", () => {
  it("creates a role=3 user with an admin-encrypted token, returns {petaUserId, token}", async () => {
    let captured: Parameters<ProvisioningDeps["client"]["createUser"]>[0] | undefined;
    const deps: ProvisioningDeps = {
      adminToken: ADMIN,
      client: {
        createUser: async (req) => {
          captured = req;
          return { success: true };
        }
      }
    };
    const res = await registerExistingIdentity(
      {
        identityId: "id-7",
        displayName: "Aristotle",
        backendId: "alden-1",
        toolPermissions: { "obsidian:read": true }
      },
      deps
    );

    // userId is SHA-256(token)[:32] and is echoed back to the caller.
    expect(res.petaUserId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.token).toMatch(/^[0-9a-f]+$/);
    expect(captured).toBeDefined();
    expect(captured?.userId).toBe(res.petaUserId);
    expect(captured?.role).toBe(3);
    expect(captured?.name).toBe("Aristotle");
    expect(captured?.permissions).toEqual({ "obsidian:read": true });

    // The encryptedToken must decrypt back to the raw token using the ADMIN token.
    const payload = JSON.parse(captured!.encryptedToken) as EncryptedPayload;
    expect(await decrypt(payload, ADMIN)).toBe(res.token);
  });

  it("surfaces a typed PetaError on createUser failure (no silent swallow)", async () => {
    const deps: ProvisioningDeps = {
      adminToken: ADMIN,
      client: {
        createUser: async () => {
          return { success: false, error: "duplicate userId" };
        }
      }
    };
    await expect(
      registerExistingIdentity(
        { identityId: "id-8", displayName: "Plato", backendId: "alden-1", toolPermissions: {} },
        deps
      )
    ).rejects.toBeInstanceOf(PetaError);
  });

  it("never returns a half-provisioned identity when the write fails", async () => {
    const deps: ProvisioningDeps = {
      adminToken: ADMIN,
      client: {
        createUser: async () => {
          throw new Error("network down mid-write");
        }
      }
    };
    await expect(
      registerExistingIdentity(
        { identityId: "id-9", displayName: "Zeno", backendId: "alden-1", toolPermissions: {} },
        deps
      )
    ).rejects.toThrow(/network down/);
  });
});
