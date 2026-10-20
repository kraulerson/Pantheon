/**
 * tmux-aware launcher — M1 task 1 (docs/handoffs/2026-08-20-M1-build-plan.md §M1.1), pure logic.
 *
 * Live session listing over the key-only SSH path: the list/attach commands are built ONLY from
 * allow-listed session names (never interpolated raw — TM-020 remote-command surface), `tmux` is
 * resolved through an absolute-path PATH prefix (Homebrew on macOS is not on a non-login shell's
 * PATH), and every failure is a LABELED result (CC1 text, CC2 fail closed) — never a throw toward
 * the page.
 *
 * Audit remediation (2026-08-25): records carry a sentinel so shell-profile chatter on stdout
 * (`~/.zshenv` banners, direnv) is ignored + counted instead of wiping the list; names are never
 * trimmed before validation; name length and session count are capped; the "no server running"
 * check is per-line anchored; remote stderr travels in a SEPARATE `remoteDetail` field (labelled
 * as machine-supplied by the page), never inside first-party `message` text; unreachable messages
 * carry no user@host; and `createTmuxLister` coalesces + caches + caps concurrent dials.
 */

import { describe, it, expect, vi } from "vitest";
import { SshConnectionError } from "../src/devmachine/connection.js";
import {
  TMUX_LIST_SENTINEL,
  TMUX_SESSION_NAME_MAX,
  TmuxError,
  assertRemoteDir,
  assertTmuxSessionName,
  buildTmuxAttachCommand,
  buildTmuxListCommand,
  classifyTmuxListResult,
  createTmuxLister,
  isSafeTmuxSessionName,
  listTmuxSessions,
  parseTmuxListOutput,
  remoteDirProblem,
  type TmuxListResult
} from "../src/devmachine/tmux.js";

const TARGET = { logicalName: "mac-mini", host: "192.168.1.192", port: 22, user: "karl" } as const;
const S = TMUX_LIST_SENTINEL;
const rec = (w: number, a: number, c: number, name: string): string => `${S}${w}:${a}:${c}:${name}`;

describe("tmux session names (allow-list, injection safety)", () => {
  it.each(["Alden", "cdf", "ios-app", "lancache", "new-solo", "pantheon", "solo", "a_b", "0", "x".repeat(64)])(
    "accepts the operator's real session names and the allow-list edge (%s)",
    (name) => {
      expect(isSafeTmuxSessionName(name)).toBe(true);
      expect(assertTmuxSessionName(name)).toBe(name);
    }
  );

  it.each([
    "",
    "a b",
    "a;id",
    "$(id)",
    "`id`",
    "a|b",
    "a&b",
    "a:b",
    "a.b",
    "-flag",
    "../x",
    "x".repeat(65),
    "ü",
    "a\nb",
    "a'b",
    'a"b',
    "a\\b",
    "pantheon "
  ])("rejects %j (shell metacharacters, tmux separators, leading dash, over-length, non-ASCII, padding)", (name) => {
    expect(isSafeTmuxSessionName(name)).toBe(false);
    expect(() => assertTmuxSessionName(name)).toThrow(TmuxError);
  });

  it("rejects non-strings", () => {
    expect(isSafeTmuxSessionName(undefined)).toBe(false);
    expect(isSafeTmuxSessionName(42)).toBe(false);
    expect(isSafeTmuxSessionName(null)).toBe(false);
    expect(isSafeTmuxSessionName(["a", "b"])).toBe(false);
    expect(() => assertTmuxSessionName(undefined)).toThrow(TmuxError);
  });

  it("TMUX_SESSION_NAME_MAX is the allow-list's length cap (the machine-shell prefix budget derives from it)", () => {
    expect(TMUX_SESSION_NAME_MAX).toBe(64);
    expect(isSafeTmuxSessionName("x".repeat(TMUX_SESSION_NAME_MAX))).toBe(true);
    expect(isSafeTmuxSessionName("x".repeat(TMUX_SESSION_NAME_MAX + 1))).toBe(false);
  });
});

