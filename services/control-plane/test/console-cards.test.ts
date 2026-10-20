/**
 * Maestro Console card builder (plan Task 6): session state, needs-you signals, card faces, project key,
 * live-session pick. Session files, pane tails and sentinels come from test/fixtures/console/.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildCardFaces,
  detectNeedsYou,
  detectReplyQuestion,
  LETTERED_OPTION_RE,
  WAIT_CLAUSE_RE,
  kindFor,
  pickLiveSession,
  projectKeyFor,
  stateFor,
} from "../src/console/cards.js";
import { maskSecrets } from "../src/console/masking.js";
import type { ProbePane, ProbeSessionFile } from "../src/console/probe.js";
import type { Turn } from "../src/console/transcript.js";

const text = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/console/${name}`, import.meta.url)), "utf8");

/** A session fixture as the probe would hand it over (allow-listed fields + alive). */
const sessionFile = (name: string, alive = true): ProbeSessionFile => {
  const raw = JSON.parse(text(name)) as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const waitingFor = str("waitingFor");
  const tmux = str("tmux");
  return {
    pid: raw["pid"] as number,
    sessionId: str("sessionId") ?? "",
    cwd: str("cwd") ?? "",
    status: str("status") ?? "",
    ...(waitingFor !== undefined ? { waitingFor } : {}),
    ...(tmux !== undefined ? { tmux } : {}),
    alive,
  };
};

const PK1 = `pk1_${"ab12".repeat(16)}`;

const turn = (over: Partial<Turn> = {}): Turn => ({
  turnUuid: "792879cd-0000-4000-8000-000000000001",
  startedAt: "2026-10-17T08:00:00.000Z",
  endedAt: "2026-10-17T08:01:00.000Z",
  byteStart: 100,
  byteEnd: 900,
  promptText: "A1",
  promptSource: "human",
  replyText: "Done.\n\n**TL;DR:** It worked.",
  toolCallCount: 3,
  thinkingChars: 42,
  ...over,
});

const CTX = { machine: "Mac-Mini", projectKey: "Pantheon", sessionId: "6e09d39d-b40c-4b13-a30c-ee642f5f6ee9" } as const;

const pane = (paneId: string, session = "Pantheon"): ProbePane => ({
  session,
  windowId: "@9",
  paneId,
  panePid: 4242,
  currentCommand: "2.1.302",
});

describe("stateFor", () => {
  it("status waiting is NEEDS YOU with the waitingFor reason", () => {
    const f = sessionFile("sessions-2.1.301.json");
    expect(stateFor(f.status, f.waitingFor, false)).toEqual({
      state: "needs_you",
      glyph: "!",
      word: "NEEDS YOU",
      reason: "permission prompt",
    });
    expect(detectNeedsYou({ status: f.status, waitingFor: "permission prompt", paneTail: "" })).toEqual({
      signals: [{ kind: "waiting", detail: "permission prompt" }],
      problems: [],
    });
  });

  it("status busy with a menu on screen is NEEDS YOU (menu_on_screen)", () => {
    const { signals: needs } = detectNeedsYou({ status: "busy", paneTail: text("pane-permission-while-busy.txt") });
    expect(needs).toEqual([{ kind: "menu_on_screen", detail: "permission" }]);
    expect(stateFor("busy", undefined, needs.length > 0)).toMatchObject({ state: "needs_you", glyph: "!", word: "NEEDS YOU" });
    expect(kindFor(needs)).toBe("menu");
  });

  it("busy, idle and shell are WORKING, IDLE and IN SHELL", () => {
    expect(stateFor("busy", undefined, false)).toEqual({ state: "working", glyph: "⟳", word: "WORKING" });
    expect(stateFor("idle", undefined, false)).toEqual({ state: "idle", glyph: "✓", word: "IDLE" });
    expect(stateFor("shell", undefined, false)).toEqual({ state: "shell", glyph: "$", word: "IN SHELL" });
  });

  it("an unknown status is UNKNOWN STATUS <value>, never idle", () => {
    const f = sessionFile("sessions-unknown-status.json");
    expect(stateFor(f.status, undefined, false)).toEqual({ state: "unknown", glyph: "?", word: "UNKNOWN STATUS hibernating" });
    expect(stateFor("", undefined, false)).toEqual({ state: "unknown", glyph: "?", word: "UNKNOWN STATUS (missing)" });
    const long = stateFor("x".repeat(100), undefined, false);
    expect(long.word).toBe(`UNKNOWN STATUS ${"x".repeat(40)}`);
    const secret = stateFor(PK1, undefined, false);
    expect(secret.word).not.toContain("pk1_");
    expect(secret.state).toBe("unknown");
  });

  it("a needs-you signal forces NEEDS YOU whatever the status", () => {
    expect(stateFor("idle", undefined, true).state).toBe("needs_you");
    expect(stateFor("hibernating", undefined, true).state).toBe("needs_you");
    expect(stateFor("", undefined, true).state).toBe("needs_you");
  });
});

