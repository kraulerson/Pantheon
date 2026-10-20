/**
 * Maestro Console settings file (spec §7). Entry-naming refusals never echo the offending value
 * (same hygiene as `approvalSourcesFrom`).
 */

import { describe, it, expect } from "vitest";
import { consoleSettingsFrom, DEFAULT_CONSOLE_SETTINGS, loadConsoleSettings, projectsRootFor } from "../src/console/settings.js";

const SPEC_EXAMPLE = `{
  "pollSeconds": 5,
  "retention": { "cardsDays": 90 },
  "reminders": { "firstAfterMin": 15, "everyHours": 4, "quiet": "20:00-07:00", "tz": "America/Denver", "bannerEveryMin": 30, "telegramThreadId": null },
  "areas": ["gate-safety","delivery","homelab-ops","fleet-sessions","memory-hygiene","learning-recovery","general"],
  "projects": {
    "lancache": { "display": "lancache", "glyph": "⬢", "border": "solid",  "areas": ["gate-safety","delivery","homelab-ops","general"] },
    "solo":     { "display": "solo",     "glyph": "▲", "border": "dashed", "areas": ["gate-safety","delivery","general"] },
    "cdf":      { "display": "cdf",      "glyph": "●", "border": "double", "areas": ["gate-safety","delivery","general"] },
    "homelab":  { "display": "homelab",  "glyph": "■", "border": "dotted", "areas": ["homelab-ops","general"] },
    "pantheon": { "display": "pantheon", "glyph": "◆", "border": "thick-left", "areas": ["gate-safety","delivery","general"] },
    "Dogfood":  { "hidden": true }
  },
  "allTabAreas": ["fleet-sessions","general"],
  "skills": { "handoff": ["general"], "change-card": ["general"], "add-service": ["homelab-ops"], "merge-gate": ["gate-safety"] }
}`;

