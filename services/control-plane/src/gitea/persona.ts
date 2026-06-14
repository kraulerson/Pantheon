/**
 * persona loading — resolves an identity's system-prompt text from its Gitea repo.
 *
 * PRIVILEGED CONTROL-PLANE PROVISIONING PATH (see client.ts header): runs under
 * the admin token behind the strongest auth tier. Reads only; the session write
 * path stays subject to the taint/approval gate (separate concern).
 */

import type { GiteaFile } from "./types.js";

export type { GiteaFile } from "./types.js";

/** Minimal read surface needed to load a persona (satisfied by GiteaClient). */
export interface GiteaFileReader {
  getFile(owner: string, repo: string, path: string, ref?: string): Promise<GiteaFile>;
}

export interface PersonaRepoRef {
  readonly owner: string;
  readonly repo: string;
  readonly ref?: string;
}

/**
 * Load the persona / system-prompt text for an identity from its Gitea repo.
 * Returns the trimmed file body. Throws if the file is empty/whitespace.
 */
export async function loadPersona(
  repoRef: PersonaRepoRef,
  path: string,
  client: GiteaFileReader
): Promise<string> {
  const file = await client.getFile(repoRef.owner, repoRef.repo, path, repoRef.ref);
  const text = file.content.trim();
  if (text.length === 0) {
    throw new Error(
      `persona at ${repoRef.owner}/${repoRef.repo}:${path} is empty`
    );
  }
  return text;
}
