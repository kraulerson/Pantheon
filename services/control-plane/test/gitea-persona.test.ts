/**
 * loadPersona unit tests (always run; the GiteaClient is mocked).
 * loadPersona resolves an identity's system-prompt text from its Gitea repo.
 */

import { describe, it, expect } from "vitest";
import { loadPersona } from "../src/gitea/persona.js";
import type { GiteaFile, GiteaFileReader } from "../src/gitea/persona.js";

function fakeClient(file: GiteaFile, capture?: (a: string[]) => void): GiteaFileReader {
  return {
    async getFile(owner, repo, path, ref) {
      capture?.([owner, repo, path, ref ?? ""]);
      return file;
    }
  };
}

describe("loadPersona", () => {
  it("returns the decoded persona text from {owner,repo,ref}", async () => {
    const persona = "You are Athena, goddess of wisdom.";
    const seen: string[] = [];
    const text = await loadPersona(
      { owner: "athena", repo: "identity", ref: "main" },
      "persona.md",
      fakeClient({ name: "persona.md", path: "persona.md", sha: "s", content: persona }, (a) => {
        seen.push(...a);
      })
    );
    expect(text).toBe(persona);
    expect(seen).toEqual(["athena", "identity", "persona.md", "main"]);
  });

  it("trims surrounding whitespace from the persona body", async () => {
    const text = await loadPersona(
      { owner: "o", repo: "r" },
      "p.md",
      fakeClient({ name: "p.md", path: "p.md", sha: "s", content: "\n\n  hello  \n" })
    );
    expect(text).toBe("hello");
  });

  it("throws if the persona file is empty", async () => {
    await expect(
      loadPersona(
        { owner: "o", repo: "r" },
        "p.md",
        fakeClient({ name: "p.md", path: "p.md", sha: "s", content: "   \n  " })
      )
    ).rejects.toThrow();
  });
});
