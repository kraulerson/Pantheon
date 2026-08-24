/**
 * Guarded live integration test against a real Gitea.
 *
 * Runs ONLY if GITEA_TOKEN is set AND GET {GITEA_BASE_URL}/api/v1/version is
 * reachable. Env is loaded from services/control-plane/.env.local (gitignored).
 * The admin token is read from env only — never hardcoded, never logged.
 *
 * Flow: create a throwaway private repo `pantheon-eval-<rand>` (auto_init) →
 * writeFile persona.md → getFile round-trip → loadPersona → listRepos includes
 * it → deleteRepo cleanup (in finally). If unreachable / no token: SKIP.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GiteaClient, GiteaError } from "../src/gitea/client.js";
import { loadPersona } from "../src/gitea/persona.js";

const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../.env.local");
if (existsSync(ENV_PATH)) {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    /* ignore malformed env; guard below handles missing token */
  }
}

const BASE = process.env["GITEA_BASE_URL"] ?? "";
const TOKEN = process.env["GITEA_TOKEN"] ?? "";

async function versionReachable(): Promise<boolean> {
  if (!BASE || !TOKEN) return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2500);
    const r = await fetch(`${BASE}/api/v1/version`, {
      signal: ac.signal,
      headers: { Authorization: `token ${TOKEN}` }
    });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

describe("GiteaClient — live round-trip (guarded)", () => {
  let reachable = false;

  beforeAll(async () => {
    reachable = await versionReachable();
    if (!reachable) {
      console.warn(`[gitea-live] SKIP: no GITEA_TOKEN or ${BASE || "<unset>"}/api/v1/version unreachable`);
    }
  });

  it("creates a private repo, writes/reads persona.md, lists, then deletes it", async (ctx) => {
    if (!reachable) {
      ctx.skip();
      return;
    }
    const client = new GiteaClient({ baseUrl: BASE, token: TOKEN });
    const name = `pantheon-eval-${Math.random().toString(36).slice(2, 10)}`;

    // The beforeAll guard only proves the token is valid and Gitea is reachable — NOT that the
    // token carries the write scope this round-trip needs. A minimal-scope token (the deliberate
    // F2 rotation, scope write:repository/read:user) 403s on createRepo. That is a SKIP, not a
    // failure — never widen the token to make this pass (BUGS #14).
    let repo;
    try {
      repo = await client.createRepo({ name });
    } catch (e) {
      if (e instanceof GiteaError && e.status === 403) { ctx.skip(); return; }
      throw e;
    }
    expect(repo.name).toBe(name);
    expect(repo.private).toBe(true);
    const owner = repo.owner?.login ?? repo.full_name.split("/")[0]!;

    try {
      const personaText = `# Persona ${name}\nYou are a throwaway eval identity.\n`;
      await client.writeFile(owner, name, "persona.md", personaText, "add persona");

      const fetched = await client.getFile(owner, name, "persona.md");
      expect(fetched.content).toBe(personaText);

      const viaPersona = await loadPersona({ owner, repo: name }, "persona.md", client);
      expect(viaPersona).toBe(personaText.trim());

      const repos = await client.listRepos();
      expect(repos.some((r) => r.name === name)).toBe(true);
    } finally {
      await client.deleteRepo(owner, name);
    }

    await expect(client.getRepo(owner, name)).rejects.toMatchObject({ status: 404 });
  }, 30_000);
});
