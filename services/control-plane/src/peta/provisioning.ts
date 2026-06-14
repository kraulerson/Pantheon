/**
 * Identity provisioning — the D1 "register existing identity" path (PROJECT_BIBLE §5/§6).
 *
 * Mints the Peta user that is 1:1 with a control-plane Identity (§5 data model): a fresh
 * random token -> `calcUserId` -> encrypted under the ADMIN token -> CREATE_USER(role=3)
 * with the identity's per-tool permissions. Returns {petaUserId, token}; the caller
 * persists `petaUserId` (NEVER the raw token — §5: "raw token not stored").
 *
 * DISTRIBUTED-WRITE RISK (documented gap — Manifesto D-/Bible §6): full provisioning is a
 * multi-system write (Gitea, Qdrant, HMAC custody, Peta). This register-existing path
 * performs only the single Peta write, but the saga/compensating-action rollback for the
 * full orchestrator is a KNOWN, DEFERRED gap. We do NOT silently swallow partial failure:
 * each step is recorded and any failure is surfaced as a typed error so no half-provisioned
 * identity is returned ("fail closed, no partially-configured session opens", §5/§7).
 */

import { randomBytes } from "node:crypto";
import { calcUserId, encryptData } from "./crypto.js";
import { PetaError, type PetaUserAdmin } from "./client.js";

/** Inputs for registering an already-existing identity as a Peta user. */
export interface RegisterExistingIdentityInput {
  readonly identityId: string;
  readonly displayName: string;
  readonly backendId: string;
  /** Per-tool authorization map mirrored into the Peta user record. */
  readonly toolPermissions: Record<string, unknown>;
}

/** What the caller gets back. The raw `token` is custody material — do not persist it. */
export interface ProvisionedPetaUser {
  readonly petaUserId: string;
  /** Raw Peta access token (= the identity at the gateway). Hand to custody, never store. */
  readonly token: string;
}

/** Injectable dependencies (keeps provisioning unit-testable without a live Peta). */
export interface ProvisioningDeps {
  /** Admin/owner token the new user's token is encrypted under (Peta vault contract). */
  readonly adminToken: string;
  readonly client: PetaUserAdmin;
}

const ROLE_USER = 3;
const STATUS_ACTIVE = 1;

/**
 * Provision the Peta side of an existing identity. Records each step; on any failure
 * (transport, success:false, or crypto) it throws — never returning a partial result.
 */
export async function registerExistingIdentity(
  input: RegisterExistingIdentityInput,
  deps: ProvisioningDeps
): Promise<ProvisionedPetaUser> {
  const steps: string[] = [];
  try {
    // Step 1 — mint a fresh token and derive the Peta userId (24 bytes hex, matches reference).
    const token = randomBytes(24).toString("hex");
    const petaUserId = await calcUserId(token);
    steps.push("mint-token");

    // Step 2 — encrypt the token under the ADMIN token (the only form Peta persists).
    const encryptedToken = JSON.stringify(await encryptData(token, deps.adminToken));
    steps.push("encrypt-token");

    // Step 3 — the one distributed write of this path: CREATE_USER(role=3) at the gateway.
    const res = await deps.client.createUser({
      userId: petaUserId,
      role: ROLE_USER,
      status: STATUS_ACTIVE,
      name: input.displayName,
      encryptedToken,
      permissions: input.toolPermissions,
      proxyId: 0
    });
    steps.push("create-user");

    // createUser already throws on success:false for the real client; guard the interface too.
    if (res.success !== true) {
      throw new PetaError(
        `createUser returned success:false for identity ${input.identityId}`,
        1010,
        0,
        res
      );
    }

    return { petaUserId, token };
  } catch (cause) {
    // Surface a clear, typed failure including WHERE we got to. No partial identity escapes.
    if (cause instanceof PetaError) throw cause;
    const reached = steps.length > 0 ? steps[steps.length - 1] : "start";
    throw new Error(
      `registerExistingIdentity(${input.identityId}) failed after step '${reached}': ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }
}
