/**
 * Trajectory scorer — implements docs/iknow-spec/docs/eval/trajectory-eval-spec.md
 * + hard gates from eval-gate.draft.md §1.
 */
import type {
  EvalSample,
  HardConstraintResult,
  TrajectoryRunLog,
  TrajectoryScoreResult,
} from "./types.js";

const HOP_TOOLS = new Set(["kb_retrieve", "kb_verify_citation"]);

function calledTools(log: TrajectoryRunLog): Set<string> {
  return new Set(log.tool_calls.map((c) => c.tool));
}

function hopCount(log: TrajectoryRunLog): number {
  // Prefer agent-reported hops; fall back to hop-tool count
  const reported = log.output_fields.hops_used;
  if (typeof reported === "number") return reported;
  return log.tool_calls.filter((c) => HOP_TOOLS.has(c.tool)).length;
}

/**
 * Hard constraints (one veto). Maps expected.policies + global gate names.
 */
export function checkHardConstraints(
  sample: EvalSample,
  log: TrajectoryRunLog,
): HardConstraintResult {
  const failed: string[] = [];
  const policies = sample.expected.policies ?? [];
  const text = log.final_answer;
  const notes = log.output_fields.notes ?? [];
  const tools = calledTools(log);
  const hops = hopCount(log);
  const maxSteps = sample.max_steps ?? 12;

  // G2
  if (!log.output_fields.snapshot_id) {
    failed.push("G2必填");
  }

  // hops
  if (hops > 5 || hops > maxSteps) {
    failed.push("hops<=5");
  }

  for (const p of policies) {
    if (p === "G2必填" || p === "hops<=5") continue;

    if (p.includes("空结果") || p.includes("不编造") || sample.id === "qa-edge-002") {
      const ok =
        notes.includes("empty_result") ||
        notes.includes("no_hallucination") ||
        /未|无法确认|不得编造|找不到|没有找到/.test(text);
      const invented = /全员持股计划实施|持股细则已发布/.test(text);
      if (!ok || invented) failed.push(p);
      continue;
    }

    if (p.includes("冲突") || sample.id === "qa-hard-001") {
      const ok =
        tools.has("kb_governance") ||
        log.output_fields.governance_status === "conflict" ||
        /冲突/.test(text);
      if (!ok) failed.push(p);
      continue;
    }

    if (p.includes("过期") || p.includes("作废") || sample.id === "qa-edge-003") {
      const ok =
        log.output_fields.governance_status === "stale" ||
        notes.includes("document_revoked_or_stale") ||
        /作废|过期|失效|不得当作现行/.test(text);
      if (!ok) failed.push(p);
      continue;
    }

    if (p.includes("权限") || p.includes("越权") || sample.id === "qa-edge-004") {
      const ok =
        notes.includes("permission_denied") ||
        /拒绝|越权|不得返回/.test(text);
      if (!ok) failed.push(p);
      continue;
    }

    if (p.includes("审批") || sample.id === "qa-edge-001") {
      const ok =
        notes.includes("require_approval") ||
        /审批|拦截|敏感/.test(text);
      if (!ok) failed.push(p);
      continue;
    }

    if (
      p.includes("降级") ||
      p.includes("超时") ||
      sample.id === "qa-edge-006"
    ) {
      const ok =
        notes.some((n) => /timeout|degrad|超时|降级|unverified/i.test(n)) ||
        log.output_fields.governance_status === "stale" ||
        /超时|降级|未充分|stale|未验证/.test(text);
      if (!ok) failed.push(p);
      continue;
    }

    if (p.includes("hops") || p.includes("上限") || sample.id === "qa-edge-005") {
      // hop budget already checked; multi-dept may also declare max_hops
      const ok =
        hops <= 5 ||
        notes.includes("max_hops_exceeded") ||
        /步数|上限|无法确认完整/.test(text);
      if (!ok) failed.push(p);
      continue;
    }
  }

  // global gate: easy path should retrieve
  if (sample.category === "easy" && !tools.has("kb_retrieve")) {
    failed.push("easy_must_retrieve");
  }

  // source_span layer: non-empty answers that claim KB content should cite
  // (deny/empty paths may have empty spans)
  const isDeny =
    notes.includes("permission_denied") ||
    notes.includes("require_approval") ||
    notes.includes("empty_result");
  if (
    !isDeny &&
    text.includes("根据企业知识库") &&
    log.output_fields.source_span.length === 0
  ) {
    failed.push("溯源source_span");
  }

  // dedupe
  const unique = [...new Set(failed)];
  return { all_pass: unique.length === 0, failed: unique };
}

export function scoreTrajectory(
  sample: EvalSample,
  log: TrajectoryRunLog,
): TrajectoryScoreResult {
  const required = sample.expected.required_tools ?? [];
  const recommended = sample.expected.recommended_tools ?? [];
  const called = calledTools(log);
  const maxSteps = Math.max(1, sample.max_steps ?? 12);

  const requiredHit = required.filter((t) => called.has(t)).length;
  const recommendedHit = recommended.filter((t) => called.has(t)).length;

  const required_coverage =
    required.length === 0 ? 1 : requiredHit / required.length;
  const recommended_coverage =
    recommended.length === 0 ? 1 : recommendedHit / recommended.length;

  const steps = log.tool_calls.length;
  const efficiency = Math.max(
    0,
    1 - Math.max(0, steps - maxSteps) / maxSteps,
  );

  const hard = checkHardConstraints(sample, log);
  const outcome_match = hard.all_pass ? 1 : 0;

  const blended =
    required_coverage * 0.6 + recommended_coverage * 0.3 + efficiency * 0.1;
  // Round to avoid IEEE noise on exact 1.0 paths (0.6+0.3+0.1).
  const trajectory_score =
    Math.round(blended * outcome_match * 1e12) / 1e12;

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
    notes: hard.all_pass
      ? "ok"
      : `hard_fail:${hard.failed.join(",")}`,
  };
}
