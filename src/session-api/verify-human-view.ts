/**
 * Human-facing verify wire projection.
 *
 * The loop may still report `passed` when HITL skips the completion judge
 * after INSUFFICIENT or CONTRADICTED evidence (and newer loops report the
 * terminal outcome `not_run` directly). Humans must not see a
 * "verification passed" verdict for those shapes: both map to the honest
 * `not_run` outcome, with `notRunReason` discriminating which locked copy
 * renders. Legacy records (final_outcome=passed + hitl_skip shape) map at
 * read time — no data migration. SUFFICIENT short-circuit stays `passed`.
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
    input.outcome !== "passed" &&
    input.outcome !== "not_run"
  ) {
    return undefined;
  }
  const skipReason = hitlSkipNotRunReason(input.records);
  if (input.outcome === "not_run") {
    return {
      outcome: "not_run",
      rounds: input.rounds,
      notRunReason: skipReason ?? "insufficient",
    };
  }
  if (input.outcome === "passed" && skipReason !== undefined) {
    return {
      outcome: "not_run",
      rounds: input.rounds,
      notRunReason: skipReason,
    };
  }
  return { outcome: input.outcome, rounds: input.rounds };
}

function hitlSkipNotRunReason(
  records: readonly VerifyHumanRecord[]
): VerifyAnswerView["notRunReason"] {
  const last = records[records.length - 1];
  if (last === undefined || last.reason !== REASON_HITL_SKIP_COMPLETION_JUDGE) {
    return undefined;
  }
  if (last.evidenceVerdict === "EVIDENCE_INSUFFICIENT") {
    return "insufficient";
  }
  if (last.evidenceVerdict === "EVIDENCE_CONTRADICTED") {
    return "contradicted";
  }
  return undefined;
}
