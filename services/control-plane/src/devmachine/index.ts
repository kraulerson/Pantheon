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
  runRemoteCommand,
  SshConnectionError,
  type TerminalSession,
  type TerminalDeps,
  type ConnectOptions,
  type RemoteCommand,
  type RemoteCommandOptions,
  type RemoteCommandResult,
  type SshClient,
  type SshStream,
  type SshExecStream,
  type SshClientFactory
} from "./connection.js";

export {
  listTmuxSessions,
  createTmuxLister,
  buildTmuxAttachCommand,
  buildTmuxListCommand,
  assertTmuxSessionName,
  isSafeTmuxSessionName,
  parseTmuxListOutput,
  classifyTmuxListResult,
  TmuxError,
  TMUX_SESSION_NAME_RE,
  TMUX_LIST_SENTINEL,
  type TmuxSession,
  type TmuxListing,
  type TmuxListResult,
  type TmuxLister,
  type TmuxListerOptions,
  type RemoteExec
} from "./tmux.js";

export { ChildProcessRunner } from "./runner.js";
export { SshKeygenGenerator } from "./keygen.js";

export { provisionAndRecord, type RegistryPort, type ProvisionAndRecordDeps } from "./provision-and-record.js";

export {
  ManagedTerminal,
  TerminalRegistry,
  TerminalError,
  attachSocket,
  openTerminalForMachine,
  resolveConnectableMachine,
  type DuplexSocket,
  type OpenTerminalDeps,
  type OpenTerminalOptions,
  type TerminalOrigin,
  type MachineLookup,
  type ConnectableMachine
} from "./terminal-gateway.js";
