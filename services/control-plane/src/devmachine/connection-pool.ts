/**
 * SshConnectionPool — BUGS #86. One persistent key-only ssh2 connection per dev machine; each non-interactive
 * command (console probe, tmux listing, delivery, session create, expand) runs as its own `exec` channel on it.
 * Before this, every command logged in from scratch — the console poller alone made about 12 logins a minute per
 * machine. Terminal tabs keep their own connections (`connectTerminal`).
 *
 * Failure contract: identical to `runRemoteCommand` — the same `SshConnectionError` messages and `phase`, so
 * `remoteCommandFailure` classifies a pooled failure exactly as before (ruling T11-18).
 *
 * Dead links: ssh2 keepalives close a silent connection. A command that outlives its timeout fails as `timeout`
 * and closes ONLY its own channel, so a slow probe never fails a delivery that shares the connection; three
 * timeouts in a row with no success between them close the connection (channels stuck on a live link). A failed login is not retried
 * until a backoff has passed (1 s doubling to 15 s, reset by a good login); a connection that drops after a good
 * login is redialled by the next command.
 *
 * Security invariants (TM-020, BUGS #86):
 * - KEY-ONLY auth; the key is resolved from custody on EVERY command, as before. A key that changed or is gone
 *   closes the open connection before anything else happens, so a rotation takes effect on the next command.
 * - A changed address, user or key handle closes the open connection.
 * - `close(logicalName)` ends the connection at once; {@link closeOnDevMachineChange} calls it whenever the registry
 *   updates (disable, address change), re-provisions or deletes the machine.
 * - No error carries key material or raw ssh2 text.
 * - At most {@link MAX_CHANNELS_PER_CONNECTION} commands at once per machine (under sshd's default MaxSessions 10).
 */

import {
  BoundedCapture,
  causeOf,
  defaultFactory,
  SshConnectionError,
  type RemoteCommand,
  type RemoteCommandOptions,
  type RemoteCommandResult,
  type SshClient,
  type SshFailureCause,
  type TerminalDeps
} from "./connection.js";
import { type SshTarget } from "./provisioning.js";

export const MAX_CHANNELS_PER_CONNECTION = 8;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
const KEEPALIVE_INTERVAL_MS = 10_000;
const KEEPALIVE_COUNT_MAX = 3;
const BACKOFF_FIRST_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;
/** Timeouts in a row, with no success between them, after which the connection itself is taken for stuck. */
const TIMEOUTS_TO_CLOSE = 3;

export interface PoolLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface ConnectionPoolDeps extends TerminalDeps {
  readonly log?: PoolLogger;
}

export interface SshConnectionPool {
  /** Run one command on the machine's persistent connection (dialling it first if there is none). */
  run(target: SshTarget, handle: string, command: RemoteCommand, opts?: RemoteCommandOptions): Promise<RemoteCommandResult>;
  /** End the machine's connection now; commands running on it fail. A later command dials again. */
  close(logicalName: string): void;
  closeAll(): void;
}

interface Job {
  fail(message: string, cause?: SshFailureCause): void;
}

interface Entry {
  readonly name: string;
  readonly client: SshClient;
  /** Key handle + user@host:port the connection was opened with. */
  readonly identity: string;
  readonly key: string;
  readonly ready: Promise<void>;
  readonly jobs: Set<Job>;
  isReady: boolean;
  dead: boolean;
  timeoutsInARow: number;
}

const failedMessage = (t: SshTarget): string => `SSH connection to ${t.logicalName} (${t.user}@${t.host}) failed`;

