/**
 * Run-plan validation witnesses the faults that get a run plan refused.
 *
 * Each rejection class is exercised on its own so a passing suite names the fault that
 * was refused, rather than "something about this document was rejected".
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import assert from "node:assert/strict";

import {
  isEvalFailure,
  type EvalFailure,
} from "../../../../scripts/eval/agent-qa/failures.ts";
import {
  BUDGET_MAGNITUDE_CEILING,
  MAX_FIXTURE_ID_LENGTH,
  MAX_PLAN_ATTEMPTS,
  MAX_PLAN_CASES,
  budgetDigest,
  freezePlan,
  readPlan,
  validateBudget,
  validatePlan,
} from "../../../../scripts/eval/agent-qa/plan.ts";
import { sha256File, writeJsonOnce } from "../../../../scripts/eval/agent-qa/artifacts.ts";
import {
  resolveCatalog,
  verifyCatalog,
} from "../../../../scripts/eval/agent-qa/catalog.ts";
import {
  EVALUATOR_VERSION,
  GROUP_SLOT_COUNT,
  REPORT_SCHEMA_VERSION,
  RUN_PLAN_FILE,
  type Budget,
  type CaseReference,
  type CatalogLock,
} from "../../../../scripts/eval/agent-qa/types.ts";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);

/** Every slot the frozen roster allocates, summed from the roster itself rather than retyped. */
const TOTAL_CATALOG_SLOTS = Object.values(GROUP_SLOT_COUNT).reduce((sum, n) => sum + n, 0);

const roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-agent-qa-plan-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function budget(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxTurns: 8,
    wallMs: 120_000,
    inputTokens: null,
    outputTokens: null,
    ...over,
  };
}

/** One locked address. Built separately so a test can state a lock list of its own. */
function lockEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "tests/fixtures/agent-qa/task.ts",
    fixtureId: "task-01-basic",
    digest: HEX_A,
    ...over,
  };
}

function caseEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const caseId = (over.caseId as string) ?? "task-01";
  const supplied = over.fixture;
  // A distinct default lock per slot: two cases never share one locked address, so a
  // test about attempts is not accidentally a test about locks. A non-object fixture is
  // passed through verbatim, because "fixture is not an object" is itself an input.
  const fixture =
    typeof supplied === "object" && supplied !== null && !Array.isArray(supplied)
      ? lockEntry(supplied as Record<string, unknown>)
      : supplied === undefined
        ? lockEntry({ fixtureId: `${caseId}-basic` })
        : supplied;
  const rest: Record<string, unknown> = { ...over };
  delete rest.fixture;
  return {
    caseId,
    group: "task",
    fixture,
    // A caller states every fixture the case cites, primary first; only a test that
    // wants a disagreement or a second lock replaces this.
    fixtureLocks: [fixture],
    oracles: [
      {
        oracleId: "acceptance-1",
        kind: "acceptance-run",
        evidence: "tests/fixtures/agent-qa/task-acceptance.ts",
      },
    ],
    allowedEffects: ["unchanged:src/index.ts"],
    forbiddenEffects: ["write:src/extra.ts"],
    ...rest,
  };
}

function planDocument(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: "run-0001",
    evaluator: EVALUATOR_VERSION,
    modelRoute: "stub-offline",
    promptDigest: HEX_A,
    toolDigest: HEX_B,
    sourceDigest: HEX_C,
    dataIdentity: "synthetic-data-v1",
    environmentIdentity: "linux-node24-scratch",
    posture: "scripted-offline",
    budget: budget(),
    cases: [caseEntry()],
    attempts: [{ attemptId: "task-01-r1", caseId: "task-01" }],
    frozenBeforeAnyOutcome: true,
    ...over,
  };
}

/**
 * The plan document a caller writes around a resolved catalog: the references verbatim,
 * one attempt per slot. This is the projection the whole mechanism depends on.
 */
