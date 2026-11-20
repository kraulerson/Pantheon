/**
 * BUGS #88 — every locked copy of a package named in the 2026-11-18 `npm audit` report must sit outside that
 * advisory's vulnerable range.
 *
 * Offline: it reads `package-lock.json` only and does not replace CI's `npm audit` step, which learns of new
 * advisories. It stops a later lockfile change from walking one of these packages back into a range that was
 * closed. A package that is no longer in the lockfile passes. Review of the fix (2026-11-19) added: aliases are
 * matched by the entry's own name, tagged versions fail, and `test-exclude` has a row.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Inclusive `[lowest, highest]` vulnerable version. */
type Range = readonly [string, string];

const VULNERABLE: Readonly<Record<string, readonly Range[]>> = {
  tinypool: [["0.0.0", "2.1.1"]],
  vitest: [["0.0.95", "4.1.10"]],
  "@vitest/mocker": [["0.0.0", "4.1.11"]],
  "@vitest/coverage-v8": [["2.0.0", "4.1.10"]],
  vite: [["7.0.0", "7.3.6"]],
  "brace-expansion": [
    ["0.0.0", "1.1.20"],
    ["2.0.0", "2.1.6"],
    ["4.0.0", "5.0.11"]
  ],
  "js-yaml": [["4.0.0", "4.3.1"]],
  "source-map-js": [["1.0.0", "1.2.1"]],
  undici: [["7.0.0", "7.30.0"]],
  glob: [["9.0.0", "14.0.1"]],
  minimatch: [["7.0.0", "11.0.0"]],
  // The audit flags every release from 7.0.0 (it depends on the vulnerable glob and minimatch).
  "test-exclude": [["7.0.0", "99999.0.0"]],
  hono: [["0.0.0", "4.13.15"]],
  "@hono/node-server": [["0.0.0", "2.1.2"]],
  "typescript-eslint": [["0.0.0", "8.72.2"]],
  "@typescript-eslint/eslint-plugin": [["6.16.0", "8.72.2"]],
  "@typescript-eslint/parser": [["6.16.0", "8.72.2"]],
  "@typescript-eslint/type-utils": [["6.16.0", "8.72.2"]],
  "@typescript-eslint/typescript-estree": [["6.16.0", "8.72.2"]],
  "@typescript-eslint/utils": [["6.16.0", "8.72.2"]]
};

/** The only version shape this check compares: three numbers. */
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

function parts(version: string): [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = version.split(".");
  return [Number(major), Number(minor), Number(patch)];
}

function compare(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * A pre-release or build-tagged version of a listed package fails outright: npm's audit counts a pre-release of
 * the first fixed version as vulnerable, and this check does not order tags.
 */
function isVulnerable(name: string, version: string): boolean {
  const ranges = VULNERABLE[name];
  if (ranges === undefined) return false;
  if (!PLAIN_VERSION.test(version)) return true;
  return ranges.some(([low, high]) => compare(version, low) >= 0 && compare(version, high) <= 0);
}

type LockPackages = Readonly<Record<string, { readonly name?: string; readonly version?: string }>>;

const MARKER = "node_modules/";
const lock = JSON.parse(readFileSync(fileURLToPath(new URL("../package-lock.json", import.meta.url)), "utf8")) as {
  packages: LockPackages;
};

/**
 * Every vulnerable installed copy of `name`, nested ones included, as `path@version`. An entry's own `name` wins
 * over its folder, so a package installed under an alias is still found.
 */
function vulnerableCopies(packages: LockPackages, name: string): string[] {
  return Object.entries(packages)
    .filter(([path, entry]) => path.includes(MARKER) && (entry.name ?? path.slice(path.lastIndexOf(MARKER) + MARKER.length)) === name)
    .filter(([, entry]) => entry.version !== undefined && isVulnerable(name, entry.version))
    .map(([path, entry]) => `${path}@${entry.version ?? ""}`);
}

describe("BUGS #88: no locked package sits inside an advisory range from the 2026-11-18 audit", () => {
  it.each(Object.keys(VULNERABLE))("%s", (name) => {
    expect(vulnerableCopies(lock.packages, name)).toEqual([]);
  });
});

describe("the range check itself", () => {
  it("treats both ends of a range as vulnerable and the next patch as fixed", () => {
    expect(isVulnerable("hono", "4.13.15")).toBe(true);
    expect(isVulnerable("hono", "4.13.16")).toBe(false);
    expect(isVulnerable("vitest", "0.0.95")).toBe(true);
    expect(isVulnerable("vitest", "4.1.11")).toBe(false);
  });

  it("leaves the gaps between a package's ranges alone", () => {
    expect(isVulnerable("brace-expansion", "1.1.22")).toBe(false);
    expect(isVulnerable("brace-expansion", "2.1.6")).toBe(true);
    expect(isVulnerable("brace-expansion", "5.0.13")).toBe(false);
    expect(isVulnerable("minimatch", "3.1.5")).toBe(false);
  });

  it("fails a pre-release or build-tagged version of a listed package instead of comparing it", () => {
    expect(isVulnerable("hono", "4.13.16-rc.1")).toBe(true);
    expect(isVulnerable("hono", "4.13.13+build.1")).toBe(true);
    expect(isVulnerable("left-pad", "1.0.0-rc.1")).toBe(false);
  });

  it("flags every test-exclude release from 7.0.0, as the audit does", () => {
    expect(isVulnerable("test-exclude", "6.0.0")).toBe(false);
    expect(isVulnerable("test-exclude", "7.0.2")).toBe(true);
  });

  it("finds a listed package installed under another folder name, and not a look-alike", () => {
    const packages = {
      "node_modules/hono-legacy": { name: "hono", version: "4.13.13" },
      "node_modules/xhono": { version: "4.13.13" },
      "node_modules/a/node_modules/hono": { version: "4.13.13" }
    };
    expect(vulnerableCopies(packages, "hono")).toEqual(["node_modules/hono-legacy@4.13.13", "node_modules/a/node_modules/hono@4.13.13"]);
  });
});
