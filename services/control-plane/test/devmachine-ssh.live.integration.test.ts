/**
 * LIVE (guarded) SSH terminal integration — Task #16(b/c), ADR-0005.
 *
 * Opt-in: set these env vars to point at a dev machine you have ALREADY provisioned (run
 * `node dist/cli/provision-devmachine.js <logicalName>` once, at the keyboard, to install the key):
 *   PANTHEON_LIVE_SSH_HOST   e.g. 192.168.1.192
 *   PANTHEON_LIVE_SSH_USER   e.g. karl
 *   PANTHEON_LIVE_SSH_PORT   default 22
 *   PANTHEON_KEY_DIR         harness key custody dir (default ~/.pantheon/keys)
 *   PANTHEON_KEY_HANDLE      default "harness"
 *
 * Skips entirely when the host var is absent (CI / unprovisioned machines). It connects key-only,
 * runs a command on the remote PTY, and asserts the output round-trips.
 */

import { describe, it, expect } from "vitest";
import { FileKeyCustody, defaultKeyDir, connectTerminal } from "../src/devmachine/index.js";

const HOST = process.env["PANTHEON_LIVE_SSH_HOST"];

describe("LIVE (optional) — SSH terminal round-trip", () => {
  it.runIf(HOST)("connects key-only to a provisioned machine and runs a command", async () => {
    const target = {
      logicalName: "live-test",
      host: HOST as string,
      port: Number(process.env["PANTHEON_LIVE_SSH_PORT"] ?? "22"),
      user: process.env["PANTHEON_LIVE_SSH_USER"] ?? "root"
    };
    const custody = new FileKeyCustody(process.env["PANTHEON_KEY_DIR"] ?? defaultKeyDir());
    const handle = process.env["PANTHEON_KEY_HANDLE"] ?? "harness";

    const session = await connectTerminal(target, handle, { custody });

    const output = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`timeout; got: ${buf}`)), 15000);
      session.onData((chunk) => {
        buf += chunk.toString();
        if (buf.includes("PANTHEON_LIVE_OK")) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
      session.onClose(() => {
        clearTimeout(timer);
        resolve(buf);
      });
      session.write("echo PANTHEON_LIVE_OK\n");
    });

    expect(output).toContain("PANTHEON_LIVE_OK");
    session.close();
  }, 20000);
});
