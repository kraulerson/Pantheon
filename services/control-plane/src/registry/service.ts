/**
 * Registry service layer — CRUD for backends + service-endpoints with FAIL-CLOSED validation
 * (PROJECT_BIBLE §10 #3: never fail open; reject malformed/empty with NO partial write).
 *
 * IMMUTABILITY #14a (enforced at this service boundary): editing a backend's *endpoint* is
 * allowed (it is the service address), but this service exposes NO operation that rebinds an
 * *identity* to a different backend. Identity→backend binding is set once at Identity creation
 * and is immutable; {@link ImmutableBindingError} documents/guards any attempt elsewhere to
 * mutate it. There is deliberately no `rebindBackend`/`changeIdentityBackend` method here.
 */

import { randomUUID } from "node:crypto";
import {
  BACKEND_KINDS,
  SERVICE_KEYS,
  type Backend,
  type BackendKind,
  type BackendPatch,
  type DevMachine,
  type DevMachinePatch,
  type NewBackend,
  type NewDevMachine,
  type NewServiceEndpoint,
  type RegistryRepository,
  type ServiceEndpoint,
  type ServiceEndpointPatch,
  type ServiceKey
} from "./types.js";

/** Thrown when input is malformed/empty/unknown. Carries no secret material. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Thrown if anything attempts to rebind an identity's backend (#14a). The registry service
 * never throws this itself (it offers no such op) — it is exported so the identity layer and
 * any future caller share one named guard for the immutability invariant.
 */
export class ImmutableBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmutableBindingError";
  }
}

/**
 * Endpoint format: `host:port` where host is an IPv4/hostname (no scheme, no whitespace) and
 * port is 1–65535. Fail-closed: anything not matching is rejected (no normalization that could
 * silently accept junk).
 */
const HOST = "(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?))*";
const ENDPOINT_RE = new RegExp(`^${HOST}:\\d{1,5}$`);

function assertEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== "string" || endpoint.trim() === "") {
    throw new ValidationError("endpoint is required");
  }
  const value = endpoint.trim();
  if (!ENDPOINT_RE.test(value)) {
    throw new ValidationError(`malformed endpoint (expected host:port): ${value}`);
  }
  const portStr = value.slice(value.lastIndexOf(":") + 1);
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError(`endpoint port out of range: ${value}`);
  }
  return value;
}

function assertNonEmpty(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`${field} is required`);
  }
  return value.trim();
}

function assertBackendKind(kind: unknown): BackendKind {
  if (typeof kind !== "string" || !(BACKEND_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`unknown backend kind: ${String(kind)}`);
  }
  return kind as BackendKind;
}

function assertServiceKey(key: unknown): ServiceKey {
  if (typeof key !== "string" || !(SERVICE_KEYS as readonly string[]).includes(key)) {
    throw new ValidationError(`unknown service key: ${String(key)}`);
  }
  return key as ServiceKey;
}

// ---- DevMachine validators (§5, ADR-0005, TM-020) ----

/** A bare host (IPv4/hostname, no scheme, no port, no whitespace). */
const HOST_RE = new RegExp(`^${HOST}$`);
/**
 * A stable, identity-binding logical handle: letters/digits with `.`, `_`, `-`. Must NOT begin with
 * `-` (it could later be spliced into an argv and parsed as an option).
 */
const LOGICAL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/**
 * An SSH username: no whitespace, no shell metacharacters, and NO leading `-` — so `${user}@host`
 * can never be parsed as an `ssh`/`ssh-copy-id` option (argv option-injection guard).
 */
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/**
 * An opaque custody handle. Filename-safe — NO path separators or `:` — so it matches the file
 * custody grammar exactly and can never traverse out of the key dir (defense in depth with
 * FileKeyCustody's own check). A single token, ≤128 chars, no whitespace/newlines.
 */
const KEY_HANDLE_RE = /^[A-Za-z0-9._-]{1,128}$/;

function assertLogicalName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("logicalName is required");
  }
  const v = value.trim();
  if (!LOGICAL_NAME_RE.test(v)) {
    throw new ValidationError(`malformed logicalName (letters/digits/._- only): ${v}`);
  }
  return v;
}

