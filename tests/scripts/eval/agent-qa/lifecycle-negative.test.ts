/**
 * Negative witnesses for the offline attempt lifecycle: who wins a race for one
 * attemptId, what each of the three read faults on a retained run root is called, and
 * that reporting and comparing never touch the provider boundary.
 *
 * Everything here is the real thing — real filesystem, real production trace writer and
 * reader, real engine dispatch against a real loopback HTTP server. The damage is done
 * through plain `writeFileSync` on purpose: the fault under witness is a reader facing
 * bytes it did not write, so no helper from the module under test may pre-shape them.
 */
import { reconstructAttempt } from "../../../../scripts/eval/agent-qa/retained.ts";
import { DISPATCH_FILE } from "../../../../scripts/eval/agent-qa/types.ts";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";

import { runAttempt, verifyTraceReconstruction } from "../../../../scripts/eval/agent-qa/attempt.ts";
import {
  readJsonArtifact,
  sha256File,
  verifyHashIndex,
  writeJsonOnce,
} from "../../../../scripts/eval/agent-qa/artifacts.ts";
import { compareReports } from "../../../../scripts/eval/agent-qa/compare.ts";
import { isEvalFailure, type EvalFailure } from "../../../../scripts/eval/agent-qa/failures.ts";
import { freezePlan, validatePlan } from "../../../../scripts/eval/agent-qa/plan.ts";
import { startScriptedProvider, type ScriptedProvider } from "../../../../scripts/eval/agent-qa/provider.ts";
import { buildReport, persistReport } from "../../../../scripts/eval/agent-qa/report.ts";
import { createJsonlTraceReader } from "../../../../src/traceserver/reader.ts";
import {
  ATTEMPT_FILE,
  ATTEMPTS_DIR,
  CATALOG_LOCK_FILE,
  CLAIM_FILE,
  COMPARISONS_DIR,
  HASH_INDEX_FILE,
  OUTCOME_FILE,
  REPORT_SCHEMA_VERSION,
  REPORTS_DIR,
  RUN_PLAN_FILE,
  TRACE_DIR,
  type AgentQaCase,
  type AgentQaReport,
  type AttemptRecord,
  type CaseReference,
  type RunPlan,
} from "../../../../scripts/eval/agent-qa/types.ts";

const perTestRoots: string[] = [];
const sharedRoots: string[] = [];

function scratch(prefix: string, shared = false): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  (shared ? sharedRoots : perTestRoots).push(root);
  return root;
}

