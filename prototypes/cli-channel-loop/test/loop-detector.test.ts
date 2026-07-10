import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  LoopDetector,
  type Judge,
  type JudgeVerdict,
  type LoopDetectorConfig,
  type TranscriptEntry
} from "../src/loop-detector.js";

const CFG: LoopDetectorConfig = {
  armAt: 5,
  windowSize: 4,
  recheckEvery: 2,
  backstopMessages: 20,
  backstopMinutes: 60
};

const T0 = 1_000_000;

function entry(n: number, text = `message ${n}`, atMs = T0 + n * 1000): TranscriptEntry {
  return { direction: n % 2 === 0 ? "inbound" : "outbound", sender: `alden-${n % 2}`, text, atMs };
}

function fixedJudge(verdict: JudgeVerdict): Judge {
  return async () => verdict;
}

async function feed(detector: LoopDetector, count: number, startAt = 1): Promise<void> {
  for (let n = startAt; n < startAt + count; n++) await detector.record(entry(n));
}

describe("LoopDetector", () => {
  it("ships with the design-note defaults (arm 25, window 10)", () => {
    expect(DEFAULT_CONFIG.armAt).toBe(25);
    expect(DEFAULT_CONFIG.windowSize).toBe(10);
  });

  it("stays disarmed and never judges below armAt", async () => {
    const judge = vi.fn(fixedJudge("looping"));
    const d = new LoopDetector(CFG, judge, T0);
    await feed(d, CFG.armAt - 1);
    expect(judge).not.toHaveBeenCalled();
    expect(d.state()).toMatchObject({ armed: false, paused: false, relayedCount: CFG.armAt - 1 });
  });

  it("arms at armAt and judges the trailing window only", async () => {
    const judge = vi.fn(fixedJudge("progress"));
    const d = new LoopDetector(CFG, judge, T0);
    await feed(d, CFG.armAt);
    expect(judge).toHaveBeenCalledTimes(1);
    const window = judge.mock.calls[0]?.[0] as TranscriptEntry[];
    expect(window).toHaveLength(CFG.windowSize);
    expect(window[window.length - 1]?.text).toBe(`message ${CFG.armAt}`);
    expect(d.state().armed).toBe(true);
  });

  it("re-judges every recheckEvery messages after arming", async () => {
    const judge = vi.fn(fixedJudge("progress"));
    const d = new LoopDetector(CFG, judge, T0);
    await feed(d, CFG.armAt + 4); // judged at 5, 7, 9
    expect(judge).toHaveBeenCalledTimes(3);
  });

  it("pauses on a looping verdict and reports it on the transitioning call", async () => {
    const d = new LoopDetector(CFG, fixedJudge("looping"), T0);
    await feed(d, CFG.armAt - 1);
    const result = await d.record(entry(CFG.armAt));
    expect(result).toMatchObject({ judged: true, verdict: "looping", pausedNow: true, reason: "judge-looping" });
    expect(d.state().paused).toBe(true);
  });

  it("pauses on a stalled verdict with its own reason", async () => {
    const d = new LoopDetector(CFG, fixedJudge("stalled"), T0);
    await feed(d, CFG.armAt);
    expect(d.state()).toMatchObject({ paused: true, reason: "judge-stalled" });
  });

  it("keeps relaying on progress and on unknown (judge outage never freezes work)", async () => {
    for (const verdict of ["progress", "unknown"] as const) {
      const d = new LoopDetector(CFG, fixedJudge(verdict), T0);
      await feed(d, CFG.armAt + 6);
      expect(d.state().paused).toBe(false);
    }
  });

  it("message-count backstop pauses even when the judge says progress", async () => {
    const d = new LoopDetector(CFG, fixedJudge("progress"), T0);
    await feed(d, CFG.backstopMessages - 1);
    const result = await d.record(entry(CFG.backstopMessages));
    expect(result).toMatchObject({ pausedNow: true, reason: "backstop-messages" });
  });

  it("wall-clock backstop pauses after backstopMinutes without a human touch", async () => {
    const d = new LoopDetector(CFG, fixedJudge("progress"), T0);
    await d.record(entry(1));
    const late = T0 + CFG.backstopMinutes * 60_000;
    const result = await d.record(entry(2, "late message", late));
    expect(result).toMatchObject({ pausedNow: true, reason: "backstop-time" });
  });

  it("humanTouch defers the wall-clock backstop without resetting counters", async () => {
    const d = new LoopDetector(CFG, fixedJudge("progress"), T0);
    await d.record(entry(1));
    const touchAt = T0 + 30 * 60_000;
    d.humanTouch(touchAt);
    const result = await d.record(entry(2, "still fine", T0 + CFG.backstopMinutes * 60_000));
    expect(result.pausedNow).toBe(false);
    expect(d.state().relayedCount).toBe(2);
  });

  it("ignores records while paused (caller-side stop is backed up detector-side)", async () => {
    const d = new LoopDetector(CFG, fixedJudge("looping"), T0);
    await feed(d, CFG.armAt);
    const before = d.state().relayedCount;
    const result = await d.record(entry(99));
    expect(result.pausedNow).toBe(false);
    expect(d.state().relayedCount).toBe(before);
  });

  it("resume unpauses, resets counters/window, and re-bases the wall clock", async () => {
    const judge = vi.fn(fixedJudge("looping"));
    const d = new LoopDetector(CFG, judge, T0);
    await feed(d, CFG.armAt);
    expect(d.state().paused).toBe(true);

    const resumeAt = T0 + 10 * 60_000;
    d.resume(resumeAt);
    expect(d.state()).toMatchObject({ paused: false, relayedCount: 0, armed: false, reason: undefined });

    // fresh thread: nothing judged again until it re-arms
    judge.mockClear();
    await feed(d, CFG.armAt - 1, 100);
    expect(judge).not.toHaveBeenCalled();
  });

  it("manual pause takes effect immediately", async () => {
    const d = new LoopDetector(CFG, fixedJudge("progress"), T0);
    await feed(d, 3);
    d.pause();
    expect(d.state()).toMatchObject({ paused: true, reason: "manual" });
  });
});
