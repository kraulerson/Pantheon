import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Vault, PathTraversalError } from "../src/vault.js";

let root: string;
let vault: Vault;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vault-test-"));
  vault = new Vault(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("write / read / list / search round-trip", () => {
  it("write creates a file with content; read returns it", async () => {
    await vault.write("notes/hello.md", "Hello vault");
    expect(existsSync(join(root, "notes", "hello.md"))).toBe(true);
    expect(await vault.read("notes/hello.md")).toBe("Hello vault");
  });

  it("write creates missing parent directories", async () => {
    await vault.write("a/b/c/deep.md", "deep");
    expect(await vault.read("a/b/c/deep.md")).toBe("deep");
  });

  it("list shows written notes (recursively), relative + posix-style", async () => {
    await vault.write("top.md", "x");
    await vault.write("sub/nested.md", "y");
    const listed = await vault.list();
    expect(listed).toContain("top.md");
    expect(listed).toContain("sub/nested.md");
  });

  it("list only returns note files, not directories, and ignores non-md by default", async () => {
    await vault.write("keep.md", "x");
    mkdirSync(join(root, "emptydir"));
    writeFileSync(join(root, "image.png"), "binary");
    const listed = await vault.list();
    expect(listed).toContain("keep.md");
    expect(listed).not.toContain("emptydir");
    expect(listed).not.toContain("image.png");
  });

  it("list can be scoped to a subfolder", async () => {
    await vault.write("root.md", "x");
    await vault.write("sub/a.md", "x");
    await vault.write("sub/b.md", "x");
    const listed = await vault.list("sub");
    expect(listed.sort()).toEqual(["sub/a.md", "sub/b.md"]);
  });

  it("search finds a substring and returns path + matching line", async () => {
    await vault.write("one.md", "the quick brown fox\nsecond line");
    await vault.write("two.md", "nothing here");
    const hits = await vault.search("quick brown");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("one.md");
    expect(hits[0]?.line).toBe(1);
    expect(hits[0]?.text).toContain("quick brown");
  });

  it("search supports regex mode", async () => {
    await vault.write("r.md", "foo123bar\nbaz");
    const hits = await vault.search("foo\\d+bar", { regex: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("r.md");
  });

  it("search returns multiple matches across files", async () => {
    await vault.write("a.md", "alpha\ntoken\nomega");
    await vault.write("b.md", "token at top");
    const hits = await vault.search("token");
    expect(hits.map((h) => h.path).sort()).toEqual(["a.md", "b.md"]);
  });
});

describe("append vs overwrite", () => {
  it("append mode adds without clobbering existing content", async () => {
    await vault.write("log.md", "line1\n");
    await vault.write("log.md", "line2\n", { mode: "append" });
    expect(await vault.read("log.md")).toBe("line1\nline2\n");
  });

  it("overwrite (default) replaces content", async () => {
    await vault.write("o.md", "original");
    await vault.write("o.md", "replaced");
    expect(await vault.read("o.md")).toBe("replaced");
  });

  it("append to a non-existent file creates it", async () => {
    await vault.write("new.md", "first", { mode: "append" });
    expect(await vault.read("new.md")).toBe("first");
  });

  it("write is observable/idempotent for later gating: same path+content yields same read", async () => {
    await vault.write("idem.md", "stable");
    await vault.write("idem.md", "stable");
    expect(await vault.read("idem.md")).toBe("stable");
    expect((await vault.list()).filter((p) => p === "idem.md")).toHaveLength(1);
  });
});

describe("CRITICAL: path-traversal rejection (no fs op outside the vault)", () => {
  const outside = () => join(root, "..", "outside.md");

  it("rejects a relative ../ escape on write and writes NOTHING outside", async () => {
    const before = existsSync(outside());
    await expect(vault.write("../outside.md", "evil")).rejects.toBeInstanceOf(PathTraversalError);
    expect(existsSync(outside())).toBe(before);
    expect(existsSync(outside())).toBe(false);
  });

  it("rejects a relative ../ escape on read without touching the fs", async () => {
    // Plant a real file just outside the vault; read must still refuse.
    writeFileSync(outside(), "secret-outside");
    await expect(vault.read("../outside.md")).rejects.toBeInstanceOf(PathTraversalError);
    rmSync(outside(), { force: true });
  });

  it("rejects absolute paths", async () => {
    await expect(vault.write("/etc/evil.md", "evil")).rejects.toBeInstanceOf(PathTraversalError);
    await expect(vault.read("/etc/passwd")).rejects.toBeInstanceOf(PathTraversalError);
    expect(existsSync("/etc/evil.md")).toBe(false);
  });

  it("rejects nested .. segments that escape even when prefixed", async () => {
    await expect(vault.write("sub/../../escape.md", "evil")).rejects.toBeInstanceOf(
      PathTraversalError
    );
    expect(existsSync(join(root, "..", "escape.md"))).toBe(false);
  });

  it("rejects a backslash/windows-separator path with .. segments", async () => {
    await expect(vault.write("..\\outside.md", "evil")).rejects.toBeInstanceOf(PathTraversalError);
  });

  it("rejects a symlink that points outside the vault", async () => {
    const { symlinkSync } = await import("node:fs");
    const linkTarget = mkdtempSync(join(tmpdir(), "vault-outside-"));
    writeFileSync(join(linkTarget, "secret.md"), "outside-secret");
    symlinkSync(linkTarget, join(root, "link"));
    try {
      await expect(vault.read("link/secret.md")).rejects.toBeInstanceOf(PathTraversalError);
      await expect(vault.write("link/planted.md", "evil")).rejects.toBeInstanceOf(
        PathTraversalError
      );
      expect(existsSync(join(linkTarget, "planted.md"))).toBe(false);
    } finally {
      rmSync(linkTarget, { recursive: true, force: true });
    }
  });

  it("allows a benign path containing dots that does NOT escape", async () => {
    await vault.write("notes/v1.2.3.md", "ok");
    expect(await vault.read("notes/v1.2.3.md")).toBe("ok");
  });

  it("error message names the offending path", async () => {
    await expect(vault.write("../x.md", "y")).rejects.toThrow(/outside the vault/i);
  });

  it("list scoped to an escaping subfolder is rejected", async () => {
    await expect(vault.list("../")).rejects.toBeInstanceOf(PathTraversalError);
  });
});

describe("read errors for legitimate-but-missing files", () => {
  it("read of a missing in-vault note throws a non-traversal error", async () => {
    await expect(vault.read("does-not-exist.md")).rejects.toThrow();
    await expect(vault.read("does-not-exist.md")).rejects.not.toBeInstanceOf(PathTraversalError);
  });

  it("list of an empty vault returns []", async () => {
    expect(await vault.list()).toEqual([]);
  });

  it("resolves the vault root absolutely regardless of cwd-relative construction", () => {
    // Constructing with a non-normalized root still confines correctly.
    const v2 = new Vault(join(root, "sub", ".."));
    expect(v2.root.endsWith(sep + root.split(sep).pop())).toBe(true);
  });
});
