/**
 * Comparison eligibility and transition witnesses the rules that let two runs be compared.
 *
 * Each arm is built independently, then its persisted report is placed in the root the
 * comparison reads it from — one root for most rules, two for the cross-root arm, which is
 * how a reviewer holding two separately retained runs actually receives them. Every refusal
 * rule gets its own failing case, so a loosened check cannot quietly keep comparing.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  COMPARISONS_DIR,
  REPORTS_DIR,
  REPORT_SCHEMA_VERSION,
  type AgentQaReport,
  type AttemptRecord,
  type CaseReference,
  type PlannedAttempt,
  type RunPlan,
} from "../../../../scripts/eval/agent-qa/types.ts";
import { buildReport } from "../../../../scripts/eval/agent-qa/report.ts";
import { compareReports } from "../../../../scripts/eval/agent-qa/compare.ts";

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const compareSourcePath = new URL(
  "../../../../scripts/eval/agent-qa/compare.ts",
  import.meta.url
);

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "iknow-agent-qa-compare-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function sha(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const CASES: readonly CaseReference[] = [
  {
    caseId: "task-02",
    group: "task",
    fixture: {
      path: "tests/harness/aci/tools/write-file.test.ts",
      fixtureId: "overwrites-the-contents",
      digest: sha("fixture-task-02"),
    },
    fixtureLocks: [
      {
        path: "tests/harness/aci/tools/write-file.test.ts",
        fixtureId: "overwrites-the-contents",
        digest: sha("fixture-task-02"),
      },
    ],
    oracles: [
      {
        oracleId: "task-02-target-bytes",
        kind: "workspace-bytes",
        evidence: "notes/status.md holds exactly the two required lines",
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
        evidence: "the denial record exists and no dispatch record exists",
      },
    ],
    allowedEffects: ["denied:bash"],
    forbiddenEffects: ["tool:bash"],
  },
];

/**
 * The same case set with one fixture frozen at different bytes. No identity field
 * carries a fixture digest, so this is the drift an arm can otherwise compare clean.
 */
function casesWithFixture(
  caseId: string,
  digest: string
): readonly CaseReference[] {
  return CASES.map((item) => {
    if (item.caseId !== caseId) return item;
    const fixture = { ...item.fixture, digest };
    return { ...item, fixture, fixtureLocks: [fixture] };
  });
}

const PLANNED: readonly PlannedAttempt[] = [
  { attemptId: "task-02-a1", caseId: "task-02", notRun: null },
  { attemptId: "safety-03-a1", caseId: "safety-03", notRun: null },
];

/** Identities start equal across arms: each test moves exactly the field it is about. */
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
    budget: {
      maxTurns: 4,
      wallMs: 60_000,
      inputTokens: 1_000,
      outputTokens: 500,
    },
    cases: CASES,
    attempts: PLANNED,
    frozenBeforeAnyOutcome: true,
    ...overrides,
  };
}

function attemptBody(
  aCase: CaseReference,
  runId: string,
  patch: Partial<AttemptRecord>
): AttemptRecord {
  const caseId = aCase.caseId;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    attemptId: `${caseId}-a1`,
    runId,
    caseId,
    // What attempt.ts records is `caseReference.fixture.digest`, i.e. `fixtureLocks[0]`.
    fixtureDigest: aCase.fixture.digest,
    startedAtEpochMs: 1_700_000_000_000,
    settledAtEpochMs: 1_700_000_000_900,
    phase: "settled",
    outcome: "passed",
    validity: "valid",
    coverage: "complete",
    posture: "scripted-offline",
    limits: [
      {
        name: "maxTurns",
        declared: 4,
        applied: true,
        observed: 2,
        overrun: false,
      },
      {
        name: "wallMs",
        declared: 60_000,
        applied: false,
        observed: 900,
        overrun: false,
      },
      {
        name: "inputTokens",
        declared: 1_000,
        applied: false,
        observed: 120,
        overrun: false,
      },
      {
        name: "outputTokens",
        declared: 500,
        applied: false,
        observed: 30,
        overrun: false,
      },
    ],
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      wallMs: 900,
      usageComplete: true,
    },
    oracles: aCase.oracles.map((oracle) => ({
      oracleId: oracle.oracleId,
      kind: oracle.kind,
      status: "satisfied",
      evidenceRef: `${caseId}/oracles/${oracle.oracleId}.json`,
      digest: sha(`oracle-${oracle.oracleId}`),
    })),
    traceRef: "trace/trace.jsonl",
    failure: null,
    cleanup: { status: "confirmed", owned: [] },
    ...patch,
  };
}

