/**
 * OPTIONAL live integration (skipped when unreachable; never fails CI offline).
 *
 *  - One real NON-STREAMING chat-completions call to Alden-1 (192.168.1.89:8080) via BackendClient.
 *  - Live Peta (:3002) approvals proxy: listApprovals against the real gateway with the owner
 *    token from peta-eval/harness/state.json.
 *
 * Both probe reachability first; if the host is down, the test is skipped (this.skip()).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { BackendClient } from "../src/backend/client.js";
import { PetaAdminClient } from "../src/peta/client.js";
import type { Backend } from "../src/registry/types.js";

const ALDEN = "192.168.1.89:8080";
const PETA_BASE = "http://127.0.0.1:3002";
const STATE = "/Users/karl/Documents/Claude Projects/Pantheon/peta-eval/harness/state.json";

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

function aldenBackend(): Backend {
  const now = new Date().toISOString();
  return { id: "alden-1", kind: "local_alden1", endpoint: ALDEN, displayName: "Alden-1", enabled: true, createdAt: now, updatedAt: now };
}

describe("LIVE (optional) — Alden-1 non-streaming completion", () => {
  it("forwards a tiny chat-completions request to Alden-1", async (ctx) => {
    if (!(await reachable(`http://${ALDEN}/v1/models`))) return ctx.skip();
    const client = new BackendClient();
    const res = await client.chatCompletions(aldenBackend(), {
      model: "alden",
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
      max_tokens: 8
    });
    expect(typeof res.choices[0]?.message?.content).toBe("string");
  }, 30_000);
});

describe("LIVE (optional) — Peta approvals proxy", () => {
  it("listApprovals against the live gateway with the owner token", async (ctx) => {
    if (!(await reachable(`${PETA_BASE}/`))) return ctx.skip();
    let ownerToken: string;
    try {
      ownerToken = JSON.parse(readFileSync(STATE, "utf8")).ownerToken as string;
    } catch {
      return ctx.skip();
    }
    const peta = new PetaAdminClient(PETA_BASE, ownerToken);
    const res = await peta.listApprovals();
    expect(res.success).toBe(true);
  }, 15_000);
});
