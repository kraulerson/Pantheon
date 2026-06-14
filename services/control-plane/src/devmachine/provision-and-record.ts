/**
 * provisionAndRecord — bridge the SSH provisioning ceremony to the registry (Task #16b).
 *
 * Looks up a DevMachine by logicalName, runs provisioning, and ONLY on success persists
 * `provisioned=true` + the key handle. A failure propagates and leaves the row unprovisioned, so a
 * machine is never marked usable unless its public key was actually installed.
 */

import { type DevMachine } from "../registry/types.js";
import { type ProvisionResult, type SshTarget } from "./provisioning.js";

/** The registry surface this orchestration needs (satisfied by RegistryService). */
export interface RegistryPort {
  getDevMachineByLogicalName(logicalName: string): DevMachine | undefined;
  /** The ONLY way provisioned state is set — keeps it un-forgeable via the generic update route. */
  markProvisioned(id: string, keyHandle: string): DevMachine;
}

export interface ProvisionAndRecordDeps {
  readonly registry: RegistryPort;
  /** Inject the SSH provisioning step (real: `provisionMachine` bound to its adapters). */
  readonly provision: (target: SshTarget, handle: string) => Promise<ProvisionResult>;
  /** The custody handle of the harness keypair (one shared keypair across machines). */
  readonly keyHandle: string;
}

export async function provisionAndRecord(logicalName: string, deps: ProvisionAndRecordDeps): Promise<DevMachine> {
  const machine = deps.registry.getDevMachineByLogicalName(logicalName);
  if (!machine) {
    throw new Error(`no dev machine with logicalName '${logicalName}'`);
  }

  const target: SshTarget = {
    logicalName: machine.logicalName,
    host: machine.host,
    port: machine.port,
    user: machine.user
  };
  // If this throws, we never reach the registry update — the row stays unprovisioned.
  const result = await deps.provision(target, deps.keyHandle);

  return deps.registry.markProvisioned(machine.id, result.keyHandle);
}
