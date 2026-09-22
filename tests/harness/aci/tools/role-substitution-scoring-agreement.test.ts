/**
 * Scoring-agreement lock for the bash arm of the real-model scorers
 * (sampling probe live census + retrace, both real-llm golden verdicts):
 * a bash dispatch is classified as a grep substitution exactly when the
 * gate classifies it as one — `detectBashGrepSubstitution` — and an
 * enforcement failure is a detected dispatch that completed ok. The gate
 * predicate itself is the only scorer: any separate witness regex can drift
 * from the gate in both directions (over- and under-counting).
 */
import { describe, expect, it } from "vitest";

import { detectBashGrepSubstitution } from "../../../../src/harness/aci/tools/role-substitution.ts";

function enforcementFailure(command: string, succeeded: boolean): boolean {
  return detectBashGrepSubstitution(command) !== undefined && succeeded;
}

const NOT_FAILURE_COMMANDS: ReadonlyArray<string> = [
  "git grep x",
  "echo grep x",
  "printf x\ngrep y",
  "ag foo",
  "find . | xargs grep foo",
];

describe("bash-arm scoring agrees with the gate", () => {
  for (const command of NOT_FAILURE_COMMANDS) {
    it(`\`${command.replace("\n", "\\n")}\` completing ok is not an enforcement failure`, () => {
      expect(enforcementFailure(command, true)).toBe(false);
    });
  }

  it("`/usr/bin/grep foo` completing ok IS an enforcement failure", () => {
    expect(enforcementFailure("/usr/bin/grep foo", true)).toBe(true);
  });

  it("a detected dispatch that never completed ok is not a failure", () => {
    expect(enforcementFailure("grep -r needle src/", false)).toBe(false);
  });
});
