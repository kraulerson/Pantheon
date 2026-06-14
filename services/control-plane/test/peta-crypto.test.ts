import { describe, it, expect } from "vitest";
import { webcrypto as wc } from "node:crypto";
import { calcUserId, encryptData, type EncryptedPayload } from "../src/peta/crypto.js";

const td = new TextDecoder();
const te = new TextEncoder();
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

/**
 * Local decrypt helper — the inverse of {@link encryptData}, used to prove round-trips.
 * Peta stores the GCM auth tag separately; webcrypto expects it appended to the ciphertext.
 */
async function decryptData(payload: EncryptedPayload, key: string): Promise<string> {
  const salt = fromB64(payload.salt);
  const iv = fromB64(payload.iv);
  const data = fromB64(payload.data);
  const tag = fromB64(payload.tag);
  const base = await wc.subtle.importKey("raw", te.encode(key), "PBKDF2", false, ["deriveKey"]);
  const ck = await wc.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data, 0);
  combined.set(tag, data.length);
  const out = await wc.subtle.decrypt({ name: "AES-GCM", iv }, ck, combined);
  return td.decode(out);
}

describe("calcUserId — SHA-256 hex, first 32 chars", () => {
  it("matches the known vector from state.json (ownerToken -> ownerUserId)", async () => {
    const id = await calcUserId("4e9fcab8b13241fcd6153352381b201db3c40117d5f1d0b2");
    expect(id).toBe("c763f935ae3bf0fabe84126df3bacd08");
  });

  it("matches a second known vector (reader)", async () => {
    const id = await calcUserId("1f96b0fd53f7d6b94f14a685856c92a52af6e4796307bcbf");
    expect(id).toBe("63c8b16fa4f9c27aef484bc3845e443b");
  });

  it("is exactly 32 lowercase hex chars", async () => {
    const id = await calcUserId("anything");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("encryptData — PBKDF2/AES-256-GCM envelope", () => {
  it("produces the {data,iv,salt,tag} base64 shape", async () => {
    const p = await encryptData("secret-payload", "the-key");
    for (const f of ["data", "iv", "salt", "tag"] as const) {
      expect(typeof p[f]).toBe("string");
      expect(p[f].length).toBeGreaterThan(0);
    }
    // 16-byte salt, 12-byte IV, 16-byte GCM tag — verify decoded byte lengths.
    expect(fromB64(p.salt).length).toBe(16);
    expect(fromB64(p.iv).length).toBe(12);
    expect(fromB64(p.tag).length).toBe(16);
  });

  it("uses a fresh random salt and IV per call (non-deterministic envelope)", async () => {
    const a = await encryptData("same", "key");
    const b = await encryptData("same", "key");
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });

  it("round-trips via the local decrypt helper", async () => {
    const plaintext = "a-throwaway-peta-token-1234567890";
    const p = await encryptData(plaintext, "admin-token");
    expect(await decryptData(p, "admin-token")).toBe(plaintext);
  });

  it("fails to decrypt with the wrong key (GCM auth)", async () => {
    const p = await encryptData("x", "right-key");
    await expect(decryptData(p, "wrong-key")).rejects.toThrow();
  });

  it("an encryptedToken (token encrypted under the admin token) is decryptable with the admin token", async () => {
    const token = "62f109ec6956b1e214420b3e163bb51f263b983f7adcf623";
    const adminToken = "4e9fcab8b13241fcd6153352381b201db3c40117d5f1d0b2";
    const p = await encryptData(token, adminToken);
    expect(await decryptData(p, adminToken)).toBe(token);
  });
});
