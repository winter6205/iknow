import type {
  Executor,
  ToolExecutionResult,
} from "../src/harness/tools/types.ts";

/**
 * Shared recording layer for the ADR-0117 role-substitution real-model set:
 * the sampling probe (`scripts/role-substitution-sampling-probe.ts`), the
 * golden-set runner (`tool-role-substitution.test.ts`) and the #1089 boundary
 * inductions (`role-substitution-boundaries-real.test.ts`) all wrap the real
 * ACI executor the same way to observe the gate's receipt.
 *
 * One record per tool dispatch: the model's call plus the result the real
 * executor produced, back-filled once `executeAll` settles. The three copies
 * previously diverged only in the type name, so a change to the record loop had
 * to be made in triplicate.
 */
export type RoleSubstitutionDispatch = {
  name: string;
  input: unknown;
  result: ToolExecutionResult | undefined;
};

/**
 * Wrap `inner` so every `executeAll` batch is appended to `sink` before it runs
 * and each record's `result` is back-filled after. The real executor stays in
 * charge — the recording layer only delegates — so the role-gate receipt the
 * verdicts read is the genuine one, never a stubbed success.
 */
export function createRecordingExecutor(
  inner: Executor,
  sink: RoleSubstitutionDispatch[]
): Executor {
  return {
    executeAll: async (...args: Parameters<Executor["executeAll"]>) => {
      const calls = args[0];
      const pending: RoleSubstitutionDispatch[] = calls.map((call) => ({
        name: call.name,
        input: call.input,
        result: undefined,
      }));
      sink.push(...pending);
      const results = await inner.executeAll(...args);
      for (let i = 0; i < pending.length; i += 1) {
        pending[i]!.result = results[i];
      }
      return results;
    },
  };
}