describe("command builders", () => {
  it("list command resolves tmux via an absolute-path PATH prefix (Homebrew) and prints sentinel-prefixed, numbers-first, name-last records", () => {
    const cmd = buildTmuxListCommand();
    expect(cmd).toContain("/opt/homebrew/bin");
    expect(cmd).toContain("/usr/local/bin");
    expect(cmd).toContain("tmux list-sessions");
    expect(cmd).toContain(`${S}#{session_windows}:#{session_attached}:#{session_created}:#{session_name}`);
  });

  it("attach command targets the EXACT session (= prefix), SINGLE-QUOTED so zsh's =cmd expansion cannot eat it", () => {
    // Live finding 2026-08-25: zsh (the Mac's login shell) expands an unquoted `=0` to "the path of a
    // command named 0" → "zsh:1: 0 not found". The allow-list contains no quote characters, so a
    // single-quoted target is literal under sh, bash and zsh alike.
    const cmd = buildTmuxAttachCommand("pantheon");
    expect(cmd).toContain("/opt/homebrew/bin");
    expect(cmd).toMatch(/tmux attach-session -t '=pantheon'$/);
    expect(cmd).not.toContain("new-session");
    expect(buildTmuxAttachCommand("0")).toMatch(/-t '=0'$/);
  });

  it("create option uses the ruled attach-or-create line (name single-quoted for the same reason)", () => {
    expect(buildTmuxAttachCommand("solo", { create: true })).toMatch(/tmux new-session -A -s 'solo'$/);
  });

  it("refuses to build an attach command from an unsafe name (fail closed — nothing is interpolated)", () => {
    for (const bad of ["a;id", "$(id)", "a b", "`id`", "a'b", "", "-x"]) {
      expect(() => buildTmuxAttachCommand(bad)).toThrow(TmuxError);
      expect(() => buildTmuxAttachCommand(bad, { create: true })).toThrow(TmuxError);
    }
  });

  it("create + cwd mints the machine-shell line: attach-or-create in that directory, name and directory single-quoted (F2 Task 7)", () => {
    const cmd = buildTmuxAttachCommand("sh-Mac-Mini", { create: true, cwd: "/Users/karl/Documents/Claude Projects" });
    expect(cmd).toContain("/opt/homebrew/bin");
    expect(cmd.endsWith("tmux new-session -A -s 'sh-Mac-Mini' -c '/Users/karl/Documents/Claude Projects'")).toBe(true);
    // Without cwd the create line is unchanged.
    expect(buildTmuxAttachCommand("sh-Mac-Mini", { create: true })).not.toContain(" -c ");
  });

  it("a cwd failing the directory allow-list never reaches a command (fail closed), and cwd without create is refused", () => {
    for (const cwd of ["relative/dir", "/a/'b", "/a/../b", "/a/\nb", ""]) {
      expect(() => buildTmuxAttachCommand("sh-Mac-Mini", { create: true, cwd })).toThrow(TmuxError);
    }
    expect(() => buildTmuxAttachCommand("sh-Mac-Mini", { cwd: "/Users/karl" })).toThrow(TmuxError);
  });
});

