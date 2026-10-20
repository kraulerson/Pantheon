/**
 * Maestro Console probe — the two read-only remote commands (plan Task 3, TM-020 remote-command
 * surface). Every value that reaches the command text passes its allow-list first and is
 * single-quoted; the F1 read-only invariant (no `send-keys`, `paste-buffer`, `load-buffer`, `kill-`)
 * is asserted over the generated text itself; `*.key` files are never named.
 */

import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { buildTmuxListCommand } from "../src/devmachine/tmux.js";
import { parseProbeOutput } from "../src/console/probe.js";
import {
  PANE_ID_RE,
  PROBE_MAX_OUTPUT_BYTES,
  PROBE_SENTINEL,
  ProbeError,
  SESSION_ID_RE,
  buildExpandCommand,
  buildPaneTailCommand,
  buildProbeCommand,
  type ProbePlan
} from "../src/console/probe-command.js";

const SID = "0f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const SID2 = "11111111-2222-4333-8444-555555555555";
const PLAN: ProbePlan = {
  slices: [
    { sessionId: SID, offset: 0 },
    { sessionId: SID2, offset: 4096 }
  ],
  panes: ["%5", "%12"],
  maxBytesPerSlice: 1048576,
  tailLines: 40
};
const uuidAt = (i: number): string => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

