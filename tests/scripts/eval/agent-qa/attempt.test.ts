/**
 * Attempt lifecycle: the headline offline witness. One real production Agent attempt
 * runs offline against a scripted provider in a fresh scratch workspace, its outcome
 * is decided by independent oracles, and a fresh reader reconstructs the same outcome
 * from the retained artifacts. The non-vacuity half is here too: a model that only
 * claims success comes out failed.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { runAttempt } from "../../../../scripts/eval/agent-qa/attempt.ts";
import {
  claimFile,
  readJsonArtifact,
  reserveDir,
  verifyHashIndex,
  writeJsonOnce,
} from "../../../../scripts/eval/agent-qa/artifacts.ts";
import { ArtifactFailure, ClaimFailure } from "../../../../scripts/eval/agent-qa/failures.ts";
import { reconstructAttempt } from "../../../../scripts/eval/agent-qa/retained.ts";
import {
  DISPATCH_FILE,
  HASH_INDEX_FILE,
  INTENT_FILE,
  LIMIT_NAMES,
} from "../../../../scripts/eval/agent-qa/types.ts";
import { validatePlan } from "../../../../scripts/eval/agent-qa/plan.ts";
import type {
  AgentQaCase,
  AttemptRecord,
  CaseReference,
  RunPlan,
} from "../../../../scripts/eval/agent-qa/types.ts";
import { createJsonlTraceReader } from "../../../../src/traceserver/reader.ts";
import { dispatchAttempt } from "../../../../scripts/eval/agent-qa/dispatch.ts";

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-qa-attempt-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const VERIFIED = "status: verified\n";
const DRAFT = "status: draft\n";

function hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/**
 * The locked address this slot cites. `path#fixtureId` is the catalog's own address
 * shape — a repo-relative path plus the printable title of the fixture the file names —
 * and the plan freezes it verbatim, so the digest here is what a stale lock would move.
 */
const WITNESS_FIXTURE = {
  path: "tests/scripts/eval/agent-qa/attempt.test.ts",
  fixtureId: "task-witness fixture",
  digest: hex("task-witness"),
};

const REFERENCE: CaseReference = {
  caseId: "task-witness",
  group: "task",
  fixture: WITNESS_FIXTURE,
  // Every locked fixture the case cites, primary first: the plan validator refuses a
  // case that names only one primary, because the other digests would be unfrozen.
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
  allowedEffects: [
    `bytes:notes.md=${VERIFIED}`,
    "tool:read_file",
    "tool:write_file",
  ],
  forbiddenEffects: ["write:leaked.txt", "tool:bash"],
};

/**
 * The scripted model follows the recipe the production tools actually demand:
 * `write_file` refuses to overwrite a non-empty file that this conversation never
 * read (src/harness/aci/tools/write-file.ts `assertLastRead`), so the witness reads
 * first and the write then lands. A script that skipped the read would be a witness
 * of the gate, not of the task.
 */
