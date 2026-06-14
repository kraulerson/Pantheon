/**
 * Alden Bridge integration — public barrel.
 *
 * Typed MCP client for the bridge's read-only memory + mailbox tools. The Bearer token is
 * sourced from env and never logged (see client.ts).
 */

export {
  BridgeClient,
  BridgeError,
  bridgeClientFromEnv,
  type BridgeClientOptions,
  type MemoryCollection,
  type MemoryHit,
  type MemorySearchArgs,
  type MemorySearchPort,
  type MailboxMessage,
  type MailboxListArgs,
  type MailboxListPort,
  type MailboxCheckResult
} from "./client.js";
