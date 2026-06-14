/**
 * ChildProcessRunner — the real {@link CommandRunner} (Task #16b). `run` captures output for
 * non-interactive commands (e.g. `ssh-keygen`); `runInteractive` inherits the parent's stdio so
 * `ssh-copy-id` can prompt the operator for the dev-machine password once.
 *
 * Commands are spawned WITHOUT a shell (`shell: false`, the spawn default) and with an argv array,
 * so DevMachine fields (host/user/port — already charset-validated upstream) cannot be reinterpreted
 * as shell syntax. No string concatenation into a shell line.
 */

import { spawn } from "node:child_process";
import { type CommandRunner } from "./provisioning.js";

export class ChildProcessRunner implements CommandRunner {
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  }

  runInteractive(cmd: string, args: string[]): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });
  }
}
