/**
 * Maestro Console menu detection (plan Task 6, spec §6.3 signal 1): does a pane tail show a Claude Code
 * menu that waits for a keypress? Prompts raised by background agents leave the session file `busy`, so
 * the screen is the only witness.
 *
 * The regexes match the REAL captures in test/fixtures/console/ (README there): the permission and trust
 * prompts are drawn one column in, the AskUserQuestion menu at column 0. A menu counts only when one of
 * its `menu` lines is followed by its `footer` line, BELOW it and at most 24 lines further down, in the
 * same region outside backtick fences — so a pasted copy of a menu inside a fence, the bare `❯ ` input
 * line and the CDF approval render never count. Option-line anchors accept the line with or without the
 * `❯ ` cursor, so a menu stays detected after the user arrows to another option. A bare `❯ ` input line
 * after a pair in the same region voids it: that menu frame is stale, a newer input box sits below it.
 *
 * Fences follow CommonMark: a line starting (after whitespace) with a run of 3+ backticks opens one, and
 * only a run at least as long closes it, so a ``` line inside a ```` fence stays quoted.
 *
 * Accepted residual (controller ruling, Task 6 fix 1): fence state is tracked only inside the tail. If
 * the opening fence scrolled above the captured tail, the parity inverts — live menus after the closing
 * fence are skipped and quoted ones inside it count; an unclosed fence hides everything below it.
 *
 * One pass, O(lines × fixtures): a hostile tail of many option-like lines cannot stall the event loop.
 *
 * Fixture names (shown by the page, Task 11):
 *   "askuserquestion" — AskUserQuestion option menu
 *   "permission"      — tool permission prompt ("Do you want to proceed?")
 *   "trust"           — folder-trust prompt at startup
 *   "review-send"     — "1 to review · 2 to send · 0 to dismiss" (plan-asserted, never observed)
 */

export type MenuName = "askuserquestion" | "permission" | "trust" | "review-send";

export interface MenuFixture {
  readonly name: MenuName;
  /**
   * A menu counts when a `menu` line is followed by a `footer` line of the same name; a `standalone`
   * line is the whole prompt by itself.
   */
  readonly role: "menu" | "footer" | "standalone";
  readonly re: RegExp;
}

export const MENU_FIXTURES: readonly MenuFixture[] = [
  // pane-askuserquestion.txt (2.1.292): `❯ 1. …` at column 0 with the cursor on it, `  1. …` without.
  { name: "askuserquestion", role: "menu", re: /^ {0,3}(?:❯ )?1\. /m },
  { name: "askuserquestion", role: "footer", re: /^Enter to select · ↑\/↓ to navigate · Esc to cancel$/m },
  // pane-permission-prompt.txt (2.1.301), pane-permission-while-busy.txt (2.1.292), one column in.
  { name: "permission", role: "menu", re: /^ ?Do you want to proceed\?$/m },
  { name: "permission", role: "menu", re: /^ {0,3}(?:❯ )?1\. Yes/m },
  // Only the tailed footer was observed; the plain one is plan-asserted.
  { name: "permission", role: "footer", re: /^ ?Esc to cancel · Tab to amend(?: · ctrl\+x ctrl\+k twice to stop background agents)?$/m },
  // pane-trust-prompt.txt (2.1.302), one column in, unnumbered options; the cursor line is ` ❯ …`.
  { name: "trust", role: "menu", re: /^ ?(?:❯ )?(?:No, exit|Yes, I trust this folder)$/m },
  { name: "trust", role: "footer", re: /^ ?Enter to confirm · Esc to cancel$/m },
  // Plan-asserted (plan + spec §6.3), NEVER observed on screen and no fixture contains it.
  { name: "review-send", role: "standalone", re: /^ ?1 to review · 2 to send · 0 to dismiss$/m },
];

/** Screens that look menu-like but are not. */
export const MENU_NEGATIVE_FIXTURES: readonly { readonly name: string; readonly re: RegExp }[] = [
  // pane-bare-prompt.txt: the empty input line between two rules. Below a pair, it voids the pair.
  { name: "bare-prompt", re: /^❯ ?$/m },
  // pane-cdf-render.txt: the CDF approval hook's block text.
  { name: "cdf-render", re: /^\s*Reply with the option id again/m },
];

const FENCE_RE = /^\s*(`{3,})/;
const BARE_PROMPT_RE = /^❯ ?$/;
/** Largest line distance from an option line down to its footer (a 4-option AskUserQuestion spans 16). */
const MAX_PAIR_DISTANCE = 24;

/** The name of the menu on screen (the lowest one if several), or undefined. */
export function menuOnScreen(paneTail: string): MenuName | undefined {
  let fenceLen = 0; // 0 = outside a fence
  let found: MenuName | undefined; // the lowest pair of the regions already closed
  let pending: MenuName | undefined; // the lowest pair of the current region, until voided
  let lastOption = new Map<MenuName, number>(); // per name, the last option line of the current region
  const closeRegion = (): void => {
    if (pending !== undefined) found = pending;
    pending = undefined;
    lastOption = new Map();
  };
  const lines = paneTail.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // `capture-pane -J` keeps trailing spaces; a stray `\r` or padding must not hide a footer.
    const line = lines[i]!.trimEnd();
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const run = fence[1]!.length;
      if (fenceLen === 0) {
        closeRegion();
        fenceLen = run;
      } else if (run >= fenceLen) {
        fenceLen = 0;
      }
      continue;
    }
    if (fenceLen > 0) continue;
    if (BARE_PROMPT_RE.test(line)) {
      pending = undefined;
      continue;
    }
    for (const f of MENU_FIXTURES) {
      if (!f.re.test(line)) continue;
      if (f.role === "menu") {
        lastOption.set(f.name, i);
      } else if (f.role === "standalone") {
        pending = f.name;
      } else {
        const o = lastOption.get(f.name);
        if (o !== undefined && i > o && i - o <= MAX_PAIR_DISTANCE) pending = f.name;
      }
    }
  }
  closeRegion();
  return found;
}
