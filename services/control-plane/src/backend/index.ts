/**
 * Backend module — public barrel. Forwards OpenAI-compatible chat-completions to a
 * registry-resolved backend (§3 ADR). Anthropic + streaming are documented seams.
 */

export {
  BackendClient,
  BackendError,
  type ChatBackend,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type BackendClientOptions
} from "./client.js";