describe("buildProbeCommand", () => {
  it("the probe command starts with the PATH prefix and names only allow-listed values", () => {
    const cmd = buildProbeCommand(PLAN);
    // The SAME prefix tmux.ts mints with (it is not exported, so compare against the list command).
    const tmuxPrefix = buildTmuxListCommand().split(" tmux ")[0];
    expect(tmuxPrefix).toBe('PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"');
    expect(cmd.startsWith(`${tmuxPrefix} `)).toBe(true);

    expect(cmd).toContain("tmux list-panes -a");
    expect(cmd).toContain("/.claude/sessions/*.json");
    expect(cmd).toContain(`'${SID}'`);
    expect(cmd).toContain(`'${SID2}'`);
    expect(cmd).toContain("'4096'");
    expect(cmd).toContain("'%5'");
    expect(cmd).toContain("'%12'");
    expect(cmd).toContain("head -c 1048576");
    expect(cmd).toContain("capture-pane -p -J -S -40");
    expect(cmd).toContain("kill -0");
    expect(cmd).toContain(`${PROBE_SENTINEL}end`);
    // The brief's field allow-list, verbatim: only these keys ever cross the wire.
    expect(cmd).toContain(
      String.raw`grep -o '"\(pid\|sessionId\|cwd\|name\|status\|waitingFor\|tmux\|procStart\|version\|kind\)" *: *\("[^"]*"\|[0-9.][0-9.]*\)'`
    );

    // Every UUID-shaped and every %-digit token in the text came from the plan — nothing else.
    const uuids = cmd.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
    expect(new Set(uuids)).toEqual(new Set([SID, SID2]));
    const panes = cmd.match(/%\d+/g) ?? [];
    expect(new Set(panes)).toEqual(new Set(["%5", "%12"]));
    // Interpolated values are single-quoted inside a quoted heredoc fed to /bin/sh: the login shell
    // (zsh on macOS) expands nothing, and a POSIX sh runs the script.
    expect(cmd).toContain("/bin/sh <<'PANTHEON_PROBE_SCRIPT'");
    expect(cmd.trimEnd().endsWith("\nPANTHEON_PROBE_SCRIPT")).toBe(true);
    expect(PROBE_MAX_OUTPUT_BYTES).toBe(2 * 1024 * 1024);
  });

  it("a sessionId that is not a UUID is refused before any command exists", () => {
    const refused = (sessionId: string): void => {
      let err: unknown;
      try {
        buildProbeCommand({ slices: [{ sessionId, offset: 0 }], panes: [], maxBytesPerSlice: 1048576, tailLines: 40 });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProbeError);
      // The refusal names the rule, never the offending value.
      if (sessionId !== "") expect((err as Error).message).not.toContain(sessionId);
    };
    refused("x; rm -rf /");
    refused("");
    refused(SID.toUpperCase());
    refused(`${SID}'`);
    refused(`${SID}\n`);
    refused(" " + SID);
    refused("0f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5");
    expect(SESSION_ID_RE.test(SID)).toBe(true);
  });

  it("a pane id outside %digits is refused", () => {
    for (const pane of ["%5; id", "5", "%", "%1234567", "@5", "%5 ", "%-1", "%5'", ""]) {
      expect(() => buildProbeCommand({ ...PLAN, panes: [pane] })).toThrow(ProbeError);
      expect(PANE_ID_RE.test(pane)).toBe(false);
    }
    expect(PANE_ID_RE.test("%123456")).toBe(true);
  });

  it("an offset above 10^12 or negative is refused", () => {
    const withOffset = (offset: number): ProbePlan => ({ ...PLAN, slices: [{ sessionId: SID, offset }] });
    expect(() => buildProbeCommand(withOffset(1e12 + 1))).toThrow(ProbeError);
    expect(() => buildProbeCommand(withOffset(-1))).toThrow(ProbeError);
    expect(() => buildProbeCommand(withOffset(1.5))).toThrow(ProbeError);
    expect(() => buildProbeCommand(withOffset(Number.NaN))).toThrow(ProbeError);
    expect(() => buildProbeCommand(withOffset(Number.POSITIVE_INFINITY))).toThrow(ProbeError);
    expect(buildProbeCommand(withOffset(1e12))).toContain("'1000000000000'");
    expect(buildProbeCommand(withOffset(0))).toContain("'0'");
  });

  it("more than 64 slices is refused", () => {
    const slices = (n: number): ProbePlan["slices"] => Array.from({ length: n }, (_, i) => ({ sessionId: uuidAt(i), offset: 0 }));
    expect(() => buildProbeCommand({ ...PLAN, slices: slices(65) })).toThrow(ProbeError);
    expect(buildProbeCommand({ ...PLAN, slices: slices(64) })).toContain(`'${uuidAt(63)}'`);
    // and the pane cap, 256
    const panes = (n: number): string[] => Array.from({ length: n }, (_, i) => `%${i}`);
    expect(() => buildProbeCommand({ ...PLAN, panes: panes(257) })).toThrow(ProbeError);
    expect(buildProbeCommand({ ...PLAN, panes: panes(256) })).toContain("'%255'");
  });

  it("maxBytesPerSlice and tailLines are bounded positive integers", () => {
    expect(() => buildProbeCommand({ ...PLAN, maxBytesPerSlice: 0 })).toThrow(ProbeError);
    expect(() => buildProbeCommand({ ...PLAN, maxBytesPerSlice: PROBE_MAX_OUTPUT_BYTES + 1 })).toThrow(ProbeError);
    expect(() => buildProbeCommand({ ...PLAN, maxBytesPerSlice: 10.5 })).toThrow(ProbeError);
    expect(() => buildProbeCommand({ ...PLAN, tailLines: 0 })).toThrow(ProbeError);
    expect(() => buildProbeCommand({ ...PLAN, tailLines: 1001 })).toThrow(ProbeError);
    expect(buildProbeCommand({ ...PLAN, tailLines: 1000, maxBytesPerSlice: PROBE_MAX_OUTPUT_BYTES })).toContain("-S -1000");
  });

  it("an empty plan (no slices, no panes) still builds — a machine with nothing yet is probed for panes and session files", () => {
    const cmd = buildProbeCommand({ slices: [], panes: [], maxBytesPerSlice: 1048576, tailLines: 40 });
    expect(cmd).toContain("tmux list-panes -a");
    expect(cmd).toContain("/.claude/sessions/*.json");
    expect(cmd).toContain(`${PROBE_SENTINEL}end`);
  });
});