describe("detectNeedsYou", () => {
  it("a sentinel with approves:commit yields a COMMIT APPROVAL kind", () => {
    const { signals: needs, problems } = detectNeedsYou({ status: "idle", paneTail: "", sentinelJson: text("sentinel-schema2.json") });
    expect(needs).toEqual([{ kind: "sentinel", detail: "Commit the staged example change?", approvesCommit: true }]);
    expect(kindFor(needs)).toBe("commit_approval");
    expect(problems).toEqual([]);
  });

  it("a v1 sentinel is shown as not answerable", () => {
    const { signals: needs } = detectNeedsYou({ status: "idle", paneTail: "", sentinelJson: text("sentinel-v1.json") });
    expect(needs).toEqual([{ kind: "sentinel", detail: "cannot be answered until the session rewrites it as schema 2" }]);
    expect(kindFor(needs)).toBe("reply");
  });

  it("an invalid sentinel yields no signal and a counted problem, never a throw", () => {
    const { signals, problems } = detectNeedsYou({ status: "idle", paneTail: "", sentinelJson: "{not json" });
    expect(signals).toEqual([]);
    expect(problems).toEqual(["sentinel: invalid JSON"]);
  });

  it("a schema-2 sentinel without a commit option is a plain sentinel signal (kind reply)", () => {
    const doc = JSON.parse(text("sentinel-schema2.json")) as { options: { approves: string }[] };
    for (const o of doc.options) o.approves = "none";
    const { signals, problems } = detectNeedsYou({ status: "idle", paneTail: "", sentinelJson: JSON.stringify(doc) });
    expect(signals).toEqual([{ kind: "sentinel", detail: "Commit the staged example change?" }]);
    expect(problems).toEqual([]);
    expect(kindFor(signals)).toBe("reply");
  });

  it("a sentinel of an unrecognised shape yields no signal and a counted problem", () => {
    for (const bad of [
      '{"schema":3,"question":"q","options":[{"id":"A1"}]}',
      '{"question":"q"}',
      '{"options":[]}',
      '{"schema":2,"question":"q","options":[]}',
      "[1,2]",
      '"text"',
      "null",
    ]) {
      const { signals, problems } = detectNeedsYou({ status: "idle", paneTail: "", sentinelJson: bad });
      expect(signals).toEqual([]);
      expect(problems).toEqual(["sentinel: unrecognised shape"]);
    }
  });

  it("signals come in the order waiting, menu_on_screen, sentinel", () => {
    const { signals: needs } = detectNeedsYou({
      status: "waiting",
      waitingFor: "permission prompt",
      paneTail: text("pane-permission-prompt.txt"),
      sentinelJson: text("sentinel-schema2.json"),
    });
    expect(needs.map((n) => n.kind)).toEqual(["waiting", "menu_on_screen", "sentinel"]);
    expect(kindFor(needs)).toBe("commit_approval");
    expect(kindFor([])).toBe("reply");
  });

  it("details are masked and at most 200 chars", () => {
    const { signals: needs } = detectNeedsYou({ status: "waiting", waitingFor: `${PK1} ${"y".repeat(400)}`, paneTail: "" });
    expect(needs[0]!.detail).not.toContain("pk1_");
    expect(needs[0]!.detail.length).toBeLessThanOrEqual(200);
    const q = JSON.stringify({ schema: 2, question: `${PK1} ${"q".repeat(400)}`, options: [{ id: "A1", text: "go", approves: "commit" }] });
    const { signals: s } = detectNeedsYou({ status: "idle", paneTail: "", sentinelJson: q });
    expect(s[0]!.detail).not.toContain("pk1_");
    expect(s[0]!.detail.length).toBeLessThanOrEqual(200);
  });

  it("a token straddling the 200-char detail cap or the 40-char status cap is masked, not cut", () => {
    const straddle = `${"y".repeat(190)}${PK1}`;
    const { signals: w } = detectNeedsYou({ status: "waiting", waitingFor: straddle, paneTail: "" });
    expect(w[0]!.detail).not.toContain("pk1_");
    expect(w[0]!.detail).toBe(`${"y".repeat(190)}[masked]`);
    expect(stateFor("waiting", straddle, false).reason).not.toContain("pk1_");
    const q = JSON.stringify({ schema: 2, question: straddle, options: [{ id: "A1", text: "go", approves: "commit" }] });
    const { signals: s } = detectNeedsYou({ status: "idle", paneTail: "", sentinelJson: q });
    expect(s[0]!.detail).not.toContain("pk1_");
    expect(stateFor(`${"s".repeat(30)}${PK1}`, undefined, false).word).not.toContain("pk1_");
  });

  it("words, reasons and details are one line (newlines and control characters collapsed)", () => {
    expect(stateFor("hiber\nnating", undefined, false).word).toBe("UNKNOWN STATUS hiber nating");
    expect(stateFor("waiting", "permission\r\nprompt", false).reason).toBe("permission prompt");
    const { signals } = detectNeedsYou({
      status: "waiting",
      waitingFor: "a\nb",
      paneTail: "",
      sentinelJson: JSON.stringify({ schema: 2, question: "Commit\n\u0007\u001b[31mnow?", options: [{ id: "A1", text: "go", approves: "none" }] }),
    });
    expect(signals.map((n) => n.detail)).toEqual(["a b", "Commit [31mnow?"]);
  });

  it("a quiet session raises nothing", () => {
    expect(detectNeedsYou({ status: "idle", paneTail: text("pane-bare-prompt.txt") })).toEqual({ signals: [], problems: [] });
  });
});

