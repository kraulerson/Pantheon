/**
 * Maestro Console secret masking (decision 14 (3)): token-shaped text becomes `[masked]` before a
 * card is stored or shown, and cannot be unmasked in the console. Every pattern carries the `g` flag
 * so a second token on the same line is masked too. Masking goes through `String.prototype.replace`,
 * which resets a global regex's `lastIndex` before it starts, so the shared RegExp objects carry no
 * state between calls. Pane output is fed through `maskCompleteLines`, which masks only terminated
 * lines, so a token split across two reads cannot slip past a pattern half at a time.
 *
 * Growth bound (ruling T4-1b, restated by T11-14): every pattern's match is at least 8 bytes — the length of
 * `[masked]` — except `url_credentials` (`://a:b@` → `://[masked]@`, 7 → 12 bytes, 12/7 ≈ 1.714×) and `proxmox`
 * (at most 20/13), and `[masked]` holds no `:`, `/` or `@`, so a replacement never creates a new match. Masking
 * therefore grows text by at most 12/7 ≈ 1.714×: a 4,096-byte Submit masks to ≤ 7,022 bytes, under the
 * 8,192-byte `text_masked` CHECK (store.ts). {@link maskSubmitText} only shrinks that further.
 */

export const MASK = "[masked]";

export interface MaskPattern {
  readonly name: string;
  readonly re: RegExp;
}