describe("console settings", () => {
  it("an absent file yields the defaults (poll 5 s, 90 days, seven areas, no projects)", () => {
    const r = loadConsoleSettings("/nope", () => undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.pollSeconds).toBe(5);
    expect(r.settings.retention.cardsDays).toBe(90);
    expect(r.settings.areas.length).toBe(7);
    expect(Object.keys(r.settings.projects).length).toBe(0);
    expect(r.settings.allTabAreas).toEqual(["fleet-sessions", "general"]);
  });

  it("the spec §7 example parses, with Dogfood hidden and lancache in four areas", () => {
    const r = consoleSettingsFrom(SPEC_EXAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.projects["Dogfood"]?.hidden).toBe(true);
    expect(r.settings.projects["Dogfood"]).toEqual({ display: "Dogfood", glyph: "·", border: "solid", areas: [], hidden: true });
    expect(r.settings.projects["lancache"]?.areas).toEqual(["gate-safety", "delivery", "homelab-ops", "general"]);
    expect(r.settings.projects["lancache"]?.hidden).toBe(false);
    expect(r.settings.skills["merge-gate"]).toEqual(["gate-safety"]);
  });

  it("a bad entry names the entry and the rule, never the value", () => {
    const r = consoleSettingsFrom('{"projects":{"solo":{"glyph":"<script>"}}}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe("projects.solo.glyph");
    expect(r.message).not.toContain("<script>");
    expect(r.message).toMatch(/one to two visible characters/);
  });

  it("an unknown area on a project is refused", () => {
    const r = consoleSettingsFrom('{"projects":{"solo":{"areas":["nope"]}}}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe("projects.solo.areas[0]");
    expect(r.message).not.toContain("nope");
  });

  it("pollSeconds outside 2..60 is refused", () => {
    const r = consoleSettingsFrom('{"pollSeconds": 1}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe("pollSeconds");
  });

  it("a project key that is not a tmux session name is refused", () => {
    const r = consoleSettingsFrom('{"projects":{"bad name":{"hidden":true}}}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe('projects["bad name"]');
  });

  it("not-JSON is refused without echoing the text", () => {
    const r = consoleSettingsFrom("{nope");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe("(file)");
    expect(r.message).not.toContain("nope");
  });

  it("unknown top-level keys (reminders, telegram) are accepted and ignored", () => {
    const r = consoleSettingsFrom('{"reminders":{"firstAfterMin":15},"telegram":{"chat":"x"}}');
    expect(r.ok).toBe(true);
  });

  it("a __proto__ project key is stored as data, never reaching the prototype", () => {
    const r = consoleSettingsFrom('{"projects":{"__proto__":{"hidden":true}}}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.settings.projects)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(r.settings.projects)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["hidden"]).toBeUndefined();
  });

  it("an unknown key inside a project entry is refused, naming the entry only", () => {
    const r = consoleSettingsFrom('{"projects":{"solo":{"glyhp":"SECRET-VALUE"}}}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe("projects.solo.glyhp");
    expect(r.message).toMatch(/not a known project setting/);
    expect(r.message).not.toContain("SECRET-VALUE");
  });

  it("the default allTabAreas is checked against an overridden areas list", () => {
    const r = consoleSettingsFrom('{"areas":["delivery"]}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe("allTabAreas[0]");
  });

  it("a null glyph is refused rather than defaulted", () => {
    const r = consoleSettingsFrom('{"projects":{"solo":{"glyph":null}}}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe("projects.solo.glyph");
  });

  it("an unknown key inside retention is refused", () => {
    const r = consoleSettingsFrom('{"retention":{"cardDays":30}}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe("retention.cardDays");
    expect(r.message).not.toContain("30");
  });
});

describe("console settings — machines (F2 Task 7: machine shells)", () => {
  const ROOT = "/Users/karl/Documents/Claude Projects";
  const withRoot = (root: unknown): string => `{"machines":{"Mac-Mini":{"projectsRoot":${JSON.stringify(root)}}}}`;

  it("accepts two machine entries; projectsRootFor answers each and is undefined for an unlisted machine", () => {
    const r = consoleSettingsFrom(`{"machines":{"Mac-Mini":{"projectsRoot":${JSON.stringify(ROOT)}},"linux.box":{"projectsRoot":"/srv/projects"}}}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.machines).toEqual({ "Mac-Mini": { projectsRoot: ROOT }, "linux.box": { projectsRoot: "/srv/projects" } });
    expect(projectsRootFor(r.settings, "Mac-Mini")).toBe(ROOT);
    expect(projectsRootFor(r.settings, "linux.box")).toBe("/srv/projects");
    expect(projectsRootFor(r.settings, "homelab")).toBeUndefined();
  });

  it("the F1 file (no machines key) stays valid with machines {} — no machine has a root; the defaults agree", () => {
    const r = consoleSettingsFrom(SPEC_EXAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.machines).toEqual({});
    expect(projectsRootFor(r.settings, "Mac-Mini")).toBeUndefined();
    expect(DEFAULT_CONSOLE_SETTINGS.machines).toEqual({});
  });

  it("a machine key that is not a logical name is refused, naming the (clipped) key only", () => {
    const bad = consoleSettingsFrom('{"machines":{"bad key":{"projectsRoot":"/x"}}}');
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.entry).toBe('machines["bad key"]');
    expect(bad.message).not.toContain("/x");
    for (const key of ["-lab", ".lab"]) {
      const r = consoleSettingsFrom(`{"machines":{"${key}":{"projectsRoot":"/x"}}}`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.entry).toBe(`machines["${key}"]`);
    }
    const long = consoleSettingsFrom(`{"machines":{"${"a".repeat(65)}":{"projectsRoot":"/x"}}}`);
    expect(long.ok).toBe(false);
    if (long.ok) return;
    expect(long.entry).toBe(`machines["${"a".repeat(40)}…"]`);
  });

  it("a machine key takes the registry's logical-name shape (ruling T7-1): a leading '_' is accepted, and a __proto__ key is stored as data", () => {
    const lab = consoleSettingsFrom('{"machines":{"_lab":{"projectsRoot":"/srv/lab"}}}');
    expect(lab.ok).toBe(true);
    if (!lab.ok) return;
    expect(projectsRootFor(lab.settings, "_lab")).toBe("/srv/lab");
    const proto = consoleSettingsFrom('{"machines":{"__proto__":{"projectsRoot":"/x"}}}');
    expect(proto.ok).toBe(true);
    if (!proto.ok) return;
    expect(Object.keys(proto.settings.machines)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(proto.settings.machines)).toBe(Object.prototype);
    expect(projectsRootFor(proto.settings, "__proto__")).toBe("/x");
    expect(({} as Record<string, unknown>)["projectsRoot"]).toBeUndefined();
  });

  it.each([
    ["a relative root", "Users/karl/Projects"],
    ["an empty root", ""],
    ["a root containing a single quote", "/Users/karl/it's"],
    ["a root with a .. segment", "/Users/karl/../root"],
    ["a root with a control character", "/Users/karl/a\u0007b"],
    ["a root over 512 bytes", `/${"x".repeat(512)}`],
    ["a missing root", undefined],
    ["a non-string root", 5],
    // Ruling T11-5: tmux expands formats in `new-session -c`, so the shared rule refuses '#' (and C1, lone surrogates, bidi).
    ["a root with a tmux format '#S'", "/Users/karl/C#Sharp"],
    ["a root with '##'", "/Users/karl/a##b"],
    ["a root with '#{'", "/Users/karl/a#{session_name}"],
    ["a root with '#('", "/Users/karl/a#(id)"],
    ["a root with a C1 control", "/Users/karl/a\u0085b"],
    ["a root with a lone surrogate", "/Users/karl/a\ud800b"],
    ["a root with a bidi override", "/Users/karl/a\u202eb"]
  ])('%s is refused as machines["Mac-Mini"].projectsRoot, never echoing the value', (_label, root) => {
    const r = consoleSettingsFrom(root === undefined ? '{"machines":{"Mac-Mini":{}}}' : withRoot(root));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe('machines["Mac-Mini"].projectsRoot');
    expect(r.message).not.toContain("karl");
    expect(r.message).not.toContain("xxxx");
  });

  it("a '#' root is refused by the rule's own words (T11-5), whichever tmux format it carries", () => {
    for (const root of ["/Users/karl/C#Sharp", "/Users/karl/a##b", "/Users/karl/a#{session_name}", "/Users/karl/a#(id)"]) {
      expect(consoleSettingsFrom(withRoot(root))).toEqual({
        ok: false,
        entry: 'machines["Mac-Mini"].projectsRoot',
        message: `machines["Mac-Mini"].projectsRoot must not contain '#'`
      });
    }
  });

  it("an unknown field inside a machine entry is refused, naming the entry only", () => {
    const r = consoleSettingsFrom('{"machines":{"Mac-Mini":{"projectsRoot":"/x","projectRoot":"SECRET-VALUE"}}}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.entry).toBe('machines["Mac-Mini"].projectRoot');
    expect(r.message).toMatch(/not a known machine setting/);
    expect(r.message).not.toContain("SECRET-VALUE");
  });

  it("machines and each machine entry must be JSON objects", () => {
    const list = consoleSettingsFrom('{"machines":[]}');
    expect(list.ok).toBe(false);
    if (list.ok) return;
    expect(list.entry).toBe("machines");
    const text = consoleSettingsFrom('{"machines":{"Mac-Mini":"/x"}}');
    expect(text.ok).toBe(false);
    if (text.ok) return;
    expect(text.entry).toBe('machines["Mac-Mini"]');
  });

  it("projectsRootFor consults own entries only (no prototype walk)", () => {
    expect(projectsRootFor(DEFAULT_CONSOLE_SETTINGS, "constructor")).toBeUndefined();
    expect(projectsRootFor(DEFAULT_CONSOLE_SETTINGS, "__proto__")).toBeUndefined();
    const r = consoleSettingsFrom('{"machines":{"constructor":{"projectsRoot":"/x"}}}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(projectsRootFor(r.settings, "constructor")).toBe("/x");
    expect(Object.getPrototypeOf(r.settings.machines)).toBe(Object.prototype);
  });
});