describe("read-only invariant and expand", () => {
  it("the command never contains send-keys, paste-buffer, load-buffer or kill-", () => {
    const text = `${buildProbeCommand(PLAN)}\n${buildExpandCommand(SID, 10, 100)}\n${buildPaneTailCommand("%5", 60)}`;
    // Plain `kill` is pinned too; only the liveness form `kill -0 ` (signal 0 sends nothing) is allowed.
    expect(text).not.toMatch(/send-keys|paste-buffer|load-buffer|kill-|\bkill\b(?! -0 )/);
    expect(text).toMatch(/kill -0 "\$pid"/);
    // tmux is only ever asked to list, display or capture.
    const tmuxVerbs = [...text.matchAll(/\btmux (\S+)/g)].map((m) => m[1]);
    expect(tmuxVerbs.length).toBeGreaterThan(0);
    for (const verb of tmuxVerbs) expect(["list-panes", "display-message", "capture-pane"]).toContain(verb);
    // The only output redirections are to /dev/null or between the two standard streams: no file is written.
    for (const m of text.matchAll(/>>?\s*([^\s;)]+)/g)) expect(["/dev/null", "&1", "&2"]).toContain(m[1]);
    expect(text).not.toMatch(/\b(rm|mv|cp|tee|touch|chmod|mkdir|truncate)\b/);
  });

  it("the expand command reads exactly the byte range", () => {
    const cmd = buildExpandCommand(SID, 10, 100);
    expect(cmd).toContain("tail -c +11 | head -c 90");
    expect(cmd).toContain(`'${SID}.jsonl'`);
    expect(cmd.startsWith('PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH" ')).toBe(true);
    expect(cmd).toContain(`${PROBE_SENTINEL}end`);
    expect(buildExpandCommand(SID, 0, 1)).toContain("tail -c +1 | head -c 1");
    // Range and id allow-lists.
    expect(() => buildExpandCommand("x; id", 10, 100)).toThrow(ProbeError);
    expect(() => buildExpandCommand(SID, 100, 100)).toThrow(ProbeError);
    expect(() => buildExpandCommand(SID, 100, 10)).toThrow(ProbeError);
    expect(() => buildExpandCommand(SID, -1, 10)).toThrow(ProbeError);
    expect(() => buildExpandCommand(SID, 0, 1e12 + 1)).toThrow(ProbeError);
    expect(() => buildExpandCommand(SID, 0.5, 10)).toThrow(ProbeError);
  });

  it("the session-file basename is allow-listed on the machine and the pane command is captured before encoding", () => {
    const cmd = buildProbeCommand(PLAN);
    // The basename is the one unencoded free-text record field: a filename with a newline or ':' must
    // never be able to forge a record, so the machine skips anything outside [A-Za-z0-9._-].
    expect(cmd).toContain("b=$(basename \"$f\")\n  case $b in *[!A-Za-z0-9._-]*) continue ;; esac");
    expect(cmd).toContain("printf 'PANTHEON_PROBE:session:%s:%s:%s\\n' \"$b\"");
    // `display-message -p` appends a newline: command substitution strips it before the base64.
    expect(cmd).toContain("c=$(tmux display-message -p -t \"$p\" '#{pane_current_command}' 2>/dev/null)");
    expect(cmd).toContain("\"$(printf '%s' \"$c\" | b64)\"");
    expect(cmd).not.toMatch(/display-message[^\n]*\| b64/);
  });

  it("key files are never named", () => {
    const text = `${buildProbeCommand(PLAN)}\n${buildExpandCommand(SID, 10, 100)}\n${buildPaneTailCommand("%5", 60)}`;
    expect(text).not.toContain("*.key");
    expect(text).not.toMatch(/\.key\b/);
    expect(text).not.toContain("bridgeSessionId");
    expect(text).not.toContain("messagingSocketPath");
    expect(text).toContain("/.claude/sessions/*.json");
  });
});

