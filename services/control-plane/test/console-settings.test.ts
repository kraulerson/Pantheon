/**
 * Maestro Console settings file (spec §7). Entry-naming refusals never echo the offending value
 * (same hygiene as `approvalSourcesFrom`).
 */

import { describe, it, expect } from "vitest";
import { consoleSettingsFrom, loadConsoleSettings } from "../src/console/settings.js";

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
