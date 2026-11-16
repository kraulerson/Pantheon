/**
 * Terminal gateway — Task #16(c), the SSH→PTY→WebSocket bridge core (ADR-0005).
 *
 * Pure, transport-agnostic logic (no real WebSocket): a `ManagedTerminal` wraps a TerminalSession
 * with a bounded scrollback ring and supports attach/detach so a dropped WebSocket does NOT kill the
 * SSH session (reconnectable, §9 C.6 "disconnected — reconnect?"). `attachSocket` wires a
 * `DuplexSocket` to it with a small JSON frame protocol. `TerminalRegistry` tracks live sessions and
 * auto-evicts on close.
 *
 * Security note (ADR-0005/TM-020): the bridge forwards ONLY operator-typed input frames to the PTY —
 * it never injects recalled `trusted:false` content; malformed/unknown frames are ignored.
 */

import { describe, it, expect, vi } from "vitest";
import {
  ManagedTerminal,
  TerminalRegistry,
  attachSocket,
  DETACH_GRACE_MS,
  openTerminalForMachine,
  TerminalError,
  type DuplexSocket
} from "../src/devmachine/terminal-gateway.js";
import { type TerminalSession } from "../src/devmachine/connection.js";
import { SqliteRegistry } from "../src/registry/sqlite-repository.js";
import { RegistryService } from "../src/registry/service.js";

function fakeSession(): TerminalSession & {
  emitData: (s: string) => void;
  emitClose: () => void;
  writes: string[];
  resizes: Array<[number, number]>;
  closed: boolean;
} {
  let dataCb: (c: Buffer) => void = () => {};
  const closeCbs: Array<() => void> = [];
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  return {
    writes,
    resizes,
    closed: false,
    write: (s) => writes.push(s),
    onData: (cb) => (dataCb = cb),
    onClose: (cb) => void closeCbs.push(cb),
    resize: (c, r) => resizes.push([c, r]),
    close() {
      this.closed = true;
    },
    emitData: (s) => dataCb(Buffer.from(s)),
    emitClose: () => closeCbs.forEach((cb) => cb())
  };
}

function fakeSocket(): DuplexSocket & { emitMessage: (s: string) => void; emitClose: () => void; sent: string[]; closed: boolean } {
  let msgCb: (raw: string) => void = () => {};
  let closeCb: () => void = () => {};
  const sent: string[] = [];
  return {
    sent,
    closed: false,
    send: (d) => sent.push(d),
    onMessage: (cb) => (msgCb = cb),
    onClose: (cb) => (closeCb = cb),
    close() {
      this.closed = true;
    },
    emitMessage: (s) => msgCb(s),
    emitClose: () => closeCb()
  };
}

const parsed = (frames: string[]) => frames.map((f) => JSON.parse(f));

describe("ManagedTerminal", () => {
  it("forwards PTY output to an attached sink as {t:'o'} frames", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    const sink = vi.fn();
    term.attach(sink);
    session.emitData("hello");
    expect(parsed(sink.mock.calls.map((c) => c[0]))).toContainEqual({ t: "o", d: "hello" });
  });

  it("replays buffered scrollback on (re)attach so a reconnecting client sees recent output", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    session.emitData("line-before-attach\n"); // produced while no client attached
    const sink = vi.fn();
    term.attach(sink);
    const out = parsed(sink.mock.calls.map((c) => c[0])).filter((f) => f.t === "o");
    expect(out.map((f) => f.d).join("")).toContain("line-before-attach");
  });

  it("routes input to write() and resize to resize() on the session", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    term.input("ls\n");
    term.resize(120, 40);
    expect(session.writes).toContain("ls\n");
    expect(session.resizes).toContainEqual([120, 40]);
  });

  it("on session close, emits {t:'x'} and ignores further input (closed)", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    const sink = vi.fn();
    term.attach(sink);
    session.emitClose();
    expect(parsed(sink.mock.calls.map((c) => c[0]))).toContainEqual({ t: "x" });
    term.input("too late\n");
    expect(session.writes).not.toContain("too late\n");
    expect(term.isClosed).toBe(true);
  });

  it("detach stops forwarding but keeps the SSH session alive (reconnectable)", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    const sink1 = vi.fn();
    term.attach(sink1);
    term.detach();
    session.emitData("while-detached");
    expect(sink1).not.toHaveBeenCalledWith(expect.stringContaining("while-detached"));
    expect(session.closed).toBe(false); // session NOT torn down by detach
    // a new client reattaches and sees the buffered output
    const sink2 = vi.fn();
    term.attach(sink2);
    expect(parsed(sink2.mock.calls.map((c) => c[0])).map((f) => f.d).join("")).toContain("while-detached");
  });

  it("bounds the scrollback buffer (drops oldest beyond the cap)", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session, 1024); // 1 KiB cap
    session.emitData("A".repeat(2000));
    session.emitData("TAIL");
    const sink = vi.fn();
    term.attach(sink);
    const replay = parsed(sink.mock.calls.map((c) => c[0])).filter((f) => f.t === "o").map((f) => f.d).join("");
    expect(replay).toContain("TAIL");
    expect(replay.length).toBeLessThanOrEqual(1024);
  });

  it("close() tears down the underlying SSH session", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    term.close();
    expect(session.closed).toBe(true);
  });
});

