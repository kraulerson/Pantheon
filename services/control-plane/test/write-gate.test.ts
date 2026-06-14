import { describe, it, expect } from "vitest";
import { decideWrite } from "../src/grounding/index.js";

describe("decideWrite — tag -> taint -> gate ordering, fail-closed", () => {
  it("reads (toolIsWrite=false) are NEVER gated, even when tainted/untagged", () => {
    const d = decideWrite({
      toolIsWrite: false,
      provenanceTagged: false,
      sessionTainted: true
    });
    expect(d.gated).toBe(false);
    expect(d.reason).toBeTruthy();
  });

  it("a write from UNTAGGED provenance is FAIL-CLOSED (gated) — D3 ordering", () => {
    // Skipping the tagging step must gate the write: tag -> taint -> gate.
    const d = decideWrite({
      toolIsWrite: true,
      provenanceTagged: false,
      sessionTainted: false
    });
    expect(d.gated).toBe(true);
    expect(d.reason).toMatch(/tag|provenance|untagged|unknown/i);
  });

  it("a write from a TAINTED session is gated pending approval", () => {
    const d = decideWrite({
      toolIsWrite: true,
      provenanceTagged: true,
      sessionTainted: true
    });
    expect(d.gated).toBe(true);
    expect(d.reason).toMatch(/taint|approval/i);
  });

  it("a write from a verifiably-clean (untainted, fully-tagged) session is UNGATED", () => {
    const d = decideWrite({
      toolIsWrite: true,
      provenanceTagged: true,
      sessionTainted: false
    });
    expect(d.gated).toBe(false);
    expect(d.reason).toBeTruthy();
  });

  it("untagged AND tainted write is gated (fail-closed, ordering wins)", () => {
    const d = decideWrite({
      toolIsWrite: true,
      provenanceTagged: false,
      sessionTainted: true
    });
    expect(d.gated).toBe(true);
    expect(d.reason).toMatch(/tag|provenance|untagged|unknown/i);
  });

  it("every decision carries a non-empty reason string", () => {
    const combos = [false, true].flatMap((toolIsWrite) =>
      [false, true].flatMap((provenanceTagged) =>
        [false, true].map((sessionTainted) => ({
          toolIsWrite,
          provenanceTagged,
          sessionTainted
        }))
      )
    );
    for (const c of combos) {
      const d = decideWrite(c);
      expect(typeof d.reason).toBe("string");
      expect(d.reason.length).toBeGreaterThan(0);
    }
  });
});
