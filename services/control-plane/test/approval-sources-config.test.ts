/**
 * `PANTHEON_APPROVAL_SOURCES` — extra approval stores the inbox and the keycard door read besides
 * this host's Peta (BUGS #42: Alden's capability gateway has its own Peta). JSON in the env; a
 * malformed value fails LOUD at startup rather than silently reading fewer stores.
 */

import { describe, it, expect } from "vitest";
import { approvalSourcesFrom, LOCAL_SOURCE_LABEL } from "../src/approvals/sources.js";

describe("approvalSourcesFrom", () => {
  it("is empty when unset or blank", () => {
    expect(approvalSourcesFrom(undefined)).toEqual([]);
    expect(approvalSourcesFrom("")).toEqual([]);
    expect(approvalSourcesFrom("  ")).toEqual([]);
  });

  it("parses a JSON list of { label, url, token } with an origin-only url", () => {
    const out = approvalSourcesFrom('[{"label":"Alden gateway","url":"http://10.100.23.88:3002","token":"abc"}]');
    expect(out).toEqual([{ label: "Alden gateway", url: "http://10.100.23.88:3002", token: "abc" }]);
  });

  it("fails loud on anything malformed, naming the entry but never echoing a token", () => {
    const bad: Array<[string, RegExp]> = [
      ["not json", /PANTHEON_APPROVAL_SOURCES.*JSON/],
      ['{"label":"x"}', /list/],
      ['[{"label":"","url":"http://h:1","token":"t"}]', /label/],
      ['[{"label":"Alden gateway","url":"http://h:1/admin","token":"t"}]', /url/],
      ['[{"label":"Alden gateway","url":"ftp://h","token":"t"}]', /url/],
      ['[{"label":"Alden gateway","url":"http://h:1","token":""}]', /token/],
      ['[{"label":"Alden gateway","url":"http://h:1","token":"SECRET-TOKEN-VALUE"},{"label":"Alden gateway","url":"http://h:2","token":"t"}]', /duplicate/],
      [`[{"label":"${LOCAL_SOURCE_LABEL}","url":"http://h:1","token":"t"}]`, /reserved/]
    ];
    for (const [raw, re] of bad) {
      let msg = "";
      try { approvalSourcesFrom(raw); } catch (e) { msg = (e as Error).message; }
      expect(msg, raw).toMatch(re);
      expect(msg).not.toContain("SECRET-TOKEN-VALUE");
    }
  });
});