// F2 Task 12 (spec §6.4): the commit approval's second step reads the session's screen — the probe's own `tail_of`
// function and record format over ONE allow-listed pane id, then `end`.
describe("buildPaneTailCommand (Task 12)", () => {
  const PREFIX_LINE = `PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH" /bin/sh <<'PANTHEON_PROBE_SCRIPT'`;
  /** The script body between the heredoc's opening line and its closing tag (the minted text ends in a newline). */
  const bodyOf = (cmd: string): string => {
    const lines = cmd.split("\n");
    expect(lines[0]).toBe(PREFIX_LINE);
    expect(lines.slice(-2)).toEqual(["PANTHEON_PROBE_SCRIPT", ""]);
    return lines.slice(1, -2).join("\n");
  };

  it("Task 12: the pane-tail command carries the pane id single-quoted only, reuses the probe's tail_of, and ends with end", () => {
    const cmd = buildPaneTailCommand("%4242", 60);
    expect(cmd.startsWith(`${PREFIX_LINE}\n`)).toBe(true);
    // The probe's own function (`capture-pane -S -<lines>`: the visible pane plus <lines> lines of history), one call.
    expect(cmd).toContain(String.raw`tail_of() {
  printf 'PANTHEON_PROBE:tail:%s:' "$1"
  tmux capture-pane -p -J -S -60 -t "$1" 2>/dev/null | b64
  printf '\n'
}`);
    expect(cmd).toContain("b64() { base64 | tr -d '\\n'; }");
    expect(cmd).toContain("command -v base64 >/dev/null 2>&1 || { echo \"probe: base64 not found\" >&2; exit 126; }");
    expect(cmd).toContain("\ntail_of '%4242'\n");
    expect(cmd).toContain(`printf '${PROBE_SENTINEL}end\\n'`);
    // The pane id is the only %-digit token, and every occurrence is single-quoted.
    expect(cmd.match(/%\d+/g)).toEqual(["%4242"]);
    expect(cmd.split("'%4242'").length - 1).toBe(1);
    // Nothing else of the probe: no pane listing, no session files, no transcript slices.
    expect(cmd).not.toContain("list-panes");
    expect(cmd).not.toContain(".claude");
    expect(cmd).not.toContain("slice");
    // The probe's own parser reads the output: the record by pane id, then the end marker.
    const text = "❯ A1\n  Staged change:\n";
    const report = parseProbeOutput(`Last login: banner\n${PROBE_SENTINEL}tail:%4242:${Buffer.from(text, "utf8").toString("base64")}\n${PROBE_SENTINEL}end\n`);
    expect(report.tails.get("%4242")).toBe(text);
    expect(report.ended).toBe(true);
  });

  it("Task 12: a pane id outside %digits and lines outside 1 … 200 are refused before any command exists, naming the rule only", () => {
    const refused = (paneId: unknown, lines: unknown): ProbeError => {
      let err: unknown;
      try {
        buildPaneTailCommand(paneId as string, lines as number);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProbeError);
      return err as ProbeError;
    };
    for (const pane of ["%5; id", "5", "%", "%1234567", "@5", "%5 ", "%-1", "%5'", "", "%5\n", "'%5'", "%5$(id)"]) {
      const err = refused(pane, 60);
      if (pane.length > 1) expect(err.message).not.toContain(pane);
    }
    refused(5, 60);
    refused(undefined, 60);
    for (const lines of [0, 201, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60", undefined, null]) refused("%5", lines);
    expect(buildPaneTailCommand("%5", 1)).toContain("capture-pane -p -J -S -1 -t");
    expect(buildPaneTailCommand("%5", 200)).toContain("capture-pane -p -J -S -200 -t");
    expect(buildPaneTailCommand("%123456", 60)).toContain("tail_of '%123456'");
  });

  it("Task 12: the pane-tail body passes sh -n (parsed, never run)", () => {
    const body = bodyOf(buildPaneTailCommand("%7", 60));
    const check = spawnSync("/bin/sh", ["-n"], { input: body, encoding: "utf8" });
    expect(check.error).toBeUndefined();
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    // The check has teeth: a body the shell cannot parse fails it.
    expect(spawnSync("/bin/sh", ["-n"], { input: `${body}\nif then fi\n`, encoding: "utf8" }).status).not.toBe(0);
  });
});
