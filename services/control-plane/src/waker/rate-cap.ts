/**
 * Per-pair sliding-window budget (TP-1; ADR-0009).
 *
 * DETERMINISTIC by design: counting timestamps, never a model call — a wake's admissibility must
 * not depend on something that can be talked into changing its mind (CC3). Each pair keeps its own
 * window, so one chatty pair cannot starve another.
 */

export interface RateCapOptions {
  /** Wakes allowed per window, per pair. */
  readonly limit: number;
  readonly windowMs: number;
  /** Clock (tests). */
  readonly now?: () => number;
}

export interface CapDecision {
  readonly allowed: boolean;
  /** When denied: how long until the oldest take leaves the window. */
  readonly retryAfterMs: number;
  readonly remaining: number;
}

export class SlidingWindowCap {
  private readonly takes = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: RateCapOptions) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new Error("waker rate cap: limit must be a positive integer");
    }
    if (!Number.isInteger(opts.windowMs) || opts.windowMs < 1) {
      throw new Error("waker rate cap: windowMs must be a positive integer");
    }
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /** Charge one wake to `pair`. A DENIED take is not counted — a refused wake never deepens the hole. */
  take(pair: string): CapDecision {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const live = (this.takes.get(pair) ?? []).filter((ts) => ts > cutoff);
    if (live.length >= this.limit) {
      this.takes.set(pair, live);
      const oldest = live[0] ?? t;
      return { allowed: false, retryAfterMs: Math.max(1, oldest + this.windowMs - t), remaining: 0 };
    }
    live.push(t);
    this.takes.set(pair, live);
    return { allowed: true, retryAfterMs: 0, remaining: this.limit - live.length };
  }
}
