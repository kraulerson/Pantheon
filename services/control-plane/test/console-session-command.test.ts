/**
 * Maestro Console new-session commands (plan Task 8, spec §14.1, TM-020 remote-command surface): the project
 * list of a machine's projects root and the creation of one detached tmux session running `claude`, plus the
 * parsers of their records. Every value passes its allow-list BEFORE any command text exists and is then
 * single-quoted; a refusal names the rule, never the value; the parsers admit first-party text only. Rulings
 * T8-2 (the `has-session` miss is a labelled record, the race guard behind the route's suffixing) and T8-3
 * (`$HOME/.local/bin` on PATH, `command -v claude`, every failure a labelled record — never a bare exit code).
 */

import { describe, expect, it } from "vitest";
import { ProbeError, mintScript } from "../src/console/probe-command.js";
import {
  LIST_PROJECTS_MAX_OUTPUT_BYTES,
  PROJECT_NAME_RE,
  PROJECTS_SENTINEL,
  SESSION_SENTINEL,
  admissiblePath,
  assertProjectName,
  buildCreateSessionCommand,
  buildListProjectsCommand,
  parseCreateSessionOutput,
  parseListProjectsOutput,
  segmentsUnderRoot,
  tmuxNameForFolder,
  type CreateSessionPlan
} from "../src/console/session-command.js";
import { TMUX_SESSION_NAME_RE } from "../src/devmachine/tmux.js";