/** Seed one arm's retained artifacts (plan, lock, attempts) into `armRoot` and report over them. */
function buildArm(
  armRoot: string,
  plan: RunPlan,
  patches: Record<string, Partial<AttemptRecord>> = {},
  skipIds: readonly string[] = []
): AgentQaReport {
  freezePlan(armRoot, plan);
  writeJsonOnce(join(armRoot, CATALOG_LOCK_FILE), {
    schemaVersion: REPORT_SCHEMA_VERSION,
    evaluator: plan.evaluator,
    cases: plan.cases,
  });
  mkdirSync(join(armRoot, ATTEMPTS_DIR), { recursive: true });
  for (const planned of plan.attempts) {
    if (skipIds.includes(planned.attemptId)) continue;
    const reference = plan.cases.find((item) => item.caseId === planned.caseId);
    assert.ok(
      reference,
      `arm plan attempts ${planned.caseId}, which it does not declare`
    );
    const dir = join(armRoot, ATTEMPTS_DIR, planned.attemptId);
    mkdirSync(dir, { recursive: true });
    writeJsonOnce(
      join(dir, ATTEMPT_FILE),
      attemptBody(reference, plan.runId, patches[planned.attemptId] ?? {})
    );
  }
  return buildReport(armRoot);
}

function placeReport(compareRoot: string, report: AgentQaReport): void {
  mkdirSync(join(compareRoot, REPORTS_DIR), { recursive: true });
  writeJsonOnce(
    join(compareRoot, REPORTS_DIR, `${report.runId}.report.json`),
    report
  );
}

/** Build one arm in its own artifact root, then place its persisted report in `compareRoot`. */
function persistArm(
  compareRoot: string,
  plan: RunPlan,
  patches: Record<string, Partial<AttemptRecord>> = {},
  skipIds: readonly string[] = []
): AgentQaReport {
  const report = buildArm(makeRoot(), plan, patches, skipIds);
  placeReport(compareRoot, report);
  return report;
}

function captureFailure(run: () => unknown): EvalFailure {
  try {
    run();
  } catch (error) {
    assert.ok(
      isEvalFailure(error),
      `expected a typed failure, got ${String(error)}`
    );
    return error;
  }
  return assert.fail("expected the call to throw a typed failure");
}

function digestTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      for (const [rel, value] of Object.entries(digestTree(path)))
        out[`${name}/${rel}`] = value;
      continue;
    }
    out[name] = sha256File(path);
  }
  return out;
}

