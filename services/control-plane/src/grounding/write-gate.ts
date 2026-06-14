/**
 * Write-gate decision (#14c, D3, D4) — the control-plane layer of tag -> taint -> gate.
 *
 * Enforcement is FAIL-CLOSED (CC2) and decided here, never by the model (CC3). Ordering
 * (D3) is load-bearing: a write whose provenance was never tagged must gate, because taint
 * can only be computed over tagged content — skipping tagging must not open an ungated
 * write window (TM-013).
 *
 * Rules:
 *  - reads (toolIsWrite=false)            -> never gated.
 *  - write, provenance NOT tagged         -> gated (fail closed; tag -> taint -> gate).
 *  - write, tagged, session tainted       -> gated pending out-of-band approval (D4).
 *  - write, tagged, session untainted     -> ungated (verifiably clean).
 */

export interface WriteDecisionInput {
  /** True if the tool being invoked is write-scoped (`dangerLevel:2`, D2). */
  readonly toolIsWrite: boolean;
  /** True only if EVERY item in the originating context carried a provenance tag. */
  readonly provenanceTagged: boolean;
  /** True if the session is tainted (any `trusted:false` content present). */
  readonly sessionTainted: boolean;
}

export interface WriteDecision {
  readonly gated: boolean;
  /** Human-readable reason; always present. */
  readonly reason: string;
}

export function decideWrite(input: WriteDecisionInput): WriteDecision {
  // Reads and reasoning are frictionless — never gated (Manifesto §1).
  if (!input.toolIsWrite) {
    return { gated: false, reason: "Read/non-write tool call — never gated." };
  }

  // tag -> taint -> gate (D3): without a tag, taint is unknowable, so fail closed.
  if (!input.provenanceTagged) {
    return {
      gated: true,
      reason:
        "Fail-closed: write from untagged/unknown-provenance context. Provenance must be " +
        "tagged before taint can be evaluated (tag -> taint -> gate, D3)."
    };
  }

  // Tagged but tainted -> hold for out-of-band human approval (D4).
  if (input.sessionTainted) {
    return {
      gated: true,
      reason: "Write from a tainted session — gated pending out-of-band approval (D4)."
    };
  }

  // Verifiably clean: fully-tagged and untainted.
  return {
    gated: false,
    reason: "Write from a verifiably-clean (fully-tagged, untainted) session — ungated."
  };
}
