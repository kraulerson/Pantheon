/**
 * Typed Gitea REST API v1 shapes used by the control-plane provisioning path.
 * Only the fields this client reads/writes are modeled (the API returns more).
 */

export interface GiteaClientConfig {
  /** Base URL of the Gitea instance, e.g. https://gitea.example.com (no /api/v1). */
  readonly baseUrl: string;
  /** Admin/personal access token. Sent as `Authorization: token <T>`; never logged. */
  readonly token: string;
}

export interface GiteaVersion {
  readonly version: string;
}

/** Decoded file: `content` is the UTF-8 text (already base64-decoded). */
export interface GiteaFile {
  readonly name?: string;
  readonly path: string;
  readonly sha: string;
  readonly content: string;
}

export interface GiteaWriteResult {
  readonly content: { readonly sha: string; readonly path: string };
  readonly commit: { readonly sha: string };
}

export interface GiteaRepo {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly private: boolean;
  readonly owner?: { readonly login: string };
}

export interface CreateRepoInput {
  readonly name: string;
  /** "owner/repo" of a template repo; uses the generate-from-template endpoint. */
  readonly fromTemplate?: string;
  /** Defaults to true (provisioned identity repos are private). */
  readonly private?: boolean;
  /** Defaults to true (initialize with a commit so writes have a base). */
  readonly autoInit?: boolean;
}