function catalogPlanDocument(
  cases: readonly CaseReference[]
): Record<string, unknown> {
  return planDocument({
    cases: cases.map((item) => ({
      caseId: item.caseId,
      group: item.group,
      fixture: item.fixture,
      fixtureLocks: item.fixtureLocks,
      oracles: item.oracles,
      allowedEffects: item.allowedEffects,
      forbiddenEffects: item.forbiddenEffects,
    })),
    attempts: cases.map((item) => ({
      attemptId: `${item.caseId}-a1`,
      caseId: item.caseId,
    })),
  });
}

function expectFailure(
  run: () => unknown,
  kind: string,
  pattern: RegExp
): EvalFailure {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown !== undefined, `expected a ${kind} failure matching ${pattern}`);
  assert.ok(isEvalFailure(thrown), `expected a typed failure, got ${String(thrown)}`);
  assert.equal(thrown.kind, kind);
  assert.equal(thrown.dispatchMayContinue, false);
  assert.match(thrown.diagnostic, pattern);
  return thrown;
}

function expectInvalidPlan(document: unknown, pattern: RegExp): EvalFailure {
  return expectFailure(() => validatePlan(document), "invalid-input", pattern);
}

describe("validatePlan", () => {
  it("accepts a minimal plan without inventing anything", () => {
    const plan = validatePlan(planDocument());
    assert.equal(plan.runId, "run-0001");
    assert.equal(plan.frozenBeforeAnyOutcome, true);
    assert.equal(plan.cases.length, 1);
    assert.equal(plan.attempts.length, 1);
  });

  it("keeps an undeclared token limit null, because unknown is not zero", () => {
    const plan = validatePlan(planDocument({ budget: budget({ inputTokens: null }) }));
    assert.equal(plan.budget.inputTokens, null);
    assert.notEqual(plan.budget.inputTokens, 0);
  });

  it("returns a plan that cannot be edited after the fact", () => {
    const plan = validatePlan(planDocument());
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.budget), true);
    assert.throws(() => {
      (plan as unknown as { runId: string }).runId = "run-rewritten";
    }, TypeError);
  });

  it("rejects documents that are not plan objects at all", () => {
    for (const raw of ["plan", 42, null, [], true]) {
      expectInvalidPlan(raw, /run plan is not an object/);
    }
  });

  it("rejects an empty document", () => {
    expectInvalidPlan({}, /run plan is empty/);
  });

  it("rejects unknown fields instead of ignoring them", () => {
    expectInvalidPlan(
      planDocument({ retries: 3 }),
      /run plan has unknown field\(s\): retries/
    );
  });

  it("rejects missing fields instead of defaulting them", () => {
    const document = planDocument();
    delete document.sourceDigest;
    expectInvalidPlan(document, /run plan is missing field\(s\): sourceDigest/);
  });

  it("rejects a plan that does not assert it froze before any outcome", () => {
    expectInvalidPlan(
      planDocument({ frozenBeforeAnyOutcome: false }),
      /frozenBeforeAnyOutcome must be the literal true/
    );
    expectInvalidPlan(
      planDocument({ frozenBeforeAnyOutcome: "true" }),
      /frozenBeforeAnyOutcome must be the literal true/
    );
  });

  it("rejects a foreign schema version and an undeclared posture", () => {
    expectInvalidPlan(
      planDocument({ schemaVersion: REPORT_SCHEMA_VERSION + 1 }),
      /schemaVersion must be/
    );
    expectInvalidPlan(
      planDocument({ posture: "unsandboxed-live" }),
      /posture is not a declared posture/
    );
  });

  it("rejects malformed identity and digest fields", () => {
    expectInvalidPlan(planDocument({ runId: "" }), /run plan\.runId/);
    expectInvalidPlan(planDocument({ runId: "run 0001" }), /run plan\.runId/);
    expectInvalidPlan(
      planDocument({ promptDigest: "not-a-digest" }),
      /promptDigest is not a sha256 hex digest/
    );
  });

  it("rejects an empty or non-array case list", () => {
    expectInvalidPlan(planDocument({ cases: [] }), /declares no cases/);
    expectInvalidPlan(planDocument({ cases: "task-01" }), /cases is not an array/);
  });

  it("rejects a case with no oracle, an unknown group, or an escaping path", () => {
    expectInvalidPlan(
      planDocument({ cases: [caseEntry({ oracles: [] })] }),
      /case\[0\]\.oracles must be a non-empty array/
    );
    expectInvalidPlan(
      planDocument({ cases: [caseEntry({ group: "misc" })] }),
      /case\[0\]\.group is not a declared case group/
    );
    expectInvalidPlan(
      planDocument({
        cases: [caseEntry({ fixture: { path: "/etc/passwd", fixtureId: "f", digest: HEX_A } })],
      }),
      /must be a repo-relative path/
    );
  });

  it("rejects a duplicate caseId", () => {
    expectInvalidPlan(
      planDocument({ cases: [caseEntry(), caseEntry()], attempts: [] }),
      /duplicate caseId task-01/
    );
  });

  it("rejects conflicting identities for one caseId", () => {
    expectInvalidPlan(
      planDocument({
        cases: [caseEntry(), caseEntry({ fixture: { path: "p.ts", fixtureId: "f2", digest: HEX_B } })],
      }),
      /conflicting identities for caseId task-01/
    );
  });

  it("rejects an empty or non-array attempt list", () => {
    expectInvalidPlan(planDocument({ attempts: [] }), /declares no attempts/);
    expectInvalidPlan(planDocument({ attempts: {} }), /attempts is not an array/);
  });

  it("rejects a duplicate attemptId", () => {
    expectInvalidPlan(
      planDocument({
        cases: [caseEntry(), caseEntry({ caseId: "task-02" })],
        attempts: [
          { attemptId: "shared", caseId: "task-01" },
          { attemptId: "shared", caseId: "task-02" },
        ],
      }),
      /duplicate attemptId value\(s\): shared/
    );
  });

  it("rejects a planned case that no attempt covers", () => {
    expectInvalidPlan(
      planDocument({
        cases: [caseEntry(), caseEntry({ caseId: "tool-01" })],
        attempts: [{ attemptId: "task-01-r1", caseId: "task-01" }],
      }),
      /covers no attempt for caseId\(s\): tool-01/
    );
  });

  it("rejects attempts that repeat one case unevenly", () => {
    expectInvalidPlan(
      planDocument({
        cases: [caseEntry(), caseEntry({ caseId: "tool-01" })],
        attempts: [
          { attemptId: "task-01-r1", caseId: "task-01" },
          { attemptId: "task-01-r2", caseId: "task-01" },
          { attemptId: "tool-01-r1", caseId: "tool-01" },
        ],
      }),
      /attempts are uneven/
    );
  });

  it("rejects an attempt that names an undeclared case", () => {
    expectInvalidPlan(
      planDocument({ attempts: [{ attemptId: "x-r1", caseId: "ghost-01" }] }),
      /undeclared caseId\(s\): ghost-01/
    );
  });

  it("rejects an attempt entry carrying a field the format does not have", () => {
    expectInvalidPlan(
      planDocument({
        attempts: [{ attemptId: "task-01-r1", caseId: "task-01", arm: "candidate" }],
      }),
      /attempt\[0\] has unknown field\(s\): arm/
    );
  });

  it("keeps an absent not-run declaration as a slot meant to run", () => {
    const plan = validatePlan(planDocument());
    assert.equal(plan.attempts[0].notRun, null);
  });

  it("freezes a declared not-run reason verbatim", () => {
    const plan = validatePlan(
      planDocument({
        attempts: [
          { attemptId: "task-01-r1", caseId: "task-01", notRun: "credential-blocked" },
        ],
      })
    );
    assert.equal(plan.attempts[0].notRun, "credential-blocked");
  });

  it("rejects a not-run reason outside the two the roster can carry", () => {
    // A fault kind spelled here would be the old magic string in the other direction: the
    // reason a slot was frozen off dispatch is a decision, not something to blame.
    expectInvalidPlan(
      planDocument({
        attempts: [{ attemptId: "task-01-r1", caseId: "task-01", notRun: "provider-failure" }],
      }),
      /attempt\[0\]\.notRun is not a declared not-run reason/
    );
    expectInvalidPlan(
      planDocument({
        attempts: [{ attemptId: "task-01-r1", caseId: "task-01", notRun: "other-not-run" }],
      }),
      /attempt\[0\]\.notRun is not a declared not-run reason/
    );
    expectInvalidPlan(
      planDocument({
        attempts: [{ attemptId: "task-01-r1", caseId: "task-01", notRun: 7 }],
      }),
      /attempt\[0\]\.notRun is not a declared not-run reason/
    );
  });

  it("rejects an overflow-sized attempt list rather than trimming it", () => {
    const attempts = Array.from({ length: MAX_PLAN_ATTEMPTS + 1 }, (_unused, i) => ({
      attemptId: `task-01-r${i}`,
      caseId: "task-01",
    }));
    expectInvalidPlan(
      planDocument({ attempts }),
      /more than 10000 attempts/
    );
  });

  it("rejects an overflow-sized case list rather than trimming it", () => {
    const cases = Array.from({ length: MAX_PLAN_CASES + 1 }, (_unused, i) =>
      caseEntry({ caseId: `task-${i}` })
    );
    expectInvalidPlan(planDocument({ cases }), /more than 1000 cases/);
  });

  it("rejects a case whose fixture is not an object", () => {
    expectInvalidPlan(
      planDocument({ cases: [caseEntry({ fixture: "tests/fixtures/task.ts" })] }),
      /case\[0\]\.fixture is not an object/
    );
  });

  it("rejects every unusable budget magnitude", () => {
    const magnitudes: readonly [Record<string, unknown>, RegExp][] = [
      [{ maxTurns: 0 }, /run plan budget maxTurns must be a positive count, got 0/],
      [{ wallMs: -5 }, /run plan budget wallMs must be a positive count, got -5/],
      [{ inputTokens: 1.5 }, /run plan budget inputTokens is not an integer count/],
      [{ outputTokens: BUDGET_MAGNITUDE_CEILING + 1 }, /run plan budget outputTokens exceeds the magnitude ceiling/],
      [{ maxTurns: "8" }, /run plan budget maxTurns is not a finite number/],
      [{ inputTokens: undefined }, /run plan budget inputTokens is not a finite number/],
    ];
    for (const [over, pattern] of magnitudes) {
      expectInvalidPlan(planDocument({ budget: budget(over) }), pattern);
    }
  });

  it("rejects a budget with a missing or unknown field", () => {
    const partial = budget();
    delete partial.outputTokens;
    expectInvalidPlan(planDocument({ budget: partial }), /budget is missing field\(s\): outputTokens/);
    expectInvalidPlan(
      planDocument({ budget: budget({ spendUsd: 5 }) }),
      /budget has unknown field\(s\): spendUsd/
    );
  });
});

