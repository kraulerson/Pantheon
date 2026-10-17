import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SshConnectionError } from "../src/devmachine/connection.js";
import { type SshTarget } from "../src/devmachine/provisioning.js";
import { type RemoteCommandResult, type RemoteExec } from "../src/devmachine/tmux.js";
import { expandCard } from "../src/console/expand.js";
import { maskSecrets } from "../src/console/masking.js";
import { buildExpandCommand } from "../src/console/probe-command.js";
import { SqliteConsoleStore, type ConsoleCardRow } from "../src/console/store.js";
import { MAX_LINE_BYTES, splitTurns, type Turn } from "../src/console/transcript.js";

const FIXTURE = join(__dirname, "fixtures", "console", "transcript-basic.jsonl");
const SID = "6e09d39d-0000-4000-8000-000000000001";
const TARGET: SshTarget = { logicalName: "Mac-Mini", host: "192.168.1.192", port: 22, user: "karl" };
const S = "PANTHEON_PROBE:";

// Token-shaped values are built at runtime so the secret scanner does not flag the test source.
const GH_TOKEN = `ghp_${"Z9".repeat(18)}`;
const ANT_TOKEN = `sk-ant-${"q7".repeat(16)}`;

type Json = Record<string, unknown>;

const fixtureLines = (): Json[] =>
  readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Json);

