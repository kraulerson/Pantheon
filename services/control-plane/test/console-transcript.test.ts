/**
 * Maestro Console transcript turn splitter (plan Task 5). Driven by the real excerpts under
 * test/fixtures/console/ (see its README for each file's turnUuids); the 3 MB line, the `summary`/`system`
 * line types and the non-JSON line are synthesized in the test because no real transcript has them.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_LINE_BYTES, extractTldr, splitTurns } from "../src/console/transcript.js";
import { buildCardFaces } from "../src/console/cards.js";
import { maskSecrets } from "../src/console/masking.js";

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/console/${name}`, import.meta.url)));

const CLOSE = { closeOpenTurn: true } as const;

const jsonLine = (o: unknown): string => JSON.stringify(o) + "\n";

const userLine = (uuid: string, text: string, extra: Record<string, unknown> = {}): string =>
  jsonLine({
    type: "user",
    uuid,
    timestamp: "2026-10-17T00:00:00.000Z",
    message: { role: "user", content: text },
    ...extra,
  });

const assistantLine = (uuid: string, text: string): string =>
  jsonLine({
    type: "assistant",
    uuid,
    timestamp: "2026-10-17T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

describe("splitTurns", () => {
  it("splits the basic fixture into its turns with the final assistant uuid as turnUuid", () => {
    const r = splitTurns(fixture("transcript-basic.jsonl"), 0, undefined, CLOSE);
    expect(r.cantRead).toBe(false);
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0]?.turnUuid.startsWith("792879cd")).toBe(true);
    expect(r.turns[1]?.turnUuid.startsWith("bd252916")).toBe(true);
    expect(r.turns[0]?.promptText).toBe("A1");
    expect(r.turns[1]?.promptText).toBe("done");
    expect(r.turns[0]?.replyText).toContain("**TL;DR**");
    expect(r.turns[0]?.toolCallCount).toBe(3);
    expect(r.turns[0]?.startedAt).toBe("2026-10-17T04:25:44.395Z");
    expect(r.turns[0]?.endedAt).toBe("2026-10-17T04:26:23.293Z");
    expect(r.carry.length).toBe(0);
    expect(r.consumedBytes).toBe(fixture("transcript-basic.jsonl").length);
  });

  it("a tool_result user line does not start a turn", () => {
    const r = splitTurns(fixture("transcript-tool-result-user.jsonl"), 0, undefined, CLOSE);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.turnUuid.startsWith("548e4bfc")).toBe(true);
    expect(r.turns[0]?.toolCallCount).toBe(1);
    expect(r.turns[0]?.promptText).toBe("Doesn't gitea pull from github?");
    expect(r.turns[0]?.promptSource).toBe("human");
    expect(r.turns[0]?.byteStart).toBe(0);
  });

  it("isMeta and promptSource:system user lines do not start a turn", () => {
    const r = splitTurns(fixture("transcript-meta-and-system.jsonl"), 0, undefined, CLOSE);
    // They never start a *human* turn: the human prompt "A1" closes at the reply before turn_duration
    // (93e78e9f), and the stop-hook feedback (isMeta) reply joined it. The later reply to the system-sourced
    // task notification is its own turn, e9680652.
    expect(r.turns.map((t) => t.turnUuid.slice(0, 8))).toEqual(["93e78e9f", "e9680652"]);
    expect(r.turns.map((t) => t.promptSource)).toEqual(["human", "system"]);
    expect(r.turns[0]?.promptText).toBe("A1");
    expect(r.turns[0]?.toolCallCount).toBe(1);
    expect(r.turns[1]?.toolCallCount).toBe(0);
    expect(r.turns[1]?.promptText).not.toBe("A1");
    // mode, permission-mode, system x2 are counted, not failed.
    expect(r.ignoredLines).toBe(4);
    expect(r.cantRead).toBe(false);
  });

  it("a human prompt still yields promptSource human", () => {
    const r = splitTurns(fixture("transcript-basic.jsonl"), 0, undefined, CLOSE);
    expect(r.turns.map((t) => t.promptSource)).toEqual(["human", "human"]);
  });

  it("a reply after a system-sourced prompt following turn_duration is its own turn with promptSource system", () => {
    const duration = jsonLine({ type: "system", subtype: "turn_duration", durationMs: 5 });
    const notice = userLine("n1", "task finished", { promptSource: "system" });
    const head = userLine("u1", "hi") + assistantLine("a1", "ok") + duration;
    // Unanswered notice: held back, not consumed.
    const first = splitTurns(Buffer.from(head + notice), 0);
    expect(first.turns.map((t) => t.turnUuid)).toEqual(["a1"]);
    expect(first.consumedBytes).toBe(Buffer.byteLength(head));
    expect(first.openTurnStart).toBe(Buffer.byteLength(head));
    // The reply arrives in the next slice: one turn, once.
    const second = splitTurns(Buffer.from(assistantLine("a2", "reporting")), first.consumedBytes, first.carry, CLOSE);
    expect(second.turns.map((t) => t.turnUuid)).toEqual(["a2"]);
    expect(second.turns[0]?.promptSource).toBe("system");
    expect(second.turns[0]?.promptText).toBe("task finished");
    expect(second.turns[0]?.byteStart).toBe(Buffer.byteLength(head));
    expect(second.openTurnStart).toBeUndefined();
  });

  it("a reply after an isMeta prompt is a turn with promptSource meta", () => {
    const meta = userLine("m1", "stop hook says carry on", { isMeta: true });
    const r = splitTurns(Buffer.from(meta + assistantLine("a1", "carrying on")), 0, undefined, CLOSE);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.promptSource).toBe("meta");
    expect(r.turns[0]?.turnUuid).toBe("a1");
    // A tool_result-only line triggers a "tool" turn with empty promptText; tool calls in between count.
    const toolResult = jsonLine({
      type: "user",
      uuid: "t1",
      timestamp: "2026-10-17T00:00:00.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "done" }] },
    });
    const toolUse = jsonLine({
      type: "assistant",
      uuid: "tu",
      timestamp: "2026-10-17T00:00:01.000Z",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    });
    const t = splitTurns(Buffer.from(toolResult + toolUse + assistantLine("a2", "result in")), 0, undefined, CLOSE);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.promptSource).toBe("tool");
    expect(t.turns[0]?.promptText).toBe("");
    expect(t.turns[0]?.toolCallCount).toBe(1);
    expect(t.turns[0]?.byteStart).toBe(0);
  });

  it("a partial trailing line is carried, not parsed, and consumedBytes stops before it", () => {
    const whole = Buffer.from(userLine("u1", "hi") + assistantLine("a1", "ok") + userLine("u2", "next"));
    const partial = Buffer.from('{"type":"assistant","uuid":"a2","times');
    const r = splitTurns(Buffer.concat([whole, partial]), 0);
    expect(r.cantRead).toBe(false);
    expect(r.turns).toHaveLength(1);
    // u2 is an open turn, so consumedBytes stops at it, ahead of the partial line.
    expect(r.consumedBytes).toBe(Buffer.byteLength(userLine("u1", "hi") + assistantLine("a1", "ok")));
    expect(r.carry.equals(Buffer.concat([Buffer.from(userLine("u2", "next")), partial]))).toBe(true);
    // With no open turn the carry is exactly the partial line.
    const closed = Buffer.from(userLine("u1", "hi") + assistantLine("a1", "ok") + userLine("u2", "next") + assistantLine("a2", "x"));
    const r2 = splitTurns(Buffer.concat([closed, partial]), 0, undefined, CLOSE);
    expect(r2.turns).toHaveLength(2);
    expect(r2.consumedBytes).toBe(closed.length);
    expect(r2.carry.equals(partial)).toBe(true);
  });

  it("the partial-tail fixture: the finished turn is returned, the prompt after it stays open, the cut line is carried", () => {
    const bytes = fixture("transcript-partial-tail.jsonl");
    const lastNl = bytes.lastIndexOf(0x0a);
    const r = splitTurns(bytes, 0, undefined, CLOSE);
    expect(r.cantRead).toBe(false);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.turnUuid.startsWith("ad14f43e")).toBe(true);
    // The prompt "A1" has no assistant text yet: open even with closeOpenTurn; the cut line follows it.
    expect(r.openTurnStart).toBe(r.turns[0]?.byteEnd);
    expect(r.consumedBytes).toBe(r.turns[0]?.byteEnd);
    expect(r.carry.equals(bytes.subarray(r.consumedBytes))).toBe(true);
    expect(r.consumedBytes).toBeLessThan(lastNl + 1);
  });

  it("a prompt whose reply is still streaming is not consumed (consumedBytes stops at the prompt, openTurnStart set)", () => {
    const done = userLine("u1", "hi") + assistantLine("a1", "ok");
    const streaming = userLine("u2", "go") + assistantLine("a2", "working");
    const r = splitTurns(Buffer.from(done + streaming), 1000);
    expect(r.turns.map((t) => t.turnUuid)).toEqual(["a1"]);
    expect(r.consumedBytes).toBe(Buffer.byteLength(done));
    expect(r.openTurnStart).toBe(1000 + Buffer.byteLength(done));
    expect(r.carry.equals(Buffer.from(streaming))).toBe(true);
    // A finished stream has no openTurnStart.
    expect("openTurnStart" in splitTurns(Buffer.from(done), 0, undefined, CLOSE)).toBe(false);
  });

  it("a turn_duration system line closes the turn without a following prompt", () => {
    const base = userLine("u1", "hi") + assistantLine("a1", "ok");
    const duration = jsonLine({ type: "system", subtype: "turn_duration", durationMs: 5 });
    const r = splitTurns(Buffer.from(base + duration), 0);
    expect(r.turns.map((t) => t.turnUuid)).toEqual(["a1"]);
    expect(r.openTurnStart).toBeUndefined();
    expect(r.consumedBytes).toBe(Buffer.byteLength(base + duration));
    expect(r.ignoredLines).toBe(1);
    // A turn_duration with no assistant text yet does not close the turn.
    const early = splitTurns(Buffer.from(userLine("u1", "hi") + duration), 0);
    expect(early.turns).toHaveLength(0);
    expect(early.openTurnStart).toBe(0);
    // An assistant line after the terminator with no non-human prompt behind it belongs to no turn.
    // It is not silent: each such orphan reply is counted (the turn_duration line is the other ignored line).
    // The closed human prompt is not reused for it.
    const after = splitTurns(Buffer.from(base + duration + assistantLine("a2", "late")), 0, undefined, CLOSE);
    expect(after.turns.map((t) => t.turnUuid)).toEqual(["a1"]);
    expect(after.ignoredLines).toBe(2);
    // A tool_use-only orphan line is not a reply and is not counted.
    const quiet = jsonLine({
      type: "assistant",
      uuid: "q",
      timestamp: "2026-10-17T00:00:01.000Z",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    });
    expect(splitTurns(Buffer.from(base + duration + quiet), 0, undefined, CLOSE).ignoredLines).toBe(1);
  });

  it("closeOpenTurn closes a turn that has assistant text and leaves a text-less prompt open", () => {
    const withText = Buffer.from(userLine("u1", "hi") + assistantLine("a1", "ok"));
    const open = splitTurns(withText, 0);
    expect(open.turns).toHaveLength(0);
    expect(open.openTurnStart).toBe(0);
    const closed = splitTurns(withText, 0, undefined, CLOSE);
    expect(closed.turns.map((t) => t.turnUuid)).toEqual(["a1"]);
    expect(closed.openTurnStart).toBeUndefined();
    expect(closed.consumedBytes).toBe(withText.length);
    expect(closed.carry.length).toBe(0);
    // Tool-use only so far: no assistant text, stays open.
    const toolOnly = Buffer.from(
      userLine("u1", "hi") +
        jsonLine({
          type: "assistant",
          uuid: "a1",
          timestamp: "2026-10-17T00:00:01.000Z",
          message: { content: [{ type: "tool_use", name: "Bash" }] },
        }),
    );
    const r = splitTurns(toolOnly, 0, undefined, CLOSE);
    expect(r.turns).toHaveLength(0);
    expect(r.openTurnStart).toBe(0);
    expect(r.consumedBytes).toBe(0);
  });

  it("feeding the unconsumed bytes back with the next slice yields the complete turn once (no duplicate)", () => {
    const done = userLine("u1", "hi") + assistantLine("a1", "ok");
    const stream1 = userLine("u2", "go") + assistantLine("a2", "part one");
    const stream2 = assistantLine("a3", "part two") + userLine("u3", "later");
    const first = splitTurns(Buffer.from(done + stream1), 0);
    expect(first.turns.map((t) => t.turnUuid)).toEqual(["a1"]);
    const second = splitTurns(Buffer.from(stream2), first.consumedBytes, first.carry);
    expect(second.turns.map((t) => t.turnUuid)).toEqual(["a3"]);
    expect(second.turns[0]?.replyText).toBe("part two");
    expect(second.turns[0]?.byteStart).toBe(Buffer.byteLength(done));
    expect(second.consumedBytes).toBe(Buffer.byteLength(stream1 + assistantLine("a3", "part two")));
    expect(second.openTurnStart).toBe(first.consumedBytes + second.consumedBytes);
  });

  it("feeding the carry back in with the rest of the line completes it", () => {
    const whole = Buffer.from(userLine("u1", "hi") + assistantLine("a1", "ok"));
    const cut = Buffer.byteLength(userLine("u1", "hi")) - 10;
    const first = splitTurns(whole.subarray(0, cut), 500);
    expect(first.turns).toHaveLength(0);
    expect(first.consumedBytes).toBe(0);
    expect(first.carry.length).toBe(cut);
    // baseOffset addresses the first byte handed over (the carry's first byte when a carry is given).
    const second = splitTurns(whole.subarray(cut), 500 + first.consumedBytes, first.carry, CLOSE);
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0]?.turnUuid).toBe("a1");
    expect(second.turns[0]?.byteStart).toBe(500);
    expect(second.carry.length).toBe(0);
  });

  it("byteStart/byteEnd of a turn address exactly its lines (round-trip: slicing the fixture by them yields the same lines)", () => {
    for (const name of [
      "transcript-basic.jsonl",
      "transcript-meta-and-system.jsonl",
      "transcript-tool-result-user.jsonl",
      "transcript-empty-thinking.jsonl",
      "transcript-partial-tail.jsonl",
    ]) {
      const bytes = fixture(name);
      const r = splitTurns(bytes, 0, undefined, CLOSE);
      for (const t of r.turns) {
        const slice = bytes.subarray(t.byteStart, t.byteEnd);
        expect(slice.at(-1)).toBe(0x0a);
        const lines = slice
          .toString("utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as { type: string; uuid?: string });
        expect(lines[0]?.type).toBe("user");
        expect(lines.at(-1)?.uuid).toBe(t.turnUuid);
        // Re-splitting exactly that range reproduces the turn.
        const again = splitTurns(slice, t.byteStart, undefined, CLOSE);
        expect(again.turns).toEqual([t]);
      }
    }
    // A base offset shifts the addresses.
    const basic = fixture("transcript-basic.jsonl");
    const shifted = splitTurns(basic, 1000, undefined, CLOSE);
    const plain = splitTurns(basic, 0, undefined, CLOSE);
    expect(shifted.turns[1]?.byteStart).toBe((plain.turns[1]?.byteStart ?? 0) + 1000);
    expect(shifted.turns[1]?.byteEnd).toBe((plain.turns[1]?.byteEnd ?? 0) + 1000);
    // The two basic turns are adjacent: turn 2 starts where turn 1 ends.
    expect(plain.turns[1]?.byteStart).toBe(plain.turns[0]?.byteEnd);
  });

  it("empty thinking blocks count zero thinkingChars", () => {
    const r = splitTurns(fixture("transcript-empty-thinking.jsonl"), 0, undefined, CLOSE);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.thinkingChars).toBe(0);
    // Non-empty thinking is summed.
    const bytes = Buffer.from(
      userLine("u1", "hi") +
        jsonLine({
          type: "assistant",
          uuid: "a1",
          timestamp: "2026-10-17T00:00:01.000Z",
          message: { content: [{ type: "thinking", thinking: "abcde" }, { type: "text", text: "ok" }] },
        }),
    );
    expect(splitTurns(bytes, 0, undefined, CLOSE).turns[0]?.thinkingChars).toBe(5);
  });

  it("a non-JSON complete line sets cantRead with the fixed reason", () => {
    const bytes = Buffer.from(userLine("u1", "hi") + "this is not json\n" + assistantLine("a1", "ok"));
    const r = splitTurns(bytes, 0, undefined, CLOSE);
    expect(r.cantRead).toBe(true);
    expect(r.cantReadWhy).toBe("line is not JSON");
    expect(r.turns).toHaveLength(1);

    const lacking = splitTurns(Buffer.from(jsonLine({ type: "user", uuid: "u1", message: { content: "x" } })), 0);
    expect(lacking.cantRead).toBe(true);
    expect(lacking.cantReadWhy).toBe("user/assistant line lacks uuid, timestamp or message");
    const noMessage = splitTurns(
      Buffer.from(jsonLine({ type: "assistant", uuid: "a", timestamp: "2026-10-17T00:00:00.000Z" })),
      0,
    );
    expect(noMessage.cantReadWhy).toBe("user/assistant line lacks uuid, timestamp or message");

    const clean = splitTurns(fixture("transcript-basic.jsonl"), 0, undefined, CLOSE);
    expect(clean.cantRead).toBe(false);
    expect("cantReadWhy" in clean).toBe(false);
  });

  it("unknown line types (summary, system) are counted and ignored", () => {
    const bytes = Buffer.from(
      jsonLine({ type: "summary", summary: "x", leafUuid: "l" }) +
        userLine("u1", "hi") +
        jsonLine({ type: "system", subtype: "turn_duration" }) +
        assistantLine("a1", "ok"),
    );
    const r = splitTurns(bytes, 0, undefined, CLOSE);
    expect(r.ignoredLines).toBe(2);
    expect(r.cantRead).toBe(false);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.turnUuid).toBe("a1");
  });

  it("a 3 MB line is skipped and counted", () => {
    const huge = jsonLine({ type: "user", uuid: "big", timestamp: "t", message: { content: "x".repeat(3 * 1024 * 1024) } });
    expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_LINE_BYTES);
    const small = userLine("u1", "hi") + assistantLine("a1", "ok");
    const r = splitTurns(Buffer.from(huge + small), 0, undefined, CLOSE);
    expect(r.ignoredLines).toBe(1);
    expect(r.cantRead).toBe(false);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]?.turnUuid).toBe("a1");
    expect(r.turns[0]?.byteStart).toBe(Buffer.byteLength(huge));
    expect(r.consumedBytes).toBe(Buffer.byteLength(huge + small));
  });
});

describe("splitTurns prompts, counting and slice boundaries", () => {
  it("a human line with no text block (image-only prompt) attributes the reply as human with empty promptText", () => {
    const duration = jsonLine({ type: "system", subtype: "turn_duration" });
    const image = jsonLine({
      type: "user",
      uuid: "i1",
      timestamp: "2026-10-17T00:00:00.000Z",
      message: { role: "user", content: [{ type: "image", source: { type: "base64", data: "AAAA" } }] },
    });
    const head = userLine("u1", "hi") + assistantLine("a1", "ok") + duration;
    const r = splitTurns(Buffer.from(head + image + assistantLine("a2", "I see it")), 0, undefined, CLOSE);
    expect(r.turns.map((t) => t.turnUuid)).toEqual(["a1", "a2"]);
    expect(r.turns[1]?.promptSource).toBe("human");
    expect(r.turns[1]?.promptText).toBe("");
    expect(r.turns[1]?.byteStart).toBe(Buffer.byteLength(head));
    // Unanswered, it is held back and reported as a human line.
    const held = splitTurns(Buffer.from(head + image), 0);
    expect(held.openTurnSource).toBe("human");
    expect(held.openTurnStart).toBe(Buffer.byteLength(head));
  });

  it("a tool_result joining a waiting non-human candidate keeps the candidate as the turn's prompt", () => {
    const duration = jsonLine({ type: "system", subtype: "turn_duration" });
    const head = userLine("u1", "hi") + assistantLine("a1", "ok") + duration;
    const notice = userLine("n1", "background task finished", { promptSource: "system" });
    const toolUse = jsonLine({
      type: "assistant",
      uuid: "tu",
      timestamp: "2026-10-17T00:00:01.000Z",
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    });
    const toolResult = jsonLine({
      type: "user",
      uuid: "t1",
      timestamp: "2026-10-17T00:00:02.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "done" }] },
    });
    const bytes = Buffer.from(head + notice + toolUse + toolResult + assistantLine("a2", "all good"));
    const r = splitTurns(bytes, 0, undefined, CLOSE);
    expect(r.turns.map((t) => t.turnUuid)).toEqual(["a1", "a2"]);
    const t = r.turns[1];
    expect(t?.promptSource).toBe("system");
    expect(t?.promptText).toBe("background task finished");
    expect(t?.toolCallCount).toBe(1);
    expect(t?.byteStart).toBe(Buffer.byteLength(head));
    // Held back (no reply yet), the candidate stays the start of the unconsumed region after the tool_result too.
    const held = splitTurns(Buffer.from(head + notice + toolUse + toolResult), 0);
    expect(held.openTurnSource).toBe("system");
    expect(held.consumedBytes).toBe(Buffer.byteLength(head));
    // A non-tool user line (here an isMeta one) still replaces the candidate.
    const meta = userLine("m1", "hook says go on", { isMeta: true });
    const replaced = splitTurns(Buffer.from(head + notice + meta + assistantLine("a3", "going")), 0, undefined, CLOSE);
    expect(replaced.turns[1]?.promptSource).toBe("meta");
    expect(replaced.turns[1]?.promptText).toBe("hook says go on");
  });

  it("openTurnSource tells an in-progress human turn from a non-human line awaiting a reply", () => {
    const human = splitTurns(Buffer.from(userLine("u1", "hi") + assistantLine("a1", "partial")), 0);
    expect(human.openTurnSource).toBe("human");
    const duration = jsonLine({ type: "system", subtype: "turn_duration" });
    const done = userLine("u1", "hi") + assistantLine("a1", "ok") + duration;
    expect(splitTurns(Buffer.from(done + userLine("m", "x", { isMeta: true })), 0).openTurnSource).toBe("meta");
    expect(splitTurns(Buffer.from(done + userLine("n", "x", { promptSource: "system" })), 0).openTurnSource).toBe("system");
    expect(splitTurns(Buffer.from(done), 0).openTurnSource).toBeUndefined();
  });

  it("promptText leaves out <system-reminder> blocks", () => {
    const prompt = jsonLine({
      type: "user",
      uuid: "u1",
      timestamp: "2026-10-17T00:00:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>\nSecret hook text\n</system-reminder>" },
          { type: "text", text: "what is the status?" },
        ],
      },
    });
    const r = splitTurns(Buffer.from(prompt + assistantLine("a1", "fine")), 0, undefined, CLOSE);
    expect(r.turns[0]?.promptText).toBe("what is the status?");
    expect(r.turns[0]?.replyText).toBe("fine");
  });

  it("ignoredLines and cantRead cover only consumed lines: two-call counts equal the single pass", () => {
    const bad = "this is not json\n";
    const duration = jsonLine({ type: "system", subtype: "turn_duration" });
    const bytes = Buffer.from(
      jsonLine({ type: "mode" }) +
        userLine("u1", "hi") +
        bad +
        jsonLine({ type: "summary" }) +
        assistantLine("a1", "ok") +
        duration +
        assistantLine("orphan", "late") +
        userLine("u2", "again") +
        jsonLine({ type: "system", subtype: "x" }) +
        assistantLine("a2", "yes"),
    );
    const single = splitTurns(bytes, 0, undefined, CLOSE);
    expect(single.ignoredLines).toBe(5); // mode, summary, turn_duration, orphan, system x
    expect(single.cantRead).toBe(true);
    for (let cut = 1; cut < bytes.length; cut += 7) {
      const first = splitTurns(bytes.subarray(0, cut), 0);
      const second = splitTurns(bytes.subarray(cut), first.consumedBytes, first.carry, CLOSE);
      expect(first.ignoredLines + second.ignoredLines).toBe(single.ignoredLines);
      expect(first.cantRead !== second.cantRead).toBe(true); // reported by exactly one call
      expect([...first.turns, ...second.turns]).toEqual(single.turns);
    }
    // The held-back region is not counted: a system line inside an open turn is reported once it is consumed.
    const open = splitTurns(Buffer.from(userLine("u1", "hi") + jsonLine({ type: "mode" }) + assistantLine("a1", "ok")), 0);
    expect(open.ignoredLines).toBe(0);
    const closed = splitTurns(Buffer.from(userLine("u1", "hi") + jsonLine({ type: "mode" }) + assistantLine("a1", "ok")), 0, undefined, CLOSE);
    expect(closed.ignoredLines).toBe(1);
  });

  it("slice-boundary sweep: any two-slice cut yields the single-pass turns, once, with no byte unaccounted", () => {
    for (const name of ["transcript-basic.jsonl", "transcript-meta-and-system.jsonl", "transcript-tool-result-user.jsonl"]) {
      const bytes = fixture(name);
      const single = splitTurns(bytes, 0, undefined, CLOSE);
      const cuts = [1, bytes.length - 1];
      for (let c = 97; c < bytes.length; c += 97) cuts.push(c);
      for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0x0a) cuts.push(i, i + 1);
      for (const cut of cuts) {
        const first = splitTurns(bytes.subarray(0, cut), 0);
        expect(first.consumedBytes + first.carry.length).toBe(cut);
        const second = splitTurns(bytes.subarray(cut), first.consumedBytes, first.carry, CLOSE);
        expect(second.consumedBytes + second.carry.length).toBe(first.carry.length + (bytes.length - cut));
        expect([...first.turns, ...second.turns]).toEqual(single.turns);
        expect(first.ignoredLines + second.ignoredLines).toBe(single.ignoredLines);
      }
    }
  });
});

describe("splitTurns oversize tail", () => {
  it("an unterminated tail over MAX_LINE_BYTES is dropped, counted once, and resynced at the next newline", () => {
    const head = userLine("u1", "hi") + assistantLine("a1", "ok");
    const junk = Buffer.alloc(MAX_LINE_BYTES + 100, 0x78); // 'x', no newline
    const first = splitTurns(Buffer.concat([Buffer.from(head), junk]), 0, undefined, CLOSE);
    expect(first.turns.map((t) => t.turnUuid)).toEqual(["a1"]);
    expect(first.ignoredLines).toBe(1);
    expect(first.carry.length).toBe(MAX_LINE_BYTES + 1);
    expect(first.consumedBytes + first.carry.length).toBe(Buffer.byteLength(head) + junk.length);
    // More of the same line arrives, still no newline: still dropped, not counted again, bounded.
    const more = Buffer.alloc(500, 0x78);
    const second = splitTurns(more, first.consumedBytes, first.carry, CLOSE);
    expect(second.ignoredLines).toBe(0);
    expect(second.carry.length).toBe(MAX_LINE_BYTES + 1);
    // The line ends; the next prompt and reply parse normally with correct offsets and no cantRead.
    const tail = Buffer.from("xx\n" + userLine("u2", "again") + assistantLine("a2", "yes"));
    const third = splitTurns(tail, first.consumedBytes + second.consumedBytes, second.carry, CLOSE);
    expect(third.cantRead).toBe(false);
    expect(third.ignoredLines).toBe(0);
    expect(third.turns.map((t) => t.turnUuid)).toEqual(["a2"]);
    const fileBytes = Buffer.concat([Buffer.from(head), junk, more, tail]);
    const t = third.turns[0];
    expect(fileBytes.subarray(t?.byteStart, t?.byteEnd).toString("utf8")).toBe(
      userLine("u2", "again") + assistantLine("a2", "yes"),
    );
  });
});

describe("extractTldr", () => {
  it("finds the **TL;DR:** block and otherwise takes 280 chars", () => {
    // Colon inside the bold, to the end of the paragraph, whitespace collapsed; later paragraphs excluded.
    expect(extractTldr("Body.\n\n**TL;DR:** It   worked.\nNext:  run it.\n\n```\ncmd\n```")).toBe(
      "It worked. Next: run it.",
    );
    // No colon (the real replies use both forms), and case-insensitive.
    expect(extractTldr("Body.\n\n**TL;DR**\nWhat happened: done.\nNext steps: none.\n\nmore")).toBe(
      "What happened: done. Next steps: none.",
    );
    expect(extractTldr("x\n\n**tl;dr:** quiet")).toBe("quiet");
    // Colon outside the bold.
    expect(extractTldr("Body.\n\n**TL;DR**: Colon after.\nSecond line.\n\nmore")).toBe("Colon after. Second line.");
    // Real fixtures, both forms.
    const basic = splitTurns(fixture("transcript-basic.jsonl"), 0, undefined, CLOSE).turns[1];
    expect(extractTldr(basic?.replyText ?? "")).toMatch(/^What happened: the same end-of-turn reminder; nothing to close\./);
    expect(extractTldr(basic?.replyText ?? "")).not.toContain("```");
    const colon = splitTurns(fixture("transcript-empty-thinking.jsonl"), 0, undefined, CLOSE).turns[0];
    expect(extractTldr(colon?.replyText ?? "")).toMatch(/^The project's safety hook/);
    // No marker: first 280 chars, collapsed.
    const long = "word ".repeat(200);
    const fallback = extractTldr(long);
    expect(fallback.length).toBe(280);
    expect(fallback.startsWith("word word")).toBe(true);
    expect(extractTldr("short\n\n  reply")).toBe("short reply");
    // A marker with nothing after it falls back to the first 280 chars.
    expect(extractTldr("Intro text.\n\n**TL;DR:**")).toBe("Intro text. **TL;DR:**");
  });

  it("fallbackChars: Infinity returns the whole collapsed text uncut; the default still cuts at 280", () => {
    const long = "word\n ".repeat(200);
    const whole = "word ".repeat(200).trim();
    expect(extractTldr(long, { fallbackChars: Number.POSITIVE_INFINITY })).toBe(whole);
    expect(extractTldr(long, { fallbackChars: Infinity }).length).toBe(999);
    expect(extractTldr(long)).toBe(whole.slice(0, 280));
    expect(extractTldr(long, {})).toBe(whole.slice(0, 280));
    // with a marker the option changes nothing
    expect(extractTldr("x\n\n**TL;DR:** done", { fallbackChars: Infinity })).toBe("done");
  });
});

// Final review I1: the marker regex had two `\s*` around an optional `:`, so `**TL;DR` followed by whitespace
// and no closing `**` was quadratic (60k spaces stalled a poller tick 2.9 s; 1 MiB ~15 min). Each rung is 4x
// the last, so a quadratic regression fails on an early rung within seconds instead of hanging the suite on
// the 1 MiB one; the last rung is the 1 MiB budget itself.
describe("TL;DR marker cost (final review I1)", () => {
  const RUNGS = [16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024];
  const BUDGET_MS = 500;
  const SHAPES: ReadonlyArray<readonly [string, (n: number) => string]> = [
    ["spaces", (n) => "**TL;DR" + " ".repeat(n) + "x"],
    ["newlines", (n) => "**TL;DR" + "\n".repeat(n) + "x"],
    ["spaces around a colon", (n) => "**TL;DR" + " ".repeat(n / 2) + ":" + " ".repeat(n / 2) + "x"],
  ];
  const timed = <T>(fn: () => T): { readonly ms: number; readonly out: T } => {
    const t0 = performance.now();
    const out = fn();
    return { ms: performance.now() - t0, out };
  };

  it("extractTldr reads a 1 MiB hostile reply in under 500 ms", () => {
    for (const [label, make] of SHAPES) {
      for (const n of RUNGS) {
        const { ms, out } = timed(() => extractTldr(make(n), { fallbackChars: Number.POSITIVE_INFINITY }));
        expect(ms, `${label}, ${n} chars`).toBeLessThan(BUDGET_MS);
        expect(out.startsWith("**TL;DR")).toBe(true); // no closing ** → no marker → the collapsed fallback
      }
    }
  });

  it("buildCardFaces (the poller's path: mask, extract, flatten, mask, clip) carries a 1 MiB hostile reply in under 500 ms", () => {
    const ctx = { machine: "Mac-Mini", projectKey: "pantheon", sessionId: "0f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b" };
    for (const [label, make] of SHAPES) {
      for (const n of RUNGS) {
        const turn = {
          turnUuid: "a-1", startedAt: "2026-10-17T00:00:00.000Z", endedAt: "2026-10-17T00:00:01.000Z", byteStart: 0, byteEnd: 10,
          promptText: "deploy it", promptSource: "human" as const, replyText: "done.\n\n" + make(n), toolCallCount: 0, thinkingChars: 0,
        };
        const { ms, out } = timed(() => buildCardFaces([turn], ctx, maskSecrets));
        expect(ms, `${label}, ${n} chars`).toBeLessThan(BUDGET_MS);
        expect(out[0]?.tldrMasked.startsWith("done. **TL;DR")).toBe(true);
      }
    }
  });

  it("the linear marker still reads every real form", () => {
    expect(extractTldr("x\n\n**TL;DR:** colon inside")).toBe("colon inside");
    expect(extractTldr("x\n\n**TL;DR** no colon")).toBe("no colon");
    expect(extractTldr("x\n\n**TL;DR**: colon after")).toBe("colon after");
    expect(extractTldr("x\n\n** TL;DR : ** spaced")).toBe("spaced");
    expect(extractTldr("x\n\n**TL;DR: **trailing space inside")).toBe("trailing space inside");
    expect(extractTldr("x\n\n**TL;DR:**: doubled colon")).toBe("doubled colon");
    expect(extractTldr("x **TL;DR** first\n\ny **TL;DR:** last")).toBe("last");
  });
});