describe("validatePlan fixture locks", () => {
  it("accepts a fixture id stated as the real test title it addresses", () => {
    const title = "阳性对照：ghp_ 形态 fixture 被拦（guard 活着，非空规则假绿）";
    const plan = validatePlan(
      planDocument({ cases: [caseEntry({ fixture: lockEntry({ fixtureId: title }) })] })
    );
    assert.equal(plan.cases[0].fixture.fixtureId, title);
    assert.equal(plan.cases[0].fixtureLocks[0].fixtureId, title);
  });

  it("accepts a second locked fixture, so a multi-fixture case is digested whole", () => {
    const primary = lockEntry();
    const secondary = lockEntry({
      fixtureId: "overwrites the complete contents of an existing file",
      digest: HEX_B,
    });
    const plan = validatePlan(
      planDocument({ cases: [caseEntry({ fixture: primary, fixtureLocks: [primary, secondary] })] })
    );
    assert.equal(plan.cases[0].fixtureLocks.length, 2);
    assert.deepEqual(plan.cases[0].fixtureLocks[1], secondary);
  });

  it("rejects an empty fixtureLocks array rather than reading the primary alone", () => {
    expectInvalidPlan(
      planDocument({ cases: [caseEntry({ fixtureLocks: [] })] }),
      /case\[0\]\.fixtureLocks must be a non-empty array/
    );
  });

  it("rejects a case with no fixtureLocks field at all", () => {
    const entry: Record<string, unknown> = caseEntry();
    delete entry.fixtureLocks;
    expectInvalidPlan(
      planDocument({ cases: [entry] }),
      /case\[0\] is missing field\(s\): fixtureLocks/
    );
  });

  it("rejects a primary that disagrees with its own first lock", () => {
    const primary = lockEntry({ fixtureId: "the stated primary" });
    const first = lockEntry({ fixtureId: "the lock that is actually first" });
    expectInvalidPlan(
      planDocument({ cases: [caseEntry({ fixture: primary, fixtureLocks: [first, primary] })] }),
      /case\[0\]\.fixture must equal case\[0\]\.fixtureLocks\[0\]/
    );
  });

  it("rejects a locked digest that is not 64-hex", () => {
    const primary = lockEntry();
    expectInvalidPlan(
      planDocument({
        cases: [
          caseEntry({
            fixture: primary,
            fixtureLocks: [lockEntry({ digest: "g".repeat(64) }), primary],
          }),
        ],
      }),
      /case\[0\]\.fixtureLocks\[0\]\.digest is not a sha256 hex digest/
    );
  });

  it("rejects a lock entry whose fields the fixture format does not state", () => {
    const primary = lockEntry();
    expectInvalidPlan(
      planDocument({
        cases: [caseEntry({ fixture: primary, fixtureLocks: [{ ...primary, arm: "candidate" } ] })],
      }),
      /case\[0\]\.fixtureLocks\[0\] has unknown field\(s\): arm/
    );
  });

  it("rejects a fixture id carrying a newline or a NUL, at either position", () => {
    for (const title of ["title\nwith a newline", "title\0with a nul", "title\twith a tab"]) {
      const primary = lockEntry({ fixtureId: title });
      expectInvalidPlan(
        planDocument({ cases: [caseEntry({ fixture: primary })] }),
        /case\[0\]\.fixture\.fixtureId is not a printable fixture title/
      );
      expectInvalidPlan(
        planDocument({
          cases: [
            caseEntry({
              fixture: lockEntry(),
              fixtureLocks: [lockEntry(), lockEntry({ fixtureId: title })],
            }),
          ],
        }),
        /case\[0\]\.fixtureLocks\[1\]\.fixtureId is not a printable fixture title/
      );
    }
  });

  it("rejects a fixture id that is empty, whitespace-only, or over the stated cap", () => {
    for (const title of ["", "   ", "x".repeat(MAX_FIXTURE_ID_LENGTH + 1)]) {
      expectInvalidPlan(
        planDocument({ cases: [caseEntry({ fixture: lockEntry({ fixtureId: title }) })] }),
        title.length > MAX_FIXTURE_ID_LENGTH
          ? new RegExp(`fixtureId exceeds ${MAX_FIXTURE_ID_LENGTH} characters`)
          : /fixtureId is not a printable fixture title/
      );
    }
  });

  it("rejects the same locked address claimed by two cases", () => {
    const shared = lockEntry();
    expectInvalidPlan(
      planDocument({
        cases: [
          caseEntry({ fixture: shared, fixtureLocks: [shared] }),
          caseEntry({ caseId: "tool-01", fixture: shared, fixtureLocks: [shared] }),
        ],
        attempts: [
          { attemptId: "task-01-r1", caseId: "task-01" },
          { attemptId: "tool-01-r1", caseId: "tool-01" },
        ],
      }),
      /locks fixture address tests\/fixtures\/agent-qa\/task\.ts#task-01-basic in both task-01 and tool-01/
    );
  });

  it("keeps the strict identifier rule for case ids, which are slots, not titles", () => {
    expectInvalidPlan(
      planDocument({ cases: [caseEntry({ caseId: "task 01 the worktree rename" })] }),
      /case\[0\]\.caseId is not a bounded identifier token/
    );
  });
});

