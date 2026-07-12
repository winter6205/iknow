#!/usr/bin/env node
/**
 * npm run eval — run trajectory suite on eval-set.draft.json
 * Offline / deterministic: no embedding API required.
 */
import { runEvalSuite } from "./run-suite.js";

async function main(): Promise<void> {
  const report = await runEvalSuite();
  const aggregate = report.aggregate;

  console.log(
    JSON.stringify(
      {
        generated_at: report.generated_at,
        eval_set_status: report.eval_set_status,
        total: aggregate.total,
        hard_pass_rate: aggregate.hard_pass_rate,
        mean_trajectory_score: aggregate.mean_trajectory_score,
        per_category: aggregate.per_category,
        release_gates: aggregate.release_gates,
        violations: aggregate.global_hard_violation_list,
      },
      null,
      2,
    ),
  );

  if (
    !aggregate.release_gates.hard_pass_rate_ok ||
    !aggregate.release_gates.mean_trajectory_ok
  ) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[eval] suite failed: ${msg}`);
  process.exit(1);
});
