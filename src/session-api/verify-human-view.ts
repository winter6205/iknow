/**
 * Human-facing verify wire projection.
 *
 * Loop outcome may still be `passed` when HITL skips the completion judge
 * after INSUFFICIENT or CONTRADICTED evidence. Humans must not see a
 * "verification passed" verdict for those shapes. SUFFICIENT short-circuit
 * stays on the wire.
 */
import {
  REASON_HITL_SKIP_COMPLETION_JUDGE,
  type EvidenceVerdict,
} from "../harness/verify/types.js";
import type { VerifyAnswerView } from "./contract.js";

export interface VerifyHumanRecord {
  readonly reason?: string;
  readonly evidenceVerdict?: EvidenceVerdict;
}

export function projectVerifyHumanView(input: {
  readonly outcome: string;
  readonly rounds: number;
  readonly records: readonly VerifyHumanRecord[];
}): VerifyAnswerView | undefined {
  if (
    input.outcome !== "failed" &&
    input.outcome !== "unstable" &&
    input.outcome !== "escalated" &&
    input.outcome !== "passed"
  ) {
    return undefined;
  }
  if (input.outcome === "passed" && isHitlSkipNotHumanPassed(input.records)) {
    return undefined;
  }
  return { outcome: input.outcome, rounds: input.rounds };
}

function isHitlSkipNotHumanPassed(
  records: readonly VerifyHumanRecord[]
): boolean {
  const last = records[records.length - 1];
  return (
    last !== undefined &&
    last.reason === REASON_HITL_SKIP_COMPLETION_JUDGE &&
    (last.evidenceVerdict === "EVIDENCE_INSUFFICIENT" ||
      last.evidenceVerdict === "EVIDENCE_CONTRADICTED")
  );
}
