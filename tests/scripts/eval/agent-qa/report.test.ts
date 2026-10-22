/**
 * Read-only report witnesses a reporter that reads real artifacts and changes nothing.
 *
 * Every case seeds real artifacts on a real temporary filesystem and then asks the
 * reporter to read them back. Nothing here mocks `node:fs`: a mock could not show
 * that a retained digest moved, that a truncated file fails to parse, or that the
 * reporter changed nothing and called nobody.
 */
import { INTENT_FILE } from "../../../../scripts/eval/agent-qa/types.ts";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import assert from "node:assert/strict";

import {
  readJsonArtifact,
  sha256File,
  writeHashIndex,
  writeJsonOnce,
} from "../../../../scripts/eval/agent-qa/artifacts.ts";
import { freezePlan } from "../../../../scripts/eval/agent-qa/plan.ts";

import {
  isEvalFailure,
  type EvalFailure,
} from "../../../../scripts/eval/agent-qa/failures.ts";
import {
  ATTEMPT_FILE,
  ATTEMPTS_DIR,
  CATALOG_LOCK_FILE,
  HASH_INDEX_FILE,
  REPORT_SCHEMA_VERSION,
  REPORTS_DIR,
  type AttemptRecord,
  type CaseReference,
  type LimitState,
  type OracleResult,
  type PlannedAttempt,
  type RunPlan,
  type UsageRecord,
} from "../../../../scripts/eval/agent-qa/types.ts";
import {
  buildReport,
  persistReport,
} from "../../../../scripts/eval/agent-qa/report.ts";

const roots: string[] = [];
const reportSourcePath = new URL(
  "../../../../scripts/eval/agent-qa/report.ts",
  import.meta.url
);
const originalFetch = globalThis.fetch;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iknow-agent-qa-report-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function sha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Two slots, one repetition each: enough shape to witness every dimension. */
const SEEDED_CASES: readonly CaseReference[] = [
  {
    caseId: "task-02",
    group: "task",
    fixture: {
      path: "tests/harness/aci/tools/write-file.test.ts",
      fixtureId: "overwrites-the-contents",
      digest: sha("fixture-task-02"),
    },
    // A second lock, so the lock list is a different fact from the primary: a drift
    // inside it can only be seen by code that verifies every entry.
    fixtureLocks: [
      {
        path: "tests/harness/aci/tools/write-file.test.ts",
        fixtureId: "overwrites-the-contents",
        digest: sha("fixture-task-02"),
      },
      {
        path: "tests/harness/aci/tools/write-file.test.ts",
        fixtureId: "refuses-an-escaping-target",
        digest: sha("fixture-task-02-secondary"),
      },
    ],
    oracles: [
      {
        oracleId: "task-02-target-bytes",
        kind: "workspace-bytes",
        evidence: "notes/status.md equals the two required lines",
      },
      {
        oracleId: "task-02-untouched",
        kind: "workspace-bytes",
        evidence: "notes/unrelated.md still equals its seed bytes",
      },
    ],
    allowedEffects: ["bytes:notes/status.md"],
    forbiddenEffects: ["write:notes/unrelated.md"],
  },
  {
    caseId: "safety-03",
    group: "safety",
    fixture: {
      path: "tests/harness/permission/denial.test.ts",
      fixtureId: "denied-call-leaves-no-effect",
      digest: sha("fixture-safety-03"),
    },
    fixtureLocks: [
      {
        path: "tests/harness/permission/denial.test.ts",
        fixtureId: "denied-call-leaves-no-effect",
        digest: sha("fixture-safety-03"),
      },
    ],
    oracles: [
      {
        oracleId: "safety-03-denial-record",
        kind: "permission-record",
        evidence: "the effect record holds a denial and no dispatch",
      },
    ],
    allowedEffects: ["denied:bash"],
    forbiddenEffects: ["tool:bash"],
  },
];

/** The address a record of `caseId` legitimately carries: the primary, i.e. locks[0]. */
function seededCase(caseId: string): CaseReference {
  const found = SEEDED_CASES.find((item) => item.caseId === caseId);
  assert.ok(found, `fixture case ${caseId} is not seeded`);
  return found;
}

function primaryDigest(caseId: string): string {
  return seededCase(caseId).fixtureLocks[0].digest;
}

/** A non-primary lock of a case, used to witness the verify-every-lock rule. */
function secondaryDigest(caseId: string): string {
  const locks = seededCase(caseId).fixtureLocks;
  assert.ok(locks.length > 1, `fixture case ${caseId} seeds no second lock`);
  return locks[1].digest;
}

const PLANNED: readonly PlannedAttempt[] = [
  { attemptId: "task-02-a1", caseId: "task-02", notRun: null },
  { attemptId: "safety-03-a1", caseId: "safety-03", notRun: null },
];

/** Named required artifacts: per attempt its record, its trace reference, one per oracle. */
const NAMED_SLOTS = PLANNED.reduce(
  (total, attempt) =>
    total + 2 + (SEEDED_CASES.find((item) => item.caseId === attempt.caseId)?.oracles.length ?? 0),
  0
);

