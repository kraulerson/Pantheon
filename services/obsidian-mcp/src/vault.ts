/**
 * Vault core — the pure, testable heart of the Obsidian/filesystem MCP server (#8).
 *
 * Every operation is confined to a single configured `VAULT_DIR`. Direct writes land
 * in the vault; Obsidian LiveSync/CouchDB propagates them (REQUIREMENTS-SOURCE #8).
 *
 * SECURITY (non-negotiable, fail-closed CC2): every relative path is resolved against
 * the vault root and any path that escapes — `../`, absolute paths, `..` segments, or a
 * symlink whose real target is outside the root — is rejected with PathTraversalError
 * BEFORE any fs read/write touches disk. The write tool is the sensitive one
 * (`dangerLevel: 2` behind Peta); read/list/search are frictionless.
 *
 * This module is transport-agnostic on purpose: server.ts wires it to MCP. Keeping the
 * logic pure makes the path-safety guarantees exhaustively unit-testable.
 */
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  readdir,
  realpath
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";

/** Thrown when a requested path would escape the configured vault root. */
export class PathTraversalError extends Error {
  constructor(requested: string) {
    super(`Path "${requested}" resolves outside the vault root and was rejected.`);
    this.name = "PathTraversalError";
  }
}

export type WriteMode = "overwrite" | "append";

export interface WriteOptions {
  /** "overwrite" (default) replaces the note; "append" adds without clobbering. */
  readonly mode?: WriteMode;
}

export interface SearchOptions {
  /** Treat the query as a JS regular expression instead of a literal substring. */
  readonly regex?: boolean;
}

export interface SearchHit {
  /** Vault-relative, posix-style path of the matching note. */
  readonly path: string;
  /** 1-based line number of the match. */
  readonly line: number;
  /** The full matching line. */
  readonly text: string;
}

const NOTE_EXT = ".md";

/** Normalize OS-specific separators to posix for stable, vault-relative paths. */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export class Vault {
  /** Absolute, normalized vault root. */
  public readonly root: string;

  constructor(vaultDir: string) {
    this.root = resolve(vaultDir);
  }

  /**
   * Resolve a vault-relative path to an absolute path, rejecting anything that
   * escapes the root. This is the lexical (pre-fs) guard: absolute paths and any
   * `..` traversal are refused before we go near the disk.
   */
  private resolveInside(relPath: string): string {
    // Reject absolute inputs outright (incl. Windows-style backslash separators).
    const candidate = relPath.split("\\").join("/");
    if (isAbsolute(relPath) || isAbsolute(candidate)) {
      throw new PathTraversalError(relPath);
    }
    const abs = resolve(this.root, candidate);
    const rel = relative(this.root, abs);
    // Escapes if the relative path climbs out (starts with "..") or is itself absolute.
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      throw new PathTraversalError(relPath);
    }
    return abs;
  }

  /**
   * Stronger guard for existing paths: resolve symlinks via realpath and confirm the
   * real target is still inside the (real) vault root. Defends against symlink traversal.
   */
  private async assertRealInside(abs: string, requested: string): Promise<void> {
    const realRoot = await realpath(this.root);
    const realTarget = await realpath(abs);
    const rel = relative(realRoot, realTarget);
    if (rel !== "" && (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))) {
      throw new PathTraversalError(requested);
    }
  }

  /** READ — list vault-relative note paths, optionally scoped to a subfolder. */
  async list(subfolder?: string): Promise<string[]> {
    const base = subfolder ? this.resolveInside(subfolder) : this.root;
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // missing/empty scope -> empty listing
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile() && e.name.toLowerCase().endsWith(NOTE_EXT)) {
          out.push(toPosix(relative(this.root, full)));
        }
      }
    };
    await walk(base);
    return out.sort();
  }

  /** READ — return a note's content by vault-relative path. */
  async read(relPath: string): Promise<string> {
    const abs = this.resolveInside(relPath);
    await this.assertRealInside(abs, relPath);
    return readFile(abs, "utf8");
  }

  /** READ — substring (default) or regex search across all notes. */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const matcher = opts.regex
      ? new RegExp(query)
      : { test: (line: string): boolean => line.includes(query) };
    const hits: SearchHit[] = [];
    for (const path of await this.list()) {
      const content = await this.read(path);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? "";
        if (matcher.test(text)) {
          hits.push({ path, line: i + 1, text });
        }
      }
    }
    return hits;
  }

  /**
   * WRITE (sensitive, dangerLevel:2 behind Peta) — create or append/overwrite a note,
   * creating parent dirs. Path-safety is enforced before any fs mutation. If a parent
   * directory is a symlink escaping the vault, the realpath guard rejects it.
   */
  async write(relPath: string, content: string, opts: WriteOptions = {}): Promise<void> {
    const abs = this.resolveInside(relPath);
    const parent = dirname(abs);
    await mkdir(parent, { recursive: true });
    // Re-validate against symlinks now that the parent chain exists on disk.
    await this.assertRealInside(parent, relPath);
    if (opts.mode === "append") {
      await appendFile(abs, content, "utf8");
    } else {
      await writeFile(abs, content, "utf8");
    }
  }
}