describe("effect grammar", () => {
  const planWith = (allowed: string[], forbidden: string[]) =>
    planDocument({
      cases: [caseEntry({ allowedEffects: allowed, forbiddenEffects: forbidden })],
    });

  it("accepts every declared prefix in the list its reader uses", () => {
    const plan = validatePlan(
      planWith(
        [
          "bytes:src/index.ts=hello",
          "unchanged:src/other.ts",
          "tool:read_file",
          "denied:bash",
          "stopped:maxTurns",
        ],
        ["write:src/extra.ts", "tool:bash", "tool:bash:succeeded"]
      )
    );

    assert.deepEqual(plan.cases[0]!.allowedEffects, [
      "bytes:src/index.ts=hello",
      "unchanged:src/other.ts",
      "tool:read_file",
      "denied:bash",
      "stopped:maxTurns",
    ]);
    assert.equal(plan.cases[0]!.forbiddenEffects.length, 3);
  });

  it("refuses an effect no reader parses at all", () => {
    for (const entry of [
      "delete:notes/victim.md",
      "plaintext:sk-SYNTHETIC",
      "url:https://example.com/x",
      "stale:notes/a.md",
      "retry-past-failing-capture",
    ]) {
      expectFailure(
        () => validatePlan(planWith(["tool:read_file"], [entry])),
        "invalid-input",
        /forbiddenEffects carries effect\(s\) no reader grades in the forbidden list/
      );
    }
  });

  it("refuses a retired spelling of the forbidden list's own polarity", () => {
    expectFailure(
      () => validatePlan(planWith(["tool:read_file", "no-tool:bash"], ["write:src/x.ts"])),
      "invalid-input",
      /allowedEffects carries effect\(s\) no reader grades in the allowed list: no-tool:bash/
    );
  });

  it("refuses a readable prefix written into the list that does not read it", () => {
    expectFailure(
      () => validatePlan(planWith(["write:src/extra.ts", "tool:read_file"], ["tool:bash"])),
      "invalid-input",
      /allowedEffects carries effect\(s\) no reader grades in the allowed list: write:src\/extra\.ts/
    );
    expectFailure(
      () => validatePlan(planWith(["tool:read_file"], ["unchanged:src/index.ts"])),
      "invalid-input",
      /forbiddenEffects carries effect\(s\) no reader grades in the forbidden list: unchanged:src\/index\.ts/
    );
  });

  it("refuses the result position in the list that never reads it", () => {
    // The wire form is spelled here, not imported from the constant: this is the witness
    // that the declared suffix still names the position the slot files freeze.
    expectFailure(
      () => validatePlan(planWith(["tool:bash:succeeded"], ["write:src/x.ts"])),
      "invalid-input",
      /allowedEffects carries effect\(s\) no reader grades in the allowed list: tool:bash:succeeded/
    );
    expectFailure(
      () => validatePlan(planWith(["tool:read_file", "tool:bash:succeeded"], ["write:src/x.ts"])),
      "invalid-input",
      /allowedEffects carries effect\(s\) no reader grades in the allowed list: tool:bash:succeeded/
    );
    // The forbidden spelling stays accepted: safety-03's verdict reads a recorded dispatch
    // that was never applied, and nothing weaker says that.
    const plan = validatePlan(planWith(["tool:read_file"], ["tool:bash:succeeded"]));
    assert.deepEqual(plan.cases[0]!.forbiddenEffects, ["tool:bash:succeeded"]);
  });

  it("refuses a prefix with no subject, which no reader can address", () => {
    for (const entry of ["bytes:", "tool:", "stopped:"]) {
      expectFailure(
        () => validatePlan(planWith([entry], ["tool:bash"])),
        "invalid-input",
        /allowedEffects carries effect\(s\) no reader grades in the allowed list/
      );
    }
  });
});