function planFor(runId: string, overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId,
    evaluator: "agent-qa-v1",
    modelRoute: "scripted-offline-route",
    promptDigest: sha("prompt-a"),
    toolDigest: sha("tool-a"),
    sourceDigest: sha("source-a"),
    dataIdentity: "data-synthetic-1",
    environmentIdentity: "env-disposable-1",
    posture: "scripted-offline",
    budget: { maxTurns: 4, wallMs: 60_000, inputTokens: 1_000, outputTokens: 500 },
    cases: SEEDED_CASES,
    attempts: PLANNED,
    frozenBeforeAnyOutcome: true,
    ...overrides,
  };
}

function freezeRun(root: string, plan: RunPlan): void {
  freezePlan(root, plan);
  writeJsonOnce(join(root, CATALOG_LOCK_FILE), {
    schemaVersion: REPORT_SCHEMA_VERSION,
    evaluator: plan.evaluator,
    cases: plan.cases,
  });
  mkdirSync(join(root, ATTEMPTS_DIR), { recursive: true });
}

type SeedAttempt = Omit<AttemptRecord, "schemaVersion" | "fixtureDigest">;

function attemptSeed(attemptId: string, caseId: string): SeedAttempt {
  return {
    attemptId,
    runId: "run-a",
    caseId,
    startedAtEpochMs: 1_700_000_000_000,
    settledAtEpochMs: 1_700_000_000_900,
    phase: "settled",
    outcome: "passed",
    validity: "valid",
    coverage: "complete",
    posture: "scripted-offline",
    limits: [
      { name: "maxTurns", declared: 4, applied: true, observed: 2, overrun: false },
      { name: "wallMs", declared: 60_000, applied: true, observed: 900, overrun: false },
      { name: "inputTokens", declared: 1_000, applied: false, observed: 120, overrun: false },
      { name: "outputTokens", declared: 500, applied: false, observed: 30, overrun: false },
    ],
    usage: { inputTokens: 120, outputTokens: 30, wallMs: 900, usageComplete: true },
    oracles: oracleResultsFor(caseId),
    traceRef: "trace/trace.jsonl",
    failure: null,
    cleanup: { status: "confirmed", owned: [] },
  };
}

function oracleResultsFor(caseId: string): OracleResult[] {
  const aCase = SEEDED_CASES.find((item) => item.caseId === caseId);
  return (aCase?.oracles ?? []).map((oracle, index) => ({
    oracleId: oracle.oracleId,
    kind: oracle.kind,
    status: "satisfied",
    evidenceRef: `${caseId}/oracles/${oracle.oracleId}.json`,
    digest: sha(`oracle-${oracle.oracleId}-${index}`),
  }));
}

function seedAttempt(root: string, seed: SeedAttempt): string {
  const dir = join(root, ATTEMPTS_DIR, seed.attemptId);
  mkdirSync(dir, { recursive: true });
  // What attempt.ts records is `caseReference.fixture.digest`, which after the arity fix
  // is `fixtureLocks[0].digest`: the record of a multi-lock case still resolves.
  return writeJsonOnce(join(dir, ATTEMPT_FILE), {
    schemaVersion: REPORT_SCHEMA_VERSION,
    fixtureDigest: primaryDigest(seed.caseId),
    ...seed,
  });
}

function seedWritten(
  root: string,
  attemptId: string,
  caseId: string,
  patch: Partial<AttemptRecord> = {}
): string {
  const seed = { ...attemptSeed(attemptId, caseId), ...patch } as SeedAttempt;
  return seedAttempt(root, seed);
}

/** The bytes a dispatch leaves behind when it never reached settlement. */
function intentOf(attemptId: string, caseId: string): AttemptRecord {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    attemptId,
    runId: "run-a",
    caseId,
    fixtureDigest: primaryDigest(caseId),
    startedAtEpochMs: 1_700_000_000_000,
    settledAtEpochMs: null,
    phase: "intent",
    outcome: "undetermined",
    validity: "not-run",
    coverage: "missing",
    posture: "scripted-offline",
    // The bytes a dispatch leaves behind when it never reached settlement: the limits
    // the plan froze, each stated as nothing applied and nothing observed.
    limits: [
      { name: "maxTurns", declared: 4, applied: false, observed: null, overrun: false },
      { name: "wallMs", declared: 60_000, applied: false, observed: null, overrun: false },
      { name: "inputTokens", declared: 1_000, applied: false, observed: null, overrun: false },
      { name: "outputTokens", declared: 500, applied: false, observed: null, overrun: false },
    ],
    usage: { inputTokens: null, outputTokens: null, wallMs: null, usageComplete: false },
    oracles: [],
    traceRef: null,
    failure: null,
    cleanup: { status: "not-applicable", owned: [] },
  };
}

function fullySeededRun(root: string): RunPlan {
  const plan = planFor("run-a");
  freezeRun(root, plan);
  seedWritten(root, "task-02-a1", "task-02");
  seedWritten(root, "safety-03-a1", "safety-03");
  return plan;
}

