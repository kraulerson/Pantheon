/**
 * Real ssh2 adapter behind {@link EnrollmentSshPort} (ADR-0005, TM-020).
 *
 * Kept apart from `enrollment.ts` so the orchestration stays unit-testable against a fake, and the
 * side-effecting client lives at the edge — the same split `connection.ts` uses for terminals.
 *
 * SECURITY NOTE (recorded, not silently accepted): like the terminal path, this connects without
 * host-key verification, because the harness has no known_hosts store yet. For a key-only terminal
 * session that risk is limited; here the FIRST connection carries the operator's machine password,
 * so a host impersonating the target on the LAN could harvest it. Tracked as a follow-up
 * (pin the host key on first enrollment, verify it on every later connection). Do not copy this
 * pattern into a new path without reading that item first.
 */

import { Client as Ssh2Client } from "ssh2";
import type { SshTarget } from "./provisioning.js";
import type { EnrollmentSession, EnrollmentSshPort } from "./enrollment.js";

/** ssh2's `Client`, narrowed to what this adapter uses (mirrors connection.ts's approach). */
interface Ssh2Like {
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  connect(cfg: Record<string, unknown>): void;
  end(): void;
  exec(command: string, cb: (err: Error | undefined, stream: Ssh2Stream) => void): void;
}

interface Ssh2Stream {
  on(event: string, cb: (...args: never[]) => void): Ssh2Stream;
  stderr: { on(event: string, cb: (chunk: Buffer) => void): unknown };
}

const READY_TIMEOUT_MS = 15_000;

function makeSession(client: Ssh2Like): EnrollmentSession {
  return {
    exec(command: string) {
      return new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
          if (err) {
            reject(new Error("remote command could not be started"));
            return;
          }
          let stdout = "";
          let stderr = "";
          stream.on("data", ((chunk: Buffer) => {
            stdout += chunk.toString();
          }) as never);
          stream.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          stream.on("close", ((code: number) => {
            resolve({ code: typeof code === "number" ? code : 0, stdout, stderr });
          }) as never);
        });
      });
    },
    end() {
      try {
        client.end();
      } catch {
        /* best-effort teardown */
      }
    }
  };
}

function connect(target: SshTarget, auth: Record<string, unknown>): Promise<EnrollmentSession> {
  return new Promise((resolve, reject) => {
    const client = new Ssh2Client() as unknown as Ssh2Like;
    let settled = false;

    client.on("ready", () => {
      if (settled) return;
      settled = true;
      resolve(makeSession(client));
    });
    client.on("error", () => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* best-effort teardown */
      }
      // No upstream text: ssh2 error messages can quote the credential they were given.
      reject(new Error("ssh connection failed"));
    });

    client.connect({
      host: target.host,
      port: target.port,
      username: target.user,
      readyTimeout: READY_TIMEOUT_MS,
      ...auth
    });
  });
}

/** The adapter the server wires into `enrollMachine`. */
export function ssh2EnrollmentPort(): EnrollmentSshPort {
  return {
    connectWithPassword: (target, password) => connect(target, { password }),
    connectWithKey: (target, privateKey) => connect(target, { privateKey })
  };
}