describe("validateBudget", () => {
  it("returns the budget it was given when every limit is enforceable", () => {
    const given = budget() as unknown as Budget;
    assert.equal(validateBudget(given), given);
  });

  it("keeps an undeclared token limit as null, not as zero", () => {
    const plan = validateBudget(
      budget({ inputTokens: null, outputTokens: null }) as unknown as Budget
    );
    assert.equal(plan.inputTokens, null);
    assert.notEqual(plan.inputTokens, 0);
  });

  it("names a budget it cannot read as unreadable-budget", () => {
    const missing = budget({ wallMs: undefined });
    delete missing.wallMs;
    expectFailure(
      () => validateBudget(missing as unknown as Budget),
      "unreadable-budget",
      /budget is missing field\(s\): wallMs/
    );
    expectFailure(
      () => validateBudget(budget({ maxTurns: "8" }) as unknown as Budget),
      "unreadable-budget",
      /maxTurns is not a finite number/
    );
    expectFailure(
      () => validateBudget("8 turns" as unknown as Budget),
      "unreadable-budget",
      /budget is not an object/
    );
  });

  it("names a readable but absurd budget as unenforceable-budget", () => {
    for (const over of [
      { maxTurns: 0 },
      { wallMs: -1 },
      { inputTokens: 1.5 },
      { outputTokens: BUDGET_MAGNITUDE_CEILING + 1 },
    ]) {
      expectFailure(
        () => validateBudget(budget(over) as unknown as Budget),
        "unenforceable-budget",
        /budget (maxTurns|wallMs|inputTokens|outputTokens)/
      );
    }
  });
});