describe("buildCardFaces", () => {
  it("card faces carry the masked TL;DR capped at 1024 chars and no other text", () => {
    const reply = `Long body ${PK1}\n\n**TL;DR:** secret ${PK1} then ${"z".repeat(3000)}`;
    const [face] = buildCardFaces([turn({ replyText: reply, promptText: `deploy with ${PK1}` })], CTX, maskSecrets);
    expect(face).toBeDefined();
    expect(face!.tldrMasked).not.toContain("pk1_");
    expect(face!.tldrMasked.startsWith("secret [masked] then")).toBe(true);
    expect(face!.tldrMasked.length).toBe(1024);
    expect(face!.title).not.toContain("pk1_");
    expect(Object.keys(face!).sort()).toEqual(
      [
        "byteEnd",
        "byteStart",
        "createdAt",
        "kind",
        "machine",
        "projectKey",
        "sessionId",
        "thinkingChars",
        "title",
        "tldrMasked",
        "toolCallCount",
        "turnUuid",
      ].sort(),
    );
    expect(face).not.toHaveProperty("replyText");
    expect(face).not.toHaveProperty("promptText");
    expect(face).toMatchObject({
      turnUuid: "792879cd-0000-4000-8000-000000000001",
      sessionId: CTX.sessionId,
      machine: "Mac-Mini",
      projectKey: "Pantheon",
      createdAt: "2026-10-17T08:01:00.000Z",
      kind: "reply",
      byteStart: 100,
      byteEnd: 900,
      toolCallCount: 3,
      thinkingChars: 42,
    });
  });

  it("tokens straddling the 280-char no-marker fallback, the 1024 cap and the title caps are masked, not cut", () => {
    const faces = buildCardFaces(
      [
        // no TL;DR marker: extractTldr falls back to the first 280 chars — the token straddles offset 280
        turn({ replyText: `${"a".repeat(270)} ${PK1} tail`, promptText: `${"p".repeat(75)}${PK1}` }),
        // TL;DR body with the token straddling offset 1024
        turn({ replyText: `body\n\n**TL;DR:** ${"z".repeat(1010)} ${PK1} more`, promptSource: "system", promptText: `${"s".repeat(55)}${PK1}` }),
      ],
      CTX,
      maskSecrets,
    );
    for (const f of faces) {
      expect(f.tldrMasked).not.toContain("pk1_");
      expect(f.title).not.toContain("pk1_");
    }
    expect(faces[0]!.tldrMasked).toContain("[masked]");
    expect(faces[0]!.title).toBe(`${"p".repeat(75)}[mask`);
    expect(faces[1]!.tldrMasked).toBe(`${"z".repeat(1010)} [masked] more`);
    expect(faces[1]!.title).toBe(`after background task: ${"s".repeat(55)}[mask`);

    // Context patterns that only match once whitespace is collapsed: `Bearer␠␠<token>` in title and TL;DR.
    // 32 chars (not 40: a 40-char run after "Bearer" + whitespace is caught by the cloudflare pattern already)
    const bearer = `Authorization: Bearer  ${"T".repeat(32)}`;
    expect(maskSecrets(bearer)).toContain("T".repeat(32)); // the raw text alone escapes every pattern
    const [b] = buildCardFaces([turn({ replyText: `x\n\n**TL;DR:** ${bearer} done`, promptText: bearer })], CTX, maskSecrets);
    expect(b!.tldrMasked).toBe("Authorization: Bearer [masked] done");
    expect(b!.title).toBe("Authorization: Bearer [masked]");
    expect(b!.tldrMasked).not.toContain("TTTTTTTTTTTTTTTT");
  });

  it("a whitespace-gapped token straddling the old 280-char no-marker cut is masked (reviewer repro)", () => {
    const replies = [
      `${"a".repeat(258)} Bearer  ${"T".repeat(32)} tail`,
      `${"a".repeat(255)} cf  ${" ".repeat(9)}${"C".repeat(40)} tail`,
    ];
    for (const r of replies) {
      // the first pass alone misses it (the whitespace gap), and the token straddles offset 280 once collapsed
      expect(maskSecrets(r)).toMatch(/TTTTTTTT|CCCCCCCC/);
      const [f] = buildCardFaces([turn({ replyText: r })], CTX, maskSecrets);
      expect(f!.tldrMasked).toContain("[masked]");
      expect(f!.tldrMasked).not.toMatch(/TTTT|CCCC/);
      expect(f!.tldrMasked.endsWith("[masked] tail")).toBe(true);
    }
    // a no-marker face is no longer cut at 280: it may reach the 1024 cap
    const [big] = buildCardFaces([turn({ replyText: "w ".repeat(2000) })], CTX, maskSecrets);
    expect(big!.tldrMasked.length).toBe(1024);
  });

  it("card titles name the trigger: human prompt, background task, hook message, tool result", () => {
    const faces = buildCardFaces(
      [
        turn({ promptText: "p".repeat(200) }),
        turn({ promptText: "   " }),
        turn({ promptSource: "system", promptText: `<task-notification> ${"s".repeat(200)}` }),
        turn({ promptSource: "meta", promptText: "Stop hook feedback" }),
        turn({ promptSource: "tool", promptText: "tool output" }),
      ],
      CTX,
      maskSecrets,
    );
    expect(faces.map((f) => f.title)).toEqual([
      "p".repeat(80),
      "(no prompt text)",
      `after background task: ${`<task-notification> ${"s".repeat(200)}`.slice(0, 60)}`,
      "after hook message: Stop hook feedback",
      "after tool result",
    ]);
    expect(faces.every((f) => f.kind === "reply")).toBe(true);
  });
});

