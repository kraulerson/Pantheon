/**
 * BackendClient — forwards an OpenAI-compatible chat-completions request to a registry-resolved
 * backend's endpoint (PROJECT_BIBLE §3 ADR: the control-plane is an OpenAI-compatible
 * pre-processor in front of the model).
 *
 * "OpenAI-compatible" = the chat-completions WIRE FORMAT only; there is NO connection to
 * OpenAI the company. Alden-1 (local Qwen) speaks this format natively.
 *
 * Scope of THIS increment:
 *  - NON-STREAMING path implemented fully: POST {scheme}://{endpoint}/v1/chat/completions.
 *  - STREAMING (SSE `stream:true`) is a DOCUMENTED SEAM — see {@link chatCompletionsStream}.
 *  - ANTHROPIC/Claude backends need a request/response TRANSLATION SEAM (OpenAI wire ⇆
 *    Anthropic Messages API). Left unwired this increment — throws a clear error.
 */

import type { Backend } from "../registry/types.js";

/** Minimal OpenAI chat-completions request shape (only the fields we depend on are typed). */
export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly max_tokens?: number;
  readonly temperature?: number;
  /** Streaming is a documented seam this increment; non-streaming is the implemented path. */
  readonly stream?: boolean;
  readonly [k: string]: unknown;
}

export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: string;
  readonly choices: ReadonlyArray<{
    readonly index: number;
    readonly message?: { readonly role: string; readonly content: string };
    readonly finish_reason?: string | null;
  }>;
  readonly [k: string]: unknown;
}

/** Thrown on transport failure or a non-2xx backend response (fail closed — no empty completion). */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly backendId: string
  ) {
    super(message);
    this.name = "BackendError";
  }
}

/** Backend kinds that speak the OpenAI chat-completions wire format directly. */
const OPENAI_WIRE_KINDS: ReadonlySet<Backend["kind"]> = new Set([
  "local_alden1",
  "future_local_7900xtx",
  "future_cloud"
]);

export interface BackendClientOptions {
  /** Override fetch (tests). */
  readonly fetchFn?: typeof fetch;
  /** Scheme for the backend endpoint (registry stores host:port without a scheme). Default http. */
  readonly scheme?: "http" | "https";
}

export class BackendClient {
  private readonly fetchFn: typeof fetch;
  private readonly scheme: string;

  constructor(opts: BackendClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.scheme = opts.scheme ?? "http";
  }

  /**
   * Forward a NON-STREAMING chat-completions request to the given backend.
   * @throws {BackendError} on transport error or non-2xx response (fail closed).
   */
  async chatCompletions(backend: Backend, req: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    // ---- ANTHROPIC / CLAUDE TRANSLATION SEAM ----
    // claude_cli speaks the Anthropic Messages API, not OpenAI chat-completions. Translating
    // request+response (system handling, content blocks, stop reasons, tool calls) is a later
    // increment. Fail closed until wired.
    if (!OPENAI_WIRE_KINDS.has(backend.kind)) {
      throw new BackendError(
        `anthropic translation not yet wired (backend kind: ${backend.kind})`,
        0,
        backend.id
      );
    }

    if (req.stream === true) {
      // ---- STREAMING SEAM (documented, not implemented this increment) ----
      // SSE pass-through (text/event-stream, `data:` chunks, `[DONE]`) needs the route to stream
      // the upstream body straight through. Implement in the streaming increment.
      throw new BackendError("streaming not yet implemented (documented seam)", 0, backend.id);
    }

    const url = `${this.scheme}://${backend.endpoint}/v1/chat/completions`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...req, stream: false })
      });
    } catch (cause) {
      throw new BackendError(`backend transport error: ${String(cause)}`, 0, backend.id);
    }
    if (!res.ok) {
      throw new BackendError(`backend returned HTTP ${res.status}`, res.status, backend.id);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new BackendError("backend returned an unparseable body", res.status, backend.id);
    }
    return body as ChatCompletionResponse;
  }
}

/** Interface the pre-processor depends on (kept narrow so tests can substitute a spy). */
export interface ChatBackend {
  chatCompletions(backend: Backend, req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}
