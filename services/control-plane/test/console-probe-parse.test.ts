/**
 * Maestro Console probe report parser and runner (plan Task 3). Everything the machine sends back is
 * `trusted:false`: only sentinel-prefixed records are read, foreign stdout lines are counted, every id
 * is re-validated on the way in, a missing `end` marks the report as cut short, and `runProbe` never
 * throws — every outcome is a labeled state whose first-party text names the logicalName only.
 */

import { describe, it, expect, vi } from "vitest";
import { SshConnectionError } from "../src/devmachine/connection.js";
import { PROBE_SENTINEL, buildProbeCommand, type ProbePlan } from "../src/console/probe-command.js";
import { parseProbeOutput, runProbe, type ProbeResult } from "../src/console/probe.js";

const S = PROBE_SENTINEL;
const SID = "0f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const SID2 = "11111111-2222-4333-8444-555555555555";
const b64 = (x: string | Buffer): string => Buffer.from(x).toString("base64");
const TARGET = { logicalName: "Mac-Mini", host: "192.168.1.192", port: 22, user: "karl" } as const;
const PLAN: ProbePlan = { slices: [{ sessionId: SID, offset: 100 }], panes: ["%5"], maxBytesPerSlice: 1048576, tailLines: 40 };

/** What the remote `grep -o` emits for one session file: one `"key": value` match per line. */
const FIELDS = [
  '"pid": 4242',
  `"sessionId": "${SID}"`,
  '"cwd": "/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness"',
  '"name": "pantheon-harness-42"',
  '"status": "waiting"',
  '"waitingFor": "permission"',
  '"tmux": "pantheon:@3.%5"',
  '"procStart": "2026-10-16T23:00:00Z"',
  '"version": "2.1.0"',
  '"kind": "cli"'
].join("\n");
const SLICE_BYTES = Buffer.from('{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n');
const TAIL = "❯ 1. Yes\n  2. No\n\nEnter to select";
const SENTINEL = '{"schema":2,"question":"Commit?"}';

const FULL = [
  "direnv: loading ~/.envrc",
  "Welcome to Mac-Mini (Darwin 25.6.0)",
  // `display-message -p` appends "\n" to the command; the wire shape carries it and the parser trims it.
  `${S}pane:${b64("pantheon")}:@3:%5:4242:${b64("node\n")}`,
  `${S}session:4242.json:1:${b64(FIELDS)}`,
  `${S}slice:${SID}:100:2000:1:1:${b64(SLICE_BYTES)}`,
  `${S}tail:%5:${b64(TAIL)}`,
  `${S}sentinel:${SID}:${b64(SENTINEL)}`,
  `${S}end`,
  ""
].join("\n");