function assertHost(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("host is required");
  }
  const v = value.trim();
  if (!HOST_RE.test(v)) {
    throw new ValidationError(`malformed host (expected bare IP/hostname, no port/scheme): ${v}`);
  }
  return v;
}

function assertPort(value: unknown): number {
  if (value === undefined) return 22;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ValidationError(`port out of range (1-65535): ${String(value)}`);
  }
  return value;
}

function assertUser(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("user is required");
  }
  const v = value.trim();
  if (!USER_RE.test(v)) {
    throw new ValidationError(`malformed user (letters/digits/._- only): ${v}`);
  }
  return v;
}

/**
 * Custody guard (TM-020 / #14b / Principle 1): a key handle is an OPAQUE single-token vault
 * reference, NEVER raw key material. Reject anything multi-line, whitespace-bearing, or carrying
 * PEM/key markers — fail closed. Empty string is allowed (machine not yet provisioned).
 */
function assertKeyHandle(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string") {
    throw new ValidationError("sshKeyHandle must be an opaque string handle");
  }
  if (/-----|BEGIN|PRIVATE/i.test(value) || !KEY_HANDLE_RE.test(value)) {
    throw new ValidationError("sshKeyHandle must be an opaque vault reference, not raw key material");
  }
  return value;
}

export class RegistryService {
  constructor(private readonly repo: RegistryRepository) {}

  // ---- Backends ----

  createBackend(input: NewBackend): Backend {
    // Validate everything BEFORE touching the repo (no partial write).
    const kind = assertBackendKind(input.kind);
    const endpoint = assertEndpoint(input.endpoint);
    const displayName = assertNonEmpty("displayName", input.displayName);
    const now = new Date().toISOString();
    const backend: Backend = {
      id: randomUUID(),
      kind,
      endpoint,
      displayName,
      enabled: input.enabled === true,
      createdAt: now,
      updatedAt: now
    };
    this.repo.insertBackend(backend);
    return backend;
  }

  getBackend(id: string): Backend | undefined {
    return this.repo.getBackend(id);
  }

  listBackends(): Backend[] {
    return this.repo.listBackends();
  }

  /** Edit a backend's mutable fields (endpoint/displayName/enabled). `kind` is not editable. */
  updateBackend(id: string, patch: BackendPatch): Backend {
    const existing = this.repo.getBackend(id);
    if (!existing) throw new ValidationError(`backend not found: ${id}`);
    // Validate the proposed values first; only write if all pass.
    const endpoint = patch.endpoint === undefined ? existing.endpoint : assertEndpoint(patch.endpoint);
    const displayName =
      patch.displayName === undefined ? existing.displayName : assertNonEmpty("displayName", patch.displayName);
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled === true;
    const next: Backend = {
      ...existing,
      endpoint,
      displayName,
      enabled,
      updatedAt: new Date().toISOString()
    };
    this.repo.updateBackend(id, next);
    return next;
  }

  deleteBackend(id: string): void {
    this.repo.deleteBackend(id);
  }

  // ---- Service endpoints ----

  createServiceEndpoint(input: NewServiceEndpoint): ServiceEndpoint {
    const key = assertServiceKey(input.key);
    const endpoint = assertEndpoint(input.endpoint);
    const displayName = assertNonEmpty("displayName", input.displayName);
    const endpointRow: ServiceEndpoint = {
      id: randomUUID(),
      key,
      endpoint,
      displayName,
      enabled: input.enabled === true,
      updatedAt: new Date().toISOString()
    };
    this.repo.insertServiceEndpoint(endpointRow);
    return endpointRow;
  }

  getServiceEndpoint(id: string): ServiceEndpoint | undefined {
    return this.repo.getServiceEndpoint(id);
  }

  listServiceEndpoints(): ServiceEndpoint[] {
    return this.repo.listServiceEndpoints();
  }

  updateServiceEndpoint(id: string, patch: ServiceEndpointPatch): ServiceEndpoint {
    const existing = this.repo.getServiceEndpoint(id);
    if (!existing) throw new ValidationError(`service endpoint not found: ${id}`);
    const endpoint = patch.endpoint === undefined ? existing.endpoint : assertEndpoint(patch.endpoint);
    const displayName =
      patch.displayName === undefined ? existing.displayName : assertNonEmpty("displayName", patch.displayName);
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled === true;
    const next: ServiceEndpoint = { ...existing, endpoint, displayName, enabled, updatedAt: new Date().toISOString() };
    this.repo.updateServiceEndpoint(id, next);
    return next;
  }