export function createConnectionPool(deps: ConnectionPoolDeps): SshConnectionPool {
  const entries = new Map<string, Entry>();
  const backoff = new Map<string, { failures: number; notBefore: number }>();
  /**
   * Bumped by every close(name) and closeAll(), even when nothing is open. A command that was already inside run()
   * (waiting on custody) when the machine was closed must not dial it again: nothing would ever close that
   * connection if the machine was disabled or removed (review finding 1, 2026-11-12).
   */
  const closedGen = new Map<string, number>();
  let closedAllGen = 0;
  const genOf = (name: string): string => `${closedAllGen}:${closedGen.get(name) ?? 0}`;

  function kill(entry: Entry, reason: string, message: string, cause?: SshFailureCause): void {
    if (entry.dead) return;
    entry.dead = true;
    if (entries.get(entry.name) === entry) entries.delete(entry.name);
    try {
      entry.client.end();
    } catch {
      /* best-effort teardown */
    }
    for (const job of [...entry.jobs]) job.fail(message, cause);
    // The ssh2 error's class, level and code under the poller's field names — never spread: `level` is the log
    // line's own severity, and the error's message can carry an address or key text.
    deps.log?.info(
      {
        event: "ssh.pool_closed",
        machine: entry.name,
        reason,
        ...(cause ? { errName: cause.errName } : {}),
        ...(cause?.level !== undefined ? { sshLevel: cause.level } : {}),
        ...(cause?.code !== undefined ? { sshCode: cause.code } : {})
      },
      "pooled ssh connection closed"
    );
  }

  function noteLoginFailure(name: string): void {
    const failures = (backoff.get(name)?.failures ?? 0) + 1;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (failures - 1));
    backoff.set(name, { failures, notBefore: Date.now() + wait });
  }

  function dial(target: SshTarget, identity: string, privateKey: string): Entry {
    const name = target.logicalName;
    let client: SshClient;
    try {
      client = (deps.clientFactory ?? defaultFactory)();
    } catch {
      noteLoginFailure(name);
      throw new SshConnectionError(`SSH client for ${name} could not be created`, "before_exec");
    }
    let markReady: () => void = () => undefined;
    let markFailed: () => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markFailed = () => reject(new Error("not ready"));
    });
    ready.catch(() => undefined);
    const entry: Entry = { name, client, identity, key: privateKey, ready, jobs: new Set(), isReady: false, dead: false, timeoutsInARow: 0 };
    entries.set(name, entry);

    const lost = (reason: string, cause?: SshFailureCause): void => {
      if (entry.dead) return;
      if (!entry.isReady) noteLoginFailure(name);
      kill(entry, reason, failedMessage(target), cause);
      markFailed();
    };
    client.on("ready", () => {
      if (entry.dead) return;
      entry.isReady = true;
      backoff.delete(name);
      deps.log?.info({ event: "ssh.pool_connected", machine: name }, "pooled ssh connection ready");
      markReady();
    });
    client.on("error", (err: unknown) => lost("error", causeOf(err)));
    client.on("close", () => lost("closed_by_peer"));
    client.on("end", () => lost("closed_by_peer"));

    // KEY-ONLY auth — no password, ever (#14b/TM-020). ssh2 can throw synchronously here.
    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: target.user,
        privateKey,
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX
      });
    } catch (err) {
      noteLoginFailure(name);
      kill(entry, "connect_threw", `SSH connection to ${name} could not be started`, causeOf(err));
      markFailed();
      throw new SshConnectionError(`SSH connection to ${name} could not be started`, "before_exec", causeOf(err));
    }
    return entry;
  }

  function exec(entry: Entry, target: SshTarget, command: RemoteCommand, opts: RemoteCommandOptions): Promise<RemoteCommandResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    return new Promise<RemoteCommandResult>((resolve, reject) => {
      let settled = false;
      let execRequested = false;
      const stdout = new BoundedCapture(cap);
      const stderr = new BoundedCapture(cap);
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.jobs.delete(job);
        fn();
      };
      const job: Job = {
        fail: (message, cause) => finish(() => reject(new SshConnectionError(message, execRequested ? "after_exec" : "before_exec", cause)))
      };
      entry.jobs.add(job);
      let channel: { close?(): void } | undefined;
      const timer = setTimeout(() => {
        job.fail(`remote command on ${target.logicalName} timed out after ${timeoutMs} ms`);
        try {
          channel?.close?.();
        } catch {
          /* best-effort: the channel may already be gone */
        }
        entry.timeoutsInARow += 1;
        if (entry.timeoutsInARow >= TIMEOUTS_TO_CLOSE) kill(entry, "repeated_timeouts", failedMessage(target));
      }, timeoutMs);

      entry.ready.then(
        () => {
          if (settled) return;
          try {
            execRequested = true;
            entry.client.exec(command, {}, (err, stream) => {
              if (err || !stream) {
                job.fail(`failed to run a command on ${target.logicalName}`, err ? causeOf(err) : undefined);
                return;
              }
              channel = stream;
              if (settled) {
                // The command timed out while the exec request was in flight: do not leave its channel open.
                try {
                  stream.close?.();
                } catch {
                  /* best-effort */
                }
                return;
              }
              stream.on("data", (chunk: Buffer) => stdout.push(chunk));
              stream.stderr.on("data", (chunk) => stderr.push(chunk));
              stream.on("close", (code: number | null) =>
                finish(() => {
                  entry.timeoutsInARow = 0;
                  resolve({ code: code ?? -1, stdout: stdout.text(), stderr: stderr.text() });
                })
              );
            });
          } catch (err) {
            job.fail(`failed to run a command on ${target.logicalName}`, causeOf(err));
          }
        },
        () => undefined // the login failed: kill() has already failed this job
      );
    });
  }

  return {
    async run(target, handle, command, opts = {}) {
      const name = target.logicalName;
      const open = (): Entry | undefined => entries.get(name);
      const gen = genOf(name);
      let privateKey: string;
      try {
        // Resolved on EVERY command: a machine with no key in custody is never dialled, and loses its connection.
        privateKey = await deps.custody.resolvePrivateKey(handle);
      } catch (err) {
        const stale = open();
        if (stale) kill(stale, "key_unavailable", failedMessage(target));
        throw err;
      }
      if (genOf(name) !== gen) throw new SshConnectionError(`SSH connection to ${name} was closed`, "before_exec");
      const identity = `${handle}\n${target.user}@${target.host}:${target.port}`;
      let entry = open();
      if (entry && (entry.identity !== identity || entry.key !== privateKey)) {
        kill(entry, entry.key !== privateKey ? "key_changed" : "target_changed", failedMessage(target));
        entry = undefined;
      }
      if (!entry) {
        const wait = backoff.get(name);
        if (wait && Date.now() < wait.notBefore) throw new SshConnectionError(failedMessage(target), "before_exec");
        entry = dial(target, identity, privateKey);
      }
      if (entry.jobs.size >= MAX_CHANNELS_PER_CONNECTION) {
        throw new SshConnectionError(`too many commands are running on ${name}`, "before_exec");
      }
      return exec(entry, target, command, opts);
    },
    close(logicalName) {
      closedGen.set(logicalName, (closedGen.get(logicalName) ?? 0) + 1);
      // The machine changed (it may have just been re-provisioned): an old login failure says nothing about it now.
      backoff.delete(logicalName);
      const entry = entries.get(logicalName);
      if (entry) kill(entry, "closed_by_registry", `SSH connection to ${logicalName} was closed`);
    },
    closeAll() {
      closedAllGen += 1;
      for (const entry of [...entries.values()]) kill(entry, "shutdown", `SSH connection to ${entry.name} was closed`);
    }
  };
}

/** The registry seam the pool listens on (implemented by `RegistryService`). */
export interface DevMachineChangeSource {
  onDevMachineChange(listener: (machine: { readonly logicalName: string }) => void): void;
}

/**
 * Close a machine's pooled connection whenever the registry updates, re-provisions or deletes it (BUGS #86 security
 * requirement). Closing is always safe: if the machine may still be used, the next command dials again.
 */
export function closeOnDevMachineChange(registry: DevMachineChangeSource, pool: Pick<SshConnectionPool, "close">): void {
  registry.onDevMachineChange((machine) => pool.close(machine.logicalName));
}
