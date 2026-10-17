/**
 * Maestro Console secret masking (decision 14 (3)): token-shaped text becomes `[masked]` before a
 * card is stored or shown, and cannot be unmasked in the console. Every pattern carries the `g` flag
 * so a second token on the same line is masked too. Masking goes through `String.prototype.replace`,
 * which resets a global regex's `lastIndex` before it starts, so the shared RegExp objects carry no
 * state between calls. Pane output is fed through `maskCompleteLines`, which masks only terminated
 * lines, so a token split across two reads cannot slip past a pattern half at a time.
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
  { name: "aws", re: /AKIA[0-9A-Z]{16}/g },
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

/**
 * Masks the terminated lines of `text`; the last unterminated line comes back as `carry`, unmasked and
 * NOT part of `masked`, so the caller prepends it to the next read and masks it once its line completes.
 */
export function maskCompleteLines(text: string): { readonly masked: string; readonly carry: string } {
  const cut = text.lastIndexOf("\n") + 1; // 0 when no line is terminated: everything is carry
  return { masked: maskSecrets(text.slice(0, cut)), carry: text.slice(cut) };
}
