/**
 * Maestro Console menu detection (plan Task 6). Driven by the real pane captures under
 * test/fixtures/console/ (see its README for origin and indentation of each file).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MENU_FIXTURES, MENU_NEGATIVE_FIXTURES, menuOnScreen } from "../src/console/menu-fixtures.js";

const pane = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/console/${name}`, import.meta.url)), "utf8");

describe("menuOnScreen — positive captures", () => {
  it("pane-trust-prompt.txt → trust", () => {
    expect(menuOnScreen(pane("pane-trust-prompt.txt"))).toBe("trust");
  });
  it("pane-permission-prompt.txt → permission", () => {
    expect(menuOnScreen(pane("pane-permission-prompt.txt"))).toBe("permission");
  });
  it("pane-permission-while-busy.txt → permission", () => {
    expect(menuOnScreen(pane("pane-permission-while-busy.txt"))).toBe("permission");
  });
  it("pane-askuserquestion.txt → askuserquestion", () => {
    expect(menuOnScreen(pane("pane-askuserquestion.txt"))).toBe("askuserquestion");
  });
});

/** Moves the cursor: `from` loses its `❯ ` prefix (replaced by spaces), `to` gains it. */
const moveCursor = (tail: string, from: string, fromWithout: string, to: string, toWith: string): string => {
  expect(tail).toContain(from);
  expect(tail).toContain(to);
  return tail.replace(from, fromWithout).replace(to, toWith);
};

describe("menuOnScreen — cursor moved off option 1 (synthesized from the real captures)", () => {
  it("permission prompt with the cursor on 2. No → permission", () => {
    for (const f of ["pane-permission-prompt.txt", "pane-permission-while-busy.txt"]) {
      const moved = moveCursor(pane(f), " ❯ 1. Yes\n", "   1. Yes\n", "   2. No\n", " ❯ 2. No\n");
      expect(moved).not.toContain("❯ 1. Yes");
      expect(menuOnScreen(moved)).toBe("permission");
      // the option line alone (with its footer) still pairs, without `Do you want to proceed?`
      expect(menuOnScreen(moved.replace(" Do you want to proceed?\n", "\n"))).toBe("permission");
    }
  });

  it("AskUserQuestion with the cursor on option 2 → askuserquestion", () => {
    const moved = moveCursor(
      pane("pane-askuserquestion.txt"),
      "❯ 1. test/fixtures/console",
      "  1. test/fixtures/console",
      "  2. test/console/fixtures",
      "❯ 2. test/console/fixtures",
    );
    expect(moved).not.toContain("❯ 1.");
    expect(menuOnScreen(moved)).toBe("askuserquestion");
  });

  it("trust prompt with the cursor on Yes → trust", () => {
    const moved = moveCursor(pane("pane-trust-prompt.txt"), " ❯ No, exit\n", "   No, exit\n", "   Yes, I trust this folder\n", " ❯ Yes, I trust this folder\n");
    expect(menuOnScreen(moved)).toBe("trust");
  });
});

describe("menuOnScreen — negative captures", () => {
  it("pane-cdf-render.txt → undefined", () => {
    expect(menuOnScreen(pane("pane-cdf-render.txt"))).toBeUndefined();
  });
  it("pane-bare-prompt.txt → undefined", () => {
    expect(menuOnScreen(pane("pane-bare-prompt.txt"))).toBeUndefined();
  });
  it("pane-quoted-menu-in-fence.txt → undefined (all three real menus quoted inside a fence)", () => {
    expect(menuOnScreen(pane("pane-quoted-menu-in-fence.txt"))).toBeUndefined();
  });
});

