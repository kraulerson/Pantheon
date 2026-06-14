import { describe, it, expect } from "vitest";
import {
  assembleGroundedContext,
  makeRecalledItem
} from "../src/grounding/index.js";

describe("assembleGroundedContext", () => {
  it("places the operator input first and marks ONLY it trusted", () => {
    const ctx = assembleGroundedContext("ship it", [
      makeRecalledItem("persona", "You are Alden."),
      makeRecalledItem("qdrant", "prior note")
    ]);
    expect(ctx.items).toHaveLength(3);
    expect(ctx.items[0]?.source).toBe("user");
    expect(ctx.items[0]?.trusted).toBe(true);
    const trustedCount = ctx.items.filter((i) => i.trusted).length;
    expect(trustedCount).toBe(1);
  });

  it("all recalled items are trusted:false in the assembled context", () => {
    const ctx = assembleGroundedContext("hello", [
      makeRecalledItem("mailbox", "msg"),
      makeRecalledItem("cross-session", "old hit"),
      makeRecalledItem("tool-result", "tool said x")
    ]);
    const recalled = ctx.items.filter((i) => i.source !== "user");
    expect(recalled).toHaveLength(3);
    expect(recalled.every((i) => i.trusted === false)).toBe(true);
  });

  it("assembles with zero retrieved items (only trusted user input)", () => {
    const ctx = assembleGroundedContext("just me", []);
    expect(ctx.items).toHaveLength(1);
    expect(ctx.items[0]?.trusted).toBe(true);
  });

  it("renders an inspectable view with provenance labels as text", () => {
    const ctx = assembleGroundedContext("do the thing", [
      makeRecalledItem("qdrant", "secret-looking recalled content")
    ]);
    const rendered = ctx.render();
    expect(rendered).toContain("TRUSTED");
    expect(rendered).toContain("UNTRUSTED");
    expect(rendered).toContain("qdrant");
    expect(rendered).toContain("do the thing");
    expect(rendered).toContain("secret-looking recalled content");
    // colorblind-safe: rendering is plain text, carries no ANSI color codes.
    // eslint-disable-next-line no-control-regex
    expect(rendered).not.toMatch(/\[/);
  });
});
