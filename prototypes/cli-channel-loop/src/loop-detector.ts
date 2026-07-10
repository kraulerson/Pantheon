/**
 * LoopDetector — progress-judge loop safety for the channel auto-relay (SPIKE STUB).
 *
 * Design authority: docs/2026-07-09-cli-comms-autonomy-design.md ("Loop safety — Karl's
 * design"). A fixed turn cap punishes long legitimate discussions, so instead:
 *
 *   1. A cheap counter ARMS the judge once a thread passes `armAt` relayed messages.
 *   2. After arming, every `recheckEvery` messages the trailing `windowSize` messages go
 *      to a judge (llm-mini in production; injectable here) asking PROGRESS vs LOOPING vs
 *      STALLED — framed on progress, not similarity, so deep productive threads survive.
 *   3. On LOOPING/STALLED: pause, don't kill (P7 / A1 circuit-breaker shape) — the caller
 *      stops relaying, notifies Karl, and preserves the thread.
 *   4. Absolute backstops (message ceiling + wall-clock without a human touch) pause
 *      regardless, because the judge is itself an LLM and can be wrong.
 *
 * Judge failure ("unknown") does NOT pause: the backstops bound a runaway if the judge is
 * down — pausing on judge outage would freeze legitimate work ("instrument, don't freeze").
 *
 * Pure logic, no I/O — unit-testable with a fake judge and explicit timestamps.
 */

export type JudgeVerdict = "progress" | "looping" | "stalled" | "unknown";

export interface TranscriptEntry {
  readonly direction: "inbound" | "outbound";
  readonly sender: string;
  readonly text: string;
  /** Wall-clock ms — supplied by the caller so tests control time. */
  readonly atMs: number;
}

/** Judges the trailing window: is the conversation still making progress? */
export type Judge = (window: readonly TranscriptEntry[]) => Promise<JudgeVerdict>;

export type PauseReason =
  | "judge-looping"
  | "judge-stalled"
  | "backstop-messages"
  | "backstop-time"
  | "manual";

export interface LoopDetectorConfig {
  /** Relayed-message count at which the judge arms. */
  readonly armAt: number;
  /** Trailing window size sent to the judge. */
  readonly windowSize: number;
  /** After arming, judge every N messages (a loop can start after arming). */
  readonly recheckEvery: number;
  /** Absolute ceiling on relayed messages since the last human touch. */
  readonly backstopMessages: number;
  /** Absolute ceiling on minutes since the last human touch. */
  readonly backstopMinutes: number;
}

export const DEFAULT_CONFIG: LoopDetectorConfig = {
  armAt: 25,
  windowSize: 10,
  recheckEvery: 3,
  backstopMessages: 200,
  backstopMinutes: 240
};

export interface DetectorState {
  readonly paused: boolean;
  readonly reason: PauseReason | undefined;
  readonly relayedCount: number;
  readonly armed: boolean;
  readonly lastVerdict: JudgeVerdict | undefined;
}

export interface RecordResult {
  readonly armed: boolean;
  readonly judged: boolean;
  readonly verdict: JudgeVerdict | undefined;
  /** True only on the record() call that transitioned the detector into paused. */
  readonly pausedNow: boolean;
  readonly reason: PauseReason | undefined;
}

export class LoopDetector {
  private readonly config: LoopDetectorConfig;
  private readonly judge: Judge;
  private window: TranscriptEntry[] = [];
  private relayedCount = 0;
  private paused = false;
  private reason: PauseReason | undefined;
  private lastVerdict: JudgeVerdict | undefined;
  private lastHumanTouchMs: number;

  constructor(config: LoopDetectorConfig, judge: Judge, startMs: number) {
    this.config = config;
    this.judge = judge;
    this.lastHumanTouchMs = startMs;
  }

  /**
   * Record one relayed message (either direction) and run the safety checks.
   * Callers must stop relaying when `pausedNow` (or `state().paused`) is true.
   */
  async record(entry: TranscriptEntry): Promise<RecordResult> {
    if (this.paused) {
      return { armed: this.armed(), judged: false, verdict: undefined, pausedNow: false, reason: this.reason };
    }

    this.relayedCount += 1;
    this.window.push(entry);
    if (this.window.length > this.config.windowSize) {
      this.window.splice(0, this.window.length - this.config.windowSize);
    }

    // Backstops first — they hold even if the judge is wrong or unreachable.
    if (this.relayedCount >= this.config.backstopMessages) {
      return this.pauseResult("backstop-messages");
    }
    if (entry.atMs - this.lastHumanTouchMs >= this.config.backstopMinutes * 60_000) {
      return this.pauseResult("backstop-time");
    }

    if (!this.armed()) {
      return { armed: false, judged: false, verdict: undefined, pausedNow: false, reason: undefined };
    }
    const sinceArm = this.relayedCount - this.config.armAt;
    if (sinceArm % this.config.recheckEvery !== 0) {
      return { armed: true, judged: false, verdict: undefined, pausedNow: false, reason: undefined };
    }

    const verdict = await this.judge([...this.window]);
    this.lastVerdict = verdict;
    if (verdict === "looping") return this.pauseResult("judge-looping", verdict);
    if (verdict === "stalled") return this.pauseResult("judge-stalled", verdict);
    return { armed: true, judged: true, verdict, pausedNow: false, reason: undefined };
  }

  /** Manual pause (operator or harness override). */
  pause(): void {
    this.paused = true;
    this.reason = "manual";
  }

  /**
   * Operator resume: unpause, reset the counters AND the window — Karl has read the
   * thread and redirected it, so the detector starts fresh (and the wall-clock backstop
   * re-bases on this human touch).
   */
  resume(nowMs: number): void {
    this.paused = false;
    this.reason = undefined;
    this.lastVerdict = undefined;
    this.relayedCount = 0;
    this.window = [];
    this.lastHumanTouchMs = nowMs;
  }

  /** A human interacted without a full resume (defers the wall-clock backstop only). */
  humanTouch(nowMs: number): void {
    this.lastHumanTouchMs = nowMs;
  }

  state(): DetectorState {
    return {
      paused: this.paused,
      reason: this.reason,
      relayedCount: this.relayedCount,
      armed: this.armed(),
      lastVerdict: this.lastVerdict
    };
  }

  private armed(): boolean {
    return this.relayedCount >= this.config.armAt;
  }

  private pauseResult(reason: PauseReason, verdict?: JudgeVerdict): RecordResult {
    this.paused = true;
    this.reason = reason;
    return {
      armed: this.armed(),
      judged: verdict !== undefined,
      verdict,
      pausedNow: true,
      reason
    };
  }
}