function caseOf(overrides: Partial<AgentQaCase> = {}): AgentQaCase {
  return {
    caseId: REFERENCE.caseId,
    group: REFERENCE.group,
    title: "offline mechanism witness",
    locks: [],
    seed: [
      { path: "notes.md", contents: DRAFT },
      { path: "keep.txt", contents: "keep\n" },
    ],
    turns: ["replace the contents of notes.md"],
    scripted: [
      {
        kind: "tool",
        toolCallId: "witness-read-1",
        toolName: "read_file",
        input: { path: "notes.md" },
      },
      {
        kind: "tool",
        toolCallId: "witness-write-1",
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

function planOf(caseReference: CaseReference, attemptId: string): RunPlan {
  return validatePlan({
    schemaVersion: 1,
    runId: `run-${randomUUID().slice(0, 8)}`,
    evaluator: "agent-qa-v1",
    modelRoute: "test-model",
    promptDigest: hex("prompt"),
    toolDigest: hex("tool"),
    sourceDigest: hex("source"),
    dataIdentity: "synthetic-offline",
    environmentIdentity: "scratch-loopback",
    posture: "scripted-offline",
    budget: { maxTurns: 6, wallMs: 30_000, inputTokens: null, outputTokens: null },
    cases: [caseReference],
    attempts: [{ attemptId, caseId: caseReference.caseId }],
    frozenBeforeAnyOutcome: true,
  });
}

describe("runAttempt — one real offline attempt, independently judged", () => {
  it(
    "passes on observed bytes, a recorded effect, and a fresh-reader reconstruction",
    async () => {
      const root = scratch();
      const attemptId = "attempt-witness-1";
      const plan = planOf(REFERENCE, attemptId);

      const record = await runAttempt(root, plan, REFERENCE, caseOf());

      assert.equal(record.outcome, "passed");
      assert.equal(record.validity, "valid");
      assert.equal(record.coverage, "complete");
      assert.equal(record.phase, "settled");
      assert.equal(record.posture, "scripted-offline");
      assert.deepEqual(
        record.oracles.map((row) => row.status),
        ["satisfied", "satisfied", "satisfied"]
      );
      // The declared limits are reported as not-applied because the run finished
      // inside them — applied=true must never be the default.
      const turns = record.limits.find((row) => row.name === "maxTurns");
      assert.equal(turns?.applied, false);
      assert.equal(turns?.observed, 3);
      assert.deepEqual(record.limits.map((row) => row.name), [...LIMIT_NAMES]);
      assert.equal(record.usage.usageComplete, true);
      // The attempt's cost is the sum over the calls its trace retained — three calls at
      // the scripted provider's 11 in each. The last call's reading would have said 11
      // and understated the run by two thirds.
      assert.equal(record.usage.inputTokens, 33);
      assert.equal(record.usage.outputTokens, 21);

      // (a) the workspace really changed, outside every artifact.
      const workspace = join(root, "workspaces", attemptId);
      assert.equal(readFileSync(join(workspace, "notes.md"), "utf8"), VERIFIED);
      assert.equal(readFileSync(join(workspace, "keep.txt"), "utf8"), "keep\n");

      // (b) the production reader finds the run's rows in the retained trace.
      const reader = createJsonlTraceReader({ filePath: record.traceRef as string });
      assert.equal(reader.query({ recordType: "llm_call" }).total, 3);
      assert.equal(reader.query({ recordType: "tool_call" }).total, 2);
      // The tool rows say `ok`: an effect the record claimed but the disk never got
      // would have shown up as an error row here, and as a violated bytes oracle.
      for (const row of reader.query({ recordType: "tool_call" }).records) {
        assert.equal(row["status"], "ok");
      }

      // (c) a fresh reader over the retained artifacts reproduces the same outcome.
      const dir = join(root, "attempts", attemptId);
      verifyHashIndex(dir);
      const rebuilt = reconstructAttempt(root, attemptId);
      assert.deepEqual(rebuilt, record);
      assert.equal(
        readJsonArtifact(join(dir, "attempt.json"), recordDigest(dir)).digest,
        recordDigest(dir)
      );
    },
    90_000
  );

  it(
    "fails a model that only claims success and wrote nothing",
    async () => {
      const root = scratch();
      const attemptId = "attempt-false-success";
      const aCase = caseOf({
        scripted: [
          {
            kind: "text",
            text: "Done — I replaced notes.md with `status: verified` and confirmed it.",
          },
        ],
      });

      const record = await runAttempt(root, planOf(REFERENCE, attemptId), REFERENCE, aCase);

      assert.equal(record.outcome, "failed");
      assert.equal(record.validity, "valid");
      const target = record.oracles.find((row) => row.oracleId === "target-bytes");
      assert.equal(target?.status, "violated");
      // The prose is what the assistant said; the bytes are what happened.
      assert.equal(
        readFileSync(join(root, "workspaces", attemptId, "notes.md"), "utf8"),
        DRAFT
      );
    },
    90_000
  );

  it("refuses a duplicate claim before dispatch and dispatches nothing", async () => {
    const root = scratch();
    const attemptId = "attempt-contended";
    const plan = planOf(REFERENCE, attemptId);
    const first = await runAttempt(root, plan, REFERENCE, caseOf());

    const callsBefore = llmCalls(first.traceRef as string);
    await assert.rejects(
      () => runAttempt(root, plan, REFERENCE, caseOf()),
      (error: unknown) =>
        error instanceof ClaimFailure &&
        (error.kind === "duplicate-claim" || error.kind === "contended-claim") &&
        error.dispatchMayContinue === false
    );
    // Zero further provider invocations, proven from the retained trace rather than
    // from a counter the same code could have incremented.
    assert.equal(llmCalls(first.traceRef as string), callsBefore);
    verifyHashIndex(join(root, "attempts", attemptId));
  });

  it("never overwrites a retained artifact", async () => {
    const root = scratch();
    const attemptId = "attempt-immutable";
    const record = await runAttempt(
      root,
      planOf(REFERENCE, attemptId),
      REFERENCE,
      caseOf()
    );
    const dir = join(root, "attempts", attemptId);
    assert.throws(
      () => writeJsonOnce(join(dir, "attempt.json"), record),
      ArtifactFailure
    );
    assert.throws(
      () => writeJsonOnce(join(dir, DISPATCH_FILE), { rewritten: true }),
      ArtifactFailure
    );
  });

  it("leaves an observable interrupted record when a crash follows the intent", async () => {
    const root = scratch();
    const attemptId = "attempt-crashed";
    const dir = join(root, "attempts", attemptId);
    mkdirSync(join(root, "attempts"), { recursive: true });
    // The crash point is produced with the same production writers the lifecycle uses.
    reserveDir(dir, attemptId);
    claimFile(join(dir, ".claim"), "agent-qa-attempt", attemptId);
    const plan = planOf(REFERENCE, attemptId);
    const partial = {
      schemaVersion: 1,
      attemptId,
      runId: plan.runId,
      caseId: REFERENCE.caseId,
      fixtureDigest: REFERENCE.fixture.digest,
      startedAtEpochMs: Date.now(),
      settledAtEpochMs: null,
      phase: "intent",
      outcome: "undetermined",
      validity: "not-run",
      coverage: "missing",
      posture: "scripted-offline",
      limits: [
        { name: "maxTurns", declared: 6, applied: false, observed: null, overrun: false },
        { name: "wallMs", declared: 30_000, applied: false, observed: null, overrun: false },
        { name: "inputTokens", declared: null, applied: false, observed: null, overrun: false },
        { name: "outputTokens", declared: null, applied: false, observed: null, overrun: false },
      ],
      usage: { inputTokens: null, outputTokens: null, wallMs: null, usageComplete: false },
      oracles: [],
      traceRef: null,
      failure: null,
      cleanup: { status: "not-applicable", owned: [] },
    } satisfies AttemptRecord;
    writeJsonOnce(join(dir, INTENT_FILE), partial);
    writeFileSync(join(dir, "partial-trace-note.txt"), "bytes retained\n", "utf8");

    const rebuilt = reconstructAttempt(root, attemptId);
    assert.equal(rebuilt.phase, "abandoned");
    assert.equal(rebuilt.validity, "interrupted");
    assert.equal(rebuilt.outcome, "undetermined");
    assert.equal(rebuilt.coverage, "partial");
    assert.equal(rebuilt.cleanup.status, "unconfirmed");
    assert.equal(
      readFileSync(join(dir, "partial-trace-note.txt"), "utf8"),
      "bytes retained\n"
    );
    assert.equal(exists(join(dir, "attempt.json")), false);
  });

  it("refuses a settled directory whose record vanished behind its own index", async () => {
    const root = scratch();
    const attemptId = "attempt-tampered";
    const plan = planOf(REFERENCE, attemptId);
    await runAttempt(root, plan, REFERENCE, caseOf());

    // Production writers froze both the manifest and the settlement; only the record the
    // manifest indexes is removed, so the directory now contradicts itself.
    const dir = join(root, "attempts", attemptId);
    const indexedBytes = readFileSync(join(dir, HASH_INDEX_FILE), "utf8");
    rmSync(join(dir, "attempt.json"));

    assert.throws(() => reconstructAttempt(root, attemptId), (error) => {
      const typed = error as ArtifactFailure;
      return (
        typed instanceof ArtifactFailure &&
        typed.kind === "missing-reference" &&
        typed.phase === "artifact-read" &&
        typed.attemptId === attemptId
      );
    });
    // Contradiction is refused, not relabelled as an interruption, and nothing is rewritten.
    assert.equal(readFileSync(join(dir, HASH_INDEX_FILE), "utf8"), indexedBytes);
    assert.equal(exists(join(dir, INTENT_FILE)), true);
  });
});

describe("cancellation preserves evidence and proves the owned server stopped", () => {
  it("aborts at the wall clock, keeps the partial run observable, and confirms teardown", async () => {
    const root = scratch();
    const startedAt = Date.now();
    const dispatched = await dispatchAttempt({
      workspaceRoot: join(root, "workspace"),
      dataDir: join(root, "state"),
      traceDir: join(root, "trace"),
      conversationId: randomUUID(),
      turns: ["a turn the wall clock ends mid-tool"],
      scripted: [
        {
          kind: "tool",
          toolCallId: "cancel-1",
          toolName: "bash",
          // Longer than the declared wall clock, shorter than the test timeout: the
          // abort has to land while this owned child is still alive.
          input: { command: "sleep 6" },
        },
        {
          kind: "tool",
          toolCallId: "cancel-2",
          toolName: "write_file",
          input: { path: "notes.md", content: VERIFIED },
        },
        { kind: "text", text: "never reached" },
      ],
      // Long enough for the first model call and its tool to start even while the suite
      // runs other files on the same machine, short enough that the run can never finish:
      // the abort lands mid-attempt, not before it.
      budget: { maxTurns: 6, wallMs: 3_000, inputTokens: null, outputTokens: null },
    });

    assert.equal(dispatched.stopReason, "cancelled");
    // Non-green by construction: a run the declared limit cut short is not an
    // admissible measurement of the model, whatever the oracles would have said.
    assert.equal(dispatched.validity, "interrupted");
    const wall = dispatched.limits.find((row) => row.name === "wallMs");
    assert.equal(wall?.applied, true);
    assert.equal(wall?.overrun, true);
    // The wall clock is what ended the run, not the turn cap: the cap stayed unapplied.
    assert.equal(
      dispatched.limits.find((row) => row.name === "maxTurns")?.applied,
      false
    );
    // The run really started and the abort really stopped it: one served call, and the
    // second scripted step never reached the provider.
    assert.equal(dispatched.providerRequests, 1);
    assert.equal(dispatched.cleanup.status, "confirmed");
    assert.equal(dispatched.failure, null);
    // Bounded: teardown waited for the owned child (6s sleep) rather than abandoning it,
    // and returned promptly after it settled instead of running the script out.
    assert.equal(Date.now() - startedAt < 12_000, true);
    assert.equal(dispatched.observedWallMs < 12_000, true);
    // Partial evidence retained: the trace the aborted run did write is still readable.
    assert.equal(exists(dispatched.tracePath), true);
    const reader = createJsonlTraceReader({ filePath: dispatched.tracePath });
    assert.equal(reader.query({ recordType: "llm_call" }).total, 1);
    assert.equal(reader.query({ recordType: "tool_call" }).total, 1);
    assert.equal(
      exists(join(root, "workspace", "notes.md")),
      false,
      "an aborted dispatch must not leave a half-applied effect"
    );
  }, 60_000);
});

function recordDigest(dir: string): string {
  return readJsonArtifact(join(dir, "attempt.json")).digest;
}

function llmCalls(tracePath: string): number {
  return createJsonlTraceReader({ filePath: tracePath }).query({
    recordType: "llm_call",
  }).total;
}

function exists(path: string): boolean {
  try {
    statSync(path);
  } catch {
    return false;
  }
  return true;
}