describe("remote directories (F2 Task 7: the allow-list for a tmux working directory)", () => {
  const ROOT = "/Users/karl/Documents/Claude Projects";

  it.each([ROOT, "/", "/a/..b", "/a/b..", "/a/./b", "/a b/c d", `/${"x".repeat(511)}`, `/${"é".repeat(255)}`, "/a/😀b", "/a/ b", "/a/‍b"])(
    "accepts an absolute path unchanged (spaces kept, '..' inside a segment allowed, up to 512 UTF-8 bytes; an astral character, NBSP and a ZWJ are not controls): %j",
    (dir) => {
      expect(assertRemoteDir(dir)).toBe(dir);
    }
  );

  it.each([
    ["relative", "Users/karl/Projects"],
    ["empty", ""],
    ["a single quote", "/Users/karl/it's"],
    ["NUL", "/a/\0b"],
    ["a newline", "/a/\nb"],
    ["0x1f", "/a/\x1fb"],
    ["DEL (0x7f)", "/a/\x7fb"],
    ["a '..' segment in the middle", "/a/../b"],
    ["a trailing '..' segment", "/a/.."],
    ["a bare '..'", "/.."],
    ["513 bytes", `/${"x".repeat(512)}`],
    ["513 bytes of multibyte characters", `/${"é".repeat(256)}`],
    // Ruling T11-5 (IV-1): tmux expands formats in `new-session -c`, so a '#' anywhere in the path is refused.
    ["a tmux format '#S' in a parent segment", "/Users/karl/C#Sharp/notes2"],
    ["'##' in a parent segment", "/Users/karl/a##b/notes2"],
    ["'#{' in a parent segment", "/Users/karl/a#{session_name}/notes2"],
    ["'#(' in a parent segment", "/Users/karl/a#(id)/notes2"],
    // Ruling T11-5 (IV-6): C1 controls, lone surrogates (scanned by code point) and bidi controls.
    ["a C1 control (U+0085)", "/a/\u0085b"],
    ["a C1 control (U+009B)", "/a/\u009bb"],
    ["a lone high surrogate", "/a/\ud800b"],
    ["a lone low surrogate", "/a/\udc00b"],
    ["a high surrogate at the end", "/a/b\ud83d"],
    ["a bidi embedding (U+202A)", "/a/\u202ab"],
    ["a bidi override (U+202E)", "/a/\u202eb"],
    ["a bidi isolate (U+2066)", "/a/\u2066b"],
    ["a bidi isolate end (U+2069)", "/a/\u2069b"]
  ])("refuses %s with a TmuxError that names the rule, never the value", (_label, dir) => {
    expect(() => assertRemoteDir(dir)).toThrow(TmuxError);
    let message = "";
    try {
      assertRemoteDir(dir);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/absolute|quote|control|'\.\.'|bytes|string|'#'|surrogate|bidirectional/);
    if (dir !== "") expect(message).not.toContain(dir);
  });

  it("names each new rule (T11-5): '#', C1 as a control character, a lone surrogate, a bidi control", () => {
    expect(remoteDirProblem("/a/C#Sharp/b")).toBe("must not contain '#'");
    expect(remoteDirProblem("/a/\u0085b")).toBe("must not contain control characters");
    expect(remoteDirProblem("/a/\ud800b")).toBe("must be well-formed Unicode (no lone surrogate)");
    expect(remoteDirProblem("/a/\u202eb")).toBe("must not contain bidirectional control characters");
    // A well-formed surrogate pair is one astral code point, not two lone halves.
    expect(remoteDirProblem("/a/😀")).toBeUndefined();
  });

  it("refuses non-strings", () => {
    for (const bad of [undefined, null, 42, ["/a"], { path: "/a" }]) expect(() => assertRemoteDir(bad)).toThrow(TmuxError);
  });
});