function captureFailure(run: () => unknown): EvalFailure {
  try {
    run();
  } catch (error) {
    assert.ok(isEvalFailure(error), `expected a typed failure, got ${String(error)}`);
    return error;
  }
  return assert.fail("expected the call to throw a typed failure");
}

function attemptOf(report: ReturnType<typeof buildReport>, attemptId: string) {
  const found = report.attempts.find((item) => item.attemptId === attemptId);
  assert.ok(found, `the report must retain ${attemptId}`);
  return found;
}

function digestTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      for (const [rel, value] of Object.entries(digestTree(path))) {
        out[`${name}/${rel}`] = value;
      }
      continue;
    }
    out[name] = sha256File(path);
  }
  return out;
}

describe("buildReport dimensions", () => {
  it("states the four dimensions of every planned attempt from stored records", () => {
    const root = makeRoot();
    fullySeededRun(root);

    const report = buildReport(root);
    const task = attemptOf(report, "task-02-a1");

    assert.equal(report.attempts.length, PLANNED.length);
    assert.equal(task.outcome, "passed");
    assert.equal(task.validity, "valid");
    assert.equal(task.coverage, "complete");
    assert.equal(task.posture, "scripted-offline");
    const limits: readonly LimitState[] = task.limits;
    assert.deepEqual(
      limits.map((limit) => [limit.name, limit.declared, limit.applied, limit.observed]),
      [
        ["maxTurns", 4, true, 2],
        ["wallMs", 60_000, true, 900],
        ["inputTokens", 1_000, false, 120],
        ["outputTokens", 500, false, 30],
      ]
    );
    assert.deepEqual(task.oracleRefs, ["task-02-target-bytes", "task-02-untouched"]);
    assert.equal(task.traceRef, "trace/trace.jsonl");
    assert.equal(report.measurementCoverage, 1);
    assert.equal(report.mayClaimCapability, false);
  });

  it("refuses a record that leaves one declared limit unstated", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");
    seedWritten(root, "safety-03-a1", "safety-03", {
      limits: attemptSeed("safety-03-a1", "safety-03").limits.filter(
        (limit) => limit.name !== "wallMs"
      ),
    });

    const failure = captureFailure(() => buildReport(root));

    // A limit the plan froze but the record never mentions would read as "no such cap was
    // frozen" — the absence has to be a refusal, not a smaller dimension 4.
    assert.equal(failure.kind, "invalid-protocol");
    assert.equal(failure.phase, "report");
    assert.equal(failure.attemptId, "safety-03-a1");
    assert.match(failure.diagnostic, /does not state each declared limit exactly once/);
  });

  it("refuses a record that states one declared limit twice", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");
    const stated = attemptSeed("safety-03-a1", "safety-03").limits;
    seedWritten(root, "safety-03-a1", "safety-03", {
      limits: [...stated.slice(0, 3), stated[0] as (typeof stated)[number]],
    });

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "invalid-protocol");
    assert.equal(failure.attemptId, "safety-03-a1");
    assert.match(failure.diagnostic, /does not state each declared limit exactly once/);
  });

  it("counts planned, executed, valid and passed while keeping coverage separate", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");
    seedWritten(root, "safety-03-a1", "safety-03", {
      outcome: "failed",
      validity: "interrupted",
      coverage: "partial",
    });

    const report = buildReport(root);

    assert.deepEqual(report.counts, {
      planned: 2,
      executed: 2,
      valid: 1,
      passed: 1,
      interrupted: 1,
      providerErrors: 0,
      invalid: 0,
      notRun: 0,
      unknown: 0,
    });
    assert.equal(report.conditionalScore, 1);
    assert.equal(report.fullCatalogCoverage, false);
    assert.deepEqual(report.roster.executed, ["task-02"]);
    assert.deepEqual(report.roster.partial, ["safety-03"]);
    assert.deepEqual(report.roster.missing, []);
  });

  it("keeps a planned attempt with no attempt directory visible as not-run", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");

    const report = buildReport(root);
    const slot = attemptOf(report, "safety-03-a1");

    assert.equal(report.counts.planned, 2);
    assert.equal(report.counts.executed, 1);
    assert.equal(report.counts.notRun, 1);
    assert.equal(report.measurementCoverage, 4 / NAMED_SLOTS);
    assert.equal(report.fullCatalogCoverage, false);
    assert.deepEqual(report.roster.missing, ["safety-03"]);
    assert.equal(slot.validity, "not-run");
    assert.equal(slot.outcome, "undetermined");
    assert.equal(slot.coverage, "missing");
    assert.equal(slot.posture, "scripted-offline");
    assert.deepEqual(slot.usage, {
      inputTokens: null,
      outputTokens: null,
      wallMs: null,
      usageComplete: false,
    });
    assert.deepEqual(
      slot.limits.map((limit) => [limit.name, limit.declared, limit.applied, limit.observed]),
      [
        ["maxTurns", 4, false, null],
        ["wallMs", 60_000, false, null],
        ["inputTokens", 1_000, false, null],
        ["outputTokens", 500, false, null],
      ]
    );
    assert.deepEqual(slot.oracleRefs, []);
  });

  it("accounts a slot the plan froze off dispatch by its declared reason", () => {
    const root = makeRoot();
    freezeRun(
      root,
      planFor("run-a", {
        attempts: [
          { attemptId: "task-02-a1", caseId: "task-02", notRun: null },
          { attemptId: "safety-03-a1", caseId: "safety-03", notRun: "credential-blocked" },
        ],
      })
    );
    seedWritten(root, "task-02-a1", "task-02");

    const report = buildReport(root);

    assert.equal(report.counts.notRun, 1);
    assert.deepEqual(report.roster["credential-blocked"], ["safety-03"]);
    assert.deepEqual(report.roster.skipped, []);
    assert.deepEqual(report.roster["other-not-run"], []);
    assert.deepEqual(report.roster.missing, [], "a declared slot is accounted, not unaccounted");
    assert.deepEqual(report.roster.executed, ["task-02"]);
    assert.equal(report.fullCatalogCoverage, false);
  });

  it("refuses measurement for a slot the plan froze off dispatch", () => {
    const root = makeRoot();
    freezeRun(
      root,
      planFor("run-a", {
        attempts: [
          { attemptId: "task-02-a1", caseId: "task-02", notRun: null },
          { attemptId: "safety-03-a1", caseId: "safety-03", notRun: "skipped" },
        ],
      })
    );
    seedWritten(root, "task-02-a1", "task-02");
    seedWritten(root, "safety-03-a1", "safety-03");

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "invalid-protocol");
    assert.equal(failure.phase, "report");
    assert.match(failure.diagnostic, /safety-03 is frozen not-run \(skipped\)/);
  });

  it("refuses one case frozen off dispatch for two different reasons", () => {
    const root = makeRoot();
    freezeRun(
      root,
      planFor("run-a", {
        attempts: [
          { attemptId: "safety-03-a1", caseId: "safety-03", notRun: "skipped" },
          {
            attemptId: "safety-03-a2",
            caseId: "safety-03",
            notRun: "credential-blocked",
          },
          { attemptId: "task-02-a1", caseId: "task-02", notRun: "skipped" },
          { attemptId: "task-02-a2", caseId: "task-02", notRun: "skipped" },
        ],
      })
    );

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "invalid-protocol");
    assert.equal(failure.phase, "report");
    assert.match(failure.diagnostic, /both skipped and credential-blocked/);
  });

  it("refuses an attempt directory the frozen plan never planned", () => {
    const root = makeRoot();
    fullySeededRun(root);
    seedWritten(root, "task-09-a1", "task-02");

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "invalid-protocol");
    assert.equal(failure.phase, "report");
    assert.match(failure.diagnostic, /task-09-a1/);
  });
});

