/**
 * Maestro Console delivery script (plan Task 5, spec §6.6.4, TM-020 remote-command surface): the one
 * remote command that pastes Karl's reply into a live Claude Code pane after re-verifying the target on
 * the machine, and the parser of its single result record. The reply text travels ONLY as base64 inside
 * the quoted heredoc (Review Focus 2); every other value passes its allow-list before any command text
 * exists; the parser's `detail` is first-party text, never stderr or raw machine output.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DELIVER_SENTINEL, buildDeliverCommand, parseDeliverOutput, type DeliverPlan } from "../src/console/deliver-command.js";
import { MENU_ANCHORS } from "../src/console/menu-fixtures.js";
import { ProbeError, mintScript } from "../src/console/probe-command.js";
import { SUBMIT_MAX_BYTES } from "../src/console/submit.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/console/${name}`, import.meta.url)), "utf8");

const SID = "0f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
/** The raw `procStart` a real session file carries (test/fixtures/console/sessions-2.1.301.json). */
const PROC_START = "Fri Oct 16 19:19:38 2026";
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const BASE: DeliverPlan = {
  sessionFile: "52971.json",
  sessionId: SID,
  procStart: PROC_START,
  pid: 52971,
  paneId: "%12",
  textB64: b64("A1"),
  bufferId: "console-0123abcd",
  tailLines: 40
};
const plan = (over: Partial<DeliverPlan> = {}): DeliverPlan => ({ ...BASE, ...over });
const record = (outcome: string, status = "idle", before = "abcd1234abcd1234", after = "ffff0000ffff0000", detail = ""): string =>
  `${DELIVER_SENTINEL}result:${outcome}:${status}:${before}:${after}:${detail}\n`;
const PATH_PREFIX = 'PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"';