describe("menu fixture regexes", () => {
  it("the permission footer matches with and without the background-agents tail", () => {
    const footers = MENU_FIXTURES.filter((f) => f.name === "permission" && f.role === "footer");
    expect(footers).toHaveLength(1);
    const re = footers[0]!.re;
    expect(re.test(" Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents")).toBe(true);
    expect(re.test(" Esc to cancel · Tab to amend")).toBe(true);
    expect(re.test("Esc to cancel · Tab to amend")).toBe(true);
    expect(re.test("  Esc to cancel · Tab to amend")).toBe(false);
  });

  it("the fence fixture's quoted menus are found once taken out of the fence (only the fence hides them)", () => {
    // The lines between the two fence lines, unquoted. (Below the closing fence the capture shows a newer
    // bare `❯ ` input box, which would void a pair in the same region, so the tail is not kept.)
    const lines = pane("pane-quoted-menu-in-fence.txt").split("\n");
    const fences = lines.flatMap((l, i) => (/^\s*```/.test(l) ? [i] : []));
    expect(fences).toHaveLength(2);
    const quoted = lines.slice(fences[0]! + 1, fences[1]!).join("\n");
    expect(menuOnScreen(quoted)).toBe("trust");
    // the fence alone hides them: the capture up to and including the closing fence (no bare ❯ below)
    expect(menuOnScreen(lines.slice(0, fences[1]! + 1).join("\n"))).toBeUndefined();
  });

  it("a real menu quoted inside a ```` fence stays quoted across an inner ``` line", () => {
    const menu = pane("pane-permission-prompt.txt");
    expect(menuOnScreen(menu)).toBe("permission");
    expect(menuOnScreen(`\`\`\`\`md\n\`\`\`\n${menu}\n\`\`\`\n\`\`\`\`\n`)).toBeUndefined();
    expect(menuOnScreen(`\`\`\`\`md\n\`\`\`\n\`\`\`\n${menu}\n\`\`\`\`\n`)).toBeUndefined();
  });

  it("a footer above its option line does not pair", () => {
    expect(menuOnScreen(" Enter to confirm · Esc to cancel\n ❯ No, exit\n")).toBeUndefined();
    expect(menuOnScreen("Enter to select · ↑/↓ to navigate · Esc to cancel\n❯ 1. one\n")).toBeUndefined();
  });

  it("a bare ❯ input line below a menu voids it (stale frame above a newer input box)", () => {
    const stale = `${pane("pane-permission-prompt.txt")}\n\n❯ \n`;
    expect(menuOnScreen(stale)).toBeUndefined();
    // blank lines alone after the footer (as in every real capture) keep it
    expect(menuOnScreen(`${pane("pane-permission-prompt.txt")}\n\n\n`)).toBe("permission");
  });

  it("a 100k-line hostile tail of option-like lines completes in under 500 ms", () => {
    const tail = `${"1. x\n".repeat(100_000)}Enter to select · ↑/↓ to navigate · Esc to cancel\n`;
    const t0 = performance.now();
    expect(menuOnScreen(tail)).toBe("askuserquestion");
    const ms = performance.now() - t0;
    console.log(`menuOnScreen on 100k lines: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });

  it("a menu line without its footer (or a footer alone) does not count", () => {
    expect(menuOnScreen(" Do you want to proceed?\n ❯ 1. Yes\n   2. No\n")).toBeUndefined();
    expect(menuOnScreen("Enter to select · ↑/↓ to navigate · Esc to cancel\n")).toBeUndefined();
  });

  it("a menu line and footer more than 24 lines apart do not pair; 24 apart do", () => {
    const filler = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
    expect(menuOnScreen(` ❯ No, exit\n${filler(24)}\n Enter to confirm · Esc to cancel\n`)).toBeUndefined();
    expect(menuOnScreen(` ❯ No, exit\n${filler(23)}\n Enter to confirm · Esc to cancel\n`)).toBe("trust");
  });

  it("a menu line and footer in different un-fenced regions do not pair", () => {
    expect(menuOnScreen(" ❯ No, exit\n```\nquoted\n```\n Enter to confirm · Esc to cancel\n")).toBeUndefined();
  });

  it("each negative fixture regex matches its negative capture", () => {
    const byName = new Map(MENU_NEGATIVE_FIXTURES.map((f) => [f.name, f.re]));
    expect(byName.get("bare-prompt")?.test(pane("pane-bare-prompt.txt"))).toBe(true);
    expect(byName.get("cdf-render")?.test(pane("pane-cdf-render.txt"))).toBe(true);
  });

  it("every regex is multiline and anchored at line start", () => {
    for (const f of [...MENU_FIXTURES, ...MENU_NEGATIVE_FIXTURES]) {
      expect(f.re.flags).toContain("m");
      expect(f.re.source.startsWith("^")).toBe(true);
    }
  });
});
