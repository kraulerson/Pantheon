/**
 * Mount-aware rendering (design 2026-08-27, "harness under the chat address"): the VM's Caddy
 * strips `/harness` on the chat site and says so in `X-Forwarded-Prefix`; every link, redirect,
 * asset and socket URL is built with that base. Anything but a clean prefix fails closed to root.
 */

import { describe, it, expect } from "vitest";
import { basePathFrom, withBase, BASE_PATH_HEADER } from "../src/http/base-path.js";

describe("basePathFrom — the prefix Caddy tells us about, validated", () => {
  it("is empty without the header and equals a clean prefix with it", () => {
    expect(BASE_PATH_HEADER).toBe("x-forwarded-prefix");
    expect(basePathFrom({})).toBe("");
    expect(basePathFrom({ "x-forwarded-prefix": "/harness" })).toBe("/harness");
    expect(basePathFrom({ "x-forwarded-prefix": "/a/b-2/c3" })).toBe("/a/b-2/c3");
  });

  it("fails closed to root on anything that is not a clean prefix", () => {
    for (const bad of ["/harness/", "harness", "//x", "/..", "/a/../b", "/%2e", "http://evil", "/UPPER", "/a/b/c/d", "/a?b", "/a b", "/a#b", "", "/"]) {
      expect(basePathFrom({ "x-forwarded-prefix": bad }), bad).toBe("");
    }
    expect(basePathFrom({ "x-forwarded-prefix": ["/harness", "/other"] })).toBe("");
    expect(basePathFrom({ "x-forwarded-prefix": 42 as unknown as string })).toBe("");
  });
});

describe("withBase — one way to build every URL", () => {
  it("prefixes absolute paths and leaves root alone", () => {
    expect(withBase("", "/harness")).toBe("/harness");
    expect(withBase("/harness", "/harness")).toBe("/harness/harness");
    expect(withBase("/harness", "/admin/config?notice=x")).toBe("/harness/admin/config?notice=x");
    expect(withBase("/harness", "/")).toBe("/harness/");
    expect(withBase("", "/")).toBe("/");
  });

  it("refuses a non-absolute path (a relative link would silently escape the base)", () => {
    expect(() => withBase("/harness", "admin/config")).toThrow(/absolute/);
    expect(() => withBase("/harness", "//evil.example/x")).toThrow(/absolute/);
  });
});
