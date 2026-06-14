/**
 * DevMachine SSH terminal backend (ADR-0005, Task #16b/c) — public barrel.
 *
 * Custody of the harness keypair, the one-time provisioning ceremony, and the key-only SSH→PTY
 * connection broker, plus the real edge adapters (child_process runner + ssh-keygen generator).
 */

export {
  FileKeyCustody,
  CustodyError,
  defaultKeyDir,
  type KeyCustody
} from "./custody.js";

export {
  provisionMachine,
  ProvisioningError,
  type CommandRunner,
  type KeyGenerator,
  type SshTarget,
  type ProvisionDeps,
  type ProvisionResult
} from "./provisioning.js";

export {
  connectTerminal,
  SshConnectionError,
  type TerminalSession,
  type TerminalDeps,
  type SshClient,
  type SshStream,
  type SshClientFactory
} from "./connection.js";

export { ChildProcessRunner } from "./runner.js";
export { SshKeygenGenerator } from "./keygen.js";

export { provisionAndRecord, type RegistryPort, type ProvisionAndRecordDeps } from "./provision-and-record.js";
