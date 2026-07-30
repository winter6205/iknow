/**
 * Trajectory scorer — implements docs/iknow-spec/docs/eval/trajectory-eval-spec.md
 * + hard gates from eval-gate.draft.md §1.
 */
import {
  ANSWER_RX,
  DEFAULT_MAX_STEPS,
  EVAL_MAX_HOPS,
  GATE_ID,
  NOTE,
} from "./lexicon.js";
import { checkPolicy } from "./policy-checks.js";
import type {
  EvalSample,
  HardConstraintResult,
  TrajectoryRunLog,
  TrajectoryScoreResult,
} from "./types.js";

function calledTools(log: TrajectoryRunLog): Set<string> {
  return new Set(log.tool_calls.map((c) => c.tool));
}

/**
 * Authoritative hop counter is agent-reported hops_used.
 * Non-number → Infinity so the hops hard gate fails.
 */
function hopCount(log: TrajectoryRunLog): number {
  const reported = log.output_fields.hops_used;
  if (typeof reported !== "number" || !Number.isFinite(reported)) {
    return Number.POSITIVE_INFINITY;
  }
  return reported;
}

function roundScore(n: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Hard constraints (one veto). Maps expected.policies + global gate names.
 * Policy routing is by string content only (no sample.id primary).
 */
export function checkHardConstraints(
  sample: EvalSample,
  log: TrajectoryRunLog
): HardConstraintResult {
  const failed: string[] = [];
  const policies = sample.expected.policies ?? [];
  const text = log.final_answer;
  const notes = log.output_fields.notes ?? [];
  const tools = calledTools(log);
  const hops = hopCount(log);
  const maxSteps = sample.max_steps ?? DEFAULT_MAX_STEPS;
  const source_span = log.output_fields.source_span ?? [];
  const snapshot_id = log.output_fields.snapshot_id ?? "";
  const governance_status = log.output_fields.governance_status;

  // G2
  if (!snapshot_id) {
    failed.push(GATE_ID.G2_REQUIRED);
  }

  // hops
  if (hops > EVAL_MAX_HOPS || hops > maxSteps) {
    failed.push(GATE_ID.HOPS_LE_5);
  }

  const ctx = {
    text,
    notes,
    tools,
    hops,
    governance_status,
    source_span_len: source_span.length,
    snapshot_id,
    sample,
  };

  for (const p of policies) {
    // Exact G2 / hops already enforced above; skip re-check noise.
    if (p === GATE_ID.G2_REQUIRED || p === GATE_ID.HOPS_LE_5) continue;

    const result = checkPolicy(p, ctx);
    if (result === "unknown") {
      failed.push(`${GATE_ID.UNRECOGNIZED_POLICY_PREFIX}${p}`);
      continue;
    }
    if (!result) {
      failed.push(p);
    }
  }

  // global gate: easy path should retrieve
  if (sample.category === "easy" && !tools.has("kb_retrieve")) {
    failed.push(GATE_ID.EASY_MUST_RETRIEVE);
  }

  // source_span layer: non-empty answers that claim KB content should cite
  // (deny/empty paths may have empty spans)
  const isDeny =
    notes.includes(NOTE.PERMISSION_DENIED) ||
    notes.includes(NOTE.REQUIRE_APPROVAL) ||
    notes.includes(NOTE.EMPTY_RESULT);
  if (!isDeny && ANSWER_RX.kbBody.test(text) && source_span.length === 0) {
    failed.push(GATE_ID.SOURCE_SPAN_REQUIRED);
  }

  // dedupe
  const unique = [...new Set(failed)];
  return { all_pass: unique.length === 0, failed: unique };
}

export function scoreTrajectory(
  sample: EvalSample,
  log: TrajectoryRunLog
): TrajectoryScoreResult {
  const required = sample.expected.required_tools ?? [];
  const recommended = sample.expected.recommended_tools ?? [];
  const called = calledTools(log);
  const maxSteps = Math.max(1, sample.max_steps ?? DEFAULT_MAX_STEPS);

  const requiredHit = required.filter((t) => called.has(t)).length;
  const recommendedHit = recommended.filter((t) => called.has(t)).length;

  const required_coverage =
    required.length === 0 ? 1 : requiredHit / required.length;
  const recommended_coverage =
    recommended.length === 0 ? 1 : recommendedHit / recommended.length;

  const steps = log.tool_calls.length;
  const efficiency = Math.max(0, 1 - Math.max(0, steps - maxSteps) / maxSteps);

  const hard = checkHardConstraints(sample, log);
  const outcome_match = hard.all_pass ? 1 : 0;

  const blended =
    required_coverage * 0.6 + recommended_coverage * 0.3 + efficiency * 0.1;
  // Round after outcome gate for stable reporting (exact 1.0 paths).
  const trajectory_score = roundScore(blended * outcome_match);

  const missingRequired = required.filter((t) => !called.has(t));
  const policy_violations = [
    ...hard.failed,
    ...missingRequired.map((t) => `missing_required:${t}`),
  ];

  return {
    sample_id: sample.id,
    category: sample.category,
    trajectory_score,
    required_coverage,
    recommended_coverage,
    efficiency,
    outcome_match,
    hard_constraints: hard,
    policy_violations,
    notes: hard.all_pass ? "ok" : `hard_fail:${hard.failed.join(",")}`,
  };
}
