/**
 * Configuration page — Session Keycards section (M1 task 2, TP-3; §9 C.5 + tier 4).
 * Text-labelled state (CC1), mint form with the closed scope set, Revoke control, never a token or hash.
 */

import { describe, it, expect } from "vitest";
import { renderConfigPage } from "../src/http/config-page.js";
import type { Keycard } from "../src/keycard/types.js";

function card(over: Partial<Keycard> = {}): Keycard {
  return {
    id: "k1",
    principal: "cli-mac-mini",
    scopes: ["sessions:read", "approvals:read"],
    createdAt: "2026-08-25T12:00:00.000Z",
    updatedAt: "2026-08-25T12:00:00.000Z",
    expiresAt: "2026-11-23T12:00:00.000Z",
    revokedAt: null,
    lastUsedAt: null,
    useCount: 0,
    denyCount: 0,
    ...over
  };
}

const base = { backends: [], mcpServers: [], serviceEndpoints: [] };

describe("renderConfigPage — Session Keycards section", () => {
  it("renders the section with a labeled mint form offering exactly the three read scopes", () => {
    const html = renderConfigPage({ ...base, keycards: [] });
    expect(html).toContain("Session Keycards");
    expect(html).toMatch(/<form[^>]*action="\/api\/keycards"[^>]*method="post"/);
    expect(html).toMatch(/name="principal"/);
    for (const s of ["usage:read", "approvals:read", "sessions:read"]) {
      expect(html).toMatch(new RegExp(`<input[^>]*type="checkbox"[^>]*name="scopes"[^>]*value="${s}"`));
    }
    expect(html).not.toMatch(/value="[a-z]+:(write|admin|decide|manage)"/);
    expect(html).toMatch(/name="ttlDays"/);
    expect(html).toMatch(/Mint keycard/i);
  });

  it("shows a labeled empty state", () => {
    const html = renderConfigPage({ ...base, keycards: [] });
    expect(html).toMatch(/No session keycards/i);
  });

  it("lists cards with text state pills (active / revoked / expired), scopes, counters, and a Revoke control", () => {
    const html = renderConfigPage({
      ...base,
      keycards: [
        card(),
        card({ id: "k2", principal: "old", revokedAt: "2026-08-25T13:00:00.000Z" }),
        card({ id: "k3", principal: "stale", expiresAt: "2026-01-01T00:00:00.000Z" })
      ],
      now: "2026-08-25T14:00:00.000Z"
    });
    expect(html).toContain("cli-mac-mini");
    expect(html).toContain("sessions:read");
    // same pill contract as the rest of the page: data-status token + role=img + human aria-label + glyph
    expect(html).toMatch(/data-status="active"[^>]*role="img"[^>]*aria-label="Active"[^>]*>[\s\S]*?\[✓\][\s\S]*?Active/);
    expect(html).toMatch(/data-status="revoked"[^>]*role="img"[^>]*aria-label="Revoked"/);
    expect(html).toMatch(/data-status="expired"[^>]*role="img"[^>]*aria-label="Expired"/);
    expect(html).toMatch(/<form[^>]*action="\/api\/keycards\/k1\/revoke"[^>]*method="post"/);
    // each Revoke button has a UNIQUE accessible name naming the principal
    expect(html).toMatch(/<button[^>]*aria-label="Revoke keycard for cli-mac-mini[^"]*"[^>]*>Revoke<\/button>/);
    expect(html).not.toMatch(/action="\/api\/keycards\/k2\/revoke"/); // already revoked: no control
    expect(html).toMatch(/uses|used/i);
    expect(html).toMatch(/denied/i);
  });

  it("escapes the principal and never renders a token or hash", () => {
    const html = renderConfigPage({ ...base, keycards: [card({ principal: '<script>alert(1)</script>' as never })] });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/pk1_[0-9a-f]{64}/);
    expect(html).not.toMatch(/tokenHash|token_hash/);
  });

  it("omits the section entirely when keycards are not part of the model (server without the feature wired)", () => {
    const html = renderConfigPage(base);
    expect(html).not.toContain("Session Keycards");
  });
});

describe("renderConfigPage — Session Keycards audit remediation (2026-08-25)", () => {
  it("a card with corrupt (empty) scopes is shown as invalid, in text", () => {
    const html = renderConfigPage({ ...base, keycards: [card({ scopes: [] })] });
    expect(html).toMatch(/data-status="invalid"[^>]*aria-label="Invalid"/);
    expect(html).toMatch(/\[!\][\s\S]*?Invalid/);
  });

  it("the scopes fieldset says in text that at least one scope must be ticked", () => {
    expect(renderConfigPage({ ...base, keycards: [] })).toMatch(/[Tt]ick at least one/);
  });

  it("escapes the counters and the scope values (never trusts the store or the enum blindly)", () => {
    const html = renderConfigPage({ ...base, keycards: [card({ useCount: "<img src=x onerror=alert(1)>" as never })] });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("shows the refused-authentication and rate-limited counters when stats are supplied", () => {
    const html = renderConfigPage({ ...base, keycards: [], keycardStats: { refusedAuth: 5, lastRefusedAt: "2026-08-25T13:00:00.000Z", rateLimited: 2 } });
    expect(html).toMatch(/Refused keycard attempts:\s*5/);
    expect(html).toContain("2026-08-25T13:00:00.000Z");
    expect(html).toMatch(/Rate-limited:\s*2/);
  });

  it("the revoke form carries a data-confirm text so the client can ask before a permanent action", () => {
    const html = renderConfigPage({ ...base, keycards: [card()] });
    expect(html).toMatch(/<form[^>]*data-form="revoke-keycard"[^>]*data-confirm="[^"]*cli-mac-mini[^"]*cannot be undone[^"]*"/);
  });
});