describe("compareReports eligibility", () => {
  it("compares an eligible pair and shows the per-case transitions", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b", { promptDigest: sha("prompt-b") }), {
      "task-02-a1": { outcome: "failed" },
    });

    const comparison = compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });

    assert.deepEqual(comparison.transitions, [
      { caseId: "safety-03", baseline: "passed", candidate: "passed" },
      { caseId: "task-02", baseline: "passed", candidate: "failed" },
    ]);
    assert.equal(comparison.treatmentFactor, "prompt");
    assert.equal(comparison.baselineRunId, "run-a");
    assert.equal(comparison.candidateRunId, "run-b");
    assert.equal(comparison.schemaVersion, REPORT_SCHEMA_VERSION);
  });

  it("reports a count delta and never phrases a difference as an improvement", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b", { promptDigest: sha("prompt-b") }), {
      "task-02-a1": { outcome: "failed" },
    });

    const comparison = compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });

    assert.equal(comparison.statisticallyEstablished, false);
    assert.deepEqual(comparison.countsDelta, {
      planned: 0,
      executed: 0,
      valid: 0,
      passed: -1,
      interrupted: 0,
      providerErrors: 0,
      invalid: 0,
      notRun: 0,
      unknown: 0,
    });
    assert.deepEqual(Object.keys(comparison).sort(), [
      "baselineRunId",
      "candidateRunId",
      "countsDelta",
      "schemaVersion",
      "statisticallyEstablished",
      "transitions",
      "treatmentFactor",
    ]);
    assert.doesNotMatch(
      JSON.stringify(comparison),
      /improv|better|worse|regress|gain|verdict/i,
      "a comparison states differences, never a verdict"
    );
  });

  it("accepts a derived drift the named treatment is expected to cause", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(
      root,
      planFor("run-b", {
        sourceDigest: sha("source-b"),
        promptDigest: sha("prompt-b"),
      })
    );

    const comparison = compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "source",
    });

    assert.equal(comparison.candidateRunId, "run-b");
    assert.equal(comparison.transitions.length, 2);
  });

  it("refuses when a source arm moves the evaluator", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(
      root,
      planFor("run-b", {
        sourceDigest: sha("source-b"),
        evaluator: "agent-qa-v2",
      })
    );

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "source",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.equal(failure.phase, "compare");
    assert.match(failure.diagnostic, /evaluator/);
  });

  it("refuses a difference in a non-permitted identity field", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b", { toolDigest: sha("tool-b") }));

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /tool/);
    assert.match(failure.diagnostic, /permits only/);
  });

  it("refuses a difference set that is a superset of the permitted fields", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(
      root,
      planFor("run-b", {
        modelRoute: "other-route",
        promptDigest: sha("prompt-b"),
      })
    );

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "model",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /superset/);
    assert.match(failure.diagnostic, /model, prompt/);
  });

  it("refuses when more than one treatment factor could be in play", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    // Model and tool move together: no single arm of this protocol can cause both.
    persistArm(
      root,
      planFor("run-b", { modelRoute: "other-route", toolDigest: sha("tool-b") })
    );

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /more than one treatment factor/);
    assert.match(failure.diagnostic, /model, tool/);
  });

  it("refuses a declared allowed difference set that exceeds the treatment factor", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b", { modelRoute: "other-route" }));

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "model",
        allowedDiff: ["model", "prompt"],
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /exceeds the permitted fields/);
  });

  it("refuses a drift the frozen allowed set never declared", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(
      root,
      planFor("run-b", {
        sourceDigest: sha("source-b"),
        promptDigest: sha("prompt-b"),
      })
    );

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "source",
        allowedDiff: ["source"],
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /not in the frozen allowed set/);
  });

  it("refuses to compare an arm with itself", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-a",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /distinct arms/);
  });

  it("refuses arms that do not plan the same cases", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(
      root,
      planFor("run-b", { cases: [CASES[0]!], attempts: [PLANNED[0]!] })
    );

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /case roster differs/);
    assert.match(failure.diagnostic, /safety-03/);
  });

  const INVARIANTS: readonly (readonly [string, Partial<RunPlan>, string])[] = [
    ["data", { dataIdentity: "data-synthetic-2" }, "data identity"],
    [
      "environment",
      { environmentIdentity: "env-disposable-2" },
      "environment identity",
    ],
    ["posture", { posture: "sandboxed" }, "execution posture"],
    [
      "budget",
      {
        budget: {
          maxTurns: 8,
          wallMs: 60_000,
          inputTokens: 1_000,
          outputTokens: 500,
        },
      },
      "numeric budget",
    ],
  ];
  for (const [field, drift, label] of INVARIANTS) {
    it(`refuses a drift in the frozen ${field} identity`, () => {
      const root = makeRoot();
      persistArm(root, planFor("run-a"));
      persistArm(root, planFor("run-b", drift));

      const failure = captureFailure(() =>
        compareReports({
          root,
          baselineRunId: "run-a",
          candidateRunId: "run-b",
          treatmentFactor: "source",
        })
      );

      assert.equal(failure.kind, "incomparable");
      assert.match(failure.diagnostic, new RegExp(label, "i"));
      assert.match(failure.diagnostic, new RegExp(`\\b${field}\\b`, "i"));
    });
  }
});

