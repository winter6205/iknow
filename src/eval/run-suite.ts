import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createSeededStore } from "../fixtures/seed-kb.js";
import { createSession } from "../agent-loop/session.js";
import { IknowAgent } from "../agent-loop/loop.js";
import { scoreTrajectory } from "./score-trajectory.js";
import type {
  EvalSample,
  EvalSetFile,
  SuiteAggregate,
  SuiteReport,
  TrajectoryRunLog,
  TrajectoryScoreResult,
} from "./types.js";

/**
 * Resolve package/repo root for default paths.
 * Prefer IKNOW_ROOT; otherwise assume npm scripts run from package root (cwd).
 */
function resolveRoot(): string {
  const fromEnv = process.env.IKNOW_ROOT;
  if (fromEnv) return fromEnv;
  // npm scripts run from package root
  return process.cwd();
}
const ROOT = resolveRoot();

const DEFAULT_EVAL_SET = join(
  ROOT,
  "docs/iknow-spec/docs/eval/eval-set.draft.json",
);

/** Configurable release-gate targets (milestone "sprint1" for now). */
export const RELEASE_GATE_TARGETS = {
  hard_pass_rate: 1.0,
  mean_trajectory: 0.6,
} as const;

const DEFAULT_REPORT_FILE = "trajectory-suite-latest.json";

let draftWarned = false;

function warnDraftOnce(path: string, status?: string): void {
  if (draftWarned) return;
  draftWarned = true;
  console.warn(
    `[eval] loading draft eval set: ${path}` +
      (status ? ` (meta.status=${status})` : ""),
  );
}

function countsFromSamples(samples: EvalSample[]): {
  total: number;
  easy: number;
  hard: number;
  edge: number;
} {
  const out = { total: samples.length, easy: 0, hard: 0, edge: 0 };
  for (const s of samples) {
    if (s.category === "easy") out.easy += 1;
    else if (s.category === "hard") out.hard += 1;
    else if (s.category === "edge") out.edge += 1;
  }
  return out;
}

export function loadEvalSet(path: string = DEFAULT_EVAL_SET): EvalSetFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read eval set at ${path}: ${msg}`);
  }

  let set: EvalSetFile;
  try {
    set = JSON.parse(raw) as EvalSetFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse eval set at ${path}: ${msg}`);
  }

  if (!set.samples || !Array.isArray(set.samples)) {
    throw new Error(`Invalid eval set at ${path}: missing samples array`);
  }

  const status = set.meta?.status;
  const isDraft =
    (typeof status === "string" && status.toUpperCase().includes("DRAFT")) ||
    basename(path).toLowerCase().includes("draft");
  if (isDraft) warnDraftOnce(path, status);

  const metaCounts = set.meta?.counts;
  if (metaCounts) {
    const computed = countsFromSamples(set.samples);
    const mismatches: string[] = [];
    for (const key of ["total", "easy", "hard", "edge"] as const) {
      if (metaCounts[key] !== computed[key]) {
        mismatches.push(`${key}: meta=${metaCounts[key]} samples=${computed[key]}`);
      }
    }
    if (mismatches.length > 0) {
      console.warn(
        `[eval] meta.counts mismatch vs samples at ${path}: ${mismatches.join("; ")}`,
      );
    }
  }

  return set;
}

/**
 * Offline sample runner for CI / npm test / npm run eval.
 * Never attaches vectorIndex — keyword+overlap only (no embedding API).
 */
export async function runSample(
  sample: EvalSample,
): Promise<{ log: TrajectoryRunLog; score: TrajectoryScoreResult }> {
  const store = createSeededStore();
  const overrides = sample.session_overrides ?? {};
  const role = overrides.caller_role ?? "employee";
  const agent = new IknowAgent({
    store,
    session: createSession(role, {
      simulate_governance_timeout:
        overrides.simulate_governance_timeout ?? false,
    }),
    // vectorIndex intentionally omitted (deterministic suite)
  });
  const ans = await agent.answer(sample.input);
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

function syntheticRunnerFail(
  sample: EvalSample,
  err: unknown,
): TrajectoryScoreResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    sample_id: sample.id,
    category: sample.category,
    trajectory_score: 0,
    required_coverage: 0,
    recommended_coverage: 0,
    efficiency: 0,
    outcome_match: 0,
    hard_constraints: {
      all_pass: false,
      failed: [`runner_error:${msg}`],
    },
    policy_violations: [],
    notes: `runner_error: ${msg}`,
  };
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
    const b = per_category[k];
    if (!b) continue;
    b.mean_score /= b.total;
  }

  const hard_pass_rate =
    results.length === 0 ? 0 : hard_pass_count / results.length;

  const targets = {
    hard_pass_rate: RELEASE_GATE_TARGETS.hard_pass_rate,
    mean_trajectory: RELEASE_GATE_TARGETS.mean_trajectory,
  };

  return {
    total: results.length,
    hard_pass_count,
    hard_pass_rate,
    mean_trajectory_score,
    per_category,
    global_hard_violation_list: results
      .filter((r) => !r.hard_constraints.all_pass)
      .map((r) => ({ sample_id: r.sample_id, failed: r.hard_constraints.failed })),
    release_gates: {
      hard_pass_rate_ok: hard_pass_rate >= targets.hard_pass_rate,
      mean_trajectory_ok: mean_trajectory_score >= targets.mean_trajectory,
      targets,
      milestone: "sprint1",
    },
  };
}

export async function runEvalSuite(opts?: {
  evalSetPath?: string;
  outDir?: string;
  /** Report filename; default trajectory-suite-latest.json */
  fileName?: string;
}): Promise<SuiteReport> {
  const evalSetPath = opts?.evalSetPath ?? DEFAULT_EVAL_SET;
  const set = loadEvalSet(evalSetPath);
  const results: TrajectoryScoreResult[] = [];
  for (const sample of set.samples) {
    try {
      results.push((await runSample(sample)).score);
    } catch (err) {
      results.push(syntheticRunnerFail(sample, err));
    }
  }
  const report: SuiteReport = {
    generated_at: new Date().toISOString(),
    eval_set: evalSetPath,
    eval_set_status: set.meta?.status,
    aggregate: aggregateResults(results),
    results,
  };

  const outDir =
    opts?.outDir ?? join(ROOT, "docs/iknow-spec/docs/eval/results");
  const fileName = opts?.fileName ?? DEFAULT_REPORT_FILE;
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, fileName);
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  return report;
}