describe("buildDeliverCommand", () => {
  it("the text never appears outside the base64 payload", () => {
    // Review Focus 2: tmux key syntax, slash/bang commands and shell syntax are delivered as literal text.
    const text = "C-c /clear !ls $(id) `id` ; | ' \"";
    const cmd = buildDeliverCommand(plan({ textB64: b64(text) }));
    expect(cmd).not.toContain("/clear");
    expect(cmd).not.toContain("$(id)");
    expect(cmd).toContain(b64(text));
    expect(cmd).toMatch(/base64 -d \| tmux load-buffer -b console-[0-9a-f]{8} -/);
    for (const token of ["C-c", "!ls", "`id`", "; |", text]) expect(cmd).not.toContain(token);
    // The command LINE carries no payload: it is the PATH prefix and the quoted-heredoc sh invocation only.
    const [head = "", ...body] = cmd.split("\n");
    expect(head).toBe(`${PATH_PREFIX} /bin/sh <<'PANTHEON_PROBE_SCRIPT'`);
    // The payload occurs exactly once, inside the body, single-quoted, as the `payload` function's literal.
    expect(body.filter((l) => l.includes(b64(text)))).toEqual([`payload() { printf '%s' '${b64(text)}'; }`]);
    expect(body).toContain('payload | base64 -d | tmux load-buffer -b console-0123abcd - || result failed "tmux step 1"');
    // Multi-line text: the newline is inside the base64, never a line of the script.
    const twoLines = buildDeliverCommand(plan({ textB64: b64("line one\nline two") }));
    expect(twoLines).not.toContain("line one");
    expect(twoLines).toContain(b64("line one\nline two"));
  });

  it("refuses every out-of-allow-list value before any command exists", () => {
    for (const bad of [
      { sessionFile: "../x.json" },
      { paneId: "%x" },
      { procStart: "2026-10-17T00:00:00Z;rm" },
      { bufferId: "console-zz" },
      { textB64: "not*base64" },
      { pid: -1 }
    ])
      expect(() => buildDeliverCommand(plan(bad))).toThrow(ProbeError);
    const refused: Partial<DeliverPlan>[] = [
      // sessionFile must be exactly `<pid>.json` for the plan's pid.
      { sessionFile: "1.json" },
      { sessionFile: "52971.json " },
      { sessionFile: "52971.JSON" },
      { sessionFile: "" },
      { sessionFile: "52971.json/../x.json" },
      { sessionId: SID.toUpperCase() },
      { sessionId: `${SID}'` },
      { sessionId: "" },
      { procStart: "" },
      { procStart: "Fri Oct 16 19:19:38 2026'" },
      { procStart: "Fri Oct 16\n19:19:38 2026" },
      { procStart: "$HOME" },
      { procStart: "x".repeat(65) },
      { pid: 0 },
      { pid: 1.5 },
      { pid: Number.NaN },
      { paneId: "%1234567" },
      { paneId: "12" },
      { paneId: "%12 " },
      { textB64: "" },
      { textB64: "QQ" }, // unpadded
      { textB64: "QR==" }, // non-canonical trailing bits
      { textB64: `${b64("A")}\n` },
      { textB64: b64("x".repeat(SUBMIT_MAX_BYTES + 1)) },
      { bufferId: "console-ABCDEF01" },
      { bufferId: "console-0123abcd9" },
      { bufferId: "buf-0123abcd" },
      { bufferId: "console-0123abcd; id" },
      { tailLines: 0 },
      { tailLines: 1001 },
      { tailLines: 40.5 }
    ];
    for (const bad of refused) expect(() => buildDeliverCommand(plan(bad)), JSON.stringify(bad)).toThrow(ProbeError);
    // The refusal names the rule, never the offending value.
    for (const bad of [{ sessionId: "x; rm -rf /" }, { procStart: "2026-10-17T00:00:00Z;rm" }, { bufferId: "console-zz" }]) {
      let err: unknown;
      try {
        buildDeliverCommand(plan(bad));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ProbeError);
      expect((err as Error).message).not.toContain(Object.values(bad)[0]);
    }
    // Boundaries that pass.
    expect(buildDeliverCommand(plan({ textB64: b64("x".repeat(SUBMIT_MAX_BYTES)) }))).toContain(b64("x".repeat(SUBMIT_MAX_BYTES)));
    expect(buildDeliverCommand(plan({ tailLines: 1000 }))).toContain("capture-pane -p -J -S -1000");
    expect(buildDeliverCommand(plan({ pid: 999999999, sessionFile: "999999999.json" }))).toContain("/.claude/sessions/999999999.json");
    expect(buildDeliverCommand(plan({ procStart: "2026-10-17T00:00:00Z" }))).toContain("'2026-10-17T00:00:00Z'");
  });

  it("the heredoc cannot be terminated by the payload", () => {
    const cmd = buildDeliverCommand(plan());
    const tag = /\/bin\/sh <<'([A-Z_]+)'\n/.exec(cmd)?.[1] ?? "";
    expect(tag).toBe("PANTHEON_PROBE_SCRIPT");
    // A base64 line can never spell the delimiter: `_` is outside the base64 alphabet.
    expect(/^[A-Za-z0-9+/=]+$/.test(tag)).toBe(false);
    // The delimiter appears on the `<<` line and as the closing line only — never as a body line.
    const lines = cmd.trimEnd().split("\n");
    expect(lines.filter((l) => l === tag)).toHaveLength(1);
    expect(lines[lines.length - 1]).toBe(tag);
    // The structural guard trips on a crafted body line equal to the delimiter (a template defect: no
    // allow-listed value can produce one); a line that merely contains it is not a terminator.
    expect(() => mintScript(`echo start\n${tag}\necho end`)).toThrow(ProbeError);
    expect(() => mintScript(`echo '${tag}'`)).not.toThrow();
  });

  it("embeds every MENU_ANCHORS entry as a single-quoted literal matched at line start by a case prefix", () => {
    for (const a of MENU_ANCHORS) expect(buildDeliverCommand(plan())).toContain(a);
    const cmd = buildDeliverCommand(plan());
    // Each anchor is a single-quoted literal of the menu loop, matched by `case` at line start (≤ 3 columns of indent).
    expect(cmd).toContain(`for a in ${MENU_ANCHORS.map((a) => `'${a}'`).join(" ")}; do`);
    expect(cmd).toContain(`case $l in "$1"*|" $1"*|"  $1"*|"   $1"*) exit 0 ;; esac`);
    expect(cmd).toContain('if menu_at_line_start "$a"; then result refused_menu_visible "$a"; fi');
    for (const a of MENU_ANCHORS) expect(a).toMatch(/^[^'\\:\n\r]{1,64}$/);
  });

  it("performs the nine steps in order and names only allow-listed values", () => {
    const cmd = buildDeliverCommand(plan());
    const steps = [
      'f="$HOME/.claude/sessions/52971.json"',
      '[ -f "$f" ] || result refused_target_changed "session file gone"',
      String.raw`grep -o '"\(pid\|sessionId\|status\|procStart\)" *: *\("[^"]*"\|[0-9.][0-9.]*\)'`,
      `[ "$(field sessionId)" = '${SID}' ] || result refused_target_changed "sessionId changed"`,
      `[ "$(field procStart)" = '${PROC_START}' ] || result refused_target_changed "procStart changed"`,
      `[ "$fpid" = '52971' ] || result refused_target_changed "pid changed"`,
      `kill -0 '52971' 2>/dev/null || result refused_target_changed "process gone"`,
      "pane_pid=$(tmux display-message -p -t '%12' '#{pane_pid}' 2>/dev/null)",
      "table=$(ps -A -o pid=,ppid= 2>/dev/null)",
      `[ "$held" = 1 ] || result refused_target_changed "pane no longer holds the session"`,
      `case $status in idle|busy) ;; '') result refused_menu_visible "status missing" ;; *) result refused_menu_visible "status $status" ;; esac`,
      'tail=$(capture) || result refused_target_changed "pane no longer holds the session"',
      'before=$(printf \'%s\\n\' "$tail" | hash16)',
      "for a in '❯ 1. '",
      "mode=$(tmux display-message -p -t '%12' '#{pane_in_mode}' 2>/dev/null)",
      `case $mode in 0) ;; 1) result refused_menu_visible "pane in copy mode" ;; *) result refused_target_changed "pane no longer holds the session" ;; esac`,
      "payload() { printf '%s' 'QTE='; }",
      'payload | base64 -d >/dev/null 2>&1 || result failed "base64 decode failed"',
      'payload | base64 -d | tmux load-buffer -b console-0123abcd - || result failed "tmux step 1"',
      "tmux paste-buffer -p -d -b console-0123abcd -t '%12' || { tmux delete-buffer -b console-0123abcd 2>/dev/null; result failed \"tmux step 2\"; }",
      "tmux send-keys -t '%12' Enter || result failed \"tmux step 3\"",
      "sleep 0.5",
      'after=$(printf \'%s\\n\' "$(capture)" | hash16)',
      'result sent ""'
    ];
    let at = -1;
    for (const step of steps) {
      const i = cmd.indexOf(step);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
    expect(cmd).toContain("capture() { tmux capture-pane -p -J -S -40 -t '%12' 2>/dev/null; }");
    expect(cmd).toContain("sha256sum; else shasum -a 256; fi | cut -c1-16");
    expect(cmd).toContain("export LC_ALL=C");
    expect(cmd).toContain("command -v base64 >/dev/null 2>&1");
    expect(cmd).toContain(`printf '${DELIVER_SENTINEL}result:%s:%s:%s:%s:%s\\n' "$1" "$status" "$before" "$after" "$2"; exit 0; }`);
    // Every UUID-shaped and every %-digit token in the text came from the plan — nothing else.
    expect(new Set(cmd.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g))).toEqual(new Set([SID]));
    expect(new Set(cmd.match(/%\d+/g))).toEqual(new Set(["%12"]));
    expect(new Set(cmd.match(/console-[0-9a-f]+/g))).toEqual(new Set(["console-0123abcd"]));
    // POSIX sh only: the dev machines run it through the login shell's /bin/sh.
    // (`$'` is bash ANSI-C quoting only when it starts a word; the BRE anchor in `grep -o '…*$'` is not one.)
    expect(cmd).not.toMatch(/\[\[|^\s*(?:local|declare|typeset)\s|\$\{[^}]*(,,|\^\^|\/\/)|(?:^|[\s=(])\$'|<<</m);
    expect(cmd).not.toContain("${");
    expect(cmd.trimEnd().endsWith("\nPANTHEON_PROBE_SCRIPT")).toBe(true);
  });

  it("tmux is asked only to display, capture, load, delete, paste and send Enter; nothing is killed or written", () => {
    const cmd = buildDeliverCommand(plan({ textB64: b64("kill-session rm -rf / > /etc/passwd") }));
    // The payload line is base64, where a `+`, `/` or `=` can bound a word such as `rm`: scan every other line
    // (the first test pins the payload line's exact shape).
    const scanned = cmd.split("\n").filter((l) => !l.startsWith("payload() {")).join("\n");
    // An invocation starts a line or follows `{ `, `| `, `; `, `&& `, `|| ` or `$(`; the `command -v tmux` guard
    // and the first-party detail strings ("tmux step N") mention tmux without invoking it.
    const tmuxVerbs = [...scanned.matchAll(/(?:^|[{|;&] |\$\()tmux ([a-z-]+)/gm)].map((m) => m[1]);
    expect(tmuxVerbs).toHaveLength(7);
    expect(new Set(tmuxVerbs)).toEqual(new Set(["display-message", "capture-pane", "load-buffer", "delete-buffer", "paste-buffer", "send-keys"]));
    expect((scanned.match(/\btmux\b/g) ?? []).length).toBe(7 + 2 + 3); // 7 invocations (two display-message reads), the guard line (2), the three details
    // The only key ever sent is Enter; the text itself reaches tmux through load-buffer's stdin.
    expect(scanned.match(/send-keys[^\n]*/g)).toEqual(["send-keys -t '%12' Enter || result failed \"tmux step 3\""]);
    // delete-buffer names the plan's buffer only and runs only when the paste failed.
    expect(scanned.match(/delete-buffer[^\n]*/g)).toEqual(['delete-buffer -b console-0123abcd 2>/dev/null; result failed "tmux step 2"; }']);
    // The only `kill` is the liveness probe `kill -0`; no tmux kill-* verb.
    expect(scanned).not.toMatch(/kill-|\bkill\b(?! -0 )/);
    // The only output redirections are to /dev/null or between the standard streams: no file is written.
    for (const m of scanned.matchAll(/>>?\s*([^\s;)]+)/g)) expect(["/dev/null", "&1", "&2"]).toContain(m[1]);
    expect(scanned).not.toMatch(/\b(rm|mv|cp|tee|touch|chmod|mkdir|truncate)\b/);
    expect(scanned).not.toContain("*.key");
  });

  it("fails closed: a failed capture refuses, a decode failure stops before load-buffer, a failed paste deletes the buffer", () => {
    const cmd = buildDeliverCommand(plan());
    // A `capture-pane` failure must not pass the menu check on an empty tail: the assignment carries the status.
    expect(cmd).toMatch(/^tail=\$\(capture\) \|\| result refused_target_changed "pane no longer holds the session"$/m);
    // POSIX sh has no pipefail: the dry-run decode (status checked) precedes the load pipeline.
    const dryRun = cmd.indexOf('payload | base64 -d >/dev/null 2>&1 || result failed "base64 decode failed"');
    const load = cmd.indexOf("payload | base64 -d | tmux load-buffer");
    expect(dryRun).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(dryRun);
    // The payload literal is defined once and read by both decodes.
    expect(cmd.split("\n").filter((l) => l.includes(BASE.textB64))).toEqual([`payload() { printf '%s' '${BASE.textB64}'; }`]);
    expect((cmd.match(/^payload \| base64 -d/gm) ?? []).length).toBe(2);
    // A failed paste leaves no buffer behind (`-d` deletes on success only).
    expect(cmd).toContain(`-t '%12' || { tmux delete-buffer -b console-0123abcd 2>/dev/null; result failed "tmux step 2"; }`);
  });

  it("triage 19 (F-3): a pane in a mode (copy mode) refuses with the menu check, before the paste — 0 goes on, 1 is refused_menu_visible 'pane in copy mode', anything else is the pane gone", () => {
    const cmd = buildDeliverCommand(plan());
    const read = cmd.indexOf("mode=$(tmux display-message -p -t '%12' '#{pane_in_mode}' 2>/dev/null)");
    const check = cmd.indexOf(`case $mode in 0) ;; 1) result refused_menu_visible "pane in copy mode" ;; *) result refused_target_changed "pane no longer holds the session" ;; esac`);
    expect(read).toBeGreaterThan(cmd.indexOf("for a in "));
    expect(check).toBeGreaterThan(read);
    expect(check).toBeLessThan(cmd.indexOf("payload() {"));
    expect(check).toBeLessThan(cmd.indexOf("tmux load-buffer"));
    // The detail is first-party: the parser admits it.
    expect(parseDeliverOutput(record("refused_menu_visible", "idle", "abcd1234abcd1234", "", "pane in copy mode"), 0)).toEqual({
      outcome: "refused_menu_visible",
      statusAtSend: "idle",
      detail: "pane in copy mode",
      tailHashBefore: "abcd1234abcd1234"
    });
  });
});

describe("parseDeliverOutput", () => {
  it.each([["sent"], ["refused_target_changed"], ["refused_menu_visible"], ["failed"]])("parses a %s record", (o) => {
    expect(parseDeliverOutput(`login banner\nPANTHEON_DELIVER:result:${o}:idle:abcd1234abcd1234:ffff0000ffff0000:detail\n`, 0).outcome).toBe(o);
    const report = parseDeliverOutput(`login banner\n${record(o)}`, 0);
    expect(report).toEqual({ outcome: o, statusAtSend: "idle", detail: "", tailHashBefore: "abcd1234abcd1234", tailHashAfter: "ffff0000ffff0000" });
  });

  it("ruling T11-18: no record is unconfirmed (the record comes last, after the paste) — except the pre-read tool guards 126/127, which stop before anything is read or written; a non-zero exit beside a record is failed with a first-party detail", () => {
    const unconfirmed = { outcome: "unconfirmed", statusAtSend: "", detail: "no_record" };
    expect(parseDeliverOutput("Permission denied (publickey)", 255)).toEqual(unconfirmed);
    expect(parseDeliverOutput("", 0)).toEqual(unconfirmed);
    expect(parseDeliverOutput("PANTHEON_DELIVER:end\n", 0)).toEqual(unconfirmed);
    expect(parseDeliverOutput("Last login: banner\n", -1)).toEqual(unconfirmed);
    expect(parseDeliverOutput("probe: base64 not found", 126)).toEqual({ outcome: "failed", statusAtSend: "", detail: "the delivery script did not report back" });
    expect(parseDeliverOutput("sh: not found", 127)).toEqual({ outcome: "failed", statusAtSend: "", detail: "the delivery script did not report back" });
    // A record beside a non-zero exit cannot be trusted either: the script exits 0 after every record it writes.
    expect(parseDeliverOutput(record("sent"), 1)).toEqual({ outcome: "failed", statusAtSend: "", detail: "the delivery script exited with code 1" });
    // A sentinel line that is not a complete record is malformed.
    expect(parseDeliverOutput("PANTHEON_DELIVER:result:sent:idle:abcd1234abcd1234\n", 0).detail).toBe("the delivery script reported a malformed record");
    expect(parseDeliverOutput("PANTHEON_DELIVER:result:sent:idle:abcd1234abcd1234:ffff0000ffff0000:x:y\n", 0).outcome).toBe("failed");
    expect(parseDeliverOutput("PANTHEON_DELIVER:result:done:idle:abcd1234abcd1234:ffff0000ffff0000:\n", 0).outcome).toBe("failed");
    expect(parseDeliverOutput(record("sent", "idle", "ABCD1234ABCD1234"), 0).outcome).toBe("failed");
    expect(parseDeliverOutput(record("sent", "idle", "abcd1234abcd12345"), 0).outcome).toBe("failed");
    expect(parseDeliverOutput(record("sent", "id le"), 0).outcome).toBe("failed");
  });

  it("ruling T11-18: `tmux step 3` (Enter failed after the paste: the text sits in the input line) is unconfirmed; a machine can never report `unconfirmed` itself", () => {
    expect(parseDeliverOutput(record("failed", "busy", "abcd1234abcd1234", "", "tmux step 3"), 0)).toEqual({
      outcome: "unconfirmed",
      statusAtSend: "busy",
      detail: "tmux_step_3",
      tailHashBefore: "abcd1234abcd1234"
    });
    expect(parseDeliverOutput(record("unconfirmed", "idle", "abcd1234abcd1234", "", ""), 0)).toEqual({ outcome: "failed", statusAtSend: "", detail: "the delivery script reported a malformed record" });
    // Steps 1 and 2 fail before anything reached the pane: still failed.
    expect(parseDeliverOutput(record("failed", "busy", "abcd1234abcd1234", "", "tmux step 1"), 0).outcome).toBe("failed");
    expect(parseDeliverOutput(record("failed", "busy", "abcd1234abcd1234", "", "tmux step 2"), 0).outcome).toBe("failed");
  });

  it("the sentinel is found after banner noise and CRLF, and the hashes are optional", () => {
    const noisy = `Last login: Sun Oct 19\r\nmotd\r\n${record("refused_target_changed", "", "", "", "session file gone").replace("\n", "\r\n")}trailer\r\n`;
    expect(parseDeliverOutput(noisy, 0)).toEqual({ outcome: "refused_target_changed", statusAtSend: "", detail: "session file gone" });
    expect(parseDeliverOutput(record("refused_menu_visible", "waiting", "", "", "status waiting"), 0)).toEqual({
      outcome: "refused_menu_visible",
      statusAtSend: "waiting",
      detail: "status waiting"
    });
    expect(parseDeliverOutput(record("refused_menu_visible", "idle", "abcd1234abcd1234", "", "❯ 1. "), 0)).toEqual({
      outcome: "refused_menu_visible",
      statusAtSend: "idle",
      detail: "❯ 1. ",
      tailHashBefore: "abcd1234abcd1234"
    });
    expect(parseDeliverOutput(record("failed", "busy", "abcd1234abcd1234", "", "tmux step 2"), 0)).toEqual({
      outcome: "failed",
      statusAtSend: "busy",
      detail: "tmux step 2",
      tailHashBefore: "abcd1234abcd1234"
    });
    expect(parseDeliverOutput(record("failed", "idle", "abcd1234abcd1234", "", "base64 decode failed"), 0).detail).toBe("base64 decode failed");
    for (const trustAnchor of ["Yes, I trust this folder", "Enter to confirm · Esc to cancel"]) {
      expect(MENU_ANCHORS).toContain(trustAnchor);
      expect(parseDeliverOutput(record("refused_menu_visible", "idle", "abcd1234abcd1234", "", trustAnchor), 0).detail).toBe(trustAnchor);
    }
    // The first record wins; a second one is ignored.
    expect(parseDeliverOutput(`${record("sent")}${record("failed")}`, 0).outcome).toBe("sent");
  });

  it("detail is first-party text only: an unrecognised detail is withheld, never echoed", () => {
    const hostile = "Permission denied (publickey) ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const report = parseDeliverOutput(record("refused_target_changed", "idle", "", "", hostile), 0);
    expect(report.outcome).toBe("refused_target_changed");
    expect(report.detail).toBe("the delivery script reported an unrecognised detail");
    expect(report.detail).not.toContain("ghp_");
    // `status <token>` admits a bounded token only.
    expect(parseDeliverOutput(record("refused_menu_visible", "idle", "", "", "status waiting:now"), 0).outcome).toBe("failed");
    expect(parseDeliverOutput(record("refused_menu_visible", "idle", "", "", `status ${"w".repeat(33)}`), 0).detail).toBe("the delivery script reported an unrecognised detail");
  });

  it("parses the recorded live run (deliver-sent.txt: the minted command against a throwaway tmux pane running cat)", () => {
    const report = parseDeliverOutput(fixture("deliver-sent.txt"), 0);
    expect(report).toEqual({ outcome: "sent", statusAtSend: "idle", detail: "", tailHashBefore: "01ba4719c80b6fe9", tailHashAfter: "f09071c01900fe47" });
    // The pane changed between the two captures: cat echoed the pasted text.
    expect(report.tailHashBefore).not.toBe(report.tailHashAfter);
  });
});
