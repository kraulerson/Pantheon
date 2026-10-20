/**
 * Maestro Console secret masking: every card face passes through `maskSecrets` before storage and
 * display (decision 14 (3)), so a pattern that misses leaks a token into SQLite and onto the page.
 * Every sample value below is synthetic — never a real token, never copied from anywhere.
 */

import { describe, it, expect } from "vitest";
import { MASK, MASK_PATTERNS, maskSecrets, maskSubmitText, maskWith, maskCompleteLines } from "../src/console/masking.js";

interface Sample {
  readonly text: string;
  readonly secret: string;
  readonly expected: string;
}

/** `prefix + secret + suffix`, expected back as `prefix + MASK + suffix`. */
const around = (prefix: string, secret: string, suffix = ""): Sample => ({ text: prefix + secret + suffix, secret, expected: prefix + MASK + suffix });

const HEX40 = "0123456789abcdef".repeat(2) + "01234567";
const HEX64 = "a".repeat(64);

/**
 * One sample per pattern, chosen so that ONLY that pattern matches it — the mutation guard below
 * depends on that. Where the patterns overlap, the sample sidesteps the others:
 *  - cloudflare (whose lookbehind also allows `Bearer`) uses the `cloudflare:` prefix with exactly
 *    40 chars; bearer uses `Bearer ` with a 24-char token containing a dot, which cloudflare's exact
 *    `{40}` cannot match.
 *  - gitea_hex uses `Authorization: token <40 hex>`: no `=`, so env_secret is out, and no `:` / `=`
 *    after the word `token`, so high_entropy_in_context and secret_assignment are out. env_secret's value
 *    is 9 non-hex chars (under high_entropy's 32 floor) behind `MY_SECRET` (no word boundary before
 *    `SECRET`, so secret_assignment is out). high_entropy's value is 35 mixed-case chars after
 *    `client_secret:` — a compound name, so the `\b`-anchored secret_assignment (T11-14) does not see it.
 *  - secret_assignment's value is 9 chars after `Password:` (no `=`, a mixed-case name, under the 32 floor).
 *  - the prefix-only patterns stand alone with no `token=` / `key:` context word in front, so neither
 *    env_secret nor high_entropy_in_context nor secret_assignment can also match them.
 */
const SAMPLES: Readonly<Record<string, Sample>> = {
  netbird: around("peer ", "nbp_" + "A".repeat(24)),
  github: around("gh ", "ghp_" + "x".repeat(36)),
  cloudflare: around("cloudflare: ", "W".repeat(20) + "x".repeat(20)),
  pantheon_keycard: around("card: ", "pk1_" + HEX64),
  anthropic: around("model ", "sk-ant-" + "k".repeat(24)),
  openai: around("model ", "sk-" + "T3BlbkFJ".repeat(6)),
  slack: around("bot ", "xoxb-" + "1234567890-" + "AbCdEfGhIjKlMnOp"),
  stripe: around("charge ", "sk_" + "live_" + "Q1w2E3r4T5y6U7i8O9p0"),
  google: around("maps ", "AIza" + "Sy" + "Ab1_-".repeat(6) + "Cd3"),
  aws: around("aws ", "AKIA" + "Q7".repeat(8)),
  private_key_block: around("pasted:\n", "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----", "\nok"),
  bearer: around("Authorization: Bearer ", "Xy9".repeat(7) + ".Qz"),
  telegram_bot: around("bot ", "123456789:" + "AbC".repeat(11) + "zz"),
  jwt: around("session ", "eyJ" + "a".repeat(12) + "." + "b".repeat(12) + "." + "c".repeat(12)),
  proxmox: around("PVEAPIToken=", "root@pam!console=0123abcd-0000-4000-8000-00000000abcd"),
  tailscale: around("join ", "tskey-auth-" + "Q".repeat(14)),
  gitea_hex: around("Authorization: token ", HEX40),
  url_credentials: around("https://", "deploy:s3cr3tpass", "@git.example.test/x.git"),
  env_secret: around("export MY_SECRET=", "abcdefgh1"),
  high_entropy_in_context: around("client_secret: ", "Zx9Qw".repeat(7)),
  secret_assignment: around("Password: ", "hunter2!x"),
};

function sample(name: string): Sample {
  const s = SAMPLES[name];
  if (s === undefined) throw new Error(`no sample for pattern ${name}`);
  return s;
}

