import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSeededStore } from "../fixtures/seed-kb.js";
import { createSession } from "../agent-loop/session.js";
import { IknowAgent } from "../agent-loop/loop.js";
import { scoreTrajectory } from "./score-trajectory.js";
import type {
  EvalSetFile,
  SuiteAggregate,
  SuiteReport,
  TrajectoryRunLog,
  TrajectoryScoreResult,
} from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_EVAL_SET = join(
  ROOT,
  "docs/iknow-spec/docs/eval/eval-set.draft.json",
);

export function loadEvalSet(path: string = DEFAULT_EVAL_SET): EvalSetFile {
  return JSON.parse(readFileSync(path, "utf8")) as EvalSetFile;
}

export function runSample(
  sample: EvalSetFile["samples"][number],
): { log: TrajectoryRunLog; score: TrajectoryScoreResult } {
  const store = createSeededStore();
  const govTimeout =
    sample.id === "qa-edge-006" || sample.input.includes("治理服务超时");
  const agent = new IknowAgent({
    store,
    session: createSession("employee", {
      simulate_governance_timeout: govTimeout,
    }),
  });
  const ans = agent.answer(sample.input);
  const log: TrajectoryRunLog = {
    sample_id: sample.id,
    tool_calls: ans.tool_calls,
    final_answer: ans.text,
    output_fields: {
      source_span: ans.source_spans,
      snapshot_id: ans.snapshot_id,
      governance_status: ans.governance_status,
      hops_used: ans.hops_used,
      notes: ans.notes,
    },
  };
  return { log, score: scoreTrajectory(sample, log) };
}

export function aggregateResults(
  results: TrajectoryScoreResult[],
): SuiteAggregate {
  const hard_pass_count = results.filter((r) => r.hard_constraints.all_pass)
    .length;
  const mean_trajectory_score =
    results.length === 0
      ? 0
      : results.reduce((s, r) => s + r.trajectory_score, 0) / results.length;

  const per_category: SuiteAggregate["per_category"] = {};
  for (const r of results) {
    const bucket = per_category[r.category] ?? {
      total: 0,
      hard_pass: 0,
      mean_score: 0,
    };
    bucket.total += 1;
    if (r.hard_constraints.all_pass) bucket.hard_pass += 1;
    bucket.mean_score += r.trajectory_score;
    per_category[r.category] = bucket;
  }
  for (const k of Object.keys(per_category)) {
    const b = per_category[k]!;
    b.mean_score = b.total === 0 ? 0 : b.mean_score / b.total;
  }

  const hard_pass_rate =
    results.length === 0 ? 0 : hard_pass_count / results.length;

  // Sprint-1 soft targets (agent-evaluation-system): trajectory ≥60%,
  // hard pass as primary policy gate (target 100% for hard constraints).
  const targets = { hard_pass_rate: 1.0, mean_trajectory: 0.6 };

  return {
    total: results.length,
    hard_pass_count,
    hard_pass_rate,
    mean_trajectory_score,
    per_category,
    global_hard_violation_list: results
      .filter((r) => !r.hard_constraints.all_pass)
      .map((r) => ({ sample_id: r.sample_id, failed: r.hard_constraints.failed })),
    sprint1_gates: {
      hard_pass_rate_ok: hard_pass_rate >= targets.hard_pass_rate,
      mean_trajectory_ok: mean_trajectory_score >= targets.mean_trajectory,
      targets,
    },
  };
}

export function runEvalSuite(opts?: {
  evalSetPath?: string;
  outDir?: string;
}): SuiteReport {
  const evalSetPath = opts?.evalSetPath ?? DEFAULT_EVAL_SET;
  const set = loadEvalSet(evalSetPath);
  const results: TrajectoryScoreResult[] = [];
  for (const sample of set.samples) {
    results.push(runSample(sample).score);
  }
  const report: SuiteReport = {
    generated_at: new Date().toISOString(),
    eval_set: evalSetPath,
    aggregate: aggregateResults(results),
    results,
  };

  const outDir =
    opts?.outDir ?? join(ROOT, "docs/iknow-spec/docs/eval/results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "trajectory-suite-latest.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}
