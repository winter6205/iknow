import type {
  GovernanceStatus,
  IknowAnswer,
  ToolCallLog,
} from "../shared/schema.js";

export interface EvalSampleExpected {
  required_tools?: string[];
  recommended_tools?: string[];
  optional_tools?: string[];
  policies?: string[];
  output_properties?: string[];
}

export interface EvalSample {
  id: string;
  category: string;
  input: string;
  expected: EvalSampleExpected;
  max_steps?: number;
  /** Optional per-sample session knobs (role, governance timeout sim). */
  session_overrides?: {
    caller_role?: "employee" | "manager" | "admin";
    simulate_governance_timeout?: boolean;
  };
}

export interface EvalSetFile {
  meta?: {
    status?: string; // e.g. DRAFT-EVAL-SET
    /**
     * Optional sanity-check anchors for the file author.
     * Prefer computing totals from `samples` at runtime; if present, the
     * loader may warn when counts diverge from the samples array.
     */
    counts?: { total: number; easy: number; hard: number; edge: number };
  };
  samples: EvalSample[];
}

/** Agent run log for one sample (trajectory-eval-spec §1.2). */
export interface TrajectoryRunLog {
  sample_id: string;
  tool_calls: ToolCallLog[];
  final_answer: string;
  output_fields: {
    source_span: IknowAnswer["source_spans"];
    snapshot_id: string;
    governance_status: GovernanceStatus;
    hops_used: number;
    notes?: string[];
  };
}

export interface HardConstraintResult {
  all_pass: boolean;
  failed: string[];
}

export interface TrajectoryScoreResult {
  sample_id: string;
  category: string;
  trajectory_score: number;
  required_coverage: number;
  recommended_coverage: number;
  efficiency: number;
  outcome_match: number;
  hard_constraints: HardConstraintResult;
  policy_violations: string[];
  notes: string;
}

export interface SuiteAggregate {
  total: number;
  hard_pass_count: number;
  hard_pass_rate: number;
  mean_trajectory_score: number;
  per_category: Record<
    string,
    { total: number; hard_pass: number; mean_score: number }
  >;
  global_hard_violation_list: Array<{ sample_id: string; failed: string[] }>;
  release_gates: {
    hard_pass_rate_ok: boolean;
    mean_trajectory_ok: boolean;
    targets: { hard_pass_rate: number; mean_trajectory: number };
    /** Milestone label for the current target set, e.g. "sprint1". */
    milestone?: string;
  };
}

export interface SuiteReport {
  generated_at: string;
  eval_set: string;
  /** From eval-set meta.status when present (e.g. DRAFT-EVAL-SET). */
  eval_set_status?: string;
  aggregate: SuiteAggregate;
  results: TrajectoryScoreResult[];
}