const only = (name: string) => MASK_PATTERNS.filter((p) => p.name === name);

function expectMasked(name: string): void {
  const s = sample(name);
  expect(s.text).toContain(s.secret);
  const out = maskSecrets(s.text);
  expect(out).toBe(s.expected);
  expect(out).not.toContain(s.secret);
}

const ALL_SAMPLES = Object.values(SAMPLES).map((s) => s.text).join("\n");

describe("console secret masking", () => {
  it("masks a NetBird setup key nbp_<20+>", () => expectMasked("netbird"));

  it("masks GitHub tokens gh?_<20+> and github_pat_<20+>", () => {
    expectMasked("github");
    expect(maskSecrets("pat github_pat_" + "y".repeat(24))).toBe("pat [masked]");
  });

  it("masks a Cloudflare API token: 40 chars after cloudflare: or cf", () => {
    expectMasked("cloudflare");
    expect(maskSecrets("cf " + "W".repeat(40))).toBe("cf [masked]");
  });

  it("masks a Pantheon keycard pk1_<64 hex>", () => {
    expectMasked("pantheon_keycard");
    expect(maskSecrets("card: pk1_" + "a".repeat(64))).toBe("card: [masked]");
  });

  it("masks an Anthropic key sk-ant-<20+>", () => expectMasked("anthropic"));

  it("masks an AWS access key id AKIA<16>, and a temporary ASIA<16> (T11-14)", () => {
    expectMasked("aws");
    expect(maskSecrets("sts " + "ASIA" + "Q7".repeat(8))).toBe("sts [masked]");
  });

  // Ruling T11-14 (DI-2(a)): prefixed vendor credentials, every match at least 8 bytes.
  it("masks an OpenAI key: sk-<20+ letters/digits> and sk-proj-<40+>", () => {
    expectMasked("openai");
    expect(maskSecrets("key sk-proj-" + "Ab1_-x9Z".repeat(8) + " done")).toBe("key [masked] done");
  });

  it("an sk- body never admits hyphenated words: sk-learn-tools and friends are folder names, not keys", () => {
    for (const plain of ["sk-learn-tools", "sk-learn-tools-for-beginners-and-experts", "/Users/karl/Projects/sk-learn-tools", "task-runner-notes", "desk-abcdefghijklmnopqrstuvwxyz", "sk-proj-roadmap-notes", "a sk_live_ mention"]) {
      expect(maskSecrets(plain), plain).toBe(plain);
    }
  });

  it("masks a Slack token xox[abposr]-…", () => {
    expectMasked("slack");
    for (const k of ["a", "p", "o", "s", "r"]) expect(maskSecrets(`t xox${k}-1234567890-abc`), k).toBe("t [masked]");
  });

  it("masks a Stripe secret or restricted key [sr]k_(live|test)_…", () => {
    expectMasked("stripe");
    expect(maskSecrets("r " + "rk_" + "test_" + "abcdefghij12")).toBe("r [masked]");
  });

  it("masks a Google API key AIza<35>", () => expectMasked("google"));

  it("masks the value after a \\b-anchored password / passwd / secret / token / api key / access key and : or = (≥ 8 chars, any case)", () => {
    expectMasked("secret_assignment");
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["password=correcthorse", "password=[masked]"],
      ["passwd: hunter22!", "passwd: [masked]"],
      ["Secret = 'abcdefgh1'", "Secret = '[masked]'"],
      ['token: "abcd-efgh-ijkl"', 'token: "[masked]"'],
      ["API_KEY: abcdefgh", "API_KEY: [masked]"],
      ["api-key=abcdefgh", "api-key=[masked]"],
      ["accessKey: abcdefgh", "accessKey: [masked]"],
      ["access_key=abcdefgh", "access_key=[masked]"]
    ];
    for (const [text, expected] of cases) expect(maskSecrets(text), text).toBe(expected);
  });

  it("the assignment form leaves usage figures, pwd, short values and longer words alone", () => {
    for (const plain of ["tokens: 12345678", "pwd: /home/karl/projects", "password: short", "tokenizer=abcdefghij", "mytoken=abcdefghij", "passwords: abcdefghij", "the secret is out"]) {
      expect(maskSecrets(plain), plain).toBe(plain);
    }
  });

  it("every pattern's match is at least 8 bytes, so masking grows text only where url_credentials (12/7) or proxmox (20/13) can", () => {
    for (const [name, s] of Object.entries(SAMPLES)) {
      if (name === "url_credentials" || name === "proxmox") continue;
      expect(Buffer.byteLength(s.secret), name).toBeGreaterThanOrEqual(8);
      expect(Buffer.byteLength(maskSecrets(s.text)), name).toBeLessThanOrEqual(Buffer.byteLength(s.text));
    }
    // The proven worst case, a 4,096-byte submit of `://a:b@` runs, stays under the 8,192-byte CHECK either way.
    const worst = "://a:b@".repeat(585) + "x";
    expect(Buffer.byteLength(worst)).toBe(4096);
    expect(Buffer.byteLength(maskSecrets(worst))).toBe(7021);
    expect(Buffer.byteLength(maskSecrets(worst))).toBeLessThanOrEqual(Math.ceil((4096 * 12) / 7));
    expect(Buffer.byteLength(maskSubmitText(worst))).toBeLessThanOrEqual(8192);
  });

  it("masks a PEM private key block, header to footer", () => expectMasked("private_key_block"));

  it("masks a Bearer token", () => expectMasked("bearer"));

  it("masks a Telegram bot token <8-10 digits>:<35>", () => expectMasked("telegram_bot"));

  it("masks a JWT eyJ<header>.<payload>.<signature>", () => expectMasked("jwt"));

  it("masks a Proxmox PVEAPIToken value", () => expectMasked("proxmox"));

  it("masks a Tailscale key tskey-<10+>", () => expectMasked("tailscale"));

  it("masks a Gitea 40-hex token after token / GITEA_TOKEN / Authorization", () => expectMasked("gitea_hex"));

  it("masks user:password credentials embedded in a URL", () => expectMasked("url_credentials"));

  it("masks the value of a *TOKEN / *SECRET / *PASSWORD / *API_KEY assignment", () => expectMasked("env_secret"));

  it("masks a 32+ char value after key / token / secret / password", () => expectMasked("high_entropy_in_context"));

  it("leaves ordinary prose, hashes in commit lines and short words alone", () => {
    for (const line of ["fix 9348a52 tmux copy", "the token count was 12", "https://git.example.test/repo.git", "key: short"]) {
      expect(maskSecrets(line)).toBe(line);
    }
  });

  it("is idempotent", () => {
    const once = maskSecrets(ALL_SAMPLES);
    expect(maskSecrets(once)).toBe(once);
    expect(maskSecrets(MASK)).toBe(MASK);
    for (const p of MASK_PATTERNS) expect(maskWith([p], MASK), `${p.name} re-matches ${MASK}`).toBe(MASK);
  });

  it("masks complete lines only and carries the unterminated tail", () => {
    const r = maskCompleteLines("a pk1_" + HEX64 + "\nb sk-ant-abcdefghijklmnopqrstu");
    expect(r.masked).toBe("a [masked]\n");
    expect(r.carry).toBe("b sk-ant-abcdefghijklmnopqrstu");
    expect(maskCompleteLines("no newline pk1_" + HEX64)).toEqual({ masked: "", carry: "no newline pk1_" + HEX64 });
    expect(maskCompleteLines("pk1_" + HEX64 + "\n")).toEqual({ masked: "[masked]\n", carry: "" });
    expect(maskCompleteLines("")).toEqual({ masked: "", carry: "" });
  });

  it("every pattern bites: removing any one pattern lets its sample through", () => {
    expect(MASK_PATTERNS.map((p) => p.name).sort()).toEqual(Object.keys(SAMPLES).sort());
    for (const p of MASK_PATTERNS) {
      const s = sample(p.name);
      const without = MASK_PATTERNS.filter((q) => q !== p);
      expect(maskWith(without, s.text), `${p.name}: another pattern already covers its sample`).toContain(s.secret);
    }
  });

  it("every pattern has the g flag, so a second token on the same line is masked too", () => {
    for (const p of MASK_PATTERNS) expect(p.re.flags, p.name).toContain("g");
    expect(maskSecrets("pk1_" + HEX64 + " and pk1_" + HEX64)).toBe("[masked] and [masked]");
  });

  // Controller rulings on the task-2 report: the separator run after the keyword is bounded to {1,8} in
  // cloudflare and gitea_hex, and the whitespace after `:` / `=` to {0,8} in high_entropy_in_context (the
  // brief's unbounded runs were quadratic on whitespace, and a blank pane is one whitespace run).
  it("cloudflare, gitea_hex and high_entropy_in_context allow up to 8 separator chars after the keyword, not 9", () => {
    const W40 = "W".repeat(40);
    const V35 = "Zx9Qw".repeat(7);
    for (const n of [1, 8]) {
      expect(maskSecrets("cf" + " ".repeat(n) + W40)).toBe("cf" + " ".repeat(n) + MASK);
      expect(maskSecrets("Authorization:" + " ".repeat(n - 1) + HEX40)).toBe("Authorization:" + " ".repeat(n - 1) + MASK);
      expect(maskSecrets("password:" + " ".repeat(n) + V35)).toBe("password:" + " ".repeat(n) + MASK);
    }
    const nineCf = "cf" + " ".repeat(9) + W40;
    const nineGitea = "Authorization:" + " ".repeat(8) + HEX40;
    const nineEntropy = "password:" + " ".repeat(9) + V35;
    expect(maskWith(only("cloudflare"), nineCf)).toBe(nineCf);
    expect(maskWith(only("gitea_hex"), nineGitea)).toBe(nineGitea);
    expect(maskWith(only("high_entropy_in_context"), nineEntropy)).toBe(nineEntropy);
  });

  it("a 100k-space run after Bearer is masked in bounded time (no quadratic lookbehind)", () => {
    const text = "Bearer " + " ".repeat(100000) + "x";
    const t0 = performance.now();
    const out = maskSecrets(text);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(out).toBe(text);
  });

  // Fix round 1 (controller rulings on the task-2 review): env_secret's name runs are bounded to {0,32}
  // and accept a quote after `=`; jwt rejects an eyJ glued to a preceding [A-Za-z0-9_-]; the PEM body is
  // bounded to 16384 chars. The floods below were quadratic before the bounds.
  it("env_secret allows up to 32 name chars before and after the keyword, not 33", () => {
    for (const n of [0, 32]) {
      expect(maskSecrets("A".repeat(n) + "TOKEN=abcdefgh1")).toBe("A".repeat(n) + "TOKEN=" + MASK);
      expect(maskSecrets("TOKEN" + "A".repeat(n) + "=abcdefgh1")).toBe("TOKEN" + "A".repeat(n) + "=" + MASK);
    }
    const before = "A".repeat(33) + "TOKEN=abcdefgh1";
    const after = "TOKEN" + "A".repeat(33) + "=abcdefgh1";
    expect(maskWith(only("env_secret"), before)).toBe(before);
    expect(maskWith(only("env_secret"), after)).toBe(after);
  });

  it("env_secret masks a quoted value and keeps the quotes", () => {
    expect(maskSecrets('export MY_SECRET="abcdefgh1"')).toBe('export MY_SECRET="[masked]"');
    expect(maskSecrets("DB_PASSWORD='abcdefgh1'")).toBe("DB_PASSWORD='[masked]'");
  });

  it("masks a 4k-char PEM block whole", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\n" + ("A".repeat(64) + "\n").repeat(62) + "-----END RSA PRIVATE KEY-----";
    expect(pem.length).toBeGreaterThan(4000);
    expect(maskSecrets("pasted:\n" + pem + "\n")).toBe("pasted:\n[masked]\n");
  });

  it("TOKEN, eyJ- and PEM-header floods of 100k-200k chars are masked in bounded time", () => {
    const floods: ReadonlyArray<readonly [string, string]> = [
      ["x + TOKEN x 20000 + =12345678", "x" + "TOKEN".repeat(20000) + "=12345678"],
      ["eyJ- x 25000", "eyJ-".repeat(25000)],
      ["PEM header x 7143, no footer", "-----BEGIN PRIVATE KEY-----\n".repeat(7143)],
    ];
    for (const [label, text] of floods) {
      const t0 = performance.now();
      const out = maskSecrets(text);
      expect(performance.now() - t0, label).toBeLessThan(1000);
      expect(out, label).toBe(text);
    }
  });

  // Final review I2: cloudflare runs before bearer and jwt, and its `{40}\b` found a word boundary INSIDE a longer
  // bearer token (a `.` or `+ / = ~ -` after the 40th char), so it masked the first 40 chars and left the rest of
  // the token visible — a JWT's payload and signature, or the tail of a long opaque token.
  it("a Bearer token longer than 40 chars is masked whole: a JWT with a 40-char header, and 40 chars + any token char", () => {
    const header = Buffer.from('{"alg":"RS256","kid":"123456"}').toString("base64url");
    expect(header).toHaveLength(40);
    const jwt = `${header}.${Buffer.from('{"sub":"karl","exp":1893456000}').toString("base64url")}.${"S".repeat(43)}`;
    expect(maskSecrets(`Authorization: Bearer ${jwt}`)).toBe("Authorization: Bearer [masked]");
    expect(maskSecrets(`curl -H "Authorization: Bearer ${jwt}" https://api.example.test`)).toBe('curl -H "Authorization: Bearer [masked]" https://api.example.test');
    for (const next of ["+", "/", "=", "~", ".", "-"]) {
      expect(maskSecrets(`Bearer ${"A".repeat(40)}${next}${"B".repeat(30)}`), `40 chars + ${next}`).toBe("Bearer [masked]");
    }
  });

  it("cloudflare still masks a 40-char token followed by a space, a comma, a newline or the end of the text", () => {
    const W40 = "W".repeat(40);
    const cases: ReadonlyArray<readonly [string, string]> = [
      [`cf ${W40}`, "cf [masked]"],
      [`cloudflare: ${W40}, then`, "cloudflare: [masked], then"],
      [`CF_API_TOKEN: ${W40}\nnext`, "CF_API_TOKEN: [masked]\nnext"],
      [`Bearer ${W40} ok`, "Bearer [masked] ok"]
    ];
    for (const [text, expected] of cases) expect(maskSecrets(text), text).toBe(expected);
  });

  // Controller ruling on the I2 lookahead: only a token after `Bearer` + one whitespace is left to bearer/jwt (which
  // mask it whole); after cf / cloudflare / CF_API_TOKEN nothing else masks it, so a 40-char token followed by a
  // `.`, `-` or `/` (a sentence-final period, a path) must still be masked by cloudflare.
  it("a Cloudflare-prefixed 40-char token followed by . - or / is still masked", () => {
    const W40 = "W".repeat(40);
    const cases: ReadonlyArray<readonly [string, string]> = [
      [`cf ${W40}.`, "cf [masked]."],
      [`cloudflare: ${W40}-x`, "cloudflare: [masked]-x"],
      [`CF_API_TOKEN: ${W40}/`, "CF_API_TOKEN: [masked]/"],
      [`Set it to cloudflare: ${W40}...`, "Set it to cloudflare: [masked]..."]
    ];
    for (const [text, expected] of cases) expect(maskSecrets(text), text).toBe(expected);
  });

  // Fix round 1, item 4 (adopted on measurement: 1.6 ms Bearer + 100k spaces, 0.3 ms access_token flood,
  // 0.2 ms blank pane, uniqueness matrix 16/16): the keyword may sit inside a `_` / `-` joined name.
  it("high_entropy_in_context matches compound names: access_token, \"access_token\", api_key", () => {
    const V = "Ab1".repeat(13) + "Z";
    expect(maskSecrets("access_token: " + V)).toBe("access_token: [masked]");
    expect(maskSecrets('"access_token": "' + V + '"')).toBe('"access_token": "[masked]"');
    expect(maskSecrets("api_key=" + V)).toBe("api_key=[masked]");
    expect(maskSecrets("tokenizer emitted " + V)).toBe("tokenizer emitted " + V);
  });

  // Ruling T6-0: the delivery script compares the session file's RAW `procStart` with the stored value, which the
  // poller passed through maskSecrets. A mask rule that touched any timestamp shape would make every Submit refuse
  // "procStart changed" (fail-closed, feature dead), so each shape must come back byte-identical.
  it("leaves procStart timestamps untouched: ISO-8601 with Z, fractional seconds, an offset, and the ctime shape", () => {
    for (const stamp of ["2026-10-17T00:00:00Z", "2026-10-17T10:11:12.345Z", "2026-10-17T10:11:12+02:00", "Fri Oct 16 19:19:38 2026"]) {
      expect(maskSecrets(stamp), stamp).toBe(stamp);
      expect(maskSecrets(`"procStart": "${stamp}"`), stamp).toBe(`"procStart": "${stamp}"`);
    }
  });

  it("T11-14: the new patterns stay linear on hostile floods (sk-, sk-proj-, xoxb-, AIza, password:, passwd=)", () => {
    const floods: ReadonlyArray<readonly [string, string]> = [
      ["sk-a x 25000", "sk-a".repeat(25000)],
      ["sk-proj-a- x 12000", "sk-proj-a-".repeat(12000)],
      ["xoxb- x 20000", "xoxb-".repeat(20000)],
      ["AIza x 25000", "AIza".repeat(25000)],
      ["password: x 10000", "password:".repeat(10000)],
      ["passwd= + 100k spaces", "passwd=" + " ".repeat(100000) + "x"]
    ];
    for (const [label, text] of floods) {
      const t0 = performance.now();
      maskSecrets(text);
      expect(performance.now() - t0, label).toBeLessThan(1000);
    }
  });
});