describe("projectKeyFor", () => {
  it("projectKey comes from the tmux field and falls back to cwd@machine as unreachable", () => {
    const f = sessionFile("sessions-2.1.302.json"); // tmux "Pantheon:@9.%9"
    expect(projectKeyFor(f, [pane("%3"), pane("%9")], "Mac-Mini")).toEqual({ key: "Pantheon", reachable: true });
    // no pane carries that id
    expect(projectKeyFor(f, [pane("%3")], "Mac-Mini")).toEqual({ key: "pantheon-harness@Mac-Mini", reachable: false });
    // no tmux field
    const { tmux: _drop, ...noTmux } = f;
    void _drop;
    expect(projectKeyFor(noTmux, [pane("%9")], "Mac-Mini")).toEqual({ key: "pantheon-harness@Mac-Mini", reachable: false });
    // invalid session name / pane id
    for (const bad of ["bad name:@9.%9", "Pantheon:@9.9", "Pantheon:@9.%1234567", "Pantheon", "$(x):@9.%9"]) {
      expect(projectKeyFor({ ...f, tmux: bad }, [pane("%9")], "Mac-Mini")).toEqual({ key: "pantheon-harness@Mac-Mini", reachable: false });
    }
  });

  it("a resolved pane's current session name wins over the file's (rename-session), when valid", () => {
    const f = sessionFile("sessions-2.1.302.json");
    expect(projectKeyFor(f, [pane("%9", "Renamed")], "Mac-Mini")).toEqual({ key: "Renamed", reachable: true });
    expect(projectKeyFor(f, [pane("%9", "bad name")], "Mac-Mini")).toEqual({ key: "Pantheon", reachable: true });
  });

  it("the fallback key is masked, one line, and (unknown) for an empty or / cwd", () => {
    const f = sessionFile("sessions-2.1.302.json");
    for (const cwd of ["", "/"]) {
      expect(projectKeyFor({ ...f, cwd, tmux: "bad" }, [], "Mac-Mini")).toEqual({ key: "(unknown)@Mac-Mini", reachable: false });
    }
    const odd = projectKeyFor({ ...f, cwd: `/home/k/a\nb-${PK1}`, tmux: "bad" }, [], "Mac-Mini");
    expect(odd).toEqual({ key: "a b-[masked]@Mac-Mini", reachable: false });
  });
});

