/**
 * SQLite implementation of {@link RegistryRepository} (better-sqlite3, synchronous).
 *
 * PROJECT_BIBLE §5: the control-plane's own persistent state uses a small local store sized
 * for one operator. No raw secrets are ever stored here (custody invariant — §5 principle 1);
 * this registry holds only service addresses + display metadata.
 */

import Database from "better-sqlite3";
import type {
  Backend,
  DevMachine,
  RegistryRepository,
  ServiceEndpoint,
  ServiceKey
} from "./types.js";

interface BackendRow {
  id: string;
  kind: string;
  endpoint: string;
  display_name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface EndpointRow {
  id: string;
  key: string;
  endpoint: string;
  display_name: string;
  enabled: number;
  updated_at: string;
}

interface DevMachineRow {
  id: string;
  logical_name: string;
  host: string;
  port: number;
  user: string;
  ssh_key_handle: string;
  provisioned: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS backend_registry (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  endpoint     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled      INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_endpoint (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  endpoint     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled      INTEGER NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dev_machine (
  id             TEXT PRIMARY KEY,
  logical_name   TEXT NOT NULL UNIQUE,
  host           TEXT NOT NULL,
  port           INTEGER NOT NULL,
  "user"         TEXT NOT NULL,
  ssh_key_handle TEXT NOT NULL,
  provisioned    INTEGER NOT NULL,
  enabled        INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
`;

export class SqliteRegistry implements RegistryRepository {
  private readonly db: Database.Database;

  /** `filename` is a path or `:memory:` (tests use in-memory or a temp file). */
  constructor(filename = ":memory:") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  private static toBackend(r: BackendRow): Backend {
    return {
      id: r.id,
      kind: r.kind as Backend["kind"],
      endpoint: r.endpoint,
      displayName: r.display_name,
      enabled: r.enabled === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  private static toEndpoint(r: EndpointRow): ServiceEndpoint {
    return {
      id: r.id,
      key: r.key as ServiceKey,
      endpoint: r.endpoint,
      displayName: r.display_name,
      enabled: r.enabled === 1,
      updatedAt: r.updated_at
    };
  }

  insertBackend(b: Backend): void {
    this.db
      .prepare(
        `INSERT INTO backend_registry (id, kind, endpoint, display_name, enabled, created_at, updated_at)
         VALUES (@id, @kind, @endpoint, @display_name, @enabled, @created_at, @updated_at)`
      )
      .run({
        id: b.id,
        kind: b.kind,
        endpoint: b.endpoint,
        display_name: b.displayName,
        enabled: b.enabled ? 1 : 0,
        created_at: b.createdAt,
        updated_at: b.updatedAt
      });
  }

  getBackend(id: string): Backend | undefined {
    const r = this.db.prepare("SELECT * FROM backend_registry WHERE id = ?").get(id) as BackendRow | undefined;
    return r ? SqliteRegistry.toBackend(r) : undefined;
  }

  listBackends(): Backend[] {
    const rows = this.db.prepare("SELECT * FROM backend_registry ORDER BY created_at, id").all() as BackendRow[];
    return rows.map(SqliteRegistry.toBackend);
  }

  updateBackend(id: string, b: Backend): void {
    this.db
      .prepare(
        `UPDATE backend_registry
         SET kind = @kind, endpoint = @endpoint, display_name = @display_name,
             enabled = @enabled, updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        kind: b.kind,
        endpoint: b.endpoint,
        display_name: b.displayName,
        enabled: b.enabled ? 1 : 0,
        updated_at: b.updatedAt
      });
  }

  deleteBackend(id: string): void {
    this.db.prepare("DELETE FROM backend_registry WHERE id = ?").run(id);
  }

  insertServiceEndpoint(e: ServiceEndpoint): void {
    this.db
      .prepare(
        `INSERT INTO service_endpoint (id, key, endpoint, display_name, enabled, updated_at)
         VALUES (@id, @key, @endpoint, @display_name, @enabled, @updated_at)`
      )
      .run({
        id: e.id,
        key: e.key,
        endpoint: e.endpoint,
        display_name: e.displayName,
        enabled: e.enabled ? 1 : 0,
        updated_at: e.updatedAt
      });
  }

  getServiceEndpoint(id: string): ServiceEndpoint | undefined {
    const r = this.db.prepare("SELECT * FROM service_endpoint WHERE id = ?").get(id) as EndpointRow | undefined;
    return r ? SqliteRegistry.toEndpoint(r) : undefined;
  }

  getServiceEndpointByKey(key: ServiceKey): ServiceEndpoint | undefined {
    const r = this.db.prepare("SELECT * FROM service_endpoint WHERE key = ?").get(key) as EndpointRow | undefined;
    return r ? SqliteRegistry.toEndpoint(r) : undefined;
  }

