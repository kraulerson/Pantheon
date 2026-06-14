import { describe, it, expect } from "vitest";
import {
  assembleGroundedContext,
  computeTaint,
  makeRecalledItem,
  SessionTaint
} from "../src/grounding/index.js";

describe("computeTaint — taint by presence", () => {
  it("is false for a context of only trusted user input", () => {
    const ctx = assembleGroundedContext("only me", []);
    expect(computeTaint(ctx)).toBe(false);
  });

  it("flips true when ANY trusted:false content is present", () => {
    const ctx = assembleGroundedContext("hi", [makeRecalledItem("persona", "p")]);
    expect(computeTaint(ctx)).toBe(true);
  });

  it("is presence-based, not judgment-based (benign recalled content still taints)", () => {
    const ctx = assembleGroundedContext("hi", [
      makeRecalledItem("mailbox", "totally benign note")
    ]);
    expect(computeTaint(ctx)).toBe(true);
  });
});

describe("SessionTaint — monotonic (D5 sticky)", () => {
  it("starts untainted", () => {
    expect(new SessionTaint().tainted).toBe(false);
  });

  it("markTaint() sets tainted true", () => {
    const s = new SessionTaint();
    s.markTaint();
    expect(s.tainted).toBe(true);
  });

  it("absorbing a tainted context taints the session", () => {
    const s = new SessionTaint();
    const ctx = assembleGroundedContext("hi", [makeRecalledItem("qdrant", "x")]);
    s.absorb(ctx);
    expect(s.tainted).toBe(true);
  });

  it("absorbing a clean context does NOT taint", () => {
    const s = new SessionTaint();
    s.absorb(assembleGroundedContext("hi", []));
    expect(s.tainted).toBe(false);
  });

  it("CANNOT be reverted once tainted — there is no detaint path", () => {
    const s = new SessionTaint();
    s.markTaint();
    expect(s.tainted).toBe(true);

    // Attempt to revert by every conceivable means; none must succeed.
    s.absorb(assembleGroundedContext("clean input now", []));
    expect(s.tainted).toBe(true);

    // Direct field write must not stick: `tainted` is a getter-only property over a
    // private field, so the assignment is rejected (throws in ESM strict mode) and the
    // flag is unchanged either way. Reverting is impossible by any means.
    const mutable = s as unknown as Record<string, unknown>;
    expect(() => {
      mutable["tainted"] = false;
    }).toThrow();
    expect(s.tainted).toBe(true);

    // No method named to clear/reset/detaint should exist on the model.
    const proto = Object.getPrototypeOf(s) as Record<string, unknown>;
    for (const name of ["detaint", "clear", "reset", "untaint", "setTainted"]) {
      expect(typeof proto[name]).not.toBe("function");
    }
  });
});
