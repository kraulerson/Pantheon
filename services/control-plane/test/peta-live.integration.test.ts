import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { PetaAdminClient } from "../src/peta/client.js";
import { registerExistingIdentity } from "../src/peta/provisioning.js";

const PETA_BASE = process.env["PETA_BASE"] ?? "http://localhost:3002";
const STATE_PATH =
  "/Users/karl/Documents/Claude Projects/Pantheon/peta-eval/harness/state.json";

function loadOwnerToken(): string | undefined {
  if (!existsSync(STATE_PATH)) return undefined;
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { ownerToken?: string };
    return s.ownerToken;
  } catch {
    return undefined;
  }
}

async function petaReachable(): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`${PETA_BASE}/health`, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

// Guarded: runs ONLY if a live Peta is reachable AND an owner token exists.
// Otherwise the whole block is skipped (never fails the suite).
describe("PetaAdminClient + provisioning — live Peta (guarded)", () => {
  let reachable = false;
  const ownerToken = loadOwnerToken();

  beforeAll(async () => {
    reachable = Boolean(ownerToken) && (await petaReachable());
    if (!reachable) {
      console.warn(`[peta-live] SKIP: Peta not reachable at ${PETA_BASE} or no ownerToken`);
    }
  });

  it("registers a throwaway identity, confirms the user exists, then deletes it", async (ctx) => {
    if (!reachable || !ownerToken) {
      ctx.skip();
      return;
    }
    const client = new PetaAdminClient(PETA_BASE, ownerToken);
    const identityId = `throwaway-${Date.now()}`;

    const { petaUserId, token } = await registerExistingIdentity(
      { identityId, displayName: identityId, backendId: "test-backend", toolPermissions: {} },
      { adminToken: ownerToken, client }
    );
    expect(petaUserId).toMatch(/^[0-9a-f]{32}$/);

    try {
      // Confirm the minted user actually exists in Peta's store (GET_USERS, 1011).
      const users = await client.getUsers();
      expect(users.success).toBe(true);
      const list = (users["data"] as { users?: Array<{ userId: string }> } | undefined)?.users ?? [];
      expect(list.some((u) => u.userId === petaUserId)).toBe(true);
      // Owner + servers-status round-trips also confirm the typed client talks to /admin.
      expect((await client.getServersStatus()).success).toBe(true);
      expect((await client.getOwner()).success).toBe(true);
    } finally {
      // Clean up: DELETE_USER (action 1013).
      const del = await client.deleteUser(petaUserId);
      expect(del.success).toBe(true);
      void token;
    }
  });
});
