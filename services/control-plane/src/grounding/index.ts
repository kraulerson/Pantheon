/**
 * Grounding + taint engine — public barrel.
 *
 * Pure, dependency-free logic implementing the tag -> taint -> gate pipeline (D3):
 *  - provenance tagging (trusted:false for all non-user sources)
 *  - grounded-context assembly + inspectable rendering
 *  - taint-by-presence + monotonic session taint (D5)
 *  - fail-closed write-gate decision (CC2/CC3)
 */

export {
  makeUserItem,
  makeRecalledItem,
  type ProvenanceItem,
  type UserProvenanceItem,
  type RecalledProvenanceItem,
  type ProvenanceSource,
  type RecalledSource,
  type UserSource
} from "./provenance.js";

export { assembleGroundedContext, type GroundedContext } from "./assemble.js";

export { computeTaint, SessionTaint } from "./taint.js";

export {
  decideWrite,
  type WriteDecision,
  type WriteDecisionInput
} from "./write-gate.js";