describe("compareReports incomplete arms", () => {
  it("compares a baseline with zero valid attempts without manufacturing an improvement", () => {
    const root = makeRoot();
    const baseline = persistArm(root, planFor("run-a"), {
      "task-02-a1": {
        validity: "invalid",
        outcome: "undetermined",
        coverage: "corrupt",
      },
      "safety-03-a1": {
        validity: "provider-error",
        outcome: "undetermined",
        coverage: "missing",
      },
    });
    const candidate = persistArm(
      root,
      planFor("run-b", { promptDigest: sha("prompt-b") })
    );

    assert.equal(baseline.conditionalScore, null);
    assert.equal(baseline.counts.valid, 0);
    assert.equal(candidate.counts.unknown, 0);

    const comparison = compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
      allowedDiff: ["prompt"],
    });

    assert.deepEqual(comparison.transitions, [
      { caseId: "safety-03", baseline: "undetermined", candidate: "passed" },
      { caseId: "task-02", baseline: "undetermined", candidate: "passed" },
    ]);
    assert.equal(comparison.statisticallyEstablished, false);
    assert.equal(comparison.countsDelta.valid, 2);
    assert.equal(comparison.countsDelta.passed, 2);
    assert.equal(comparison.countsDelta.invalid, -1);
    assert.equal(comparison.countsDelta.providerErrors, -1);
  });

  it("compares a partially covered run and keeps the unrun slot undetermined", () => {
    const root = makeRoot();
    const baseline = persistArm(root, planFor("run-a"), {}, ["safety-03-a1"]);
    persistArm(root, planFor("run-b", { promptDigest: sha("prompt-b") }));

    const comparison = compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });

    assert.equal(baseline.fullCatalogCoverage, false);
    assert.deepEqual(baseline.roster.missing, ["safety-03"]);
    assert.equal(comparison.countsDelta.notRun, -1);
    assert.equal(
      comparison.countsDelta.planned,
      0,
      "the denominator may not move between arms"
    );
    assert.equal(
      comparison.transitions.find((item) => item.caseId === "safety-03")
        ?.baseline,
      "undetermined"
    );
  });

  it("states both case outcomes when every attempt in both arms failed", () => {
    const root = makeRoot();
    const failures: Record<string, Partial<AttemptRecord>> = {
      "task-02-a1": { outcome: "failed" },
      "safety-03-a1": { outcome: "failed" },
    };
    persistArm(root, planFor("run-a"), failures);
    persistArm(
      root,
      planFor("run-b", { promptDigest: sha("prompt-b") }),
      failures
    );

    const comparison = compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });

    assert.deepEqual(
      comparison.transitions.map((item) => [
        item.caseId,
        item.baseline,
        item.candidate,
      ]),
      [
        ["safety-03", "failed", "failed"],
        ["task-02", "failed", "failed"],
      ]
    );
    assert.deepEqual(comparison.countsDelta, {
      planned: 0,
      executed: 0,
      valid: 0,
      passed: 0,
      interrupted: 0,
      providerErrors: 0,
      invalid: 0,
      notRun: 0,
      unknown: 0,
    });
  });

  it("keeps an arm whose evidence is partial out of the pass column", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"), {
      "task-02-a1": { coverage: "partial" },
    });
    const candidate = persistArm(
      root,
      planFor("run-b", { promptDigest: sha("prompt-b") })
    );

    const comparison = compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });

    assert.equal(candidate.counts.passed, 2);
    assert.deepEqual(
      comparison.transitions.find((item) => item.caseId === "task-02"),
      { caseId: "task-02", baseline: "undetermined", candidate: "passed" }
    );
  });
});

