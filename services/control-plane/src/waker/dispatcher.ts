/**
 * The gate every wake passes through (TP-1 + TP-5; ADR-0009).
 *
 * Order is deliberate: **configured -> allowlisted -> rate cap -> idle**. A wake that is not
 * allowed never reaches the rate cap (a refusal must not consume budget), and a wake that is
 * allowed but arrives mid-turn is HELD rather than dropped — delivering it would break the
 * session's turn and bust its prompt cache. Everything held during one busy turn coalesces into a
 * SINGLE wake: a burst of mail is one interruption, not twenty.
 */

import type { PairAllowlist } from "./allowlist.js";
import type { SlidingWindowCap } from "./rate-cap.js";
import { buildWake, type Wake, type WakeableMessage, type WakeOptions } from "./wake.js";

/** XC-6: dispatching with no allowlist configured is a programming error, not a silent allow. */
export class WakerNotConfiguredError extends Error {
  constructor() {
    super("session waker: no allowlist configured — dispatch refused (XC-6, deny by default)");
    this.name = "WakerNotConfiguredError";
  }
}

export type DispatchResult =
  | { readonly state: "sent" }
  | { readonly state: "denied"; readonly reason: "not_allowlisted"; readonly pair: string }
  | { readonly state: "rate_limited"; readonly retryAfterMs: number }
  | { readonly state: "held"; readonly reason: "session_busy" | "send_failed" };

export interface WakeDispatcherDeps {
  readonly allowlist: PairAllowlist;
  readonly cap: SlidingWindowCap;
  /** True when the session is between turns — the only moment a wake may be delivered. */
  readonly isIdle: () => boolean;
  readonly send: (wake: Wake) => Promise<void>;
}

export class WakeDispatcher {
  private held: WakeableMessage[] = [];
  private heldOpts: WakeOptions | undefined;

  constructor(private readonly deps: WakeDispatcherDeps) {}

  /** Messages waiting for the session to go idle (or for a failed send to be retried). */
  get pending(): number {
    return this.held.length;
  }

  async dispatch(batch: readonly WakeableMessage[], opts: WakeOptions): Promise<DispatchResult> {
    if (!this.deps.allowlist.isConfigured) throw new WakerNotConfiguredError();
    if (batch.length === 0) return { state: "held", reason: "session_busy" };

    const sender = batch[0]?.sender ?? "";
    const refused = batch.find((m) => !this.deps.allowlist.allows(m.sender, opts.recipient));
    if (refused !== undefined) {
      // A mixed batch is refused unless EVERY pair in it is allowed.
      return { state: "denied", reason: "not_allowlisted", pair: `${refused.sender}->${opts.recipient}` };
    }

    const decision = this.deps.cap.take(`${sender}->${opts.recipient}`);
    if (!decision.allowed) return { state: "rate_limited", retryAfterMs: decision.retryAfterMs };

    this.hold(batch, opts);
    if (!this.deps.isIdle()) return { state: "held", reason: "session_busy" };
    return (await this.flush()) > 0 ? { state: "sent" } : { state: "held", reason: "send_failed" };
  }

  /** Deliver everything held, as ONE wake, if the session is idle. Returns how many wakes were sent. */
  async flush(): Promise<number> {
    if (this.held.length === 0 || this.heldOpts === undefined || !this.deps.isIdle()) return 0;
    const wake = buildWake(this.held, this.heldOpts);
    try {
      await this.deps.send(wake);
    } catch {
      return 0; // the batch stays held — a wake is never lost to a broken channel
    }
    this.held = [];
    this.heldOpts = undefined;
    return 1;
  }

  private hold(batch: readonly WakeableMessage[], opts: WakeOptions): void {
    // Keep the EARLIEST sinceId so the session's fetch still covers everything held.
    this.heldOpts =
      this.heldOpts === undefined
        ? opts
        : { recipient: opts.recipient, sinceId: Math.min(this.heldOpts.sinceId, opts.sinceId) };
    this.held = [...this.held, ...batch];
  }
}