afterEach(() => {
  for (const root of perTestRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  for (const root of sharedRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const VERIFIED = "status: verified\n";
const DRAFT = "status: draft\n";
const HOLDER = "agent-qa-attempt";

function hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

const WITNESS_FIXTURE = {
  path: "tests/scripts/eval/agent-qa/lifecycle-negative.test.ts",
  fixtureId: "lifecycle-negative witness fixture",
  digest: hex("lifecycle-negative-witness"),
};

const REFERENCE: CaseReference = {
  caseId: "lifecycle-negative",
  group: "task",
  fixture: WITNESS_FIXTURE,
  fixtureLocks: [WITNESS_FIXTURE],
  oracles: [
    {
      oracleId: "target-bytes",
      kind: "workspace-bytes",
      evidence: "notes.md holds exactly the verified line",
    },
    {
      oracleId: "scope-bytes",
      kind: "workspace-bytes",
      evidence: "every other seeded file is byte-identical",
    },
    {
      oracleId: "attempted-write",
      kind: "effect-record",
      evidence: "read_file and write_file were both attempted and recorded",
    },
  ],
  allowedEffects: [`bytes:notes.md=${VERIFIED}`, "tool:read_file", "tool:write_file"],
  forbiddenEffects: ["write:leaked.txt", "tool:bash"],
};

/**
 * The recipe production tools demand: `write_file` refuses a non-empty file this
 * conversation never read, so the script reads first. A script that skipped the read
 * would witness the gate, not the lifecycle.
 */
function caseOf(overrides: Partial<AgentQaCase> = {}): AgentQaCase {
  return {
    caseId: REFERENCE.caseId,
    group: REFERENCE.group,
    title: "lifecycle negative witness",
    locks: [],
    seed: [
      { path: "notes.md", contents: DRAFT },
      { path: "keep.txt", contents: "keep\n" },
    ],
    turns: ["replace the contents of notes.md"],
    scripted: [
      {
        kind: "tool",
        toolCallId: "negative-read-1",
        toolName: "read_file",
        input: { path: "notes.md" },
      },
      {
        kind: "tool",
        toolCallId: "negative-write-1",
        toolName: "write_file",
        input: { path: "notes.md", content: VERIFIED },
      },
      { kind: "text", text: "rewrote notes.md" },
    ],
    allowedEffects: REFERENCE.allowedEffects,
    forbiddenEffects: REFERENCE.forbiddenEffects,
    oracles: REFERENCE.oracles,
    ...overrides,
  };
}

/**
 * A frozen plan and catalog lock, so the retained root is reportable. A `shared` root
 * outlives the per-test sweep, because later witnesses damage their own copy of it.
 */
function frozenRoot(
  attemptId: string,
  opts: { readonly modelRoute?: string; readonly shared?: boolean } = {}
): { root: string; plan: RunPlan } {
  const root = scratch("agent-qa-lifecycle-", opts.shared ?? false);
  const plan = validatePlan({
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: `run-${randomUUID().slice(0, 8)}`,
    evaluator: "agent-qa-v1",
    modelRoute: opts.modelRoute ?? "test-model",
    promptDigest: hex("prompt"),
    toolDigest: hex("tool"),
    sourceDigest: hex("source"),
    dataIdentity: "synthetic-offline",
    environmentIdentity: "scratch-loopback",
    posture: "scripted-offline",
    budget: { maxTurns: 6, wallMs: 30_000, inputTokens: null, outputTokens: null },
    cases: [REFERENCE],
    attempts: [{ attemptId, caseId: REFERENCE.caseId }],
    frozenBeforeAnyOutcome: true,
  });
  freezePlan(root, plan);
  writeJsonOnce(join(root, CATALOG_LOCK_FILE), {
    schemaVersion: REPORT_SCHEMA_VERSION,
    evaluator: plan.evaluator,
    cases: plan.cases,
  });
  mkdirSync(join(root, ATTEMPTS_DIR), { recursive: true });
  return { root, plan };
}

function attemptDirOf(root: string, attemptId: string): string {
  return join(root, ATTEMPTS_DIR, attemptId);
}

/** The one retained trace file; more than one would prove a second dispatch. */
function traceOf(root: string, attemptId: string): string {
  const dir = join(attemptDirOf(root, attemptId), TRACE_DIR);
  const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(names.length, 1, `${dir} retains ${names.length} trace file(s)`);
  return join(dir, names[0] as string);
}

function rowsOf(path: string, recordType: "tool_call" | "llm_call" | "turn") {
  return createJsonlTraceReader({ filePath: path }).query({ recordType, limit: 200 });
}

function providerRequestsOf(root: string, attemptId: string): number {
  const dispatched = readJsonArtifact(
    join(attemptDirOf(root, attemptId), DISPATCH_FILE)
  ).value as { providerRequests: number };
  return dispatched.providerRequests;
}

function copyRoot(root: string, prefix: string): string {
  const parent = scratch(prefix);
  const dst = join(parent, "run");
  cpSync(root, dst, { recursive: true });
  return dst;
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

function toEvalFailure(reason: unknown): EvalFailure {
  assert.ok(isEvalFailure(reason), `expected a typed failure, got ${String(reason)}`);
  return reason;
}

function digestTree(root: string, base = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const rel = base === "" ? name : `${base}/${name}`;
    if (statSync(path).isDirectory()) {
      for (const [nested, value] of Object.entries(digestTree(path, rel))) out[nested] = value;
      continue;
    }
    out[rel] = sha256File(path);
  }
  return out;
}

describe("two same-tick runAttempt calls on one attemptId", () => {
  it(
    "lets exactly one settle and refuses the other as a contended claim that dispatched nothing",
    async () => {
      const attemptId = "attempt-same-tick";
      const { root, plan } = frozenRoot(attemptId);
      const aCase = caseOf();

      const raced = await Promise.allSettled([
        runAttempt(root, plan, REFERENCE, aCase),
        runAttempt(root, plan, REFERENCE, aCase),
      ]);
      const won = raced.filter((out): out is PromiseFulfilledResult<AttemptRecord> => out.status === "fulfilled");
      const lost = raced.filter((out): out is PromiseRejectedResult => out.status === "rejected");

      assert.equal(won.length, 1, "exactly one caller may retain a record");
      assert.equal(lost.length, 1);
      assert.equal(won[0].value.outcome, "passed");
      assert.equal(won[0].value.phase, "settled");

      const refusal = toEvalFailure(lost[0].reason);
      assert.equal(refusal.kind, "contended-claim");
      // Reservation precedes claiming, so one attemptId can only ever collide as `contended`:
      // `duplicate-claim` is claimFile's fact, and attempt.test.ts accepts either name.
      assert.notEqual(refusal.kind, "duplicate-claim", "a reservation collision is not a claim collision");
      assert.equal(refusal.phase, "claim");
      assert.equal(refusal.attemptId, attemptId);
      assert.equal(refusal.dispatchMayContinue, false);

      assertStatementsForNoSecondDispatch(root, attemptId, aCase);
      const report = buildReport(root);
      assert.equal(report.counts.planned, 1);
      assert.equal(report.counts.passed, 1);
      assert.equal(report.counts.notRun, 0, "the loser widened no denominator");
    },
    90_000
  );
});

/**
 * Zero loser dispatch, read off the boundary and the retained bytes: the scripted
 * provider's own request counter, one trace file, one run's worth of rows, and nothing
 * extra in the attempt directory the index did not freeze.
 */
function assertStatementsForNoSecondDispatch(
  root: string,
  attemptId: string,
  aCase: AgentQaCase
): void {
  const dir = attemptDirOf(root, attemptId);
  assert.equal(readdirSync(join(root, ATTEMPTS_DIR)).length, 1);
  assert.equal(readFileSync(join(dir, CLAIM_FILE), "utf8"), `${HOLDER}\n`);
  assert.equal(providerRequestsOf(root, attemptId), aCase.scripted.length);
  assert.equal(rowsOf(traceOf(root, attemptId), "llm_call").total, aCase.scripted.length);
  assert.equal(rowsOf(traceOf(root, attemptId), "tool_call").total, 2);
  verifyHashIndex(dir);
}

type Retained = {
  readonly root: string;
  readonly attemptId: string;
  readonly record: AttemptRecord;
};

let retained: Retained;

beforeAll(async () => {
  const attemptId = "attempt-retained";
  const { root, plan } = frozenRoot(attemptId, { shared: true });
  retained = { root, attemptId, record: await runAttempt(root, plan, REFERENCE, caseOf()) };
}, 90_000);

/** A trace with no terminated record left: the row reader is the one that refuses it. */
async function witnessTornTraceHead(): Promise<void> {
  const damaged = copyRoot(retained.root, "agent-qa-torn-");
  const path = traceOf(damaged, retained.attemptId);
  const body = readFileSync(path, "utf8");
  writeFileSync(path, body.slice(0, body.indexOf("\n") - 8), "utf8");

  const query = rowsOf(path, "tool_call");
  assert.equal(statSync(path).size > 0, true, "the torn bytes are still there to reach");
  assert.equal(query.offset, 0, "the reader consumed the head and found no line terminator");
  assert.equal(query.total, 0);

  const refusal = captureFailure(() => verifyTraceReconstruction(retained.record, path));
  assert.equal(refusal.kind, "artifact-corrupt");
  assert.match(refusal.diagnostic, /holds no reconstructable rows/);
  assert.doesNotMatch(refusal.diagnostic, /digest/, "the row reader refused before any digest");
  // The run itself is not in question: the provider served every declared step.
  assert.equal(providerRequestsOf(damaged, retained.attemptId), caseOf().scripted.length);
  assert.equal(captureFailure(() => buildReport(damaged)).kind, "artifact-corrupt");
  assert.equal(existsSync(join(damaged, REPORTS_DIR)), false);
}

/** The row reader cannot tell absence from emptiness, so only the frozen index can refuse this. */
async function witnessVanishedTrace(): Promise<void> {
  const damaged = copyRoot(retained.root, "agent-qa-vanished-");
  const path = traceOf(damaged, retained.attemptId);
  unlinkSync(path);

  assert.equal(rowsOf(path, "tool_call").total, 0);
  const refusal = captureFailure(() => reconstructAttempt(damaged, retained.attemptId));
  assert.equal(refusal.kind, "missing-reference");
  assert.notEqual(refusal.kind, "artifact-corrupt", "nothing here is not the same fact as broken bytes");
  assert.match(refusal.diagnostic, /trace\/.*\.jsonl is indexed but absent/);
  assert.equal(captureFailure(() => buildReport(damaged)).kind, "missing-reference");
  assert.equal(existsSync(join(damaged, REPORTS_DIR)), false);
}

/** One torn record among intact neighbours: counted as skipped, caught by the digest. */
async function witnessTornTraceInterior(): Promise<void> {
  const damaged = copyRoot(retained.root, "agent-qa-interior-");
  const path = traceOf(damaged, retained.attemptId);
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
  const middle = lines.length - 3;
  writeFileSync(
    path,
    `${lines.map((line, index) => (index === middle ? line.slice(0, 30) : line)).join("\n")}\n`,
    "utf8"
  );

  const query = rowsOf(path, "llm_call");
  assert.equal(query.skippedLines, 1, "the reader parsed the damaged record and lost it");
  const refusal = captureFailure(() => reconstructAttempt(damaged, retained.attemptId));
  assert.equal(refusal.kind, "artifact-corrupt");
  assert.match(refusal.diagnostic, /trace\/.*\.jsonl digest does not match the index/);
  assert.equal(captureFailure(() => buildReport(damaged)).kind, "artifact-corrupt");
}

/** Well-formed wrong bytes: only the digest can see it, because every reader parses it happily. */
async function witnessSubstitutedArtifact(): Promise<void> {
  const damaged = copyRoot(retained.root, "agent-qa-substituted-");
  const path = join(attemptDirOf(damaged, retained.attemptId), OUTCOME_FILE);
  const before = sha256File(path);
  writeFileSync(path, `${JSON.stringify({ outcome: "passed", oracles: [] })}\n`, "utf8");

  assert.notEqual(sha256File(path), before);
  assert.deepEqual(readJsonArtifact(path).value, { outcome: "passed", oracles: [] });

  const refusal = captureFailure(() => reconstructAttempt(damaged, retained.attemptId));
  assert.equal(refusal.kind, "artifact-corrupt");
  assert.match(refusal.diagnostic, /outcome\.json digest does not match the index/);
  assert.equal(captureFailure(() => buildReport(damaged)).kind, "artifact-corrupt");
  assert.equal(existsSync(join(damaged, REPORTS_DIR)), false);
}

/** The reference moved, not the bytes: every index entry still verifies, and the report still refuses. */
async function witnessStaleFixtureReference(): Promise<void> {
  const stale = copyRoot(retained.root, "agent-qa-stale-");
  const dir = attemptDirOf(stale, retained.attemptId);
  const recordDigest = sha256File(join(dir, ATTEMPT_FILE));
  movePlanFixtureDigest(stale, hex("reference-moved-past-the-lock"));

  verifyHashIndex(dir);
  assert.equal(sha256File(join(dir, ATTEMPT_FILE)), recordDigest, "no artifact byte moved");
  assert.equal(reconstructAttempt(stale, retained.attemptId).outcome, "passed");

  const refusal = captureFailure(() => buildReport(stale));
  assert.equal(refusal.kind, "stale-digest");
  assert.notEqual(refusal.kind, "artifact-corrupt");
  assert.match(refusal.diagnostic, /not the digest the catalog lock froze/);
  assert.equal(existsSync(join(stale, REPORTS_DIR)), false);
}

/** A manifest that lies about intact bytes: the same verdict as a substitution, never a stale read. */
async function witnessStaleIndexEntry(): Promise<void> {
  const damaged = copyRoot(retained.root, "agent-qa-stale-index-");
  const dir = attemptDirOf(damaged, retained.attemptId);
  const indexPath = join(dir, HASH_INDEX_FILE);
  const recordDigest = sha256File(join(dir, ATTEMPT_FILE));
  const entries = (readJsonArtifact(indexPath).value as { entries: Record<string, string> }).entries;
  entries[ATTEMPT_FILE] = hex("entry-pointing-elsewhere");
  writeFileSync(indexPath, `${JSON.stringify({ indexVersion: 1, entries })}\n`, "utf8");

  assert.equal(sha256File(join(dir, ATTEMPT_FILE)), recordDigest, "the artifact is intact");
  const refusal = captureFailure(() => reconstructAttempt(damaged, retained.attemptId));
  assert.equal(refusal.kind, "artifact-corrupt");
  assert.notEqual(refusal.kind, "stale-digest");
  assert.match(refusal.diagnostic, /attempt\.json digest does not match the index/);
  assert.equal(captureFailure(() => buildReport(damaged)).kind, "artifact-corrupt");
}

describe("truncated, corrupt and stale are three different facts", () => {
  it("refuses a trace torn mid-record at the row reader, naming no digest", witnessTornTraceHead, 60_000);
  it("reads a vanished trace as an absent reference, which a torn trace is not", witnessVanishedTrace, 60_000);
  it("counts a torn interior record as skipped, so the refusal still reaches the damage", witnessTornTraceInterior, 60_000);
  it("refuses a substituted artifact by digest alone, because its bytes still parse", witnessSubstitutedArtifact, 60_000);
  it("refuses a stale digest reference while every retained digest still verifies", witnessStaleFixtureReference, 60_000);
  it("reads a stale index entry as corrupt, the same verdict as a substituted artifact", witnessStaleIndexEntry, 60_000);
});

/** Both digest slots of the planned case move together, so the plan stays well-formed. */
function movePlanFixtureDigest(root: string, digest: string): void {
  const path = join(root, RUN_PLAN_FILE);
  const stored = readJsonArtifact(path).value as {
    cases: { fixture: { digest: string }; fixtureLocks: { digest: string }[] }[];
  };
  const planned = stored.cases[0];
  if (planned === undefined) throw new Error("the retained plan froze no case");
  planned.fixture.digest = digest;
  (planned.fixtureLocks[0] as { digest: string }).digest = digest;
  writeFileSync(path, `${JSON.stringify(stored)}\n`, "utf8");
}

const REPORT_SOURCE = new URL("../../../../scripts/eval/agent-qa/report.ts", import.meta.url);
const COMPARE_SOURCE = new URL("../../../../scripts/eval/agent-qa/compare.ts", import.meta.url);
const RETAINED_SOURCE = new URL(
  "../../../../scripts/eval/agent-qa/retained.ts",
  import.meta.url
);

/** Every name that would let a module reach the provider boundary, as it is written at the seam. */
const DISPATCH_NEEDLES: readonly string[] = [
  "./dispatch.ts",
  "./provider.ts",
  "./attempt.ts",
  "dispatchAttempt(",
  "startScriptedProvider(",
  "runAttempt(",
  "evaluateOracle(",
];

/** Structural proof: a reader that holds no seam cannot open one. */
function witnessNoDispatchSeamInSource(): void {
  for (const [source, label] of [
    [REPORT_SOURCE, "report.ts"],
    [COMPARE_SOURCE, "compare.ts"],
    [RETAINED_SOURCE, "retained.ts"],
  ] as const) {
    const text = readFileSync(source, "utf8");
    for (const needle of DISPATCH_NEEDLES) {
      assert.ok(!text.includes(needle), `${label} must not reference ${needle}`);
    }
  }
}

const PACKAGE_SOURCE = new URL(
  "../../../../scripts/eval/agent-qa/",
  import.meta.url
);

/**
 * A bare `mkdirSync` throws an errno, and an errno that reaches the dispatch classifier
 * gets an attribution it never earned. Only the typed helper may call mkdir.
 */
function witnessMkdirIsOwnedByArtifactsSource(): void {
  const sources = readdirSync(PACKAGE_SOURCE).filter(
    (name) => name.endsWith(".ts") && name !== "artifacts.ts"
  );
  assert.equal(sources.length > 0, true, "the package source directory was not found");
  for (const name of sources) {
    const text = readFileSync(new URL(name, PACKAGE_SOURCE), "utf8");
    assert.ok(
      !text.includes("mkdirSync"),
      `${name} creates a directory without the typed helper`
    );
  }
  assert.equal(
    readFileSync(new URL("artifacts.ts", PACKAGE_SOURCE), "utf8").includes(
      "export function makeDir"
    ),
    true,
    "artifacts.ts no longer owns directory creation"
  );
}

/** One real arm: a real dispatch, a real report, a persisted report artifact. */
async function arm(modelRoute: string): Promise<{ root: string; report: AgentQaReport }> {
  const attemptId = `attempt-${modelRoute}`;
  const { root, plan } = frozenRoot(attemptId, { modelRoute });
  await runAttempt(root, plan, REFERENCE, caseOf());
  const report = buildReport(root);
  persistReport(root, report);
  return { root, report };
}

function comparisonRootFor(arms: readonly { root: string; report: AgentQaReport }[]): string {
  const root = scratch("agent-qa-comparison-");
  mkdirSync(join(root, REPORTS_DIR));
  for (const one of arms) {
    const name = `${one.report.runId}.report.json`;
    cpSync(join(one.root, REPORTS_DIR, name), join(root, REPORTS_DIR, name));
  }
  return root;
}

const SENTINEL = "the step nothing was allowed to consume";

/**
 * One real POST at the seam, run last: a zero counter before it means reporting and
 * comparing dispatched nothing, not that a listener was unreachable.
 */
async function probeTheSeam(provider: ScriptedProvider): Promise<number> {
  const response = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "route-a", messages: [{ role: "user", content: "probe" }] }),
  });
  assert.equal(response.status, 200, "the sentinel step was still there to serve");
  return provider.requestCount;
}