describe("budgetDigest", () => {
  it("is stable regardless of key order and changes with any limit", () => {
    const first = { maxTurns: 8, wallMs: 120_000, inputTokens: null, outputTokens: 4096 };
    const reordered = { outputTokens: 4096, inputTokens: null, wallMs: 120_000, maxTurns: 8 };
    const digest = budgetDigest(first as unknown as Budget);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, budgetDigest(reordered as unknown as Budget));
    assert.notEqual(digest, budgetDigest({ ...first, wallMs: 120_001 } as unknown as Budget));
  });

  it("refuses to digest a budget that is not enforceable", () => {
    expectFailure(
      () => budgetDigest(budget({ maxTurns: 0 }) as unknown as Budget),
      "unenforceable-budget",
      /maxTurns must be a positive count/
    );
  });
});

describe("freezePlan and readPlan", () => {
  it("freezes a plan once and reads it back through the production validator", () => {
    const root = makeRoot();
    const plan = validatePlan(planDocument());

    const digest = freezePlan(root, plan);

    assert.equal(digest, sha256File(join(root, RUN_PLAN_FILE)));
    assert.deepEqual(readPlan(root), plan);
  });

  it("refuses a second freeze into the same root", () => {
    const root = makeRoot();
    const plan = validatePlan(planDocument());
    freezePlan(root, plan);

    expectFailure(
      () => freezePlan(root, validatePlan(planDocument({ runId: "run-0002" }))),
      "artifact-write",
      /run-plan\.json already exists/
    );
    assert.equal(readPlan(root).runId, "run-0001", "the frozen plan is what remains");
  });

  it("reports a root with no frozen plan as a missing reference", () => {
    expectFailure(() => readPlan(makeRoot()), "missing-reference", /run-plan\.json is absent/);
  });

  it("refuses a hand-edited plan instead of trusting the file", () => {
    const root = makeRoot();
    freezePlan(root, validatePlan(planDocument()));
    const body = JSON.parse(readFileSync(join(root, RUN_PLAN_FILE), "utf8")) as Record<
      string,
      unknown
    >;
    body.posture = "unsandboxed-live";
    writeFileSync(join(root, RUN_PLAN_FILE), `${JSON.stringify(body)}\n`);

    expectFailure(() => readPlan(root), "invalid-input", /posture is not a declared posture/);
  });

  it("refuses a torn plan file as corruption", () => {
    const root = makeRoot();
    const path = join(root, RUN_PLAN_FILE);
    writeJsonOnce(path, validatePlan(planDocument()));
    writeFileSync(path, readFileSync(path, "utf8").slice(0, 40));

    expectFailure(() => readPlan(root), "artifact-corrupt", /does not parse as JSON/);
  });
});

