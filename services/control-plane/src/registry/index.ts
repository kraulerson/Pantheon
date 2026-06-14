/**
 * Configuration / Service Registry — public barrel.
 *
 * Persistence (SQLite repo + seed), the validating service layer, and the thin MCP-server
 * registration proxy over the existing PetaAdminClient (PROJECT_BIBLE §5/§7).
 */

export {
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

export { SqliteRegistry, seedDefaults } from "./sqlite-repository.js";
export { RegistryService, ValidationError, ImmutableBindingError } from "./service.js";
export {
  McpRegistrationService,
  type PetaServerAdmin,
  type RegisterMcpServerInput
} from "./mcp-registration.js";