export const MASK_PATTERNS: readonly MaskPattern[] = [
  { name: "netbird", re: /nbp_[A-Za-z0-9_-]{20,}/g },
  { name: "github", re: /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g },
  // Bounded {1,8} where the brief has `+`: the unbounded run was quadratic on whitespace (a blank pane is one run).
  // Final review I2 (scoped by controller ruling): `\b` also falls inside a longer bearer token (`.`, `+ / = ~ -` or
  // more token chars after the 40th), and this pattern, running before bearer and jwt, then masked only the first 40
  // chars (a JWT with a 40-char header kept its payload and signature). So after `Bearer` + one whitespace — where
  // bearer masks the whole token — it steps aside when the token runs on; after cf / cloudflare / CF_API_TOKEN, which
  // nothing else covers, it keeps `\b`, so a token followed by `.`, `-` or `/` (a sentence-final period) stays masked.
  { name: "cloudflare", re: /(?<=\b(?:Bearer|cf|cloudflare|CF_API_TOKEN)[\s:=]{1,8})(?!(?<=\bBearer\s)[A-Za-z0-9_-]{40}[A-Za-z0-9._~+/=-])[A-Za-z0-9_-]{40}\b/g },
  { name: "pantheon_keycard", re: /pk1_[0-9a-f]{64}/g },
  { name: "anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  // Ruling T11-14 (DI-2(a)): prefixed vendor credentials. The legacy `sk-` body is letters and digits only and a
  // project key needs 40+ chars after `sk-proj-`, so hyphenated folder names (`sk-learn-tools`) are never masked.
  { name: "openai", re: /(?<![A-Za-z0-9_-])(?:sk-proj-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{20,})/g },
  { name: "slack", re: /xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe", re: /[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { name: "google", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "aws", re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  // Body bounded to 16384 chars where the brief has `*?` (an RSA-4096 PEM is ~3.3k): the unbounded lazy body rescanned to the end per header.
  { name: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,16384}?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "bearer", re: /(?<=\bBearer\s)[A-Za-z0-9._~+/=-]{16,}/g },
  { name: "telegram_bot", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  // `(?<![A-Za-z0-9_-])eyJ` where the brief has `\beyJ`: with `\b` every eyJ in an `eyJ-` flood rescanned to the end (quadratic); an eyJ glued to a `-` is accepted as missed.
  { name: "jwt", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "proxmox", re: /(?<=PVEAPIToken=)[^\s'"]+/g },
  { name: "tailscale", re: /tskey-[A-Za-z0-9_-]{10,}/g },
  // Bounded {1,8} where the brief has `+`: the unbounded run was quadratic on whitespace (a blank pane is one run).
  { name: "gitea_hex", re: /(?<=\b(?:token|GITEA_TOKEN|Authorization)[\s:=]{1,8}(?:token\s)?)[0-9a-f]{40}\b/g },
  { name: "url_credentials", re: /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g },
  // Name runs bounded to {0,32} where the brief has `*` (a keyword repeated inside one uppercase run was quadratic); `["']?` after `=` so a quoted value is masked too.
  { name: "env_secret", re: /(?<=\b[A-Z0-9_]{0,32}(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|API_KEY|PRIVATE_KEY)[A-Z0-9_]{0,32}=["']?)[^\s'"]{8,}/g },
  // Bounded {0,8} where the brief has `\s*`: the unbounded run was quadratic on whitespace (a blank pane is one run).
  // The keyword may sit inside a `_` / `-` joined name (access_token, api_key, client_secret) where the brief has `\bkey\b`.
  { name: "high_entropy_in_context", re: /(?<=\b(?:[A-Za-z0-9]{1,24}[_-]){0,4}(?:key|token|secret|password)(?:[_-][A-Za-z0-9]{1,24}){0,4}\b[^\n]{0,20}?[:=]\s{0,8}["']?)[A-Za-z0-9+/_=-]{32,}/g },
  // Ruling T11-14: the value (8+ chars) after a whole-word keyword and `:` / `=`, any case. `\b` on both sides keeps
  // usage figures ("tokens: 12345678") and longer names alone; `pwd` is left out (a Unix word: "pwd: /home/…").
  // Bounded {0,8} runs around the separator, as above: the lookbehind stays linear on a whitespace flood.
  { name: "secret_assignment", re: /(?<=\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\b\s{0,8}[:=]\s{0,8}["']?)[^\s'"]{8,}/gi },
];

/** Applies each pattern in order. Exported so a test can drop one pattern and prove its sample then leaks. */
export function maskWith(patterns: readonly MaskPattern[], text: string): string {
  let out = text;
  for (const p of patterns) out = out.replace(p.re, MASK);
  return out;
}

/** Applies every pattern. Idempotent: re-masking yields the same text (`[masked]` is either unmatched or replaced by itself). */
export function maskSecrets(text: string): string {
  return maskWith(MASK_PATTERNS, text);
}

/** A run of 40+ hex digits: a bare Gitea token (or a git SHA, which the audit copy gives up — ruling T11-14). */
const HEX_RUN_RE = /[0-9A-Fa-f]{40,}/g;
/** A run of 32+ token characters; masked only when it mixes letters and digits (tested by the replacer, no lookaheads). */
const TOKEN_RUN_RE = /[A-Za-z0-9+/=_-]{32,}/g;
const HAS_DIGIT_RE = /[0-9]/;
const HAS_LETTER_RE = /[A-Za-z]/;

/**
 * The audit-only mask for `console_submit_log.text_masked` (ruling T11-14, DI-2(b)): {@link maskSecrets}, then two
 * context-free rules that would be too eager for card faces but cost only forensic fidelity in a table nothing
 * displays — a run of 40+ hex digits, and a run of 32+ `[A-Za-z0-9+/=_-]` that mixes letters and digits (an AWS
 * secret key, a Cloudflare or Gitea token pasted bare). Both replace a run of 32+ chars with 8, so the text only
 * shrinks and the 8,192-byte CHECK still holds; both are single character-class runs, so the scan stays linear.
 */
export function maskSubmitText(text: string): string {
  return maskSecrets(text)
    .replace(HEX_RUN_RE, MASK)
    .replace(TOKEN_RUN_RE, (run) => (HAS_DIGIT_RE.test(run) && HAS_LETTER_RE.test(run) ? MASK : run));
}

/**
 * Masks the terminated lines of `text`; the last unterminated line comes back as `carry`, unmasked and
 * NOT part of `masked`, so the caller prepends it to the next read and masks it once its line completes.
 */
export function maskCompleteLines(text: string): { readonly masked: string; readonly carry: string } {
  const cut = text.lastIndexOf("\n") + 1; // 0 when no line is terminated: everything is carry
  return { masked: maskSecrets(text.slice(0, cut)), carry: text.slice(cut) };
}
