/**
 * Typed failures for the agent-qa capability. Every non-success branch uses one
 * of these; a null, an empty value, or a bare error string is not a verdict.
 */

import type { CaseId } from "./types.ts";

/** Every fault kind this capability can name, as one list the union is derived from. */
export const FAILURE_KINDS = [
  "invalid-input",
  "invalid-protocol",
  "unreadable-budget",
  "unenforceable-budget",
  "duplicate-claim",
  "contended-claim",
  "provider-failure",
  "missing-oracle",
  "unreadable-evidence",
  "missing-reference",
  "stale-digest",
  "artifact-read",
  "artifact-write",
  "artifact-corrupt",
  "incomparable",
  "cancelled",
  "cleanup-failure",
  "unknown-usage",
  "io-failure",
  // A fault no boundary of this capability claims: stated, never attributed elsewhere.
  "unattributed",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

/** The lifecycle stages a failure can name as its origin. */
export const FAILURE_PHASES = [
  "plan-validate",
  "catalog-resolve",
  "claim",
  "dispatch",
  "oracle",
  "artifact-write",
  "artifact-read",
  "report",
  "compare",
  "cancel",
  "cleanup",
] as const;

export type FailurePhase = (typeof FAILURE_PHASES)[number];

export const CLEANUP_STATUSES = [
  "confirmed",
  "unconfirmed",
  "failed",
  "not-applicable",
] as const;

export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

/** What a retained record stores about a fault: which kind, in which phase. */
export type FailureRef = {
  readonly kind: FailureKind;
  readonly phase: FailurePhase;
};

/** A fault's stored reference plus the sentence that names it to the operator. */
export type FailureNote = FailureRef & { readonly diagnostic: string };

export type FailureDetail = {
  readonly kind: FailureKind;
  readonly phase: FailurePhase;
  readonly caseId?: CaseId;
  readonly attemptId?: string;
  /** Operator-facing and secret-free by construction. */
  readonly diagnostic: string;
  readonly dispatchMayContinue: boolean;
  readonly cleanup?: {
    readonly status: CleanupStatus;
    readonly owned: readonly string[];
  };
};

export class EvalFailure extends Error {
  readonly kind: FailureKind;
  readonly phase: FailurePhase;
  readonly caseId?: CaseId;
  readonly attemptId?: string;
  readonly diagnostic: string;
  readonly dispatchMayContinue: boolean;
  readonly cleanup?: {
    readonly status: CleanupStatus;
    readonly owned: readonly string[];
  };

  constructor(detail: FailureDetail) {
    super(`${detail.kind}@${detail.phase}: ${detail.diagnostic}`);
    this.name = "EvalFailure";
    this.kind = detail.kind;
    this.phase = detail.phase;
    this.caseId = detail.caseId;
    this.attemptId = detail.attemptId;
    this.diagnostic = detail.diagnostic;
    this.dispatchMayContinue = detail.dispatchMayContinue;
    this.cleanup = detail.cleanup;
  }

  toRecord(): FailureRef {
    return { kind: this.kind, phase: this.phase };
  }
}

export class InvalidInputFailure extends EvalFailure {
  constructor(diagnostic: string, phase: FailurePhase = "plan-validate") {
    super({
      kind: "invalid-input",
      phase,
      diagnostic,
      dispatchMayContinue: false,
    });
    this.name = "InvalidInputFailure";
  }
}

export class BudgetFailure extends EvalFailure {
  constructor(
    kind: Extract<FailureKind, "unreadable-budget" | "unenforceable-budget">,
    diagnostic: string
  ) {
    super({ kind, phase: "plan-validate", diagnostic, dispatchMayContinue: false });
    this.name = "BudgetFailure";
  }
}

export class ClaimFailure extends EvalFailure {
  constructor(
    kind: Extract<FailureKind, "duplicate-claim" | "contended-claim">,
    attemptId: string,
    diagnostic: string
  ) {
    super({
      kind,
      phase: "claim",
      attemptId,
      diagnostic,
      dispatchMayContinue: false,
    });
    this.name = "ClaimFailure";
  }
}

export class ArtifactFailure extends EvalFailure {
  constructor(
    kind: Extract<
      FailureKind,
      | "artifact-read"
      | "artifact-write"
      | "artifact-corrupt"
      | "missing-reference"
      | "stale-digest"
      | "io-failure"
    >,
    phase: FailurePhase,
    diagnostic: string,
    attemptId?: string
  ) {
    super({ kind, phase, attemptId, diagnostic, dispatchMayContinue: false });
    this.name = "ArtifactFailure";
  }
}

export class OracleFailure extends EvalFailure {
  constructor(
    kind: Extract<FailureKind, "missing-oracle" | "unreadable-evidence">,
    diagnostic: string,
    caseId?: CaseId
  ) {
    super({
      kind,
      phase: "oracle",
      caseId,
      diagnostic,
      dispatchMayContinue: false,
    });
    this.name = "OracleFailure";
  }
}

export class ProviderFailure extends EvalFailure {
  constructor(diagnostic: string, attemptId?: string) {
    super({
      kind: "provider-failure",
      phase: "dispatch",
      attemptId,
      diagnostic,
      dispatchMayContinue: false,
    });
    this.name = "ProviderFailure";
  }
}

export class IncomparableFailure extends EvalFailure {
  constructor(diagnostic: string) {
    super({
      kind: "incomparable",
      phase: "compare",
      diagnostic,
      dispatchMayContinue: false,
    });
    this.name = "IncomparableFailure";
  }
}

export class CancellationFailure extends EvalFailure {
  constructor(
    diagnostic: string,
    cleanup?: { readonly status: CleanupStatus; readonly owned: readonly string[] }
  ) {
    super({
      kind: "cancelled",
      phase: "cancel",
      diagnostic,
      dispatchMayContinue: false,
      cleanup,
    });
    this.name = "CancellationFailure";
  }
}

export class CleanupFailure extends EvalFailure {
  constructor(diagnostic: string, owned: readonly string[]) {
    super({
      kind: "cleanup-failure",
      phase: "cleanup",
      diagnostic,
      dispatchMayContinue: false,
      cleanup: { status: "failed", owned },
    });
    this.name = "CleanupFailure";
  }
}

export function isEvalFailure(value: unknown): value is EvalFailure {
  return value instanceof EvalFailure;
}

/**
 * Maps an errno to a typed failure so a filesystem fault never degrades into a
 * generic Error on the way out of the capability.
 */
export function ioFailure(
  error: unknown,
  phase: FailurePhase,
  subject: string,
  attemptId?: string
): EvalFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "unknown";
  return new ArtifactFailure(
    "io-failure",
    phase,
    `${subject} failed (${code})`,
    attemptId
  );
}
