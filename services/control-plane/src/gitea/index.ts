/**
 * Gitea direct client (PRIVILEGED control-plane provisioning path).
 * Construct from env: GITEA_BASE_URL + GITEA_TOKEN (token never logged).
 */

export { GiteaClient, GiteaError } from "./client.js";
export { loadPersona } from "./persona.js";
export type { GiteaFileReader, PersonaRepoRef } from "./persona.js";
export type {
  CreateRepoInput,
  GiteaClientConfig,
  GiteaFile,
  GiteaRepo,
  GiteaVersion,
  GiteaWriteResult
} from "./types.js";