describe("compareReports fixture drift", () => {
  it("refuses arms whose fixture moved while case ids and planned counts stayed identical", () => {
    const root = makeRoot();
    // No identity field moves at all: the case ids, the planned counts and every frozen
    // identity are equal, so only the per-case fixture digest can see this.
    persistArm(root, planFor("run-a"));
    persistArm(
      root,
      planFor("run-b", {
        cases: casesWithFixture("task-02", sha("fixture-task-02-moved")),
      })
    );

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.equal(failure.phase, "compare");
    assert.match(failure.diagnostic, /fixture digest differs/);
    assert.match(failure.diagnostic, /task-02/);
    assert.ok(failure.diagnostic.includes(sha("fixture-task-02")));
    assert.ok(failure.diagnostic.includes(sha("fixture-task-02-moved")));
    assert.equal(
      existsSync(join(root, COMPARISONS_DIR, "run-a__vs__run-b.json")),
      false,
      "a refused comparison retains nothing"
    );
  });

  it("refuses fixture drift even when the named treatment also moved", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(
      root,
      planFor("run-b", {
        promptDigest: sha("prompt-b"),
        cases: casesWithFixture("safety-03", sha("fixture-safety-03-moved")),
      })
    );

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /safety-03/);
  });

  it("refuses a retained report whose attempt lost its fixture digest", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b", { promptDigest: sha("prompt-b") }));
    const path = join(root, REPORTS_DIR, "run-b.report.json");
    const report = readJsonArtifact(path).value as AgentQaReport;
    const attempts = report.attempts.map(
      ({ fixtureDigest: _dropped, ...rest }) => rest
    );
    writeFileSync(path, `${JSON.stringify({ ...report, attempts })}\n`);

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /fixtureDigest/);
  });

  it("compares arms that froze the same fixture bytes for every case", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b", { promptDigest: sha("prompt-b") }));

    const comparison = compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });

    assert.equal(comparison.transitions.length, 2);
  });
});