describe("buildReport denominators", () => {
  it("leaves the conditional score undefined and the run non-green at zero valid attempts", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", {
      outcome: "undetermined",
      validity: "provider-error",
      coverage: "missing",
    });
    // The second slot never ran, so incompleteness is stated, never implied by a number.
    const report = buildReport(root);

    assert.equal(report.conditionalScore, null);
    assert.equal(report.counts.valid, 0);
    assert.equal(report.counts.providerErrors, 1);
    assert.equal(report.counts.notRun, 1);
    assert.equal(report.fullCatalogCoverage, false);
    assert.deepEqual(report.roster.missing, ["safety-03"]);
    assert.equal(report.measurementCoverage < 1, true);
    assert.equal(report.mayClaimCapability, false);
  });

  it("keeps conditionalScore null rather than 0 when all ran and none was valid", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", { validity: "invalid" });
    seedWritten(root, "safety-03-a1", "safety-03", {
      validity: "unknown",
      coverage: "corrupt",
    });

    const report = buildReport(root);

    assert.equal(report.conditionalScore, null);
    assert.notEqual(report.conditionalScore, 0);
    assert.equal(report.counts.executed, 1, "unknown validity is not an executed measurement");
    assert.equal(report.counts.invalid, 1);
    assert.equal(report.counts.unknown, 1);
    assert.equal(report.counts.passed, 0, "a non-admissible attempt cannot contribute a pass");
  });

  it("cannot turn unconfirmed cleanup into a task pass", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", {
      cleanup: { status: "unconfirmed", owned: ["scratch/workspace"] },
    });
    seedWritten(root, "safety-03-a1", "safety-03");

    const report = buildReport(root);

    assert.equal(report.counts.valid, 2);
    assert.equal(report.counts.passed, 1, "only the attempt whose cleanup is confirmed may pass");
    assert.equal(report.conditionalScore, 0.5);
  });

  it("separates unknown usage from a measured zero", () => {
    const unknownRoot = makeRoot();
    freezeRun(unknownRoot, planFor("run-a"));
    seedWritten(unknownRoot, "task-02-a1", "task-02", {
      usage: { inputTokens: null, outputTokens: null, wallMs: null, usageComplete: false },
    });
    seedWritten(unknownRoot, "safety-03-a1", "safety-03");
    const unknownUsage: UsageRecord = attemptOf(
      buildReport(unknownRoot),
      "task-02-a1"
    ).usage;

    const zeroRoot = makeRoot();
    freezeRun(zeroRoot, planFor("run-a"));
    seedWritten(zeroRoot, "task-02-a1", "task-02", {
      usage: { inputTokens: 0, outputTokens: 0, wallMs: 0, usageComplete: true },
    });
    seedWritten(zeroRoot, "safety-03-a1", "safety-03");
    const measuredZero: UsageRecord = attemptOf(
      buildReport(zeroRoot),
      "task-02-a1"
    ).usage;

    assert.equal(unknownUsage.inputTokens, null);
    assert.equal(unknownUsage.outputTokens, null);
    assert.equal(unknownUsage.wallMs, null);
    assert.equal(unknownUsage.usageComplete, false);
    assert.equal(measuredZero.inputTokens, 0);
    assert.equal(measuredZero.wallMs, 0);
    assert.equal(measuredZero.usageComplete, true);
    assert.notDeepEqual(measuredZero, unknownUsage);
  });

  it("cannot turn incomplete evidence into a task pass", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", { coverage: "partial" });
    seedWritten(root, "safety-03-a1", "safety-03", {
      outcome: "undetermined",
      validity: "provider-error",
      coverage: "missing",
    });

    const report = buildReport(root);

    assert.equal(report.counts.valid, 1);
    assert.equal(report.counts.passed, 0);
    assert.equal(report.conditionalScore, 0);
    assert.equal(report.measurementCoverage < 1, true);
  });
});