describe("pickLiveSession", () => {
  it("of two files naming one pane, the dead one is ended and the live one wins", () => {
    const live = sessionFile("sessions-2.1.302.json", true);
    const stale = { ...sessionFile("sessions-unknown-status.json", false), pid: 1111 };
    const other = { ...sessionFile("sessions-2.1.301.json", true) };
    const { live: kept, ended } = pickLiveSession([stale, live, other]);
    expect(kept).toEqual([live, other]);
    expect(ended).toEqual([stale]);
  });
});

describe("reply_question (O1)", () => {
  const SCHEMA2 = text("sentinel-schema2.json");
  const ask = (tldr: string, body = ""): ReturnType<typeof detectReplyQuestion> =>
    detectReplyQuestion(`${body}\n\n**TL;DR:** ${tldr}`, maskSecrets);

  it("fires on a non-negated waiting clause", () => {
    expect(ask("Waiting on you: reply A1 to save them, or A2 to wait.")?.waiting).toMatch(/reply A1/);
  });
  it("does not fire when the clause is negated in its first words", () => {
    for (const t of [
      "Nothing is waiting on you.",
      "Waiting on you: nothing.",
      "Waiting on you: no commands are needed.",
      "Waiting on you: only your glance at the console.",
      "Waiting on you: your usual upload.",
      "Nothing is waiting on you right now.",
      "Nothing is waiting on you. Next step: I commit on your word.",
      "Nothing is waiting on you; the next step is mine.",
      "No decision is waiting on you here.",
      "There is nothing waiting on you until the trial ends.",
    ]) {
      expect(ask(t)).toBeUndefined();
    }
  });
  it("Review Focus 1: negation after a comma is still the first words of the clause", () => {
    expect(ask("Waiting on you: nothing now, but reply A1 later.")).toBeUndefined();
    expect(ask("Waiting on you: no commands, just reply A1.")).toBeUndefined();
  });
  it("collects lettered option ids from the body, never numbered lists", () => {
    const body = "- **A1 (recommended):** commit\n- **A2:** hold\n1. first finding\n2. second finding";
    expect(ask("Waiting on you: one answer.", body)?.options).toEqual(["A1", "A2"]);
    expect(ask("Waiting on you: one answer.", "1. a\n2. b")?.options).toEqual([]);
  });
  it("a single lettered line is not an option set", () => {
    expect(ask("Waiting on you: go.", "A1: only one")?.options).toEqual([]);
  });
  // Known residual: "What is waiting on you right now: nothing." still fires (negation follows a colon).
  it.todo("does not fire on 'What is waiting on you right now: nothing.'");
  it("reads the whole reply when there is no marker", () => {
    expect(detectReplyQuestion("Waiting on you: say go.", (t) => t)?.waiting).toBe("say go.");
  });
  it("a trailing question mark alone is not a signal", () => {
    expect(ask("All done. Shall I continue?")).toBeUndefined();
  });
  it("detectNeedsYou appends reply_question only when no other signal fired", () => {
    const r1 = detectNeedsYou({ status: "idle", paneTail: "", replyText: "**TL;DR:** Waiting on you: reply A1." });
    expect(r1.signals.map((s) => s.kind)).toEqual(["reply_question"]);
    const r2 = detectNeedsYou({ status: "idle", paneTail: "", sentinelJson: SCHEMA2, replyText: "**TL;DR:** Waiting on you: reply A1." });
    expect(r2.signals.map((s) => s.kind)).toEqual(["sentinel"]);
  });
  it("masks the waiting clause", () => {
    expect(ask("Waiting on you: paste ghp_" + "a".repeat(36) + " here.")?.waiting).not.toContain("ghp_a");
  });
  it("caps options at 12 unique ids and dedupes", () => {
    const body = Array.from({ length: 30 }, (_, i) => `A${i + 1}: x\nA1: again`).join("\n");
    const o = ask("Waiting on you: pick.", body)?.options ?? [];
    expect(o).toHaveLength(12);
    expect(new Set(o).size).toBe(12);
  });
  it("hostile input stays linear", () => {
    const t0 = performance.now();
    "waiting on you ".repeat(6_800).replace(WAIT_CLAUSE_RE, "");
    "A1: x\n".repeat(20_000).replace(LETTERED_OPTION_RE, "");
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
