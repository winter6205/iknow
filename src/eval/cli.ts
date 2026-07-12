#!/usr/bin/env node
/**
 * npm run eval — run trajectory suite on eval-set.draft.json
 */
import { runEvalSuite } from "./run-suite.js";

const report = runEvalSuite();
const a = report.aggregate;

console.log(
  JSON.stringify(
    {
      generated_at: report.generated_at,
      total: a.total,
      hard_pass_rate: a.hard_pass_rate,
      mean_trajectory_score: a.mean_trajectory_score,
      per_category: a.per_category,
      sprint1_gates: a.sprint1_gates,
      violations: a.global_hard_violation_list,
    },
    null,
    2,
  ),
);

if (
  !a.sprint1_gates.hard_pass_rate_ok ||
  !a.sprint1_gates.mean_trajectory_ok
) {
  process.exitCode = 1;
}