describe("parseProbeOutput", () => {
  it("reads panes, session files, slices, tails and sentinels from sentinel records, counts foreign lines and sees the end marker", () => {
    const r = parseProbeOutput(FULL);
    expect(r.panes).toEqual([{ session: "pantheon", windowId: "@3", paneId: "%5", panePid: 4242, currentCommand: "node" }]);
    expect(r.sessions).toHaveLength(1);
    const file = r.sessions[0];
    expect(file?.alive).toBe(true);
    expect(file?.status).toBe("waiting");
    expect(file?.pid).toBe(4242);
    expect(file?.sessionId).toBe(SID);
    expect(file?.cwd).toBe("/Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness");
    expect(file?.name).toBe("pantheon-harness-42");
    expect(file?.waitingFor).toBe("permission");
    expect(file?.tmux).toBe("pantheon:@3.%5");
    expect(file?.procStart).toBe("2026-10-16T23:00:00Z");
    expect(file?.version).toBe("2.1.0");
    expect(file?.kind).toBe("cli");
    expect(r.slices).toHaveLength(1);
    const slice = r.slices[0];
    expect(slice?.sessionId).toBe(SID);
    expect(slice?.offset).toBe(100);
    expect(slice?.size).toBe(2000);
    expect(slice?.truncated).toBe(true);
    expect(slice?.found).toBe(true);
    expect(slice?.bytes.equals(SLICE_BYTES)).toBe(true);
    expect(r.tails.get("%5")).toBe(TAIL);
    expect(r.sentinels.get(SID)).toBe(SENTINEL);
    expect(r.ignoredLines).toBe(2);
    expect(r.ended).toBe(true);
  });

  it("a report without the end marker is marked not ended", () => {
    const r = parseProbeOutput(FULL.replace(`${S}end\n`, ""));
    expect(r.ended).toBe(false);
    expect(r.panes).toHaveLength(1);
    expect(parseProbeOutput("").ended).toBe(false);
    expect(parseProbeOutput(`${S}end`).ended).toBe(true);
    // Review Focus 5: a machine with no tmux server and no sessions dir yields an empty, ENDED report.
    expect(parseProbeOutput(`${S}end\n`)).toEqual({
      panes: [],
      sessions: [],
      slices: [],
      tails: new Map(),
      sentinels: new Map(),
      ignoredLines: 0,
      sessionsUnparsed: 0,
      ended: true
    });
  });

  it("a session file whose extracted fields lack pid or sessionId is dropped and counted", () => {
    const noPid = FIELDS.replace('"pid": 4242\n', "");
    const noSid = FIELDS.replace(`"sessionId": "${SID}"\n`, "");
    const badSid = FIELDS.replace(SID, "not-a-uuid");
    const out = [`${S}session:1.json:1:${b64(noPid)}`, `${S}session:2.json:1:${b64(noSid)}`, `${S}session:3.json:1:${b64(badSid)}`, `${S}session:4242.json:0:${b64(FIELDS)}`, `${S}end`].join("\n");
    const r = parseProbeOutput(out);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]?.pid).toBe(4242);
    expect(r.ignoredLines).toBe(3);
    expect(r.ended).toBe(true);
  });

  // Final review I3: a session record that arrives whole but whose fields lack a valid pid or sessionId means the
  // session-file format is not what this parser knows (a Claude Code update renamed a key): counted apart, so the
  // poller can say CAN'T READ instead of reading every session as gone.
  it("session records whose fields lack a valid pid or sessionId are also counted apart in sessionsUnparsed", () => {
    const renamed = FIELDS.replace('"sessionId"', '"session_id"');
    const noPid = FIELDS.replace('"pid": 4242\n', "");
    const out = [
      `${S}session:1.json:1:${b64(renamed)}`,
      `${S}session:2.json:0:${b64(noPid)}`,
      `${S}session:a b.json:1:${b64(FIELDS)}`, // a malformed record, not an unreadable file
      `${S}session:4242.json:1:${b64(FIELDS)}`,
      `${S}end`
    ].join("\n");
    const r = parseProbeOutput(out);
    expect(r.sessions.map((f) => f.pid)).toEqual([4242]);
    expect(r.sessionsUnparsed).toBe(2);
    expect(r.ignoredLines).toBe(3);
    expect(parseProbeOutput(FULL).sessionsUnparsed).toBe(0);
  });

  // Controller ruling (format-change hardening): the machine reads liveness from a bare-number pid only
  // (probe-command.ts greps `"pid" *: *[0-9]…`), so a pid written as a JSON string would come back as a dead session
  // and be ENDED. Such a record, like one whose sessionId is not a lowercase UUID, is a format we do not know.
  it("a pid written as a JSON string, or a sessionId that is not a lowercase UUID, counts in sessionsUnparsed — never a dead session", () => {
    const quotedPid = FIELDS.replace('"pid": 4242', '"pid": "1234"');
    const r = parseProbeOutput(`${S}session:1234.json:0:${b64(quotedPid)}\n${S}end\n`);
    expect(r.sessionsUnparsed).toBe(1);
    expect(r.sessions).toEqual([]);
    const upperSid = FIELDS.replace(SID, SID.toUpperCase());
    const r2 = parseProbeOutput(`${S}session:4242.json:1:${b64(upperSid)}\n${S}end\n`);
    expect(r2.sessionsUnparsed).toBe(1);
    expect(r2.sessions).toEqual([]);
  });

  it("a session record whose basename fails the allow-list is dropped and counted", () => {
    const out = [
      `${S}session:a b.json:1:${b64(FIELDS)}`,
      `${S}session:a$b.json:1:${b64(FIELDS)}`,
      `${S}session:${"x".repeat(129)}:1:${b64(FIELDS)}`,
      `${S}session::1:${b64(FIELDS)}`,
      `${S}session:4242.json:1:${b64(FIELDS)}`,
      `${S}end`
    ].join("\n");
    const r = parseProbeOutput(out);
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]?.pid).toBe(4242);
    expect(r.ignoredLines).toBe(4);
    expect(r.ended).toBe(true);
  });

  it("a pane command's trailing newline is trimmed even when the machine did not strip it", () => {
    const r = parseProbeOutput(`${S}pane:${b64("solo")}:@1:%1:7:${b64("zsh\r\n")}\n${S}pane:${b64("cdf")}:@2:%2:8:${b64("node")}\n${S}end\n`);
    expect(r.panes.map((p) => p.currentCommand)).toEqual(["zsh", "node"]);
  });

  it("an alive flag other than 0/1 is read as not alive", () => {
    for (const flag of ["2", "x", "", "01", "true"]) {
      const r = parseProbeOutput(`${S}session:4242.json:${flag}:${b64(FIELDS)}\n${S}end\n`);
      expect(r.sessions).toHaveLength(1);
      expect(r.sessions[0]?.alive).toBe(false);
    }
    expect(parseProbeOutput(`${S}session:4242.json:0:${b64(FIELDS)}\n${S}end\n`).sessions[0]?.alive).toBe(false);
    expect(parseProbeOutput(`${S}session:4242.json:1:${b64(FIELDS)}\n${S}end\n`).sessions[0]?.alive).toBe(true);
  });

  it("a session file's absent optional fields stay absent, status defaults to empty (shown as UNKNOWN STATUS downstream), numbers become strings", () => {
    const minimal = ['"pid": 7', `"sessionId": "${SID}"`, '"cwd": "/tmp/x"', '"procStart": 1760000000.5'].join("\n");
    const r = parseProbeOutput(`${S}session:7.json:1:${b64(minimal)}\n${S}end\n`);
    expect(r.sessions).toEqual([{ pid: 7, sessionId: SID, cwd: "/tmp/x", status: "", procStart: "1760000000.5", alive: true }]);
    expect(r.ignoredLines).toBe(0);
  });

  it("session field values are JSON-unescaped, the first occurrence wins, and unknown keys are ignored", () => {
    const fields = ['"pid": 7', `"sessionId": "${SID}"`, '"cwd": "/Users/karl/caf\\u00e9"', '"status": "busy"', '"status": "idle"', '"bridgeSessionId": "zzz"'].join("\n");
    const r = parseProbeOutput(`${S}session:7.json:1:${b64(fields)}\n${S}end\n`);
    expect(r.sessions[0]?.cwd).toBe("/Users/karl/café");
    expect(r.sessions[0]?.status).toBe("busy");
    expect(JSON.stringify(r.sessions[0])).not.toContain("zzz");
  });

  it("base64 line wrapping (76 cols, macOS) is tolerated", () => {
    const big = Buffer.alloc(900, 0x41);
    const wrapped = (b64(big).match(/.{1,76}/g) ?? []).join("\n");
    const tailWrapped = (b64("x".repeat(200)).match(/.{1,76}/g) ?? []).join("\n");
    const out = [`${S}slice:${SID}:0:900:0:1:${wrapped}`, `${S}tail:%5:${tailWrapped}`, `${S}end`, ""].join("\n");
    const r = parseProbeOutput(out);
    expect(r.slices[0]?.bytes.equals(big)).toBe(true);
    expect(r.tails.get("%5")).toBe("x".repeat(200));
    expect(r.ignoredLines).toBe(0);
    expect(r.ended).toBe(true);
    // A base64-looking line AFTER `end` is foreign (end has no payload), and CRLF endings are tolerated.
    const r2 = parseProbeOutput(`${S}tail:%5:${b64("hi")}\r\n${S}end\r\nQUJD\r\n`);
    expect(r2.tails.get("%5")).toBe("hi");
    expect(r2.ended).toBe(true);
    expect(r2.ignoredLines).toBe(1);
  });

  it("a slice that is not on the machine is found:false with no bytes and keeps the plan offset", () => {
    const r = parseProbeOutput(`${S}slice:${SID2}:4096:0:0:0:\n${S}end\n`);
    expect(r.slices).toEqual([{ sessionId: SID2, offset: 4096, size: 0, bytes: Buffer.alloc(0), truncated: false, found: false }]);
  });

  // Final review M5: the builder refuses an offset above 10^12, so a parsed slice offset beyond it (or one whose end
  // lies beyond it, since the poller's next offset is offset + consumed bytes) wedged every later probe of the
  // machine ("probe plan refused — invalid offset", nothing dialled). Such a record is dropped and counted.
  it("a slice whose offset, size or end lies beyond the builder's 10^12 bound is dropped and counted", () => {
    const line = b64("x\n");
    const out = [
      `${S}slice:${SID}:9999999999999:10:0:1:${line}`, // 13 digits
      `${S}slice:${SID}:1000000000000:10:0:1:`, // 10^12 itself is 13 digits
      `${S}slice:${SID}:0:9999999999999:0:1:`, // size
      `${S}slice:${SID}:999999999999:999999999999:0:1:${line}`, // within the bound, but its end is not
      `${S}slice:${SID2}:999999999999:999999999999:0:1:`, // the largest record accepted: no bytes past the bound
      `${S}end`
    ].join("\n");
    const r = parseProbeOutput(out);
    expect(r.slices).toEqual([{ sessionId: SID2, offset: 999999999999, size: 999999999999, bytes: Buffer.alloc(0), truncated: false, found: true }]);
    expect(r.ignoredLines).toBe(4);
    expect(r.ended).toBe(true);
  });

  it("records whose ids fail the allow-lists or whose shape is wrong are dropped and counted, never thrown", () => {
    const bad = [
      `${S}pane:${b64("p")}:3:%5:4242:${b64("node")}`, // window id without @
      `${S}pane:${b64("p")}:@3:5:4242:${b64("node")}`, // pane id without %
      `${S}pane:${b64("p")}:@3:%5:pid:${b64("node")}`, // non-numeric pid
      `${S}slice:NOT-A-UUID:0:0:0:0:`,
      `${S}slice:${SID}:0:0:2:1:`, // truncated flag outside 0/1
      `${S}slice:${SID}:0:0:0:1:not base64!`,
      `${S}tail:5:${b64("x")}`,
      `${S}sentinel:${SID.toUpperCase()}:${b64("{}")}`,
      `${S}session:has:colon:1:${b64(FIELDS)}`,
      `${S}session:4242.json:1:${b64(FIELDS)}:extra`,
      `${S}unknown:1:2`,
      `${S}`,
      `${S}end:extra`,
      `${S}end`
    ].join("\n");
    const r = parseProbeOutput(bad);
    expect(r.panes).toEqual([]);
    expect(r.slices).toEqual([]);
    expect(r.sessions).toEqual([]);
    expect(r.tails.size).toBe(0);
    expect(r.sentinels.size).toBe(0);
    expect(r.ignoredLines).toBe(13);
    expect(r.ended).toBe(true);
  });

  it("over-long free-text fields are clipped so a hostile pane or session file cannot flood a card", () => {
    const long = "n".repeat(5000);
    const fields = ['"pid": 7', `"sessionId": "${SID}"`, `"cwd": "/${long}"`, `"status": "${long}"`].join("\n");
    const r = parseProbeOutput(`${S}pane:${b64(long)}:@1:%1:1:${b64(long)}\n${S}session:7.json:1:${b64(fields)}\n${S}end\n`);
    expect(r.panes[0]?.session.length).toBeLessThanOrEqual(512);
    expect(r.panes[0]?.currentCommand.length).toBeLessThanOrEqual(512);
    // Session fields are clipped at 2048 here (final review M1): the poller masks the whole value, THEN clips it
    // to what it stores, so a token across a shorter cut cannot slip past its pattern.
    expect(r.sessions[0]?.status.length).toBe(2048);
    expect(r.sessions[0]?.cwd.length).toBe(2048);
  });
});