describe("buildReport determinism and read-only-ness", () => {
  it("reconstructs byte-identical JSON from the same artifacts", () => {
    const root = makeRoot();
    fullySeededRun(root);

    const first = JSON.stringify(buildReport(root));
    const second = JSON.stringify(buildReport(root));

    assert.equal(first, second);
    assert.equal(JSON.parse(first).attempts.length, PLANNED.length);
  });

  it("leaves every input artifact digest unchanged and invokes no provider", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const before = digestTree(root);
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("the reporter must never call out");
    }) as typeof globalThis.fetch;

    const report = buildReport(root);
    const persisted = persistReport(root, report);

    assert.equal(fetchCalls, 0);
    assert.equal(persisted, sha256File(join(root, REPORTS_DIR, "run-a.report.json")));
    assert.deepEqual(
      digestTree(root),
      { ...before, [`reports/run-a.report.json`]: persisted },
      "reporting writes exactly one new artifact"
    );
  });

  it("names no network or child-process module anywhere in its source", () => {
    const source = readFileSync(reportSourcePath, "utf8");
    for (const needle of [
      "node:net",
      "node:tls",
      "node:http",
      "node:https",
      "node:dgram",
      "node:child_process",
      "node:worker_threads",
      "node:repl",
      "undici",
      "fetch(",
      "spawn(",
      "exec(",
      "terminal-bench",
    ]) {
      assert.ok(!source.includes(needle), `report.ts must not reference ${needle}`);
    }
    assert.match(source, /from "node:fs"/);
    assert.match(source, /mayClaimCapability: false/);
  });

  it("freezes the plan identities into the report so a comparison needs no live run", () => {
    const root = makeRoot();
    fullySeededRun(root);

    const report = buildReport(root);

    assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION);
    assert.equal(report.runId, "run-a");
    assert.deepEqual(Object.keys(report.identities).sort(), [
      "budget",
      "data",
      "environment",
      "evaluator",
      "model",
      "posture",
      "prompt",
      "source",
      "tool",
    ]);
    assert.equal(report.identities.evaluator, "agent-qa-v1");
    assert.equal(report.identities.model, "scripted-offline-route");
    assert.equal(report.identities.data, "data-synthetic-1");
    assert.equal(report.identities.environment, "env-disposable-1");
    assert.equal(report.identities.posture, "scripted-offline");
    assert.match(report.identities.budget, /^[0-9a-f]{64}$/);
  });

  it("refuses a second persist instead of overwriting the report", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const report = buildReport(root);
    const digest = persistReport(root, report);

    const failure = captureFailure(() => persistReport(root, report));

    assert.equal(failure.kind, "artifact-write");
    assert.equal(failure.phase, "artifact-write");
    assert.equal(failure.dispatchMayContinue, false);
    assert.equal(sha256File(join(root, REPORTS_DIR, "run-a.report.json")), digest);
  });

  it("rebuilds the identical report after one has been persisted", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const report = buildReport(root);
    persistReport(root, report);

    assert.equal(JSON.stringify(buildReport(root)), JSON.stringify(report));
  });
});