  deleteServiceEndpoint(id: string): void {
    this.repo.deleteServiceEndpoint(id);
  }

  // ---- Dev machines (Claude-CLI SSH targets — ADR-0005, §5, TM-020) ----

  createDevMachine(input: NewDevMachine): DevMachine {
    // Validate everything BEFORE touching the repo (no partial write).
    const logicalName = assertLogicalName(input.logicalName);
    const host = assertHost(input.host);
    const port = assertPort(input.port);
    const user = assertUser(input.user);
    const sshKeyHandle = assertKeyHandle(input.sshKeyHandle);
    if (this.repo.getDevMachineByLogicalName(logicalName)) {
      throw new ValidationError(`dev machine logicalName already in use: ${logicalName}`);
    }
    const now = new Date().toISOString();
    const machine: DevMachine = {
      id: randomUUID(),
      logicalName,
      host,
      port,
      user,
      sshKeyHandle,
      // A freshly-registered machine is never provisioned; provisioning is a separate step (b).
      provisioned: false,
      enabled: input.enabled === true,
      createdAt: now,
      updatedAt: now
    };
    this.repo.insertDevMachine(machine);
    return machine;
  }

  getDevMachine(id: string): DevMachine | undefined {
    return this.repo.getDevMachine(id);
  }

  getDevMachineByLogicalName(logicalName: string): DevMachine | undefined {
    return this.repo.getDevMachineByLogicalName(logicalName);
  }

  listDevMachines(): DevMachine[] {
    return this.repo.listDevMachines();
  }

  /**
   * Edit mutable fields. `logicalName` (the immutable binding handle, #14a) is not editable, and
   * neither are `provisioned`/`sshKeyHandle` (set only by {@link markProvisioned} — they cannot be
   * forged here, TM-020 invariant #4). Changing a connectivity field (host/port/user) RESETS
   * provisioning, because the new endpoint has no harness key installed.
   */
  updateDevMachine(id: string, patch: DevMachinePatch): DevMachine {
    const existing = this.repo.getDevMachine(id);
    if (!existing) throw new ValidationError(`dev machine not found: ${id}`);
    // Validate the proposed values first; only write if all pass.
    const host = patch.host === undefined ? existing.host : assertHost(patch.host);
    const port = patch.port === undefined ? existing.port : assertPort(patch.port);
    const user = patch.user === undefined ? existing.user : assertUser(patch.user);
    const enabled = patch.enabled === undefined ? existing.enabled : patch.enabled === true;

    const connectivityChanged = host !== existing.host || port !== existing.port || user !== existing.user;
    const provisioned = connectivityChanged ? false : existing.provisioned;
    const sshKeyHandle = connectivityChanged ? "" : existing.sshKeyHandle;

    const next: DevMachine = {
      ...existing,
      host,
      port,
      user,
      enabled,
      provisioned,
      sshKeyHandle,
      updatedAt: new Date().toISOString()
    };
    this.repo.updateDevMachine(id, next);
    return next;
  }

  /**
   * Record a successful provisioning (called by the provisioning bridge after `ssh-copy-id`). This
   * is the ONLY path that sets `provisioned=true` + the key handle — keeping that state un-forgeable
   * through the generic update/admin route (TM-020 invariant #4).
   */
  markProvisioned(id: string, keyHandle: string): DevMachine {
    const existing = this.repo.getDevMachine(id);
    if (!existing) throw new ValidationError(`dev machine not found: ${id}`);
    const handle = assertKeyHandle(keyHandle);
    if (handle === "") throw new ValidationError("a provisioned machine requires a non-empty key handle");
    const next: DevMachine = {
      ...existing,
      provisioned: true,
      sshKeyHandle: handle,
      updatedAt: new Date().toISOString()
    };
    this.repo.updateDevMachine(id, next);
    return next;
  }

  deleteDevMachine(id: string): void {
    this.repo.deleteDevMachine(id);
  }
}
