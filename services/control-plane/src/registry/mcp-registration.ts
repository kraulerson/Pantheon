/**
 * Thin MCP-server registration service — proxies the existing {@link PetaAdminClient}
 * (PROJECT_BIBLE §7/#10a: new downstream MCP servers require admin-tier registration at the
 * gateway; a session can never register a server). Validation is fail-closed: a malformed
 * endpoint or empty id/name is rejected BEFORE any Peta call (no partial gateway write).
 *
 * ADR-0003: downstreams are remote/HTTP only — never CustomStdio. We register the server with
 * its HTTP endpoint in the launch config.
 */

import { ValidationError } from "./service.js";
import type { CreateServerRequest, PetaResponse } from "../peta/client.js";

/** The narrow Peta surface this service depends on (keeps it unit-testable with a stub). */
export interface PetaServerAdmin {
  createServer(req: CreateServerRequest): Promise<PetaResponse>;
  getServers(): Promise<PetaResponse>;
}

export interface RegisterMcpServerInput {
  readonly serverId: string;
  readonly serverName: string;
  /** Remote HTTP endpoint (host:port) — ADR-0003 forbids stdio downstreams. */
  readonly endpoint: string;
}

const ENDPOINT_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?))*:\d{1,5}$/;

// Peta server category/auth enums (mirrors the validated reference; HTTP downstream, no auth-by-default).
const CATEGORY_REMOTE_HTTP = 1;
const AUTH_NONE = 0;

export class McpRegistrationService {
  constructor(private readonly client: PetaServerAdmin) {}

  async register(input: RegisterMcpServerInput): Promise<PetaResponse> {
    const serverId = (input.serverId ?? "").trim();
    const serverName = (input.serverName ?? "").trim();
    const endpoint = (input.endpoint ?? "").trim();
    if (serverId === "") throw new ValidationError("serverId is required");
    if (serverName === "") throw new ValidationError("serverName is required");
    if (!ENDPOINT_RE.test(endpoint)) throw new ValidationError(`malformed endpoint (expected host:port): ${endpoint}`);

    const req: CreateServerRequest = {
      serverId,
      serverName,
      category: CATEGORY_REMOTE_HTTP,
      authType: AUTH_NONE,
      allowUserInput: false,
      enabled: true,
      configTemplate: "{}",
      launchConfig: JSON.stringify({ transport: "http", url: `http://${endpoint}` })
    };
    return this.client.createServer(req);
  }

  /** List registered servers (unwraps Peta's `servers` array; fail-closed to []). */
  async list(): Promise<unknown[]> {
    const res = await this.client.getServers();
    const servers = (res as { servers?: unknown }).servers;
    return Array.isArray(servers) ? servers : [];
  }
}