describe("runProbe", () => {
  const ok = { code: 0, stdout: FULL, stderr: "" };

  it("a successful probe is an ok report and the exec received the built command", async () => {
    const exec = vi.fn(async () => ok);
    const r = await runProbe(TARGET, "harness", exec, PLAN);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith(TARGET, "harness", buildProbeCommand(PLAN));
    expect(r.state).toBe("ok");
    if (r.state !== "ok") throw new Error("unreachable");
    expect(r.report.sessions[0]?.status).toBe("waiting");
    expect(r.report.ended).toBe(true);
  });

  it("a thrown SshConnectionError becomes unreachable with the logicalName only", async () => {
    const exec = vi.fn(async () => {
      throw new SshConnectionError("SSH connection to Mac-Mini (karl@192.168.1.192) failed");
    });
    const r = await runProbe(TARGET, "harness", exec, PLAN);
    expect(r.state).toBe("unreachable");
    if (r.state !== "unreachable") throw new Error("unreachable");
    expect(r.message).toContain("Mac-Mini");
    expect(r.message).toMatch(/SSH connection failed/);
    expect(r.message).not.toContain("karl@");
    expect(r.message).not.toContain("192.168");

    const timeout = vi.fn(async () => {
      throw new SshConnectionError("remote command on Mac-Mini timed out after 4000 ms");
    });
    const t = await runProbe(TARGET, "harness", timeout, PLAN);
    expect(t.state === "unreachable" && t.message).toMatch(/timed out/);
  });

  it("a non-SSH exception never leaks its text (no key material, no raw error)", async () => {
    const exec = vi.fn(async () => {
      throw new Error("-----BEGIN OPENSSH PRIVATE KEY----- SECRET-DO-NOT-LEAK karl@192.168.1.192");
    });
    const r = await runProbe(TARGET, "harness", exec, PLAN);
    expect(r.state).toBe("unreachable");
    expect(JSON.stringify(r)).not.toContain("SECRET-DO-NOT-LEAK");
    expect(JSON.stringify(r)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(r)).not.toContain("karl@");
  });

  it("exit 127 becomes failed with a first-party message", async () => {
    const exec = vi.fn(async () => ({ code: 127, stdout: "", stderr: "zsh:1: no such file or directory: /bin/sh" }));
    const r = await runProbe(TARGET, "harness", exec, PLAN);
    expect(r.state).toBe("failed");
    if (r.state !== "failed") throw new Error("unreachable");
    expect(r.message).toContain("Mac-Mini");
    expect(r.message).toContain("127");
    expect(r.message).not.toContain("zsh");
    expect(r.message).not.toContain("karl@");
  });

  it("another non-zero exit is failed with the machine's first stderr line in remoteDetail only (sanitized, capped)", async () => {
    const stderr = `\u001b[31mprobe: base64 not found\u001b[0m\u0007 ${"x".repeat(300)}\nsecond line`;
    const exec = vi.fn(async () => ({ code: 126, stdout: "", stderr }));
    const r = await runProbe(TARGET, "harness", exec, PLAN);
    expect(r.state).toBe("failed");
    if (r.state !== "failed") throw new Error("unreachable");
    expect(r.message).toContain("Mac-Mini");
    expect(r.message).toContain("126");
    expect(r.message).not.toContain("base64 not found");
    expect(r.remoteDetail).toMatch(/^probe: base64 not found/);
    expect(r.remoteDetail).not.toContain("\u001b");
    expect(r.remoteDetail).not.toContain("\u0007");
    expect(r.remoteDetail).not.toContain("second line");
    // The whole first line, capped at 2048 (final review M1): the poller masks it, THEN clips it to 140 for the page.
    expect(r.remoteDetail).toBe(`probe: base64 not found ${"x".repeat(300)}`);
    const long = await runProbe(TARGET, "harness", vi.fn(async () => ({ code: 2, stdout: "", stderr: "y".repeat(5000) })), PLAN);
    expect(long.state === "failed" && long.remoteDetail?.length).toBe(2048);
    // Empty stderr → no remoteDetail key at all (exactOptionalPropertyTypes).
    const quiet = await runProbe(TARGET, "harness", vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })), PLAN);
    expect(quiet).toEqual({ state: "failed", message: expect.stringContaining("Mac-Mini") });
  });

  it("a report without end becomes cant_read", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: FULL.replace(`${S}end\n`, ""), stderr: "" }));
    const r = await runProbe(TARGET, "harness", exec, PLAN);
    expect(r.state).toBe("cant_read");
    if (r.state !== "cant_read") throw new Error("unreachable");
    expect(r.message).toContain("Mac-Mini");
    expect(r.message).not.toContain("karl@");
  });

  it("a plan outside the allow-list is a labeled failed result, never a throw, and nothing is dialled", async () => {
    const exec = vi.fn(async () => ok);
    const r: ProbeResult = await runProbe(TARGET, "harness", exec, { ...PLAN, slices: [{ sessionId: "x; id", offset: 0 }] });
    expect(r.state).toBe("failed");
    expect(r.state === "failed" && r.message).toContain("Mac-Mini");
    expect(JSON.stringify(r)).not.toContain("x; id");
    expect(exec).not.toHaveBeenCalled();
  });
});