describe("parseTmuxListOutput", () => {
  it("parses one sentinel record per line as windows:attached:created:name", () => {
    const out = parseTmuxListOutput(`${rec(2, 1, 1724500000, "pantheon")}\n${rec(1, 0, 1724400000, "Alden")}\n`);
    expect(out).toEqual({
      sessions: [
        { name: "pantheon", windows: 2, attached: true, createdAt: new Date(1724500000 * 1000).toISOString(), attachable: true },
        { name: "Alden", windows: 1, attached: false, createdAt: new Date(1724400000 * 1000).toISOString(), attachable: true }
      ],
      ignoredLines: 0,
      truncated: false
    });
  });

  it("returns an empty list for empty / whitespace output (blank lines are not 'ignored lines')", () => {
    expect(parseTmuxListOutput("")).toEqual({ sessions: [], ignoredLines: 0, truncated: false });
    expect(parseTmuxListOutput("\n  \n")).toEqual({ sessions: [], ignoredLines: 0, truncated: false });
  });

  it("IGNORES + COUNTS foreign stdout lines (shell-profile banners, direnv chatter) instead of wiping the list", () => {
    const out = parseTmuxListOutput(`Welcome to the Mac mini\n${rec(1, 0, 1724400000, "solo")}\ndirenv: loading ~/.envrc\n`);
    expect(out.sessions.map((s) => s.name)).toEqual(["solo"]);
    expect(out.ignoredLines).toBe(2);
  });

  it("a malformed sentinel record is counted as ignored; the other records survive", () => {
    const out = parseTmuxListOutput(`${S}x:y:z:name\n${rec(1, 0, 1724400000, "solo")}\n${S}\n`);
    expect(out.sessions.map((s) => s.name)).toEqual(["solo"]);
    expect(out.ignoredLines).toBe(2);
  });

  it("tolerates CRLF line endings", () => {
    expect(parseTmuxListOutput(`${rec(1, 0, 1724400000, "solo")}\r\n`).sessions[0]?.name).toBe("solo");
  });

  it("treats the name as the LAST field so separators inside it cannot shift the numeric fields", () => {
    const out = parseTmuxListOutput(`${rec(3, 2, 1724400000, "odd:name")}\n`);
    expect(out.sessions[0]).toMatchObject({ name: "odd:name", windows: 3, attached: true, attachable: false });
  });

  it("does NOT trim the name before validation — padded names are listed verbatim and are not attachable", () => {
    const nbsp = parseTmuxListOutput(`${rec(1, 0, 1724400000, "pantheon ")}\n`).sessions[0];
    expect(nbsp).toMatchObject({ name: "pantheon ", attachable: false });
    const space = parseTmuxListOutput(`${rec(1, 0, 1724400000, " solo")}\n`).sessions[0];
    expect(space).toMatchObject({ name: " solo", attachable: false });
  });

  it("lists a session whose name fails the allow-list but marks it NOT attachable", () => {
    const out = parseTmuxListOutput(`${rec(1, 0, 1724400000, "weird name;x")}\n`);
    expect(out.sessions[0]?.name).toBe("weird name;x");
    expect(out.sessions[0]?.attachable).toBe(false);
  });

  it("caps a name at 64 characters for display (with an ellipsis) and never marks it attachable", () => {
    const out = parseTmuxListOutput(`${rec(1, 0, 1724400000, "x".repeat(500))}\n`);
    expect(out.sessions[0]?.name).toBe(`${"x".repeat(64)}…`);
    expect(out.sessions[0]?.attachable).toBe(false);
  });

  it("caps the session count at 100 and flags truncation", () => {
    const lines = Array.from({ length: 150 }, (_, i) => rec(1, 0, 1724400000, `s${i}`)).join("\n");
    const out = parseTmuxListOutput(lines);
    expect(out.sessions).toHaveLength(100);
    expect(out.truncated).toBe(true);
  });

  it("an out-of-range epoch (13+ digits) is a malformed record — ignored + counted, never a RangeError", () => {
    const out = parseTmuxListOutput(`${S}1:0:99999999999999999999:solo\n`);
    expect(out.sessions).toEqual([]);
    expect(out.ignoredLines).toBe(1);
  });
});

