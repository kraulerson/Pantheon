/**
 * Maestro Console submit validation (plan Task 4, spec §6.6.2): the text Karl types for a session is
 * refused — never stripped, trimmed or normalised — when it is nothing but whitespace (ruling T6-1), carries
 * a C0/C1 control other than `\n` / `\t`, an ESC, a lone surrogate (no UTF-8 form) or more than 4096 UTF-8
 * bytes. Pure: no I/O, nothing logged, and a refusal never carries the text (the 400 body is the labelled
 * reason alone, Task 6).
 */

export const SUBMIT_MAX_BYTES = 4096;

export type SubmitRefusal = "not_text" | "empty" | "too_long" | "control_char" | "escape" | "invalid_utf8";

/**
 * Delivery outcomes the submit route reports and `console_submit_log` records (store.ts). `unconfirmed` (ruling
 * T11-18) is the route's own verdict on a send that may have reached the pane — the dial died after the exec request,
 * Enter failed after the paste (`tmux step 3`), or no record came back — and is never accepted from the machine.
 */
export type SubmitOutcome = "sent" | "refused_target_changed" | "refused_menu_visible" | "failed" | "unconfirmed";

/** One lowercase hyphenated uuid per Submit (`crypto.randomUUID()` on the page); a replay returns the stored outcome. */
export const IDEMPOTENCY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SubmitValidation =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: SubmitRefusal };

const TAB = 0x09;
const LF = 0x0a;
const ESC = 0x1b;
/** Nothing but JS `\s` (space, `\t`, `\n`, `\r`, NBSP, the Unicode spaces, BOM): an Enter on an empty prompt is a wasted dial at best. */
const WHITESPACE_ONLY_RE = /^\s*$/;

/**
 * The refusal one code point earns, or undefined when it may travel. The string iterator yields a lone
 * surrogate as a single code point in U+D800–U+DFFF (a well-formed pair comes out as one astral code
 * point), which is what `String.prototype.isWellFormed()` would report; that method is ES2024 and absent
 * from the project's ES2022 lib, so the scan carries the check.
 */
function refusalFor(cp: number): SubmitRefusal | undefined {
  if (cp >= 0xd800 && cp <= 0xdfff) return "invalid_utf8";
  if (cp === ESC) return "escape";
  if ((cp < 0x20 && cp !== LF && cp !== TAB) || (cp >= 0x7f && cp <= 0x9f)) return "control_char";
  return undefined;
}

/**
 * `not_text` for anything but a primitive string; `empty` for "" or whitespace only (ruling T6-1: a server-side
 * guard, checked before the byte bound, so a whitespace flood is `empty` too); `too_long` over
 * {@link SUBMIT_MAX_BYTES} UTF-8 bytes (checked before the scan, so it never runs over more than 4 KiB); then
 * the first offending code point in reading order names the reason. `bytes` is the UTF-8 length the route
 * logs; `text` is the input itself.
 */
export function validateSubmitText(text: unknown): SubmitValidation {
  if (typeof text !== "string") return { ok: false, reason: "not_text" };
  if (WHITESPACE_ONLY_RE.test(text)) return { ok: false, reason: "empty" };
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > SUBMIT_MAX_BYTES) return { ok: false, reason: "too_long" };
  for (const ch of text) {
    const reason = refusalFor(ch.codePointAt(0)!);
    if (reason !== undefined) return { ok: false, reason };
  }
  return { ok: true, text, bytes };
}