describe("attachSocket (DuplexSocket ↔ ManagedTerminal)", () => {
  it("pipes input/resize frames from the socket to the terminal", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    const socket = fakeSocket();
    attachSocket(socket, term);
    socket.emitMessage(JSON.stringify({ t: "i", d: "whoami\n" }));
    socket.emitMessage(JSON.stringify({ t: "r", c: 100, r: 30 }));
    expect(session.writes).toContain("whoami\n");
    expect(session.resizes).toContainEqual([100, 30]);
  });

  it("forwards terminal output to socket.send", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    const socket = fakeSocket();
    attachSocket(socket, term);
    session.emitData("output!");
    expect(parsed(socket.sent)).toContainEqual({ t: "o", d: "output!" });
  });

  it("ignores malformed JSON and unknown frame types (no throw, no write)", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    const socket = fakeSocket();
    attachSocket(socket, term);
    expect(() => socket.emitMessage("not json")).not.toThrow();
    socket.emitMessage(JSON.stringify({ t: "evil", d: "rm -rf /\n" }));
    socket.emitMessage(JSON.stringify({ t: "i" })); // missing d
    expect(session.writes).toHaveLength(0);
  });

  it("on socket close, DETACHES (keeps the SSH session alive for reconnect)", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("s1", session);
    const socket = fakeSocket();
    attachSocket(socket, term);
    socket.emitClose();
    expect(session.closed).toBe(false);
  });
});

