/**
 * Configuration / Service Registry domain types (PROJECT_BIBLE §5 data model).
 *
 * BackendRegistry  — data-driven set of AI systems (#2, #5).
 * ServiceEndpoint  — control-plane's own downstream service endpoints (Qdrant, Gitea,
 *                    Bridge, Obsidian, Peta) — operationally configurable, NOT identity bindings.
 *
 * NB (#14a immutability): a Backend's `endpoint` is editable here (it is the *service* address),
 * but there is no operation anywhere that rebinds an *identity* to a different backend — that
 * binding is immutable and lives on the Identity row, set once at creation. See service.ts.
 */

/** Closed set of backend kinds (§5: BackendRegistry.kind). */
export const BACKEND_KINDS = ["local_alden1", "claude_cli", "future_local_7900xtx", "future_cloud"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

/** Closed set of control-plane service-endpoint keys. */
export const SERVICE_KEYS = ["qdrant", "gitea", "bridge", "obsidian", "peta", "other"] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

export interface Backend {
  readonly id: string;
  readonly kind: BackendKind;
  readonly endpoint: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServiceEndpoint {
  readonly id: string;
  readonly key: ServiceKey;
  readonly endpoint: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}

/**
 * DevMachine — a Claude-CLI SSH-terminal target (PROJECT_BIBLE §5, ADR-0005, TM-020).
 *
 * `logicalName` is the IMMUTABLE handle identities bind against (#14a): the `host`/IP may change
 * without breaking the binding. `sshKeyHandle` is an OPAQUE vault custody reference (#14b /
 * Principle 1) — NEVER the raw private key; `""` until the machine is provisioned (sub-task b).
 */
export interface DevMachine {
  readonly id: string;
  readonly logicalName: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly sshKeyHandle: string;
  readonly provisioned: boolean;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewDevMachine {
  readonly logicalName: string;
  readonly host: string;
  /** SSH port; defaults to 22 when omitted. */
  readonly port?: number;
  readonly user: string;
  /** Opaque custody reference; defaults to `""` (unprovisioned). NEVER a raw key. */
  readonly sshKeyHandle?: string;
  readonly enabled: boolean;
}

/**
 * Partial mutations via the generic update path. `logicalName` (the binding handle, #14a) and `id`
 * are NOT editable; `provisioned`/`sshKeyHandle` are NOT here either — they are set only by
 * {@link RegistryService.markProvisioned} after the SSH provisioning ceremony succeeds, so they
 * cannot be forged through the admin update route (TM-020 invariant #4). Editing a connectivity
 * field (host/port/user) resets provisioning, since the new endpoint has no key installed.
 */
export type DevMachinePatch = Partial<Pick<DevMachine, "host" | "port" | "user" | "enabled">>;

export interface NewBackend {
  readonly kind: BackendKind;
  readonly endpoint: string;
  readonly displayName: string;
  readonly enabled: boolean;
}

export interface NewServiceEndpoint {
  readonly key: ServiceKey;
  readonly endpoint: string;
  readonly displayName: string;
  readonly enabled: boolean;
}

/** Partial mutations; `endpoint` re-validated when present. Never includes `id`/`kind`/`key`. */
export type BackendPatch = Partial<Pick<Backend, "endpoint" | "displayName" | "enabled">>;
export type ServiceEndpointPatch = Partial<Pick<ServiceEndpoint, "endpoint" | "displayName" | "enabled">>;

/**
 * Persistence boundary. Repository methods are storage-only (no validation): validation and
 * fail-closed policy live in the service layer so they are enforced at one place (§10 #3).
 */
export interface RegistryRepository {
  insertBackend(b: Backend): void;
  getBackend(id: string): Backend | undefined;
  listBackends(): Backend[];
  updateBackend(id: string, b: Backend): void;
  deleteBackend(id: string): void;

  insertServiceEndpoint(e: ServiceEndpoint): void;
  getServiceEndpoint(id: string): ServiceEndpoint | undefined;
  getServiceEndpointByKey(key: ServiceKey): ServiceEndpoint | undefined;
  listServiceEndpoints(): ServiceEndpoint[];
  updateServiceEndpoint(id: string, e: ServiceEndpoint): void;
  deleteServiceEndpoint(id: string): void;

  insertDevMachine(m: DevMachine): void;
  getDevMachine(id: string): DevMachine | undefined;
  getDevMachineByLogicalName(logicalName: string): DevMachine | undefined;
  listDevMachines(): DevMachine[];
  updateDevMachine(id: string, m: DevMachine): void;
  deleteDevMachine(id: string): void;
}