/** Observational proof, on two arms that really dispatched: nothing re-ran, nothing moved. */
async function witnessReadersServeNoRequest(): Promise<void> {
  const baseline = await arm("route-a");
  const candidate = await arm("route-b");
  const comparisonRoot = comparisonRootFor([baseline, candidate]);
  const provider = await startScriptedProvider([{ kind: "text", text: SENTINEL }]);
  const before = {
    baseline: digestTree(baseline.root),
    candidate: digestTree(candidate.root),
  };
  try {
    const first = buildReport(baseline.root);
    assert.deepEqual(buildReport(baseline.root), first, "a second report reads the same retained bytes");
    assert.deepEqual(buildReport(candidate.root), candidate.report);

    const input = {
      root: comparisonRoot,
      baselineRunId: first.runId,
      candidateRunId: candidate.report.runId,
      treatmentFactor: "model",
    } as const;
    const comparison = compareReports(input);
    assert.deepEqual(comparison.transitions, [
      { caseId: REFERENCE.caseId, baseline: "passed", candidate: "passed" },
    ]);
    assert.equal(comparison.statisticallyEstablished, false);
    assert.equal(comparison.countsDelta.passed, 0);
    assert.deepEqual(digestTree(baseline.root), before.baseline);
    assert.deepEqual(digestTree(candidate.root), before.candidate);

    const retainedPath = join(
      comparisonRoot,
      COMPARISONS_DIR,
      `${first.runId}__vs__${candidate.report.runId}.json`
    );
    assert.deepEqual(readJsonArtifact(retainedPath).value, comparison);
    assert.equal(captureFailure(() => compareReports(input)).kind, "artifact-write");
    assert.deepEqual(readJsonArtifact(retainedPath).value, comparison, "a refused second call rewrote nothing");

    assert.equal(provider.requestCount, 0, "neither reader reached the boundary");
    assert.equal(await probeTheSeam(provider), 1, "that same counter does move for a real request");
  } finally {
    await provider.stop();
  }
}

describe("reporting and comparing never redispatch", () => {
  it("holds no dispatch seam in either module's own source", witnessNoDispatchSeamInSource);
  it(
    "serves no provider request and repeats byte-identically while reporting and comparing",
    witnessReadersServeNoRequest,
    90_000
  );
});

describe("a directory fault is typed where it is created", () => {
  it("leaves mkdir to the one helper that names its failure", witnessMkdirIsOwnedByArtifactsSource);
});