describe("buildReport artifact faults", () => {
  it("reports the slot that froze its intent and never settled, keeping the run observable", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");
    const dir = join(root, ATTEMPTS_DIR, "safety-03-a1");
    mkdirSync(dir, { recursive: true });
    writeJsonOnce(join(dir, INTENT_FILE), intentOf("safety-03-a1", "safety-03"));

    const report = buildReport(root);
    const slot = attemptOf(report, "safety-03-a1");

    assert.equal(slot.validity, "interrupted");
    assert.equal(slot.outcome, "undetermined");
    assert.equal(slot.coverage, "partial");
    assert.equal(report.attempts.length, PLANNED.length);
    assert.deepEqual(report.counts, {
      planned: 2,
      executed: 2,
      valid: 1,
      passed: 1,
      interrupted: 1,
      providerErrors: 0,
      invalid: 0,
      notRun: 0,
      unknown: 0,
    });
    assert.equal(report.measurementComplete, false);
    assert.equal(report.measurementCoverage, 5 / NAMED_SLOTS);
    assert.deepEqual(report.cleanupUnconfirmed, ["safety-03-a1"]);
  });

  it("fails typed when a settlement froze its index and then lost attempt.json", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const dir = join(root, ATTEMPTS_DIR, "task-02-a1");
    writeHashIndex(dir);
    rmSync(join(dir, ATTEMPT_FILE));

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.attemptId, "task-02-a1");
    assert.equal(failure.phase, "artifact-read");
    assert.ok(
      failure.kind === "missing-reference" || failure.kind === "artifact-corrupt",
      `a tampered settlement is a typed refusal, got ${failure.kind}`
    );
  });

  it("fails typed when a reserved attempt directory holds no bytes at all", () => {
    const root = makeRoot();
    fullySeededRun(root);
    rmSync(join(root, ATTEMPTS_DIR, "task-02-a1", ATTEMPT_FILE));

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "missing-reference");
    assert.equal(failure.phase, "artifact-read");
    assert.equal(failure.attemptId, "task-02-a1");
  });

  it("fails typed when a retained attempt.json is truncated", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const path = join(root, ATTEMPTS_DIR, "task-02-a1", ATTEMPT_FILE);
    const body = readFileSync(path, "utf8");
    writeFileSync(path, body.slice(0, Math.floor(body.length / 2)));

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "artifact-corrupt");
    assert.equal(failure.phase, "artifact-read");
    assert.ok(
      !failure.diagnostic.includes("trace/trace.jsonl"),
      "a refusal never echoes the retained contents"
    );
  });

  it("fails typed when a fixture digest moved past the frozen lock", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", { fixtureDigest: sha("moved-fixture") });
    seedWritten(root, "safety-03-a1", "safety-03");

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "stale-digest");
    assert.equal(failure.attemptId, "task-02-a1");
    assert.match(failure.diagnostic, /task-02/);
  });

  it("fails typed when a required oracle result was never retained", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const path = join(root, ATTEMPTS_DIR, "task-02-a1", ATTEMPT_FILE);
    const record = readJsonArtifact(path).value as AttemptRecord;
    writeFileSync(path, `${JSON.stringify({ ...record, oracles: record.oracles.slice(0, 1) })}\n`);

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "missing-reference");
    assert.match(failure.diagnostic, /task-02-untouched/);
  });

  it("names the attempt inside an unreadable record so the fault is attributable", () => {
    const root = makeRoot();
    fullySeededRun(root);
    writeFileSync(
      join(root, ATTEMPTS_DIR, "task-02-a1", ATTEMPT_FILE),
      `${JSON.stringify({ schemaVersion: REPORT_SCHEMA_VERSION, attemptId: "task-02-a1" })}\n`
    );

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "invalid-protocol");
    assert.equal(failure.attemptId, "task-02-a1");
    assert.match(failure.diagnostic, /missing field\(s\)/);
  });

  it("refuses a record that carries prose: an outcome cannot come from assistant text", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const path = join(root, ATTEMPTS_DIR, "task-02-a1", ATTEMPT_FILE);
    const record = readJsonArtifact(path).value as AttemptRecord;
    writeFileSync(path, `${JSON.stringify({ ...record, assistantText: "task done" })}\n`);

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "invalid-protocol");
    assert.match(failure.diagnostic, /assistantText/);
  });

  it("refuses a record that attributes itself to another run", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const path = join(root, ATTEMPTS_DIR, "task-02-a1", ATTEMPT_FILE);
    const record = readJsonArtifact(path).value as AttemptRecord;
    writeFileSync(path, `${JSON.stringify({ ...record, runId: "run-b" })}\n`);

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "invalid-protocol");
    assert.match(failure.diagnostic, /run-b/);
  });

  it("refuses a catalog lock that disagrees with the frozen plan", () => {
    const root = makeRoot();
    fullySeededRun(root);
    // The reference stays internally consistent — primary and its first lock move
    // together — so what is being refused here is the plan/lock disagreement.
    const movedFixture = {
      ...SEEDED_CASES[0].fixture,
      digest: sha("moved-lock"),
    };
    const moved = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      evaluator: "agent-qa-v1",
      cases: [
        {
          ...SEEDED_CASES[0],
          fixture: movedFixture,
          fixtureLocks: [movedFixture, ...SEEDED_CASES[0].fixtureLocks.slice(1)],
        },
        SEEDED_CASES[1],
      ],
    };
    writeFileSync(join(root, CATALOG_LOCK_FILE), `${JSON.stringify(moved)}\n`);

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "stale-digest");
    assert.match(failure.diagnostic, /task-02/);
  });

  it("reports a missing run plan or catalog lock as a missing reference", () => {
    const root = makeRoot();

    assert.equal(captureFailure(() => buildReport(root)).kind, "missing-reference");

    const lockless = makeRoot();
    freezeRun(lockless, planFor("run-a"));
    rmSync(join(lockless, CATALOG_LOCK_FILE));
    assert.equal(captureFailure(() => buildReport(lockless)).kind, "missing-reference");
  });

  it("detects tampering with an attempt directory that froze a hash index", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const dir = join(root, ATTEMPTS_DIR, "task-02-a1");
    writeJsonOnce(join(dir, "outcome.json"), { outcome: "passed" });
    writeHashIndex(dir);
    writeFileSync(join(dir, "outcome.json"), `${JSON.stringify({ outcome: "edited" })}\n`);

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "artifact-corrupt");
    assert.match(failure.diagnostic, /outcome\.json/);
    assert.equal(existsSync(join(dir, HASH_INDEX_FILE)), true);
  });

  it("refuses a lock whose primary disagrees with the first address of its own lock list", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const moved = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      evaluator: "agent-qa-v1",
      cases: [
        {
          ...SEEDED_CASES[0],
          fixture: { ...SEEDED_CASES[0].fixture, digest: sha("lock-half-moved") },
        },
        SEEDED_CASES[1],
      ],
    };
    writeFileSync(join(root, CATALOG_LOCK_FILE), `${JSON.stringify(moved)}\n`);

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "stale-digest");
    assert.equal(failure.phase, "report");
    assert.match(failure.diagnostic, /task-02/);
  });

  it("refuses a lock that carries no fixture list at all", () => {
    const root = makeRoot();
    fullySeededRun(root);
    const stripped = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      evaluator: "agent-qa-v1",
      cases: SEEDED_CASES.map((item) => ({ ...item, fixtureLocks: [] })),
    };
    writeFileSync(join(root, CATALOG_LOCK_FILE), `${JSON.stringify(stripped)}\n`);

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "invalid-protocol");
    assert.match(failure.diagnostic, /fixtureLocks/);
  });
});

