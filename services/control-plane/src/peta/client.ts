/**
 * Typed Peta admin client — wraps `POST {base}/admin {action, data}` with a bearer token.
 *
 * Action numbers are Peta's ADMIN_API codes, ported from the validated reference
 * (`peta-eval/harness/peta.mjs`). PROJECT_BIBLE §6: `/admin` and GET_OWNER are NEVER
 * exposed publicly — this client is control-plane-internal only.
 */

/** Peta ADMIN_API action codes (subset used by the control-plane). */
import type { ApprovalsListFilter } from "../approvals/projection.js";
export const PetaAction = {
  CREATE_USER: 1010,
  UPDATE_USER_PERMISSIONS: 1002,
  DELETE_USER: 1013,
  GET_OWNER: 1016,
  GET_USERS: 1011,
  CREATE_SERVER: 2010,
  UPDATE_SERVER_CAPABILITIES: 2003,
  GET_SERVERS: 2011,
  GET_SERVERS_STATUS: 3004,
  LIST_APPROVALS: 9201,
  DECIDE_APPROVAL: 9203
} as const;

/** Every Peta admin response carries at least a success flag. */
export interface PetaResponse {
  readonly success: boolean;
  readonly error?: string;
  readonly [k: string]: unknown;
}

/** Thrown when Peta returns `success:false`, a non-2xx status, or an unparseable body. */
export class PetaError extends Error {
  constructor(
    message: string,
    readonly action: number,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
    this.name = "PetaError";
  }
}

export interface CreateUserRequest {
  readonly userId: string;
  readonly role: number;
  readonly status: number;
  readonly name: string;
  /** JSON-stringified {@link import("./crypto.js").EncryptedPayload}. */
  readonly encryptedToken: string;
  readonly permissions: Record<string, unknown>;
  readonly proxyId: number;
}

export interface CreateServerRequest {
  readonly serverId: string;
  readonly serverName: string;
  readonly category: number;
  readonly authType: number;
  readonly allowUserInput: boolean;
  readonly enabled: boolean;
  readonly configTemplate: string;
  readonly launchConfig: string;
}

/** The createUser surface provisioning depends on (kept narrow for testability). */
export interface PetaUserAdmin {
  createUser(req: CreateUserRequest): Promise<PetaResponse>;
}

export class PetaAdminClient implements PetaUserAdmin {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  /** Low-level call: throws {@link PetaError} on transport error, non-2xx, or success:false. */
  private async call(action: number, data: Record<string, unknown>): Promise<PetaResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/admin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`
        },
        body: JSON.stringify({ action, data })
      });
    } catch (cause) {
      throw new PetaError(`Peta admin transport error (action ${action})`, action, 0, cause);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new PetaError(`Peta returned an unparseable body (action ${action})`, action, res.status, undefined);
    }
    const json = body as PetaResponse;
    if (!res.ok || json?.success !== true) {
      // Peta's error field is sometimes a string, sometimes a {code,message} object.
      const err = json?.error as unknown;
      const detail =
        typeof err === "string"
          ? err
          : err && typeof err === "object" && "message" in err
            ? String((err as { message: unknown }).message)
            : `HTTP ${res.status}`;
      throw new PetaError(`Peta admin action ${action} failed: ${detail}`, action, res.status, body);
    }
    return json;
  }

  createUser(req: CreateUserRequest): Promise<PetaResponse> {
    return this.call(PetaAction.CREATE_USER, { ...req });
  }

  updateUserPermissions(targetId: string, permissions: Record<string, unknown>): Promise<PetaResponse> {
    return this.call(PetaAction.UPDATE_USER_PERMISSIONS, { targetId, permissions });
  }

  // DELETE_USER (1013) keys on `userId` (verified live), unlike the `targetId`-keyed
  // permission/server actions — Peta's admin field names are not uniform across actions.
  deleteUser(userId: string): Promise<PetaResponse> {
    return this.call(PetaAction.DELETE_USER, { userId });
  }

  createServer(req: CreateServerRequest): Promise<PetaResponse> {
    return this.call(PetaAction.CREATE_SERVER, { ...req });
  }

  updateServerCapabilities(targetId: string, capabilities: string): Promise<PetaResponse> {
    return this.call(PetaAction.UPDATE_SERVER_CAPABILITIES, { targetId, capabilities });
  }

  getServers(): Promise<PetaResponse> {
    return this.call(PetaAction.GET_SERVERS, {});
  }

  getServersStatus(): Promise<PetaResponse> {
    return this.call(PetaAction.GET_SERVERS_STATUS, {});
  }

  /** Filter is Peta's own vocabulary (e.g. `{ status: "PENDING", page }`); omit for the first unfiltered page. */
  listApprovals(filter: ApprovalsListFilter = {}): Promise<PetaResponse> {
    return this.call(PetaAction.LIST_APPROVALS, { ...filter });
  }

  decideApproval(approvalId: string, decision: "approved" | "rejected"): Promise<PetaResponse> {
    return this.call(PetaAction.DECIDE_APPROVAL, { approvalId, decision });
  }

  getOwner(): Promise<PetaResponse> {
    return this.call(PetaAction.GET_OWNER, {});
  }

  getUsers(): Promise<PetaResponse> {
    return this.call(PetaAction.GET_USERS, {});
  }
}
