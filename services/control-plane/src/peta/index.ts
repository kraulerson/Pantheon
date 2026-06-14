/**
 * Peta admin client + identity-provisioning — public barrel.
 *
 * Control-plane-internal glue to Peta's `/admin` API (PROJECT_BIBLE §6/§7):
 *  - crypto: byte-for-byte port of Peta's PBKDF2/AES-256-GCM envelope + userId hash
 *  - PetaAdminClient: typed methods over POST /admin {action, data}
 *  - registerExistingIdentity: mints the 1:1 Peta user for an existing Identity
 */

export { calcUserId, encryptData, type EncryptedPayload } from "./crypto.js";

export {
  PetaAdminClient,
  PetaError,
  PetaAction,
  type PetaResponse,
  type PetaUserAdmin,
  type CreateUserRequest,
  type CreateServerRequest
} from "./client.js";

export {
  registerExistingIdentity,
  type RegisterExistingIdentityInput,
  type ProvisionedPetaUser,
  type ProvisioningDeps
} from "./provisioning.js";