describe("buildReport fixture digests", () => {
  it("states each attempt's fixture digest from the retained record", () => {
    const root = makeRoot();
    fullySeededRun(root);

    const report = buildReport(root);

    assert.equal(
      attemptOf(report, "task-02-a1").fixtureDigest,
      primaryDigest("task-02"),
      "a multi-lock case still resolves against fixtureLocks[0]"
    );
    assert.equal(
      attemptOf(report, "safety-03-a1").fixtureDigest,
      primaryDigest("safety-03")
    );
  });

  it("accepts a record whose digest names any of the case's locked fixtures", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", {
      fixtureDigest: secondaryDigest("task-02"),
    });
    seedWritten(root, "safety-03-a1", "safety-03");

    const report = buildReport(root);

    assert.equal(
      attemptOf(report, "task-02-a1").fixtureDigest,
      secondaryDigest("task-02"),
      "the every-lock rule is what lets a case cite more than one fixture"
    );
  });

  it("states the plan-frozen digest for a slot that never ran", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");

    const slot = attemptOf(buildReport(root), "safety-03-a1");

    assert.equal(slot.validity, "not-run");
    assert.equal(
      slot.fixtureDigest,
      primaryDigest("safety-03"),
      "an unrun slot states the digest the plan froze, never an empty one"
    );
    assert.match(slot.fixtureDigest, /^[0-9a-f]{64}$/);
  });
});

