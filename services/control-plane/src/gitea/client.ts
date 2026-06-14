/**
 * GiteaClient — typed direct client for the Gitea REST API v1.
 *
 * PRIVILEGED CONTROL-PLANE PROVISIONING PATH. This module uses the admin token
 * and MUST sit behind the strongest auth tier. It provisions identity repos and
 * loads personas. It is NOT the session write path: session-driven Gitea writes
 * remain subject to the taint / approval gate (a separate concern, not here).
 *
 * Security invariants:
 *  - The token is read from config (env-sourced) only; it is NEVER hardcoded.
 *  - The token is NEVER written to logs, thrown errors, error `.url`, or stacks.
 */

import type {
  CreateRepoInput,
  GiteaClientConfig,
  GiteaFile,
  GiteaRepo,
  GiteaVersion,
  GiteaWriteResult
} from "./types.js";

/** Typed error for any non-2xx Gitea response. Carries status + sanitized URL. */
export class GiteaError extends Error {
  readonly status: number;
  /** Request path WITHOUT host or query string — never carries the token. */
  readonly url: string;

  constructor(status: number, apiMessage: string, path: string) {
    super(`Gitea API ${status}: ${apiMessage}`);
    this.name = "GiteaError";
    this.status = status;
    this.url = path;
  }
}

/** URL-encode each path segment while preserving "/" separators. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

export class GiteaClient {
  readonly baseUrl: string;
  readonly #token: string;

  constructor(config: GiteaClientConfig) {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    if (!baseUrl) throw new Error("GiteaClient: baseUrl is required");
    if (!config.token) throw new Error("GiteaClient: token is required");
    this.baseUrl = baseUrl;
    this.#token = config.token;
  }

  async getVersion(): Promise<GiteaVersion> {
    return this.#request<GiteaVersion>("GET", "/version");
  }

  /** Read + decode a file's content (used by persona loading). */
  async getFile(owner: string, repo: string, path: string, ref?: string): Promise<GiteaFile> {
    const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const apiPath = `/repos/${owner}/${repo}/contents/${encodePath(path)}${q}`;
    const raw = await this.#request<{
      name?: string;
      path?: string;
      sha: string;
      encoding?: string;
      content?: string;
    }>("GET", apiPath);
    if (raw.encoding !== "base64" || typeof raw.content !== "string") {
      throw new GiteaError(
        200,
        `unexpected file encoding "${raw.encoding ?? "none"}" for ${path}`,
        `/repos/${owner}/${repo}/contents/${path}`
      );
    }
    const decoded = Buffer.from(raw.content, "base64").toString("utf8");
    const file: GiteaFile = { path: raw.path ?? path, sha: raw.sha, content: decoded };
    return raw.name === undefined ? file : { ...file, name: raw.name };
  }

  /**
   * Create or update a file (write-scoped, control-plane provisioning).
   * `content` may be plain text or already-base64; it is sent base64-encoded.
   */
  async writeFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    branch?: string
  ): Promise<GiteaWriteResult> {
    const apiPath = `/repos/${owner}/${repo}/contents/${encodePath(path)}`;
    const body: Record<string, unknown> = {
      content: toBase64(content),
      message
    };
    if (branch) body["branch"] = branch;
    return this.#request<GiteaWriteResult>("POST", apiPath, body);
  }

  async createRepo(input: CreateRepoInput): Promise<GiteaRepo> {
    const isPrivate = input.private ?? true;
    const autoInit = input.autoInit ?? true;
    if (input.fromTemplate) {
      return this.#request<GiteaRepo>("POST", `/repos/${input.fromTemplate}/generate`, {
        name: input.name,
        private: isPrivate
      });
    }
    return this.#request<GiteaRepo>("POST", "/user/repos", {
      name: input.name,
      private: isPrivate,
      auto_init: autoInit
    });
  }

  async getRepo(owner: string, repo: string): Promise<GiteaRepo> {
    return this.#request<GiteaRepo>("GET", `/repos/${owner}/${repo}`);
  }

  async listRepos(): Promise<readonly GiteaRepo[]> {
    return this.#request<GiteaRepo[]>("GET", "/user/repos");
  }

  async deleteRepo(owner: string, repo: string): Promise<void> {
    await this.#request<void>("DELETE", `/repos/${owner}/${repo}`);
  }

  async #request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      // Token auth per Gitea docs. Sanitized out of any error below.
      Authorization: `token ${this.#token}`,
      Accept: "application/json"
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    // Path without query, for error reporting (never contains the token).
    const pathOnly = apiPath.split("?")[0] ?? apiPath;
    const res = await fetch(`${this.baseUrl}/api/v1${apiPath}`, init);

    if (!res.ok) {
      let apiMessage = res.statusText || "request failed";
      try {
        const parsed = (await res.json()) as { message?: string };
        if (parsed && typeof parsed.message === "string") apiMessage = parsed.message;
      } catch {
        /* non-JSON error body: keep statusText, do not echo raw body (avoid leaks) */
      }
      throw new GiteaError(res.status, apiMessage, pathOnly);
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** Encode text→base64; if `value` is already valid base64, pass it through. */
function toBase64(value: string): string {
  const b64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (value.length > 0 && value.length % 4 === 0 && b64.test(value)) {
    const round = Buffer.from(value, "base64").toString("base64");
    if (round === value) return value;
  }
  return Buffer.from(value, "utf8").toString("base64");
}
