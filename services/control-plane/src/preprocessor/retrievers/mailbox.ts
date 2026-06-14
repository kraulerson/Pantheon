/**
 * MailboxRetriever — recent inter-Alden messages via the Alden Bridge (#13).
 *
 * Uses alden_mailbox_list (NON-DESTRUCTIVE) with since_id high-water polling, so messages
 * already surfaced in this process are not re-surfaced — and crucially we never call
 * alden_mailbox_read, which marks-read and would consume Cloud Alden's heartbeat.
 *
 * NOTE — SHARED BUS: the bridge mailbox is a single SHARED broadcast bus. `recipient` is NOT
 * routed by the bridge (there is no per-identity delivery), so per-identity mailbox filtering
 * does not exist at the bridge. The harness simply surfaces recent messages as UNTRUSTED
 * context (trusted:false) for whatever identity is active.
 */

import type { GroundingRetriever, RetrievedItem } from "../retriever.js";
import type { MailboxListPort, MailboxMessage } from "../../bridge/client.js";

export interface MailboxRetrieverOptions {
  /** Messages per poll (bridge default 100; clamp 1..500). */
  readonly limit?: number;
}

function recalledMailboxItem(m: MailboxMessage): RetrievedItem {
  return {
    source: "mailbox",
    trusted: false,
    content: m.message,
    label: `UNTRUSTED — mailbox #${m.id} from ${m.sender} @${m.timestamp}`
  };
}

export class MailboxRetriever implements GroundingRetriever {
  private readonly port: MailboxListPort;
  private readonly limit: number | undefined;
  /** Highest message id surfaced so far; the next poll resumes strictly after it. */
  private highWater: number | undefined;

  constructor(port: MailboxListPort, opts: MailboxRetrieverOptions = {}) {
    this.port = port;
    this.limit = opts.limit;
  }

  async retrieve(_identityId: string | null, _userInput: string): Promise<RetrievedItem[]> {
    let messages: MailboxMessage[];
    try {
      messages = await this.port.mailboxList({
        ...(this.highWater !== undefined ? { sinceId: this.highWater } : {}),
        ...(this.limit !== undefined ? { limit: this.limit } : {})
      });
    } catch {
      console.warn("[mailbox-retriever] mailbox list failed");
      return [];
    }
    // Advance the high-water mark past the highest id seen this poll.
    for (const m of messages) {
      if (this.highWater === undefined || m.id > this.highWater) this.highWater = m.id;
    }
    return messages.map(recalledMailboxItem);
  }
}
