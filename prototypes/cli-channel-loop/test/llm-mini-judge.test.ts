import { describe, expect, it } from "vitest";
import { formatWindow, parseVerdict } from "../src/llm-mini-judge.js";
import type { TranscriptEntry } from "../src/loop-detector.js";

describe("parseVerdict", () => {
  it("extracts the verdict word regardless of case or surrounding prose", () => {
    expect(parseVerdict("PROGRESS")).toBe("progress");
    expect(parseVerdict("Verdict: Looping.")).toBe("looping");
    expect(parseVerdict("I think this is stalled")).toBe("stalled");
  });

  it("returns unknown for anything unparseable", () => {
    expect(parseVerdict("")).toBe("unknown");
    expect(parseVerdict("the conversation moves forward")).toBe("unknown");
  });
});

describe("formatWindow", () => {
  it("renders direction, sender, and truncates long bodies", () => {
    const entries: TranscriptEntry[] = [
      { direction: "inbound", sender: "alden-1", text: "hello", atMs: 1 },
      { direction: "outbound", sender: "claude-code", text: "x".repeat(600), atMs: 2 }
    ];
    const out = formatWindow(entries);
    expect(out).toContain("[inbound] alden-1: hello");
    expect(out).toContain("[outbound] claude-code:");
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(600);
  });
});