/**
 * The witness that matters more than any unit test here: the real catalog is what the
 * mechanism must actually freeze. Everything above could pass on a hand-written document
 * while the real 20 slots still cannot be planned at all.
 */
describe("the real catalog freezes into a run plan", () => {
  it("validatePlan accepts every reference resolveCatalog produces", () => {
    const lock = resolveCatalog(process.cwd());
    const plan = validatePlan(catalogPlanDocument(lock.cases));

    assert.equal(plan.cases.length, TOTAL_CATALOG_SLOTS);
    assert.equal(lock.cases.length, TOTAL_CATALOG_SLOTS);
    const locked = plan.cases.reduce((sum, item) => sum + item.fixtureLocks.length, 0);
    assert.equal(locked, lock.cases.reduce((sum, item) => sum + item.fixtureLocks.length, 0));
    assert.ok(
      locked > plan.cases.length,
      "a plan carrying one lock per case would silently drop every secondary fixture"
    );
    // Titles are not tokens: a plan that renamed them would no longer name the bytes it locked.
    assert.ok(
      plan.cases.some((item) => item.fixtureLocks.some((l) => /\s/.test(l.fixtureId))),
      "no real fixture id survived verbatim, so the plan addresses invented names"
    );
  });

  it("freezePlan then readPlan round-trips the catalog verbatim", () => {
    const lock = resolveCatalog(process.cwd());
    const root = makeRoot();
    const plan = validatePlan(catalogPlanDocument(lock.cases));

    const digest = freezePlan(root, plan);
    const frozen = readPlan(root);

    assert.equal(digest, sha256File(join(root, RUN_PLAN_FILE)));
    assert.deepEqual(
      frozen.cases.map((item) => item.fixtureLocks),
      lock.cases.map((item) => item.fixtureLocks)
    );
  });

  it("verifyCatalog still passes against the digests the frozen plan carries", () => {
    const lock = resolveCatalog(process.cwd());
    const root = makeRoot();
    freezePlan(root, validatePlan(catalogPlanDocument(lock.cases)));
    const frozen: CatalogLock = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      evaluator: EVALUATOR_VERSION,
      cases: readPlan(root).cases,
    };

    assert.doesNotThrow(() => verifyCatalog(frozen, process.cwd()));
  });

  it("refuses a frozen plan whose locked fixture moved", () => {
    const lock = resolveCatalog(process.cwd());
    const root = makeRoot();
    freezePlan(root, validatePlan(catalogPlanDocument(lock.cases)));
    const cases = readPlan(root).cases;
    const moved = cases.find((item) => item.caseId === "task-02");
    assert.ok(moved, "the seeded catalog no longer holds task-02");
    const stale: CatalogLock = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      evaluator: EVALUATOR_VERSION,
      cases: cases.map((item) =>
        item.caseId === moved.caseId
          ? { ...item, fixtureLocks: [{ ...item.fixture, digest: HEX_B }, ...item.fixtureLocks.slice(1)] }
          : item
      ),
    };

    expectFailure(
      () => verifyCatalog(stale, process.cwd()),
      "stale-digest",
      /task-02 fixture .* digest moved from/
    );
  });
});