const ROOT = "/Users/karl/Documents/Claude Projects";
const PATH_PREFIX = 'PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"';
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const record = (path: string): string => `${PROJECTS_SENTINEL}${b64(path)}\n`;
const BASE: CreateSessionPlan = { tmuxName: "My-App-2", cwd: `${ROOT}/My App 2`, mkdir: true };
const plan = (over: Partial<CreateSessionPlan> = {}): CreateSessionPlan => ({ ...BASE, ...over });
/** POSIX sh only: no bashisms (the dev machines run the script through the login shell's /bin/sh). */
const POSIX_ONLY = /\[\[|^\s*(?:local|declare|typeset)\s|\$\{[^}]*(,,|\^\^|\/\/)|(?:^|[\s=(])\$'|<<</m;

/** Every occurrence of `value` in `text` sits inside a single-quoted token. */
function occursOnlySingleQuoted(text: string, value: string): boolean {
  const total = text.split(value).length - 1;
  const quoted = (text.match(new RegExp(`'[^']*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^']*'`, "g")) ?? []).length;
  return total > 0 && total === quoted;
}

/** The thrown error is a ProbeError whose message never carries the offending value. */
function expectRefusal(fn: () => unknown, value: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProbeError);
  // A one-character value may coincide with the rule's own punctuation list; longer values must be absent.
  if (value.length > 1) expect((err as Error).message).not.toContain(value);
}

describe("PROJECT_NAME_RE / assertProjectName", () => {
  it("admits a folder name of 1–64 letters, digits, spaces, '.', '_' or '-' that starts with a letter or digit", () => {
    for (const ok of ["My App 2", "pantheon-harness", "a", "7", "x".repeat(64), "v1.2_beta-3", "Claude Projects", "a.b", "a b  c"]) {
      expect(PROJECT_NAME_RE.test(ok), ok).toBe(true);
      expect(assertProjectName(ok)).toBe(ok);
    }
  });

  it("refuses a slash, a leading dot, a leading '-' / '_' / space, 65 characters, quotes, control characters and non-strings", () => {
    const refused = ["../x", ".hidden", "a/b", "x".repeat(65), "", " lead", "-dash", "_under", "it's", 'say "hi"', "a\nb", "a\tb", "a\x00b", "Café", "a:b", "a;b", "$HOME", "a\\b", "..", "."];
    for (const bad of refused) {
      expect(PROJECT_NAME_RE.test(bad), JSON.stringify(bad)).toBe(false);
      expectRefusal(() => assertProjectName(bad), bad);
    }
    for (const notText of [undefined, null, 42, ["a"], { name: "a" }]) expect(() => assertProjectName(notText)).toThrow(ProbeError);
  });
});

describe("tmuxNameForFolder", () => {
  it("maps the basename: every char outside [A-Za-z0-9_-] → '-', a leading '-' → '_', cut to 64", () => {
    expect(tmuxNameForFolder("Claude Projects")).toBe("Claude-Projects");
    expect(tmuxNameForFolder(`${ROOT}/Claude Projects`)).toBe("Claude-Projects");
    expect(tmuxNameForFolder("my.app v2")).toBe("my-app-v2");
    expect(tmuxNameForFolder("pantheon-harness")).toBe("pantheon-harness");
    expect(tmuxNameForFolder("a_b")).toBe("a_b");
    expect(tmuxNameForFolder("-x")).toBe("_x");
    expect(tmuxNameForFolder(" x")).toBe("_x");
    expect(tmuxNameForFolder("Café")).toBe("Caf-");
    // One '-' per code point, not per UTF-16 unit.
    expect(tmuxNameForFolder("a😀b")).toBe("a-b");
    expect(tmuxNameForFolder("x".repeat(70))).toBe("x".repeat(64));
    expect(tmuxNameForFolder(`${"y".repeat(63)} z`)).toBe(`${"y".repeat(63)}-`);
  });

  it("ruling T8-5: a derived name in the machine-shell namespace (`sh-…`) is prefixed `p-`, then cut to 64", () => {
    expect(tmuxNameForFolder("/root/sh-foo")).toBe("p-sh-foo");
    expect(tmuxNameForFolder("/root/sh")).toBe("sh"); // no dash: not the namespace
    expect(tmuxNameForFolder("/root/sh-")).toBe("p-sh-");
    expect(tmuxNameForFolder("sh foo")).toBe("p-sh-foo"); // the character mapping lands in the namespace too
    expect(tmuxNameForFolder("/root/shell-x")).toBe("shell-x");
    expect(tmuxNameForFolder("/root/SH-foo")).toBe("SH-foo"); // tmux names are case-sensitive; the shells are lowercase `sh-`
    expect(tmuxNameForFolder("/root/p-sh-foo")).toBe("p-sh-foo");
    const long = `sh-${"x".repeat(61)}`;
    expect(long).toHaveLength(64);
    expect(tmuxNameForFolder(`/root/${long}`)).toBe(`p-sh-${"x".repeat(59)}`); // cut AFTER prefixing
    expect(tmuxNameForFolder(`/root/${long}`)).toHaveLength(64);
  });

  it("yields a tmux-safe name outside the shell namespace for every name the project allow-list admits", () => {
    for (const name of ["My App 2", "a", "7", "x".repeat(64), "v1.2_beta-3", "a b  c", "9 lives", "sh-foo", "sh foo", "sh-"]) {
      const tmuxName = tmuxNameForFolder(assertProjectName(name));
      expect(TMUX_SESSION_NAME_RE.test(tmuxName), name).toBe(true);
      expect(tmuxName.startsWith("sh-"), name).toBe(false);
    }
  });
});

describe("admissiblePath / segmentsUnderRoot (ruling T8-7: the one rule for an existing project folder)", () => {
  it("admits a path strictly under the root whose basename is a project name, whatever its parents are called", () => {
    for (const ok of [`${ROOT}/My App 2`, `${ROOT}/Parent & Co/child`, `${ROOT}/a/b/c`, `${ROOT}/x (copy)/v1.2_beta-3`, `${ROOT}/./x`, `${ROOT}//y`, `${ROOT}/${"x".repeat(64)}`]) {
      expect(admissiblePath(ROOT, ok), ok).toBe(true);
    }
    expect(segmentsUnderRoot(ROOT, `${ROOT}/Parent & Co/child`)).toEqual(["Parent & Co", "child"]);
    expect(segmentsUnderRoot(ROOT, `${ROOT}/./x`)).toEqual(["x"]);
    expect(segmentsUnderRoot(`${ROOT}/`, `${ROOT}/x`)).toEqual(["x"]); // a root given with a trailing slash
    expect(segmentsUnderRoot("/", "/x/y")).toEqual(["x", "y"]);
  });

  it("refuses everything not strictly under the root: the root itself, a sibling, an absolute path elsewhere, a .. escape", () => {
    for (const bad of ["/etc/cron.d", ROOT, `${ROOT}/`, `${ROOT}-other/x`, `${ROOT}/x/../../escape`, "relative/x", "", "/"]) {
      expect(segmentsUnderRoot(ROOT, bad), JSON.stringify(bad)).toBeUndefined();
      expect(admissiblePath(ROOT, bad), JSON.stringify(bad)).toBe(false);
    }
    // Triage 70: the root "/" itself is not under "/" either (it used to read as one empty segment).
    for (const root of ["/", "//"]) {
      for (const self of ["/", "//", "/."]) {
        expect(segmentsUnderRoot(root, self), `${root} ${self}`).toBeUndefined();
        expect(admissiblePath(root, self), `${root} ${self}`).toBe(false);
      }
    }
  });

  it("refuses a hidden segment anywhere below the root, a path failing the remote-directory rule, and a basename failing the name rule", () => {
    const refused = [
      `${ROOT}/.hidden/x`,
      `${ROOT}/Parent/.git`,
      `${ROOT}/.x`,
      `${ROOT}/it's/x`, // a parent with a quote: the remote-directory rule
      `${ROOT}/x/it's`,
      `${ROOT}/x/../y`, // a `..` segment is refused even though it resolves inside the root
      `${ROOT}/x\n`,
      `${ROOT}/x/${"y".repeat(65)}`,
      `${ROOT}/x/Café`,
      `${ROOT}/x/-dash`,
      `${ROOT}/${"x".repeat(600)}`
    ];
    for (const bad of refused) expect(admissiblePath(ROOT, bad), JSON.stringify(bad)).toBe(false);
    // A parent segment is not held to PROJECT_NAME_RE; the basename is.
    expect(PROJECT_NAME_RE.test("Parent & Co")).toBe(false);
    expect(admissiblePath(ROOT, `${ROOT}/Parent & Co/child`)).toBe(true);
    expect(admissiblePath(ROOT, `${ROOT}/child/Parent & Co`)).toBe(false);
  });

  it("ruling T11-5: a parent segment carrying a tmux format ('#S', '##', '#{', '#('), a C1 control, a lone surrogate or a bidi control is refused by the remote-directory rule", () => {
    for (const parent of ["C#Sharp", "a##b", "a#{session_name}", "a#(id)", "a\u0085b", "a\ud800b", "a\u202eb", "a\u2066b"]) {
      expect(admissiblePath(ROOT, `${ROOT}/${parent}/notes2`), JSON.stringify(parent)).toBe(false);
    }
  });
});

describe("buildListProjectsCommand", () => {
  it("is the heredoc-minted script: depth-1 directories, depth-2 directories holding .git, hidden names skipped, the root only single-quoted", () => {
    const cmd = buildListProjectsCommand(ROOT);
    const [head = "", ...body] = cmd.split("\n");
    expect(head).toBe(`${PATH_PREFIX} /bin/sh <<'PANTHEON_PROBE_SCRIPT'`);
    expect(cmd.trimEnd().endsWith("\nPANTHEON_PROBE_SCRIPT")).toBe(true);
    expect(body).toContain("export LC_ALL=C");
    expect(cmd).toContain("command -v base64 >/dev/null 2>&1");
    expect(cmd).toContain(`[ -d '${ROOT}' ] || { echo "projects: root is not a directory" >&2; exit 2; }`);
    expect(cmd).toContain(`find '${ROOT}' -mindepth 1 -maxdepth 1 -type d ! -name '.*' -exec sh -c '`);
    expect(cmd).toContain(`find '${ROOT}' -mindepth 2 -maxdepth 2 -type d ! -name '.*' -exec sh -c '`);
    // Each path is emitted base64 behind the sentinel by the per-path shell find hands the paths to (no `read` loop:
    // a newline in a name cannot split a record).
    expect(cmd).toContain(`printf "${PROJECTS_SENTINEL}%s\\n" "$(printf "%s" "$d" | base64 | tr -d "\\n")"`);
    expect(cmd).toContain('if [ -e "$d/.git" ]; then');
    // A depth-2 directory under a hidden parent is skipped by the inner shell (the root travels as its $0).
    expect(cmd).toContain(`case $d in "$0"/.*) continue ;; esac`);
    expect(cmd).toContain(`' '${ROOT}' {} +`);
    expect(occursOnlySingleQuoted(cmd, ROOT)).toBe(true);
    expect(cmd.trimEnd().split("\n").at(-2)).toBe("exit 0");
    expect(LIST_PROJECTS_MAX_OUTPUT_BYTES).toBe(262144);
  });

  it("reads only: no write verbs, no redirection to a file, no tmux, POSIX sh only", () => {
    const cmd = buildListProjectsCommand(ROOT);
    // `.git` is only ever tested for existence; `git` itself is never invoked.
    expect(cmd).not.toMatch(/\b(rm|mv|cp|tee|touch|chmod|mkdir|truncate)\b|\bgit\s/);
    for (const m of cmd.matchAll(/>>?\s*([^\s;)]+)/g)) expect(["/dev/null", "&1", "&2"]).toContain(m[1]);
    expect(cmd).not.toContain("tmux");
    expect(cmd).not.toMatch(POSIX_ONLY);
    expect(cmd).not.toContain("${");
  });

  it("refuses a root outside the remote-directory allow-list before any command exists, naming the rule only", () => {
    for (const bad of ["relative/root", "", `${ROOT}/it's`, `${ROOT}/../x`, "/a/..", `${ROOT}\n`, `${ROOT}\x7f`, `/${"x".repeat(512)}`, `${ROOT}/C#Sharp`, `${ROOT}/a#(id)`, `${ROOT}\u0085`, `${ROOT}\u202e`]) {
      expectRefusal(() => buildListProjectsCommand(bad), bad);
    }
    for (const notText of [undefined, null, 42]) expect(() => buildListProjectsCommand(notText as never)).toThrow(ProbeError);
    expect(buildListProjectsCommand(`/${"x".repeat(511)}`)).toContain(`find '/${"x".repeat(511)}' -mindepth 1`);
    expect(buildListProjectsCommand("/a/..b c")).toContain("find '/a/..b c' -mindepth 1");
  });

  it("the heredoc cannot be terminated by a root", () => {
    expect(() => mintScript("echo start\nPANTHEON_PROBE_SCRIPT\necho end")).toThrow(ProbeError);
    const lines = buildListProjectsCommand(ROOT).trimEnd().split("\n");
    expect(lines.filter((l) => l === "PANTHEON_PROBE_SCRIPT")).toHaveLength(1);
  });
});

describe("parseListProjectsOutput", () => {
  it("decodes every sentinel record into { name: basename, path }, sorted by name, ignoring foreign lines", () => {
    const stdout = `Last login: banner\r\n${record(`${ROOT}/pantheon-harness`)}${record(`${ROOT}/My App 2`)}direnv: loading\n${record(`${ROOT}/Pantheon/pantheon-harness`)}${record(`${ROOT}/Pantheon`)}`;
    expect(parseListProjectsOutput(stdout)).toEqual({
      projects: [
        { name: "My App 2", path: `${ROOT}/My App 2` },
        { name: "Pantheon", path: `${ROOT}/Pantheon` },
        { name: "pantheon-harness", path: `${ROOT}/Pantheon/pantheon-harness` },
        { name: "pantheon-harness", path: `${ROOT}/pantheon-harness` }
      ],
      dropped: 0
    });
    expect(parseListProjectsOutput("")).toEqual({ projects: [], dropped: 0 });
    expect(parseListProjectsOutput("Last login: banner\n")).toEqual({ projects: [], dropped: 0 });
    // CRLF around a record is tolerated.
    expect(parseListProjectsOutput(`${PROJECTS_SENTINEL}${b64(`${ROOT}/a`)}\r\n`)).toEqual({ projects: [{ name: "a", path: `${ROOT}/a` }], dropped: 0 });
  });

  it("drops and counts a record whose name fails the allow-list or whose path fails the remote-directory rule or is not base64", () => {
    const bad = [
      record(`${ROOT}/.hidden`),
      record(`${ROOT}/it's`),
      record(`${ROOT}/${"x".repeat(65)}`),
      record(`${ROOT}/a:b`),
      record(`${ROOT}/..`),
      record(`${ROOT}/../escape`),
      record("relative/name"),
      record(`${ROOT}/ctl\x01`),
      record(`/${"x".repeat(520)}`),
      record(""),
      `${PROJECTS_SENTINEL}not*base64\n`,
      `${PROJECTS_SENTINEL}QQ\n`,
      `${PROJECTS_SENTINEL}\n`
    ];
    const listing = parseListProjectsOutput(`${bad.join("")}${record(`${ROOT}/ok`)}`);
    expect(listing).toEqual({ projects: [{ name: "ok", path: `${ROOT}/ok` }], dropped: bad.length });
    // A dropped record never surfaces its text.
    expect(JSON.stringify(listing)).not.toContain("hidden");
    expect(JSON.stringify(listing)).not.toContain("escape");
  });

  it("ruling T11-5: a path whose parent carries a tmux format ('#S', '##', '#{', '#('), a C1 control or a bidi control is dropped and counted", () => {
    const bad = ["C#Sharp", "a##b", "a#{session_name}", "a#(id)", "a\u0085b", "a\u202eb"].map((parent) => record(`${ROOT}/${parent}/notes2`));
    const listing = parseListProjectsOutput(`${bad.join("")}${record(`${ROOT}/ok`)}`);
    expect(listing).toEqual({ projects: [{ name: "ok", path: `${ROOT}/ok` }], dropped: bad.length });
  });

  it("triage 18 (IV-6): a path that is not well-formed UTF-8 is dropped and counted — never listed with U+FFFD (it could not be started)", () => {
    const raw = (...parts: (string | number[])[]): string =>
      `${PROJECTS_SENTINEL}${Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : Buffer.from(p)))).toString("base64")}\n`;
    const bad = [
      raw(`${ROOT}/a`, [0xff], "b/notes2"), // a stray byte in a parent
      raw(`${ROOT}/a`, [0xed, 0xa0, 0x80], "b/notes2"), // CESU-8: an encoded surrogate
      raw(`${ROOT}/a`, [0xc0, 0xaf], "b/notes2"), // an overlong '/'
      raw(`${ROOT}/notes`, [0xe2, 0x82]), // a truncated sequence at the end
      raw([0xef, 0xbb, 0xbf], `${ROOT}/bom`) // a BOM is kept as data, so the path is no longer absolute
    ];
    // Well-formed multi-byte UTF-8 in a parent still decodes and is listed.
    const listing = parseListProjectsOutput(`${bad.join("")}${record(`${ROOT}/ok`)}${record(`${ROOT}/Café/notes`)}`);
    expect(listing).toEqual({ projects: [{ name: "notes", path: `${ROOT}/Café/notes` }, { name: "ok", path: `${ROOT}/ok` }], dropped: bad.length });
    expect(JSON.stringify(listing)).not.toContain("�");
  });

  it("has no root: containment and hidden parents are admissiblePath's, which the list route applies to every path returned", () => {
    expect(parseListProjectsOutput(record("/etc/cron.d"))).toEqual({ projects: [{ name: "cron.d", path: "/etc/cron.d" }], dropped: 0 });
    expect(parseListProjectsOutput(record(`${ROOT}/.hidden/x`))).toEqual({ projects: [{ name: "x", path: `${ROOT}/.hidden/x` }], dropped: 0 });
    expect(admissiblePath(ROOT, "/etc/cron.d")).toBe(false);
    expect(admissiblePath(ROOT, `${ROOT}/.hidden/x`)).toBe(false);
  });
});

describe("buildCreateSessionCommand", () => {
  it("mkdir plan: has-session guard FIRST (ruling T11-18: 'session already exists' never sits over a folder the script just made), existence check, a plain mkdir (never -p, never git init), detached new-session running claude, the created record", () => {
    const cmd = buildCreateSessionCommand(plan());
    const [head = ""] = cmd.split("\n");
    expect(head).toBe(`${PATH_PREFIX} /bin/sh <<'PANTHEON_PROBE_SCRIPT'`);
    const steps = [
      'PATH="$HOME/.local/bin:$PATH"; export PATH',
      'command -v tmux >/dev/null 2>&1 || { echo "session: tmux not found" >&2; exit 126; }',
      `result() { printf '${SESSION_SENTINEL}%s:%s\\n' "$1" "$2"; exit 0; }`,
      'command -v claude >/dev/null 2>&1 || result failed "claude not found"',
      `tmux has-session -t '=My-App-2' 2>/dev/null && result failed "session already exists"`,
      `[ -e '${ROOT}/My App 2' ] && result failed "folder exists"`,
      `mkdir '${ROOT}/My App 2' || result failed "mkdir failed"`,
      `tmux new-session -d -s 'My-App-2' -c '${ROOT}/My App 2' -e "PATH=$PATH" claude || result failed "tmux new-session failed"`,
      "result created 'My-App-2'"
    ];
    expect(cmd.indexOf("tmux has-session")).toBeLessThan(cmd.indexOf("mkdir '"));
    let at = -1;
    for (const step of steps) {
      const i = cmd.indexOf(step);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
    expect(cmd).not.toContain("mkdir -p");
    expect(cmd).not.toContain("git ");
    expect(cmd).not.toContain("folder missing");
    expect(cmd.trimEnd().endsWith("\nPANTHEON_PROBE_SCRIPT")).toBe(true);
  });

  it("ruling T8-6: the create body sets no locale (a fresh tmux server would inherit it for every later window); the list body still does", () => {
    for (const mkdir of [true, false]) {
      const cmd = buildCreateSessionCommand(plan({ mkdir }));
      expect(cmd).not.toContain("LC_ALL");
      expect(cmd).not.toContain("LANG");
      // The PATH is the only environment the script shapes, and it is handed to the session explicitly.
      expect(cmd.split("\n").filter((l) => /^export |; export /.test(l))).toEqual(['PATH="$HOME/.local/bin:$PATH"; export PATH']);
    }
    expect(buildListProjectsCommand(ROOT)).toContain("\nexport LC_ALL=C\n");
  });

  it("folder plan: no mkdir at all; the folder must already exist", () => {
    const cmd = buildCreateSessionCommand(plan({ mkdir: false, tmuxName: "pantheon-harness", cwd: `${ROOT}/Pantheon/pantheon-harness` }));
    expect(cmd).not.toContain("mkdir");
    expect(cmd).not.toContain("folder exists");
    expect(cmd).toContain(`[ -d '${ROOT}/Pantheon/pantheon-harness' ] || result failed "folder missing"`);
    expect(cmd).toContain(`tmux has-session -t '=pantheon-harness' 2>/dev/null && result failed "session already exists"`);
    expect(cmd).toContain(`tmux new-session -d -s 'pantheon-harness' -c '${ROOT}/Pantheon/pantheon-harness' -e "PATH=$PATH" claude`);
    expect(cmd).toContain("result created 'pantheon-harness'");
  });

  it("the folder and the name occur only single-quoted; a folder with a single quote is refused before any command exists", () => {
    const cmd = buildCreateSessionCommand(plan());
    expect(occursOnlySingleQuoted(cmd, `${ROOT}/My App 2`)).toBe(true);
    expect(occursOnlySingleQuoted(cmd, "My-App-2")).toBe(true);
    // The bare folder name appears nowhere outside the quoted path.
    expect(cmd.split("\n").filter((l) => l.includes("My App 2")).every((l) => l.includes(`'${ROOT}/My App 2'`))).toBe(true);
    const quoted = `${ROOT}/it's`;
    expectRefusal(() => buildCreateSessionCommand(plan({ cwd: quoted })), quoted);
    expectRefusal(() => buildCreateSessionCommand(plan({ cwd: quoted, mkdir: false })), quoted);
  });

  it("refuses every out-of-allow-list value before any command exists, naming the rule only", () => {
    const refused: Partial<CreateSessionPlan>[] = [
      { cwd: "relative/dir" },
      { cwd: "" },
      { cwd: `${ROOT}/../x` },
      { cwd: `${ROOT}/x\n` },
      { cwd: `${ROOT}/x\x1b` },
      { cwd: `/${"x".repeat(512)}` },
      // Ruling T11-5: tmux would expand a format in `-c`.
      { cwd: `${ROOT}/C#Sharp/notes2` },
      { cwd: `${ROOT}/a##b/notes2` },
      { cwd: `${ROOT}/a#{session_name}/notes2` },
      { cwd: `${ROOT}/a#(id)/notes2` },
      { cwd: `${ROOT}/a\u009bb/notes2` },
      { cwd: `${ROOT}/a\udc00b/notes2` },
      { cwd: `${ROOT}/a\u2069b/notes2` },
      { tmuxName: "" },
      { tmuxName: "-x" },
      { tmuxName: "a b" },
      { tmuxName: "x".repeat(65) },
      { tmuxName: "a'b" },
      { tmuxName: "a;b" },
      { tmuxName: "a:b" },
      { tmuxName: "a.b" }
    ];
    for (const bad of refused) expectRefusal(() => buildCreateSessionCommand(plan(bad)), String(Object.values(bad)[0]));
    for (const notText of [{ tmuxName: 42 }, { cwd: null }, { mkdir: "yes" }]) expect(() => buildCreateSessionCommand(plan(notText as never))).toThrow(ProbeError);
    // Boundaries that pass.
    expect(buildCreateSessionCommand(plan({ tmuxName: "x".repeat(64) }))).toContain(`-s '${"x".repeat(64)}'`);
    expect(buildCreateSessionCommand(plan({ tmuxName: "_x" }))).toContain("-s '_x'");
    expect(buildCreateSessionCommand(plan({ cwd: `/${"x".repeat(511)}` }))).toContain(`-c '/${"x".repeat(511)}'`);
  });

  it("tmux is asked only has-session and new-session; nothing is killed, no key is sent, no file is written; POSIX sh only", () => {
    for (const mkdir of [true, false]) {
      const cmd = buildCreateSessionCommand(plan({ mkdir }));
      const verbs = [...cmd.matchAll(/(?:^|[{|;&] |\$\()tmux ([a-z-]+)/gm)].map((m) => m[1]);
      expect(verbs).toEqual(["has-session", "new-session"]);
      expect(cmd).not.toMatch(/kill|send-keys|paste-buffer|load-buffer/);
      for (const m of cmd.matchAll(/>>?\s*([^\s;)]+)/g)) expect(["/dev/null", "&1", "&2"]).toContain(m[1]);
      expect(cmd).not.toMatch(/\b(rm|mv|cp|tee|touch|chmod|truncate)\b/);
      // `mkdir` is invoked once at line start for a new folder (its failure detail names it too), never otherwise.
      expect((cmd.match(/^mkdir /gm) ?? []).length).toBe(mkdir ? 1 : 0);
      if (!mkdir) expect(cmd).not.toContain("mkdir");
      expect(cmd).not.toMatch(POSIX_ONLY);
      expect(cmd).not.toContain("${");
    }
  });
});

describe("parseCreateSessionOutput", () => {
  const created = (name: string): string => `${SESSION_SENTINEL}created:${name}\n`;
  const failed = (detail: string): string => `${SESSION_SENTINEL}failed:${detail}\n`;

  it("parses a created record (behind banner noise and CRLF) and each labelled failure", () => {
    expect(parseCreateSessionOutput(`Last login: banner\r\n${created("My-App-2").replace("\n", "\r\n")}trailer\n`, 0)).toEqual({ outcome: "created", tmuxName: "My-App-2" });
    for (const detail of ["claude not found", "folder exists", "mkdir failed", "folder missing", "session already exists", "tmux new-session failed"]) {
      expect(parseCreateSessionOutput(failed(detail), 0)).toEqual({ outcome: "failed", detail });
    }
    // The first record wins.
    expect(parseCreateSessionOutput(`${created("a")}${failed("folder exists")}`, 0)).toEqual({ outcome: "created", tmuxName: "a" });
  });

  it("ruling T11-18: no record is unconfirmed (the record comes after `new-session`), except the pre-read tool guards 126/127; a non-zero exit beside a record is failed with a first-party detail; a malformed record never surfaces machine text", () => {
    expect(parseCreateSessionOutput("Permission denied (publickey)", 255)).toEqual({ outcome: "unconfirmed", detail: "no_record" });
    expect(parseCreateSessionOutput("", 0)).toEqual({ outcome: "unconfirmed", detail: "no_record" });
    expect(parseCreateSessionOutput("session: tmux not found", 126)).toEqual({ outcome: "failed", detail: "the session script did not report back" });
    expect(parseCreateSessionOutput("sh: not found", 127)).toEqual({ outcome: "failed", detail: "the session script did not report back" });
    expect(parseCreateSessionOutput(created("a"), 1)).toEqual({ outcome: "failed", detail: "the session script exited with code 1" });
    expect(parseCreateSessionOutput(`${SESSION_SENTINEL}done:a\n`, 0)).toEqual({ outcome: "failed", detail: "the session script reported a malformed record" });
    expect(parseCreateSessionOutput(`${SESSION_SENTINEL}created\n`, 0)).toEqual({ outcome: "failed", detail: "the session script reported a malformed record" });
    expect(parseCreateSessionOutput(created("a b"), 0)).toEqual({ outcome: "failed", detail: "the session script reported a malformed record" });
    expect(parseCreateSessionOutput(created(""), 0)).toEqual({ outcome: "failed", detail: "the session script reported a malformed record" });
    const hostile = `Permission denied ghp_${"q".repeat(36)}`;
    const report = parseCreateSessionOutput(failed(hostile), 0);
    expect(report).toEqual({ outcome: "failed", detail: "the session script reported an unrecognised detail" });
    expect(JSON.stringify(report)).not.toContain("ghp_");
  });
});