describe("classifyTmuxListResult", () => {
  it("exit 0 → ok with the parsed sessions plus the ignored-line count and truncation flag", () => {
    const r = classifyTmuxListResult({ code: 0, stdout: `banner\n${rec(1, 0, 1724400000, "solo")}\n`, stderr: "" });
    expect(r).toEqual({ state: "ok", sessions: [expect.objectContaining({ name: "solo" })], ignoredLines: 1, truncated: false });
  });

  it("'no server running' (tmux present, nothing running) → ok with ZERO sessions, not an error", () => {
    for (const stderr of [
      "no server running on /private/tmp/tmux-501/default\n",
      "tmux: no server running on /private/tmp/tmux-501/default\n",
      "error connecting to /tmp/tmux-501/default (No such file or directory)\n"
    ]) {
      expect(classifyTmuxListResult({ code: 1, stdout: "", stderr })).toEqual({ state: "ok", sessions: [], ignoredLines: 0, truncated: false });
    }
  });

  it("the 'no server' check is anchored per line — a real failure that merely CONTAINS the phrase is still a failure", () => {
    const r = classifyTmuxListResult({ code: 2, stdout: "", stderr: "fatal: something else, no server running here\n" });
    expect(r.state).toBe("failed");
  });

  it("exit 127 → labeled tmux_missing", () => {
    const r = classifyTmuxListResult({ code: 127, stdout: "", stderr: "zsh:1: command not found: tmux\n" });
    expect(r.state).toBe("tmux_missing");
    expect(r.state === "tmux_missing" && r.message).toMatch(/tmux/i);
  });

  it("any other failure → labeled failed: first-party message only; remote stderr in a SEPARATE sanitized remoteDetail", () => {
    const r = classifyTmuxListResult({ code: 2, stdout: "", stderr: "\u001b[31mboom\u001b[0m first line\nsecond line\n" });
    expect(r.state).toBe("failed");
    if (r.state !== "failed") throw new Error("unreachable");
    expect(r.message).toBe("tmux list-sessions failed (exit 2)");
    expect(r.remoteDetail).toContain("boom");
    expect(r.remoteDetail).toContain("first line");
    expect(r.remoteDetail).not.toContain("second line");
    expect(r.remoteDetail).not.toContain("\u001b");
    const long = classifyTmuxListResult({ code: 2, stdout: "", stderr: "x".repeat(1000) });
    expect(long.state === "failed" && long.remoteDetail && long.remoteDetail.length).toBeLessThanOrEqual(140);
  });

  it("a failure with empty stderr carries no remoteDetail at all", () => {
    const r = classifyTmuxListResult({ code: 3, stdout: "", stderr: "  \n" });
    expect(r).toEqual({ state: "failed", message: "tmux list-sessions failed (exit 3)" });
  });

  it("an entirely unparseable listing with exit 0 is ok-with-zero-sessions plus the ignored count (never a throw)", () => {
    const r = classifyTmuxListResult({ code: 0, stdout: "garbage\nmore garbage\n", stderr: "" });
    expect(r).toEqual({ state: "ok", sessions: [], ignoredLines: 2, truncated: false });
  });
});

describe("listTmuxSessions", () => {
  it("runs the list command over the injected remote exec and returns the sessions", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: `${rec(1, 0, 1724400000, "solo")}\n`, stderr: "" }));
    const r = await listTmuxSessions(TARGET, "harness", exec);
    expect(exec).toHaveBeenCalledWith(TARGET, "harness", buildTmuxListCommand());
    expect(r).toEqual({ state: "ok", sessions: [expect.objectContaining({ name: "solo", attachable: true })], ignoredLines: 0, truncated: false });
  });

  it("an unreachable machine → labeled 'unreachable' naming the machine but NOT user@host — never a throw", async () => {
    const exec = vi.fn(async () => {
      throw new SshConnectionError("SSH connection to mac-mini (karl@192.168.1.192) failed");
    });
    const r = await listTmuxSessions(TARGET, "harness", exec);
    expect(r.state).toBe("unreachable");
    if (r.state !== "unreachable") throw new Error("unreachable");
    expect(r.message).toMatch(/mac-mini/);
    expect(r.message).toMatch(/SSH connection failed/);
    expect(r.message).not.toContain("karl@");
    expect(r.message).not.toContain("192.168");
  });

  it("a timeout is reported as such (first-party wording)", async () => {
    const exec = vi.fn(async () => {
      throw new SshConnectionError("remote command on mac-mini timed out after 10000 ms");
    });
    const r = await listTmuxSessions(TARGET, "harness", exec);
    expect(r.state === "unreachable" && r.message).toMatch(/timed out/);
  });

  it("never echoes key material or raw exception text into the labeled result", async () => {
    const exec = vi.fn(async () => {
      throw new Error("-----BEGIN OPENSSH PRIVATE KEY----- SECRET-DO-NOT-LEAK");
    });
    const r = await listTmuxSessions(TARGET, "harness", exec);
    expect(JSON.stringify(r)).not.toContain("SECRET-DO-NOT-LEAK");
    expect(JSON.stringify(r)).not.toContain("PRIVATE KEY");
    expect(r.state).toBe("unreachable");
  });
});

