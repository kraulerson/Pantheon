import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IDEMPOTENCY_KEY_RE, SUBMIT_MAX_BYTES, validateSubmitText } from "../src/console/submit.js";

describe("validateSubmitText", () => {
  it.each([
    ["newline and tab", "hello\nworld\tx", true],
    ["BEL", "a\x07b", false],
    ["ESC sequence", "\x1b[31m", false],
    ["4097 ASCII bytes", "x".repeat(4097), false],
    ["2048 x é (4096 bytes)", "é".repeat(2048), true],
    ["2049 x é (4098 bytes)", "é".repeat(2049), false],
    ["empty", "", false],
    ["whitespace only", " \n\t ", false]
  ])("validateSubmitText(%s) ok=%s", (_name, text, ok) => expect(validateSubmitText(text).ok).toBe(ok));

  it("refuses a lone surrogate as invalid_utf8", () => expect(validateSubmitText("a\ud800b")).toEqual({ ok: false, reason: "invalid_utf8" }));

  it("refuses non-strings", () => expect(validateSubmitText(42)).toEqual({ ok: false, reason: "not_text" }));

  it("refuses every non-string shape as not_text, String objects and buffers included", () => {
    for (const v of [null, undefined, true, 0, {}, [], ["a"], Buffer.from("a"), new String("a")]) {
      expect(validateSubmitText(v), String(v)).toEqual({ ok: false, reason: "not_text" });
    }
  });

  it("returns the text unmodified (no trim, no newline normalisation) with its UTF-8 byte count", () => {
    const text = "  keep \n\t the spacing \n";
    expect(validateSubmitText(text)).toEqual({ ok: true, text, bytes: Buffer.byteLength(text, "utf8") });
    expect(validateSubmitText("")).toEqual({ ok: false, reason: "empty" });
  });

  // Ruling T6-1: a server-side guard, not trust in the page's disabled button. Nothing but whitespace (JS `\s`) is
  // `empty`, checked after `not_text` and before `too_long`, so a whitespace flood over 4 KiB is `empty` too.
  it("refuses empty and whitespace-only text as empty — '', space, \\n, \\t, \\r, CRLF, NBSP, em space, ideographic space, BOM, line separator; whitespace around a word still passes", () => {
    // NBSP, em space, ideographic space, BOM, line separator — by code point, so the cases are visible in source.
    const unicodeSpaces = [0x00a0, 0x2003, 0x3000, 0xfeff, 0x2028].map((cp) => String.fromCodePoint(cp));
    for (const ws of ["", " ", "\n", "\t", "\r", "\r\n", " \n\t ", ...unicodeSpaces]) {
      expect(validateSubmitText(ws), JSON.stringify(ws)).toEqual({ ok: false, reason: "empty" });
    }
    expect(validateSubmitText(" ".repeat(SUBMIT_MAX_BYTES + 1))).toEqual({ ok: false, reason: "empty" });
    expect(validateSubmitText(" a ")).toEqual({ ok: true, text: " a ", bytes: 3 });
    expect(validateSubmitText("\n\n.\n")).toEqual({ ok: true, text: "\n\n.\n", bytes: 4 });
    // Not whitespace: a control byte among spaces is still control_char; a non-string is still not_text.
    expect(validateSubmitText(" \x07 ")).toEqual({ ok: false, reason: "control_char" });
    expect(validateSubmitText("\x00")).toEqual({ ok: false, reason: "control_char" });
    expect(validateSubmitText(undefined)).toEqual({ ok: false, reason: "not_text" });
  });

  it("labels ESC as escape and every other C0/C1 control (NUL, BEL, CR, US, DEL, C1) as control_char", () => {
    expect(validateSubmitText("\x1b[31m")).toEqual({ ok: false, reason: "escape" });
    expect(validateSubmitText("plain text then \x1b")).toEqual({ ok: false, reason: "escape" });
    for (const c of ["\x00", "\x07", "\r", "\x1f", "\x7f", "\x80", "\x9f"]) {
      expect(validateSubmitText(`a${c}b`), JSON.stringify(c)).toEqual({ ok: false, reason: "control_char" });
    }
    expect(validateSubmitText("line one\r\nline two")).toEqual({ ok: false, reason: "control_char" });
  });

  it("lets non-control Unicode through: astral code points, separators, zero-width joiner, the chars after C1", () => {
    const text = "😀 café —  ‍ ¡ ok";
    expect(validateSubmitText(text)).toEqual({ ok: true, text, bytes: Buffer.byteLength(text, "utf8") });
  });

  it("the byte boundary is exact and counts UTF-8 bytes, not characters", () => {
    expect(SUBMIT_MAX_BYTES).toBe(4096);
    expect(validateSubmitText("x".repeat(4096))).toMatchObject({ ok: true, bytes: 4096 });
    expect(validateSubmitText("x".repeat(4097))).toEqual({ ok: false, reason: "too_long" });
    expect(validateSubmitText("é".repeat(2048))).toMatchObject({ ok: true, bytes: 4096 });
    expect(validateSubmitText("é".repeat(2049))).toEqual({ ok: false, reason: "too_long" });
    expect(validateSubmitText("😀".repeat(1024))).toMatchObject({ ok: true, bytes: 4096 });
    expect(validateSubmitText(`${"😀".repeat(1024)}x`)).toEqual({ ok: false, reason: "too_long" });
  });

  it("reports too_long before scanning oversize text, and otherwise the first offending code point", () => {
    expect(validateSubmitText(`\x1b${"x".repeat(4096)}`)).toEqual({ ok: false, reason: "too_long" });
    expect(validateSubmitText("a\x07b\x1bc")).toEqual({ ok: false, reason: "control_char" });
    expect(validateSubmitText("a\x1bb\x07c")).toEqual({ ok: false, reason: "escape" });
  });

  it("catches a lone surrogate on either side of a well-formed pair without splitting the pair", () => {
    expect(validateSubmitText("😀")).toMatchObject({ ok: true, bytes: 4 });
    expect(validateSubmitText("\ud83d")).toEqual({ ok: false, reason: "invalid_utf8" });
    expect(validateSubmitText("\ude00")).toEqual({ ok: false, reason: "invalid_utf8" });
    expect(validateSubmitText("😀\udc00")).toEqual({ ok: false, reason: "invalid_utf8" });
    expect(validateSubmitText("\ud800😀")).toEqual({ ok: false, reason: "invalid_utf8" });
  });
});

describe("IDEMPOTENCY_KEY_RE", () => {
  it("accepts crypto.randomUUID() output and refuses other shapes", () => {
    for (let i = 0; i < 20; i += 1) expect(IDEMPOTENCY_KEY_RE.test(randomUUID())).toBe(true);
    expect(IDEMPOTENCY_KEY_RE.test("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    for (const bad of [
      "",
      "123E4567-E89B-12D3-A456-426614174000",
      "{123e4567-e89b-12d3-a456-426614174000}",
      "123e4567-e89b-12d3-a456-426614174000\n",
      " 123e4567-e89b-12d3-a456-426614174000",
      "123e4567e89b12d3a456426614174000",
      "123e4567-e89b-12d3-a456-42661417400",
      "123e4567-e89b-12d3-a456-4266141740000",
      "g23e4567-e89b-12d3-a456-426614174000"
    ]) {
      expect(IDEMPOTENCY_KEY_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