const toFile = (lines: readonly Json[]): Buffer => Buffer.from(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");

const blocks = (line: Json): Json[] => {
  const content = (line["message"] as { content: unknown }).content;
  return Array.isArray(content) ? (content as Json[]) : [];
};

/** Every complete turn of a whole file (the last one closed explicitly: it has no terminator). */
const turnsOf = (file: Buffer): readonly Turn[] => splitTurns(file, 0, undefined, { closeOpenTurn: true }).turns;

/** File offset of the start of each line (the offset after the last newline is included). */
const lineStarts = (file: Buffer): number[] => {
  const out = [0];
  for (let i = file.indexOf(0x0a); i !== -1; i = file.indexOf(0x0a, i + 1)) out.push(i + 1);
  return out;
};

const cardFor = (turn: Turn, over: Partial<ConsoleCardRow> = {}): ConsoleCardRow =>
  Object.freeze({
    id: "c".repeat(32),
    turnUuid: turn.turnUuid,
    sessionId: SID,
    machine: "Mac-Mini",
    projectKey: "pantheon-harness",
    createdAt: turn.endedAt,
    kind: "reply" as const,
    title: "A1",
    tldrMasked: "TL;DR",
    byteStart: turn.byteStart,
    byteEnd: turn.byteEnd,
    toolCallCount: turn.toolCallCount,
    thinkingChars: turn.thinkingChars,
    needsYou: false,
    needsKind: null,
    dismissedAt: null,
    purgeAfter: "2026-11-16T00:00:00.000Z",
    version: 1,
    updatedAt: turn.endedAt,
    ...over,
  });

interface FakeMachine {
  readonly found?: boolean;
  readonly truncated?: boolean;
  readonly ended?: boolean;
  readonly code?: number;
}

/** A fake machine holding `file`: answers the expand command with the exact bytes of the asked range. */
function machine(file: Buffer, over: FakeMachine = {}): RemoteExec & { readonly calls: unknown[][] } {
  const calls: unknown[][] = [];
  const exec = (target: SshTarget, handle: string, command: string): Promise<RemoteCommandResult> => {
    calls.push([target, handle, command]);
    const m = /tail -c \+(\d+) \| head -c (\d+)/.exec(command);
    if (!m) return Promise.reject(new Error("fake machine: not an expand command"));
    const start = Number(m[1]) - 1;
    const end = start + Number(m[2]);
    const found = over.found ?? true;
    // The script sets truncated iff the file is now shorter than the range end: model a file that shrank by one byte.
    const size = !found ? 0 : over.truncated === true ? end - 1 : file.length;
    const payload = found ? file.subarray(start, Math.min(end, size)).toString("base64") : "";
    const record = `${S}slice:${SID}:${start}:${size}:${over.truncated === true ? 1 : 0}:${found ? 1 : 0}:${payload}`;
    const stdout = `Last login: banner\n${record}\n${over.ended === false ? "" : `${S}end\n`}`;
    return Promise.resolve({ code: over.code ?? 0, stdout, stderr: over.code !== undefined ? "karl@192.168.1.192: boom" : "" });
  };
  return Object.assign(exec, { calls });
}

/** The fixture with a non-empty thinking block (Claude Code usually stores none) and planted secrets. */
function plantedFile(): Buffer {
  const lines = fixtureLines();
  const first = turnsOf(toFile(lines))[0]!;
  for (const line of lines) {
    for (const b of blocks(line)) {
      if (b["type"] === "thinking") b["thinking"] = `Considering the commit; the key is ${ANT_TOKEN} — do not print it.`;
      if (b["type"] === "tool_result" && typeof b["content"] === "string") b["content"] = `${b["content"]}\nGITHUB_TOKEN=${GH_TOKEN}`;
      if (b["type"] === "tool_use" && b["name"] === "Bash") {
        const input = b["input"] as Json;
        input["command"] = `curl -u bot ${GH_TOKEN} && ${String(input["command"])}`;
      }
      if (b["type"] === "text" && line["uuid"] === first.turnUuid) b["text"] = `${String(b["text"])}\nPaste ${ANT_TOKEN} nowhere.`;
    }
  }
  return toFile(lines);
}

describe("expandCard (R1 on-demand expand)", () => {
  it("returns full text, why (reasoning + non-empty thinking) and the tool calls of exactly that turn", async () => {
    const lines = fixtureLines();
    for (const line of lines) {
      for (const b of blocks(line)) if (b["type"] === "thinking" && String(line["uuid"]).startsWith("605825ad")) b["thinking"] = "First check the tree, then commit.";
    }
    const file = toFile(lines);
    const [first, second] = turnsOf(file);
    expect(first!.turnUuid.startsWith("792879cd")).toBe(true);
    const exec = machine(file);
    const r = await expandCard(cardFor(first!), TARGET, "harness", exec, maskSecrets);
    expect(exec.calls).toEqual([[TARGET, "harness", buildExpandCommand(SID, first!.byteStart, first!.byteEnd)]]);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    // Every assistant text block of the turn (both text lines), joined by a blank line — nothing of turn 2.
    expect(r.view.fullText.startsWith("Committed as `9f640cd`")).toBe(true);
    expect(r.view.fullText).toContain("\n\nAdvisory repeat, not applicable");
    expect(r.view.fullText).not.toContain(second!.replyText.slice(0, 40));
    expect(r.view.why).toBe("First check the tree, then commit.");
    expect(r.view.whatItDid.map((w) => w.tool)).toEqual(["Bash", "Bash", "Bash"]);
    expect(r.view.whatItDid[0]).toEqual({
      tool: "Bash",
      inputSummary: "git status --short",
      outputSummary: "AM .claude/approvals.jsonl\n M .claude/tool-usage.json\n?? docs/handoffs/2026-10-16-uat5-closed-bugs48-console-go.md\n?? services/control-plane/.claude/",
    });
    expect(r.view.whatItDid[2]!.inputSummary.startsWith("git log -1 --oneline; git status -sb;")).toBe(true);
    expect(r.view.agentRuns).toBe(0);
  });

  it("an empty thinking block (the usual case) gives an empty why", async () => {
    const file = readFileSync(FIXTURE);
    const second = turnsOf(file)[1]!;
    const r = await expandCard(cardFor(second), TARGET, "harness", machine(file), maskSecrets);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.view.why).toBe("");
    expect(r.view.whatItDid).toHaveLength(1);
    expect(r.view.fullText).toContain("**TL;DR**");
  });

  it("a turn whose uuid no longer matches is reported as changed", async () => {
    const file = readFileSync(FIXTURE);
    const first = turnsOf(file)[0]!;
    const r = await expandCard(cardFor(first, { turnUuid: "00000000-dead-beef-0000-000000000000" }), TARGET, "harness", machine(file), maskSecrets);
    expect(r.state).toBe("changed");
    if (r.state === "changed") expect(r.message).toContain("Mac-Mini");
  });

  it("a range that now covers two turns, or none, is reported as changed", async () => {
    const file = readFileSync(FIXTURE);
    const [first, second] = turnsOf(file);
    const both = await expandCard(cardFor(second!, { byteStart: first!.byteStart }), TARGET, "harness", machine(file), maskSecrets);
    expect(both.state).toBe("changed");
    // Only the prompt line and the first tool_use line: no assistant text, so no turn.
    const none = await expandCard(cardFor(first!, { byteEnd: lineStarts(file)[2]! }), TARGET, "harness", machine(file), maskSecrets);
    expect(none.state).toBe("changed");
  });

  it("a range that gained a trailing line, or lost its prompt line, is reported as changed (same uuid, wrong span)", async () => {
    const file = readFileSync(FIXTURE);
    const first = turnsOf(file)[0]!;
    const starts = lineStarts(file);
    const next = starts.indexOf(first.byteEnd);
    expect(next).toBeGreaterThan(0);
    // The turn plus the next turn's prompt line: the split still yields one turn with the card's uuid.
    const trailing = await expandCard(cardFor(first, { byteEnd: starts[next + 1]! }), TARGET, "harness", machine(file), maskSecrets);
    expect(trailing.state).toBe("changed");
    // From the turn's second line: the prompt is gone, the tool_result line becomes the trigger, same uuid.
    const headless = await expandCard(cardFor(first, { byteStart: starts[1]! }), TARGET, "harness", machine(file), maskSecrets);
    expect(headless.state).toBe("changed");
    if (headless.state === "changed") expect(headless.message).toContain("Mac-Mini");
  });

  it("range starting at the turn's third line (a tool_result) → changed", async () => {
    const file = readFileSync(FIXTURE);
    const first = turnsOf(file)[0]!;
    const starts = lineStarts(file);
    // The splitter accepts a tool_result as a "tool"-sourced trigger, so span and uuid both match here;
    // only the row's own counts show that tool calls are missing.
    const third = splitTurns(file.subarray(starts[2]!, first.byteEnd), starts[2]!, undefined, { closeOpenTurn: true }).turns;
    expect(third.map((t) => [t.turnUuid, t.byteStart, t.byteEnd])).toEqual([[first.turnUuid, starts[2], first.byteEnd]]);
    const r = await expandCard(cardFor(first, { byteStart: starts[2]! }), TARGET, "harness", machine(file), maskSecrets);
    expect(r.state).toBe("changed");
  });

  it("a transcript that is gone or shrank (slice not found / truncated) is reported as changed", async () => {
    const file = readFileSync(FIXTURE);
    const first = turnsOf(file)[0]!;
    for (const over of [{ found: false }, { truncated: true }]) {
      const r = await expandCard(cardFor(first), TARGET, "harness", machine(file, over), maskSecrets);
      expect(r.state).toBe("changed");
      if (r.state === "changed") expect(r.message).toContain("Mac-Mini");
    }
  });

  it("a cut report or a non-zero exit is failed with first-party text only", async () => {
    const file = readFileSync(FIXTURE);
    const first = turnsOf(file)[0]!;
    for (const over of [{ ended: false }, { code: 2 }]) {
      const r = await expandCard(cardFor(first), TARGET, "harness", machine(file, over), maskSecrets);
      expect(r.state).toBe("failed");
      if (r.state !== "failed") continue;
      expect(r.message).toContain("Mac-Mini");
      expect(r.message).not.toMatch(/karl@|192\.168|boom/);
    }
  });

  it("a planted secret in the fixture is masked in fullText, why and whatItDid", async () => {
    const file = plantedFile();
    const first = turnsOf(file)[0]!;
    const r = await expandCard(cardFor(first), TARGET, "harness", machine(file), maskSecrets);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    const all = JSON.stringify(r.view);
    expect(all).not.toContain(GH_TOKEN);
    expect(all).not.toContain(ANT_TOKEN);
    expect(r.view.fullText).toContain("Paste [masked] nowhere.");
    expect(r.view.why).toContain("the key is [masked]");
    expect(r.view.whatItDid[0]!.inputSummary).toBe("curl -u bot [masked] && git status --short");
    // A secret in a tool_result is masked in outputSummary.
    expect(r.view.whatItDid[0]!.outputSummary.endsWith("GITHUB_TOKEN=[masked]")).toBe(true);
  });

  it("masks before clipping: a token straddling the 2 KiB cut leaks no prefix", async () => {
    const lines = fixtureLines();
    for (const line of lines) for (const b of blocks(line)) if (b["type"] === "tool_result") b["content"] = `${"x".repeat(2040)} ${GH_TOKEN}`;
    const file = toFile(lines);
    const first = turnsOf(file)[0]!;
    const r = await expandCard(cardFor(first), TARGET, "harness", machine(file), maskSecrets);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    const out = r.view.whatItDid[0]!.outputSummary;
    expect(out.length).toBe(2048);
    expect(out).not.toContain("ghp_");
    expect(out.endsWith(" [masked")).toBe(true); // 2041 chars + 7 of "[masked]"
  });

  it("counts Agent/Task runs and summarises Edit/Write by path and Agent/Task by description", async () => {
    const at = (n: number): string => `2026-10-17T10:00:0${n}.000Z`;
    const uuid = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;
    const file = toFile([
      { type: "user", uuid: uuid(1), timestamp: at(1), message: { role: "user", content: "spawn helpers" } },
      {
        type: "assistant",
        uuid: uuid(2),
        timestamp: at(2),
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu_a", name: "Agent", input: { description: "Explore the console", prompt: "long prompt" } },
            { type: "tool_use", id: "tu_t", name: "Task", input: { prompt: "p".repeat(300) } },
            { type: "tool_use", id: "tu_e", name: "Edit", input: { file_path: "/Users/karl/a.ts", old_string: "a", new_string: "b" } },
            { type: "tool_use", id: "tu_w", name: "Write", input: { file_path: "/Users/karl/b.ts", content: "x" } },
            { type: "tool_use", id: "tu_g", name: "Grep", input: { pattern: "foo" } },
          ],
        },
      },
      {
        type: "user",
        uuid: uuid(3),
        timestamp: at(3),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_a", content: [{ type: "text", text: "agent says hi" }] }] },
      },
      { type: "assistant", uuid: uuid(4), timestamp: at(4), message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
    ]);
    const turn = turnsOf(file)[0]!;
    const r = await expandCard(cardFor(turn), TARGET, "harness", machine(file), maskSecrets);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.view.agentRuns).toBe(2);
    expect(r.view.fullText).toBe("Done.");
    expect(r.view.whatItDid).toEqual([
      { tool: "Agent", inputSummary: "Explore the console", outputSummary: "agent says hi" },
      { tool: "Task", inputSummary: "p".repeat(120), outputSummary: "" },
      { tool: "Edit", inputSummary: "/Users/karl/a.ts", outputSummary: "" },
      { tool: "Write", inputSummary: "/Users/karl/b.ts", outputSummary: "" },
      { tool: "Grep", inputSummary: '{"pattern":"foo"}', outputSummary: "" },
    ]);
  });

  it("masks tool names and JSON input keys too", async () => {
    const at = (n: number): string => `2026-10-17T10:00:0${n}.000Z`;
    const uuid = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;
    const file = toFile([
      { type: "user", uuid: uuid(1), timestamp: at(1), message: { role: "user", content: "go" } },
      {
        type: "assistant",
        uuid: uuid(2),
        timestamp: at(2),
        message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: `mcp__${GH_TOKEN}`, input: { [ANT_TOKEN]: "v" } }] },
      },
      { type: "assistant", uuid: uuid(3), timestamp: at(3), message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ]);
    const turn = turnsOf(file)[0]!;
    const r = await expandCard(cardFor(turn), TARGET, "harness", machine(file), maskSecrets);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.view.whatItDid).toEqual([{ tool: "mcp__[masked]", inputSummary: '{"[masked]":"v"}', outputSummary: "" }]);
  });

  it("clips fullText and why at 16 KiB", async () => {
    const at = (n: number): string => `2026-10-17T10:00:0${n}.000Z`;
    const uuid = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;
    const file = toFile([
      { type: "user", uuid: uuid(1), timestamp: at(1), message: { role: "user", content: "go" } },
      {
        type: "assistant",
        uuid: uuid(2),
        timestamp: at(2),
        message: { role: "assistant", content: [{ type: "thinking", thinking: "w".repeat(20_000) }, { type: "text", text: "t".repeat(20_000) }] },
      },
    ]);
    const turn = turnsOf(file)[0]!;
    const r = await expandCard(cardFor(turn), TARGET, "harness", machine(file), maskSecrets);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.view.fullText).toBe("t".repeat(16 * 1024));
    expect(r.view.why).toBe("w".repeat(16 * 1024));
  });

  it("an oversize line inside the turn is skipped, as splitTurns skips it", async () => {
    const at = (n: number): string => `2026-10-17T10:00:0${n}.000Z`;
    const uuid = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`;
    const file = toFile([
      { type: "user", uuid: uuid(1), timestamp: at(1), message: { role: "user", content: "go" } },
      {
        type: "assistant",
        uuid: uuid(2),
        timestamp: at(2),
        message: { role: "assistant", content: [{ type: "tool_use", id: "tu_big", name: "Write", input: { file_path: "/big", content: "b".repeat(MAX_LINE_BYTES) } }] },
      },
      {
        type: "assistant",
        uuid: uuid(3),
        timestamp: at(3),
        message: { role: "assistant", content: [{ type: "tool_use", id: "tu_s", name: "Bash", input: { command: "ls" } }] },
      },
      { type: "assistant", uuid: uuid(4), timestamp: at(4), message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
    ]);
    const turn = turnsOf(file)[0]!;
    expect(turn.toolCallCount).toBe(1);
    const r = await expandCard(cardFor(turn), TARGET, "harness", machine(file), maskSecrets);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.view.whatItDid).toEqual([{ tool: "Bash", inputSummary: "ls", outputSummary: "" }]);
  });

  it("an unreachable machine is a labeled state with the logicalName only", async () => {
    const file = readFileSync(FIXTURE);
    const first = turnsOf(file)[0]!;
    for (const err of [new SshConnectionError("SSH connection to Mac-Mini (karl@192.168.1.192) failed"), new Error("ECONNREFUSED 192.168.1.192:22")]) {
      const exec = vi.fn((): Promise<RemoteCommandResult> => Promise.reject(err));
      const r = await expandCard(cardFor(first), TARGET, "harness", exec, maskSecrets);
      expect(r.state).toBe("unreachable");
      if (r.state !== "unreachable") continue;
      expect(r.message).toContain("Mac-Mini");
      expect(r.message).not.toMatch(/karl@|192\.168|ECONNREFUSED/);
    }
  });

  it("a card whose range the command builder refuses is failed and nothing is dialled", async () => {
    const file = readFileSync(FIXTURE);
    const first = turnsOf(file)[0]!;
    const exec = vi.fn(machine(file));
    const r = await expandCard(cardFor(first, { sessionId: "not-a-uuid" }), TARGET, "harness", exec, maskSecrets);
    expect(r.state).toBe("failed");
    expect(exec).not.toHaveBeenCalled();
  });

  it("nothing is written to the store", async () => {
    const store = new SqliteConsoleStore();
    const writes = (["upsertSession", "markEnded", "upsertCard", "clearNeedsYou", "setCardNeeds", "purgeExpired"] as const).map((m) =>
      vi.spyOn(SqliteConsoleStore.prototype, m),
    );
    try {
      const file = plantedFile();
      const first = turnsOf(file)[0]!;
      const r = await expandCard(cardFor(first), TARGET, "harness", machine(file), maskSecrets);
      expect(r.state).toBe("ok");
      for (const w of writes) expect(w).not.toHaveBeenCalled();
      expect(store.listCards({})).toHaveLength(0);
      // The module cannot reach a store at all: at most a type-only import, no database or filesystem.
      const source = readFileSync(join(__dirname, "..", "src", "console", "expand.ts"), "utf8");
      expect(source).not.toMatch(/^import (?!type )[^\n]*store\.js/m);
      expect(source).not.toMatch(/better-sqlite3|node:fs/);
    } finally {
      for (const w of writes) w.mockRestore();
      store.close();
    }
  });
});