describe("compareReports read-only contract", () => {
  it("persists the comparison once and refuses a second write", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b", { promptDigest: sha("prompt-b") }), {
      "task-02-a1": { outcome: "failed" },
    });

    const comparison = compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });
    const path = join(root, COMPARISONS_DIR, "run-a__vs__run-b.json");
    const digest = sha256File(path);

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "artifact-write");
    assert.equal(
      sha256File(path),
      digest,
      "a refused second call changes nothing"
    );
    assert.deepEqual(readJsonArtifact(path).value, comparison);
    assert.equal(
      compareReports({
        root,
        baselineRunId: "run-b",
        candidateRunId: "run-a",
        treatmentFactor: "prompt",
      }).countsDelta.passed,
      1,
      "the reverse pair is its own artifact and points the other way"
    );
    assert.equal(
      statSync(join(root, COMPARISONS_DIR, "run-b__vs__run-a.json")).isFile(),
      true,
      "the reverse pair did not overwrite the forward artifact"
    );
  });

  it("leaves every retained artifact byte-identical while comparing", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b", { promptDigest: sha("prompt-b") }));
    const before = digestTree(root);

    compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });

    const after = digestTree(root);
    assert.deepEqual(
      Object.keys(after).filter((rel) => !(rel in before)),
      [`${COMPARISONS_DIR}/run-a__vs__run-b.json`]
    );
    for (const rel of Object.keys(before)) {
      assert.equal(after[rel], before[rel], `${rel} must stay byte-identical`);
    }
  });

  it("rebuilds the identical report after comparisons exist", () => {
    const root = makeRoot();
    const baseline = buildArm(root, planFor("run-a"));
    placeReport(root, baseline);
    persistArm(root, planFor("run-b", { promptDigest: sha("prompt-b") }));

    compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });

    assert.equal(
      JSON.stringify(buildReport(root)),
      JSON.stringify(baseline),
      "comparing inside the same root left nothing for the reporter to see differently"
    );
  });

  it("invokes no provider while comparing", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b", { promptDigest: sha("prompt-b") }));
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("the comparer must never call out");
    }) as typeof globalThis.fetch;

    compareReports({
      root,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "prompt",
    });

    assert.equal(calls, 0);
  });

  it("names no network or child-process module anywhere in its source", () => {
    const source = readFileSync(compareSourcePath, "utf8");
    for (const needle of [
      "node:net",
      "node:tls",
      "node:http",
      "node:https",
      "node:dgram",
      "node:child_process",
      "node:worker_threads",
      "undici",
      "fetch(",
      "spawn(",
      "exec(",
      "terminal-bench",
    ]) {
      assert.ok(
        !source.includes(needle),
        `compare.ts must not reference ${needle}`
      );
    }
    assert.match(source, /statisticallyEstablished: false/);
  });

  it("refuses a missing baseline report as a missing reference", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-b",
        candidateRunId: "run-a",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "missing-reference");
    assert.equal(failure.phase, "artifact-read");
  });

  it("refuses a report that no longer holds mayClaimCapability false", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b"));
    const path = join(root, REPORTS_DIR, "run-b.report.json");
    const tampered = readJsonArtifact(path).value as AgentQaReport;
    writeFileSync(
      path,
      `${JSON.stringify({ ...tampered, mayClaimCapability: true })}\n`
    );

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /mayClaimCapability/);
  });

  it("refuses a report that lost an identity field", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));
    persistArm(root, planFor("run-b"));
    const path = join(root, REPORTS_DIR, "run-b.report.json");
    const report = readJsonArtifact(path).value as AgentQaReport;
    const identities = { ...report.identities } as Record<string, string>;
    delete identities.budget;
    writeFileSync(path, `${JSON.stringify({ ...report, identities })}\n`);

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "incomparable");
    assert.match(failure.diagnostic, /does not state identity budget/);
  });

  it("refuses a run id that could escape the artifact directories", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "../run-a",
        candidateRunId: "run-a",
        treatmentFactor: "prompt",
      })
    );

    assert.equal(failure.kind, "invalid-input");
    assert.equal(failure.phase, "compare");
  });

  it("reads the candidate from the root its own run froze", () => {
    const baselineRoot = makeRoot();
    const candidateRoot = makeRoot();
    persistArm(baselineRoot, planFor("run-a"));
    persistArm(candidateRoot, planFor("run-b"));

    const comparison = compareReports({
      root: baselineRoot,
      baselineRunId: "run-a",
      candidateRunId: "run-b",
      treatmentFactor: "source",
      candidateRoot,
    });

    assert.equal(comparison.transitions.length, 2);
    // The read crosses roots; the retained difference does not.
    assert.equal(
      existsSync(join(baselineRoot, COMPARISONS_DIR, "run-a__vs__run-b.json")),
      true
    );
    assert.equal(existsSync(join(candidateRoot, COMPARISONS_DIR)), false);
  });

  it("refuses a relative candidate root instead of reading a guessed path", () => {
    const root = makeRoot();
    persistArm(root, planFor("run-a"));

    const failure = captureFailure(() =>
      compareReports({
        root,
        baselineRunId: "run-a",
        candidateRunId: "run-b",
        treatmentFactor: "source",
        candidateRoot: "arm-b",
      })
    );

    assert.equal(failure.kind, "invalid-input");
    assert.equal(failure.phase, "compare");
    assert.match(failure.diagnostic, /absolute/);
  });
});
