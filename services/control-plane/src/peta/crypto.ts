/**
 * Peta crypto — byte-for-byte port of Peta's CryptoService (validated against a live
 * Peta in `peta-eval/harness/peta.mjs`). PROJECT_BIBLE §7: `userId = SHA-256(token)[:32]`;
 * the raw token is stored ONLY encrypted, under the admin token, in Peta's vault.
 *
 * Envelope: PBKDF2-HMAC-SHA256 (100k iters, 16-byte salt) -> AES-256-GCM (12-byte IV).
 * The GCM auth tag (last 16 bytes of the webcrypto output) is split out and stored
 * separately, exactly as Peta does. Uses Node `webcrypto` only — no native crypto.
 */

import { webcrypto as wc } from "node:crypto";

// `CryptoKey` is a DOM lib type not present under lib:["ES2022"]; derive it from the
// runtime's own webcrypto surface so we stay on the configured toolchain (no DOM lib).
type CryptoKey = Awaited<ReturnType<typeof wc.subtle.importKey>>;

const te = new TextEncoder();
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** The on-the-wire encrypted envelope Peta stores (all fields base64). */
export interface EncryptedPayload {
  /** Ciphertext WITHOUT the trailing 16-byte GCM tag. */
  readonly data: string;
  /** 12-byte AES-GCM initialization vector. */
  readonly iv: string;
  /** 16-byte PBKDF2 salt. */
  readonly salt: string;
  /** 16-byte AES-GCM authentication tag (split from the ciphertext tail). */
  readonly tag: string;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await wc.subtle.importKey("raw", te.encode(password), "PBKDF2", false, [
    "deriveKey"
  ]);
  return wc.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt `data` under `key`, producing Peta's {data,iv,salt,tag} envelope.
 * Salt and IV are freshly random per call, so output is non-deterministic by design.
 */
export async function encryptData(data: string, key: string): Promise<EncryptedPayload> {
  const salt = wc.getRandomValues(new Uint8Array(16));
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ck = await deriveKey(key, salt);
  const out = new Uint8Array(
    await wc.subtle.encrypt({ name: "AES-GCM", iv }, ck, te.encode(data))
  );
  return {
    data: b64(out.slice(0, -16)),
    iv: b64(iv),
    salt: b64(salt),
    tag: b64(out.slice(-16))
  };
}

/** Peta identity hash: hex SHA-256 of the token, truncated to the first 32 chars. */
export async function calcUserId(token: string): Promise<string> {
  const h = new Uint8Array(await wc.subtle.digest("SHA-256", te.encode(token)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 32);
}