describe("buildReport measurement completeness", () => {
  it("is true only when every planned attempt yielded complete measurement", () => {
    const root = makeRoot();
    fullySeededRun(root);

    const report = buildReport(root);

    assert.equal(report.measurementComplete, true);
    assert.equal(report.conditionalScore, 1);
  });

  it("is false when a planned attempt has no retained record", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");

    const report = buildReport(root);

    assert.equal(report.counts.planned, 2);
    assert.equal(report.counts.notRun, 1);
    assert.equal(report.measurementComplete, false);
    assert.deepEqual(report.roster.missing, ["safety-03"]);
  });

  it("is false when a retained record states not-run", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");
    seedWritten(root, "safety-03-a1", "safety-03", {
      phase: "intent",
      outcome: "undetermined",
      validity: "not-run",
      coverage: "missing",
      traceRef: null,
      oracles: [],
      failure: { kind: "cancelled", phase: "dispatch" },
    });

    const report = buildReport(root);

    assert.equal(report.measurementComplete, false);
    // A cancelled dispatch is a fault the runner named, not a reason the plan froze, so
    // it is accounted as not run without a declared reason rather than as unaccounted.
    assert.deepEqual(report.roster["other-not-run"], ["safety-03"]);
    assert.deepEqual(report.roster.skipped, []);
    assert.deepEqual(report.roster.missing, []);
  });

  it("refuses a roster reason smuggled in through a fault kind", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");
    seedWritten(root, "safety-03-a1", "safety-03", {
      validity: "not-run",
      // A roster state is not a fault kind, so it cannot be spelled where one is expected;
      // the cast writes the malformed artifact a hand-edited record could still contain.
      failure: { kind: "skipped", phase: "dispatch" } as unknown as AttemptRecord["failure"],
    });

    const failure = captureFailure(() => buildReport(root));

    assert.equal(failure.kind, "invalid-protocol");
    assert.equal(failure.phase, "report");
    assert.match(failure.diagnostic, /failure\.kind/);
  });

  it("stays false beside a numeric score when coverage is only partial", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", { coverage: "partial" });
    seedWritten(root, "safety-03-a1", "safety-03");

    const report = buildReport(root);

    assert.equal(report.conditionalScore, 0.5, "a score is still a number here");
    assert.equal(report.measurementComplete, false);
    assert.equal(report.counts.executed, 2);
  });

  it("keeps completeness apart from admissibility, and neither one reads as green", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", { validity: "invalid" });
    seedWritten(root, "safety-03-a1", "safety-03", { validity: "invalid" });

    const report = buildReport(root);

    // Every planned attempt yielded complete evidence, so measurement is complete;
    // none of it is admissible, so nothing may be scored. A null score is what keeps
    // this report from reading as green, and it stands on its own.
    assert.equal(report.measurementComplete, true);
    assert.equal(report.fullCatalogCoverage, true);
    assert.equal(report.conditionalScore, null);
    assert.notEqual(report.conditionalScore, 0);
    assert.equal(report.mayClaimCapability, false);
  });

  it("is false when a planned attempt's measurement is not admissible and not covered", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", { validity: "unknown", coverage: "corrupt" });
    seedWritten(root, "safety-03-a1", "safety-03");

    const report = buildReport(root);

    assert.equal(report.measurementComplete, false);
    assert.equal(report.counts.unknown, 1);
  });
});

describe("buildReport usage totals", () => {
  it("sums every counter when each member states a number", () => {
    const root = makeRoot();
    fullySeededRun(root);

    const report = buildReport(root);

    assert.deepEqual(report.usageTotals, {
      inputTokens: 240,
      outputTokens: 60,
      wallMs: 1_800,
      usageComplete: true,
    });
  });

  it("carries a null from any member into the total instead of a manufactured zero", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", {
      usage: { inputTokens: null, outputTokens: 30, wallMs: 900, usageComplete: false },
    });
    seedWritten(root, "safety-03-a1", "safety-03");

    const totals = buildReport(root).usageTotals;

    assert.equal(totals.inputTokens, null);
    assert.notEqual(totals.inputTokens, 0, "unknown usage is never zero");
    assert.equal(totals.outputTokens, 60, "a counter nobody left unknown still totals");
    assert.equal(totals.usageComplete, false);
  });

  it("keeps usageComplete false when a member states numbers it cannot vouch for", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", {
      usage: { inputTokens: 120, outputTokens: 30, wallMs: 900, usageComplete: false },
    });
    seedWritten(root, "safety-03-a1", "safety-03");

    const totals = buildReport(root).usageTotals;

    assert.equal(totals.inputTokens, 240);
    assert.equal(totals.usageComplete, false);
    assert.equal(totals.wallMs, 1_800);
  });

  it("is unknown as a whole when a planned slot never ran", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");

    const totals = buildReport(root).usageTotals;

    assert.deepEqual(totals, {
      inputTokens: null,
      outputTokens: null,
      wallMs: null,
      usageComplete: false,
    });
  });
});

describe("buildReport cleanup state", () => {
  it("names no attempt when every cleanup is confirmed", () => {
    const root = makeRoot();
    fullySeededRun(root);

    assert.deepEqual(buildReport(root).cleanupUnconfirmed, []);
  });

  it("names an unconfirmed cleanup as its own state, not as a lost pass", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", {
      cleanup: { status: "unconfirmed", owned: ["scratch/workspace"] },
    });
    seedWritten(root, "safety-03-a1", "safety-03");

    const report = buildReport(root);

    assert.deepEqual(report.cleanupUnconfirmed, ["task-02-a1"]);
    assert.equal(report.counts.passed, 1);
    assert.equal(report.counts.valid, 2);
    assert.equal(report.conditionalScore, 0.5);
    assert.equal(report.measurementComplete, true, "cleanup is its own dimension");
  });

  it("names a failed cleanup and leaves a not-applicable one out", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02", {
      cleanup: { status: "failed", owned: ["scratch/workspace"] },
    });
    seedWritten(root, "safety-03-a1", "safety-03", {
      cleanup: { status: "not-applicable", owned: [] },
    });

    const report = buildReport(root);

    assert.deepEqual(report.cleanupUnconfirmed, ["task-02-a1"]);
    assert.equal(report.counts.passed, 0);
  });

  it("names no cleanup obligation for a slot nobody dispatched", () => {
    const root = makeRoot();
    freezeRun(root, planFor("run-a"));
    seedWritten(root, "task-02-a1", "task-02");

    const report = buildReport(root);

    assert.deepEqual(report.cleanupUnconfirmed, []);
    assert.deepEqual(report.roster.missing, ["safety-03"]);
    assert.equal(report.measurementComplete, false);
  });
});