  listServiceEndpoints(): ServiceEndpoint[] {
    const rows = this.db.prepare("SELECT * FROM service_endpoint ORDER BY key").all() as EndpointRow[];
    return rows.map(SqliteRegistry.toEndpoint);
  }

  updateServiceEndpoint(id: string, e: ServiceEndpoint): void {
    this.db
      .prepare(
        `UPDATE service_endpoint
         SET endpoint = @endpoint, display_name = @display_name, enabled = @enabled, updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        endpoint: e.endpoint,
        display_name: e.displayName,
        enabled: e.enabled ? 1 : 0,
        updated_at: e.updatedAt
      });
  }

  deleteServiceEndpoint(id: string): void {
    this.db.prepare("DELETE FROM service_endpoint WHERE id = ?").run(id);
  }

  private static toDevMachine(r: DevMachineRow): DevMachine {
    return {
      id: r.id,
      logicalName: r.logical_name,
      host: r.host,
      port: r.port,
      user: r.user,
      sshKeyHandle: r.ssh_key_handle,
      provisioned: r.provisioned === 1,
      enabled: r.enabled === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }

  insertDevMachine(m: DevMachine): void {
    this.db
      .prepare(
        `INSERT INTO dev_machine
           (id, logical_name, host, port, "user", ssh_key_handle, provisioned, enabled, created_at, updated_at)
         VALUES
           (@id, @logical_name, @host, @port, @user, @ssh_key_handle, @provisioned, @enabled, @created_at, @updated_at)`
      )
      .run({
        id: m.id,
        logical_name: m.logicalName,
        host: m.host,
        port: m.port,
        user: m.user,
        ssh_key_handle: m.sshKeyHandle,
        provisioned: m.provisioned ? 1 : 0,
        enabled: m.enabled ? 1 : 0,
        created_at: m.createdAt,
        updated_at: m.updatedAt
      });
  }

  getDevMachine(id: string): DevMachine | undefined {
    const r = this.db.prepare("SELECT * FROM dev_machine WHERE id = ?").get(id) as DevMachineRow | undefined;
    return r ? SqliteRegistry.toDevMachine(r) : undefined;
  }

  getDevMachineByLogicalName(logicalName: string): DevMachine | undefined {
    const r = this.db.prepare("SELECT * FROM dev_machine WHERE logical_name = ?").get(logicalName) as
      | DevMachineRow
      | undefined;
    return r ? SqliteRegistry.toDevMachine(r) : undefined;
  }

  listDevMachines(): DevMachine[] {
    const rows = this.db.prepare("SELECT * FROM dev_machine ORDER BY created_at, id").all() as DevMachineRow[];
    return rows.map(SqliteRegistry.toDevMachine);
  }

  updateDevMachine(id: string, m: DevMachine): void {
    this.db
      .prepare(
        `UPDATE dev_machine
         SET host = @host, port = @port, "user" = @user, ssh_key_handle = @ssh_key_handle,
             provisioned = @provisioned, enabled = @enabled, updated_at = @updated_at
         WHERE id = @id`
      )
      .run({
        id,
        host: m.host,
        port: m.port,
        user: m.user,
        ssh_key_handle: m.sshKeyHandle,
        provisioned: m.provisioned ? 1 : 0,
        enabled: m.enabled ? 1 : 0,
        updated_at: m.updatedAt
      });
  }

  deleteDevMachine(id: string): void {
    this.db.prepare("DELETE FROM dev_machine WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Seed sensible homelab defaults (PROJECT_BIBLE §4/§5): Alden-1 backend + Qdrant/Bridge service
 * endpoints. Idempotent — re-running does not duplicate (keyed by service key / existing endpoint).
 */
export function seedDefaults(repo: RegistryRepository): void {
  const now = new Date().toISOString();

  const haveAlden = repo.listBackends().some((b) => b.endpoint === "192.168.1.89:8080");
  if (!haveAlden) {
    repo.insertBackend({
      id: "seed-alden-1",
      kind: "local_alden1",
      endpoint: "192.168.1.89:8080",
      displayName: "Alden-1",
      enabled: true,
      createdAt: now,
      updatedAt: now
    });
  }

  const serviceSeeds: ReadonlyArray<{ key: ServiceKey; endpoint: string; displayName: string }> = [
    { key: "qdrant", endpoint: "10.100.23.79:6333", displayName: "Qdrant" },
    { key: "bridge", endpoint: "10.100.23.88:8765", displayName: "Alden Bridge" }
  ];
  for (const s of serviceSeeds) {
    if (!repo.getServiceEndpointByKey(s.key)) {
      repo.insertServiceEndpoint({
        id: `seed-${s.key}`,
        key: s.key,
        endpoint: s.endpoint,
        displayName: s.displayName,
        enabled: true,
        updatedAt: now
      });
    }
  }
}