describe("detached terminals are closed after a grace period (BUGS #49)", () => {
  const GRACE = DETACH_GRACE_MS;

  it("a socket that closes without a close frame ends the SSH session once the grace period passes", () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const term = new ManagedTerminal("t1", session);
      const socket = fakeSocket();
      attachSocket(socket, term);
      socket.emitClose(); // reload, closed lid, dropped network: no {t:"c"} frame
      vi.advanceTimersByTime(GRACE - 1);
      expect(session.closed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(session.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reattach inside the grace period keeps the session, with no later teardown", () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const term = new ManagedTerminal("t1", session);
      const first = fakeSocket();
      attachSocket(first, term);
      first.emitClose();
      vi.advanceTimersByTime(GRACE - 1000);
      const second = fakeSocket();
      attachSocket(second, term);
      vi.advanceTimersByTime(GRACE * 3);
      expect(session.closed).toBe(false);
      session.emitData("still here");
      expect(parsed(second.sent)).toContainEqual({ t: "o", d: "still here" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("each detach starts a fresh grace period", () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const term = new ManagedTerminal("t1", session);
      const first = fakeSocket();
      attachSocket(first, term);
      first.emitClose();
      vi.advanceTimersByTime(GRACE - 1000);
      const second = fakeSocket();
      attachSocket(second, term);
      second.emitClose();
      vi.advanceTimersByTime(GRACE - 1);
      expect(session.closed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(session.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an old socket closing after a newer one attached neither silences nor times out the newer one", () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const term = new ManagedTerminal("t1", session);
      const old = fakeSocket();
      attachSocket(old, term);
      const fresh = fakeSocket();
      attachSocket(fresh, term); // the reloaded page reattaches before the old socket's close arrives
      old.emitClose();
      session.emitData("live");
      expect(parsed(fresh.sent)).toContainEqual({ t: "o", d: "live" });
      vi.advanceTimersByTime(GRACE * 3);
      expect(session.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a terminal nobody ever attached to is closed after the grace period", () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      new ManagedTerminal("t1", session);
      vi.advanceTimersByTime(GRACE);
      expect(session.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the grace period is the 2 minutes Karl ruled", () => {
    expect(DETACH_GRACE_MS).toBe(120_000);
  });

  it("a tab closing after the remote side already exited starts no timer", () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const term = new ManagedTerminal("t1", session);
      const socket = fakeSocket();
      attachSocket(socket, term);
      session.emitClose(); // the remote shell exited while the tab was open
      socket.emitClose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a client replaced by a newer one is told its view has ended", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("t1", session);
    const older = fakeSocket();
    attachSocket(older, term);
    const newer = fakeSocket();
    attachSocket(newer, term); // the same terminal opened from a duplicated browser tab
    expect(parsed(older.sent)).toContainEqual({ t: "x" });
    expect(parsed(newer.sent)).not.toContainEqual({ t: "x" });
  });

  it("frames from a replaced client are ignored: it can neither type into nor close the newer client's terminal", () => {
    const session = fakeSession();
    const term = new ManagedTerminal("t1", session);
    const older = fakeSocket();
    attachSocket(older, term);
    const newer = fakeSocket();
    attachSocket(newer, term);
    older.emitMessage(JSON.stringify({ t: "i", d: "stale keystrokes" }));
    older.emitMessage(JSON.stringify({ t: "c" }));
    expect(session.writes).toEqual([]);
    expect(session.closed).toBe(false);
    newer.emitMessage(JSON.stringify({ t: "i", d: "live" }));
    expect(session.writes).toEqual(["live"]);
  });

  it("a session that ends by itself while detached leaves no timer behind", () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession();
      const term = new ManagedTerminal("t1", session);
      const socket = fakeSocket();
      attachSocket(socket, term);
      socket.emitClose();
      expect(vi.getTimerCount()).toBe(1);
      session.emitClose(); // the remote shell exited during the grace period
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(GRACE * 2);
      expect(session.closed).toBe(false); // close() is not called on a session that already ended
    } finally {
      vi.useRealTimers();
    }
  });

  it("the grace timer is cancelled when the session ends first, and the registry evicts on the grace teardown", () => {
    vi.useFakeTimers();
    try {
      const reg = new TerminalRegistry();
      const session = fakeSession();
      // A real session's close() ends the stream, which fires its close subscribers.
      session.close = function (this: typeof session) {
        this.closed = true;
        this.emitClose();
      };
      const term = reg.register("t1", session);
      const socket = fakeSocket();
      attachSocket(socket, term);
      socket.emitClose();
      vi.advanceTimersByTime(GRACE);
      expect(session.closed).toBe(true);
      expect(term.isClosed).toBe(true);
      expect(reg.get("t1")).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("openTerminalForMachine (resolve → fail-closed → connect → register)", () => {
  function regWith(machine: { provisioned?: boolean; enabled?: boolean; handle?: string }): RegistryService {
    const svc = new RegistryService(new SqliteRegistry(":memory:"));
    const m = svc.createDevMachine({
      logicalName: "mac-studio",
      host: "192.168.1.192",
      user: "karl",
      enabled: machine.enabled ?? true
    });
    if (machine.provisioned) svc.markProvisioned(m.id, machine.handle ?? "harness");
    return svc;
  }

  it("opens + registers a terminal for a provisioned, enabled machine", async () => {
    const registry = regWith({ provisioned: true, handle: "harness" });
    const terminals = new TerminalRegistry();
    const connect = vi.fn(async () => fakeSession());
    const term = await openTerminalForMachine("mac-studio", { registry, terminals, connect });

    expect(term).toBeInstanceOf(ManagedTerminal);
    expect(terminals.get(term.id)).toBe(term);
    const [target, handle] = connect.mock.calls[0];
    expect(target).toMatchObject({ logicalName: "mac-studio", host: "192.168.1.192", port: 22, user: "karl" });
    expect(handle).toBe("harness");
  });

  it("rejects an unknown machine without connecting", async () => {
    const registry = regWith({ provisioned: true });
    const connect = vi.fn(async () => fakeSession());
    await expect(openTerminalForMachine("ghost", { registry, terminals: new TerminalRegistry(), connect })).rejects.toBeInstanceOf(
      TerminalError
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects an UNPROVISIONED machine without connecting (fail closed)", async () => {
    const registry = regWith({ provisioned: false });
    const connect = vi.fn(async () => fakeSession());
    await expect(
      openTerminalForMachine("mac-studio", { registry, terminals: new TerminalRegistry(), connect })
    ).rejects.toBeInstanceOf(TerminalError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a disabled machine without connecting", async () => {
    const registry = regWith({ provisioned: true, enabled: false });
    const connect = vi.fn(async () => fakeSession());
    await expect(
      openTerminalForMachine("mac-studio", { registry, terminals: new TerminalRegistry(), connect })
    ).rejects.toBeInstanceOf(TerminalError);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("TerminalRegistry", () => {
  it("registers, retrieves, and auto-evicts a terminal when its session closes", () => {
    const reg = new TerminalRegistry();
    const session = fakeSession();
    const term = reg.register("s1", session);
    expect(reg.get("s1")).toBe(term);
    session.emitClose();
    expect(reg.get("s1")).toBeUndefined(); // auto-evicted on close
  });

  it("remove() tears down and drops a terminal", () => {
    const reg = new TerminalRegistry();
    const session = fakeSession();
    reg.register("s1", session);
    reg.remove("s1");
    expect(reg.get("s1")).toBeUndefined();
    expect(session.closed).toBe(true);
  });
});