describe("maskSubmitText — the audit-only mask for console_submit_log.text_masked (ruling T11-14, DI-2(b))", () => {
  // Built at runtime: an AWS-secret-shaped and a Cloudflare-shaped value (40 mixed chars, no context word).
  const AWS_SECRET_SHAPE = ["wJalr", "XUtnFEMI", "/K7MDENG/", "bPxRfiCY", "EXAMPLEKEY"].join("");
  const CF_SHAPE = "Zq8".repeat(13) + "x";

  it("is maskSecrets first: every shared pattern still applies", () => {
    for (const s of Object.values(SAMPLES)) expect(maskSubmitText(s.text)).toBe(maskSecrets(s.text));
  });

  it("masks a bare 40-hex run (a Gitea token pasted with no context) — a pasted git SHA is masked too, by design", () => {
    expect(maskSubmitText(`use ${HEX40} now`)).toBe("use [masked] now");
    expect(maskSubmitText(`commit ${"abc123".repeat(6)}abcd`)).toBe("commit [masked]");
    expect(maskSecrets(`commit ${HEX40}`)).toBe(`commit ${HEX40}`); // the shared mask keeps SHAs on cards
  });

  it("masks a bare run of 32+ token chars that mixes letters and digits (an AWS secret key, a Cloudflare token)", () => {
    expect(AWS_SECRET_SHAPE).toHaveLength(40);
    expect(maskSubmitText(`aws secret ${AWS_SECRET_SHAPE}`)).toBe("aws secret [masked]");
    expect(maskSubmitText(`${CF_SHAPE}.`)).toBe("[masked].");
    expect(maskSecrets(CF_SHAPE)).toBe(CF_SHAPE); // no context word: the shared mask leaves it
  });

  it("leaves letters-only and digits-only runs, short runs and ordinary prose alone", () => {
    for (const plain of [
      "supercalifragilisticexpialidocious-and-then-some-more",
      "1234567890123456789012345678901234",
      "A1 — go ahead with the second option",
      "Short123abc",
      "see /Users/karl/Documents/Claude Projects/Pantheon/pantheon-harness for the plan"
    ]) {
      expect(maskSubmitText(plain), plain).toBe(plain);
    }
  });

  it("only ever shrinks what maskSecrets produced, so the 8,192-byte CHECK holds", () => {
    const texts = [`x ${AWS_SECRET_SHAPE} y ${HEX40} z ${CF_SHAPE}`, ALL_SAMPLES, "://a:b@".repeat(585) + "x"];
    for (const t of texts) expect(Buffer.byteLength(maskSubmitText(t))).toBeLessThanOrEqual(Buffer.byteLength(maskSecrets(t)));
  });

  it("is idempotent and linear on hostile input (runs of 31 token chars, a 100k mixed run)", () => {
    const once = maskSubmitText(`a ${AWS_SECRET_SHAPE} b`);
    expect(maskSubmitText(once)).toBe(once);
    for (const [label, text] of [
      ["31-char runs", ("a1".repeat(15) + "b ").repeat(3000)],
      ["one 100k mixed run", "a1".repeat(50000)],
      ["39-hex runs", ("f".repeat(39) + " ").repeat(2500)]
    ] as const) {
      const t0 = performance.now();
      maskSubmitText(text);
      expect(performance.now() - t0, label).toBeLessThan(1000);
    }
  });
});