describe("createTmuxLister (coalesce + cache + concurrency cap — the SSH-dial amplifier fix)", () => {
  type Deferred = { promise: Promise<TmuxListResult>; resolve: (r: TmuxListResult) => void };
  function deferred(): Deferred {
    let resolve!: (r: TmuxListResult) => void;
    const promise = new Promise<TmuxListResult>((res) => (resolve = res));
    return { promise, resolve };
  }
  const OK: TmuxListResult = { state: "ok", sessions: [], ignoredLines: 0, truncated: false };
  const other = { logicalName: "linux-box", host: "192.168.1.202", port: 22, user: "karl" } as const;

  it("coalesces concurrent calls for the same machine into ONE dial", async () => {
    const d = deferred();
    const list = vi.fn(() => d.promise);
    const lister = createTmuxLister(list, { ttlMs: 3000, maxConcurrent: 4, now: () => 1000 });
    const a = lister.list(TARGET, "harness");
    const b = lister.list(TARGET, "harness");
    expect(list).toHaveBeenCalledTimes(1);
    d.resolve(OK);
    expect(await a).toEqual(OK);
    expect(await b).toEqual(OK);
  });

  it("serves a cached result within the TTL and re-dials after it", async () => {
    let t = 1000;
    const list = vi.fn(async () => OK);
    const lister = createTmuxLister(list, { ttlMs: 3000, maxConcurrent: 4, now: () => t });
    await lister.list(TARGET, "harness");
    t = 2000;
    await lister.list(TARGET, "harness");
    expect(list).toHaveBeenCalledTimes(1);
    t = 4001;
    await lister.list(TARGET, "harness");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("caches labeled failures too (an unreachable machine is not re-dialed every click)", async () => {
    const list = vi.fn(async (): Promise<TmuxListResult> => ({ state: "unreachable", message: "mac-mini unreachable — SSH connection failed" }));
    const lister = createTmuxLister(list, { ttlMs: 3000, maxConcurrent: 4, now: () => 1000 });
    await lister.list(TARGET, "harness");
    const r = await lister.list(TARGET, "harness");
    expect(r.state).toBe("unreachable");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps machines separate", async () => {
    const list = vi.fn(async () => OK);
    const lister = createTmuxLister(list, { ttlMs: 3000, maxConcurrent: 4, now: () => 1000 });
    await lister.list(TARGET, "harness");
    await lister.list(other, "harness");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("caps concurrent dials: beyond the cap it answers a labeled 'failed' immediately WITHOUT dialing", async () => {
    const d1 = deferred();
    const d2 = deferred();
    const queue = [d1, d2];
    const list = vi.fn(() => (queue.shift() as Deferred).promise);
    const third = { logicalName: "third", host: "192.168.1.203", port: 22, user: "karl" } as const;
    const lister = createTmuxLister(list, { ttlMs: 3000, maxConcurrent: 2, now: () => 1000 });
    const a = lister.list(TARGET, "harness");
    const b = lister.list(other, "harness");
    const c = await lister.list(third, "harness");
    expect(list).toHaveBeenCalledTimes(2);
    expect(c.state).toBe("failed");
    expect(c.state === "failed" && c.message).toMatch(/too many/i);
    d1.resolve(OK);
    d2.resolve(OK);
    await a;
    await b;
    // capacity freed → a new dial proceeds
    queue.push(deferred());
    void lister.list(third, "harness");
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("a lister that throws is converted into a labeled 'failed' result (never rejects)", async () => {
    const list = vi.fn(async (): Promise<TmuxListResult> => {
      throw new Error("SECRET-DO-NOT-LEAK");
    });
    const lister = createTmuxLister(list, { ttlMs: 3000, maxConcurrent: 4, now: () => 1000 });
    const r = await lister.list(TARGET, "harness");
    expect(r.state).toBe("failed");
    expect(JSON.stringify(r)).not.toContain("SECRET-DO-NOT-LEAK");
  });
});
