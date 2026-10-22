/**
 * The four `turn` slots, run end to end through the real production engine and
 * decided by their own oracles.
 *
 * Every slot here is a multi-turn run of one loop: the later operator turn arrives
 * through the production continuation seam, so the verdict must come from the state
 * the later turn leaves on disk and in the record. Each slot therefore gets two
 * witnesses — the run itself, and one falsification where the later turn does the
 * opposite thing and the same frozen oracle declaration must call it a violation.
 *
 * Only the provider is faked. The engine, the tools, the session ledger, the trace
 * writer and the filesystem are the production ones, and the retained run root is
 * re-read through `buildReport`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it } from "vitest";

import { runAttempt } from "../../../../scripts/eval/agent-qa/attempt.ts";
import { loadCases } from "../../../../scripts/eval/agent-qa/catalog.ts";
import type { DispatchResult } from "../../../../scripts/eval/agent-qa/dispatch.ts";
import { buildReport } from "../../../../scripts/eval/agent-qa/report.ts";
import { freezeRunRoot, runSuiteOffline } from "../../../../scripts/eval/agent-qa/suite.ts";
import type { CaseRun, SuiteResult } from "../../../../scripts/eval/agent-qa/suite.ts";
import type {
  AgentQaCase,
  AttemptRecord,
  CaseId,
  CaseReference,
} from "../../../../scripts/eval/agent-qa/types.ts";
import { createJsonlTraceReader } from "../../../../src/traceserver/reader.ts";

const REPO_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../../../.."));
const TURN_IDS: readonly CaseId[] = ["turn-01", "turn-02", "turn-03", "turn-04"];
const LEDGER_REL = (conversationId: string): string =>
  join(".session", conversationId, "todos.md");
const SECRET = "sk-SYNTHETIC-iknow-agent-qa-0000000000";

const scratchRoots: string[] = [];
const shared: { group: SuiteResult | null } = { group: null };

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-qa-turn-"));
  scratchRoots.push(root);
  return root;
}

/** One frozen root, one dispatch of all four slots; every other test reads its bytes. */
async function groupRun(): Promise<SuiteResult> {
  if (shared.group === null) {
    shared.group = await runSuiteOffline({
      root: mkdtempSync(join(tmpdir(), "agent-qa-turn-group-")),
      repoRoot: REPO_ROOT,
      caseIds: TURN_IDS,
    });
  }
  return shared.group;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (shared.group !== null) {
    rmSync(shared.group.root, { recursive: true, force: true });
  }
});

function registryCase(caseId: CaseId): AgentQaCase {
  const found = loadCases().find((item) => item.caseId === caseId);
  if (found === undefined) throw new Error(`the catalog registry holds no ${caseId}`);
  return found;
}

function runOf(result: SuiteResult, caseId: CaseId): CaseRun {
  const found = result.runs.find((item) => item.caseId === caseId);
  if (found === undefined) throw new Error(`the suite returned no entry for ${caseId}`);
  return found;
}

function settledRecord(result: SuiteResult, caseId: CaseId): AttemptRecord {
  const run = runOf(result, caseId);
  assert.equal(run.failure, null, `${caseId} faulted: ${JSON.stringify(run.failure)}`);
  if (run.record === null) throw new Error(`${caseId} settled with no retained record`);
  return run.record;
}

function retainedDispatch(result: SuiteResult, caseId: CaseId): DispatchResult {
  const dir = join(result.root, "attempts", runOf(result, caseId).attemptId);
  return JSON.parse(readFileSync(join(dir, "dispatch.json"), "utf8")) as DispatchResult;
}

function workspaceOf(result: SuiteResult, caseId: CaseId): string {
  return join(result.root, "workspaces", runOf(result, caseId).attemptId);
}

function statusesOf(record: AttemptRecord): [string, string][] {
  return record.oracles.map((row) => [row.oracleId, row.status] as [string, string]);
}

function statusOf(record: AttemptRecord, oracleId: string): string {
  const found = record.oracles.find((row) => row.oracleId === oracleId);
  if (found === undefined) throw new Error(`${record.caseId} retains no oracle ${oracleId}`);
  return found.status;
}

/** The bytes the case itself declares for one path, read out of its effect list. */
function declaredBytes(aCase: AgentQaCase, needle: string): string {
  const prefix = "bytes:";
  const found = aCase.allowedEffects.find(
    (entry) => entry.startsWith(prefix) && entry.slice(prefix.length).includes(needle)
  );
  if (found === undefined) throw new Error(`${aCase.caseId} declares no bytes for ${needle}`);
  const pair = found.slice(prefix.length);
  const split = pair.indexOf("=");
  return split === -1 ? "" : pair.slice(split + 1);
}

function seedBytes(aCase: AgentQaCase, path: string): string {
  const found = aCase.seed.find((entry) => entry.path === path && entry.mode !== "mkdir");
  if (found === undefined) throw new Error(`${aCase.caseId} seeds no file at ${path}`);
  return found.contents;
}

function readWorkspace(result: SuiteResult, caseId: CaseId, rel: string): string {
  return readFileSync(join(workspaceOf(result, caseId), rel), "utf8");
}

/** The frozen slot re-run with one half of its trajectory changed, in its own root. */
async function witness(
  caseId: CaseId,
  change: Pick<AgentQaCase, "scripted">
): Promise<AttemptRecord> {
  const root = scratch();
  const frozen = freezeRunRoot(root, REPO_ROOT);
  const reference = frozen.lock.cases.find(
    (item: CaseReference) => item.caseId === caseId
  ) as CaseReference;
  return await runAttempt(root, frozen.plan, reference, {
    ...registryCase(caseId),
    ...change,
  });
}

function toolRowCount(record: AttemptRecord, conversationId: string): number {
  if (record.traceRef === null) throw new Error(`${record.caseId} settled without a trace`);
  return createJsonlTraceReader({ filePath: record.traceRef }).query({
    conversationId,
    recordType: "tool_call",
    limit: 50,
  }).total;
}

describe("the turn group — four slots on the real engine", () => {
  it("executes all four slots in one offline run and passes each on its own oracles", async () => {
    const result = await groupRun();
    assert.deepEqual(result.runs.map((run) => run.caseId), [...TURN_IDS]);

    for (const caseId of TURN_IDS) {
      const record = settledRecord(result, caseId);
      assert.equal(record.phase, "settled", caseId);
      assert.equal(record.outcome, "passed", `${caseId}: ${JSON.stringify(record.oracles)}`);
      assert.equal(record.validity, "valid", caseId);
      assert.equal(record.coverage, "complete", caseId);
      assert.equal(record.posture, "scripted-offline", caseId);
      assert.equal(record.failure, null, caseId);
      assert.equal(record.cleanup.status, "confirmed", caseId);
      assert.equal(record.usage.usageComplete, true, caseId);
      assert.equal(
        record.limits.find((row) => row.name === "maxTurns")?.overrun,
        false,
        `${caseId} outran the declared turn cap`
      );
      // The whole declared trajectory reached the provider, read off the retained dispatch.
      const dispatched = retainedDispatch(result, caseId);
      assert.equal(dispatched.stopReason, "completed", caseId);
      assert.equal(dispatched.providerRequests, registryCase(caseId).scripted.length, caseId);
      assert.equal(record.oracles.length >= 2, true, `${caseId} is decided by too little`);
      for (const [oracleId, status] of statusesOf(record)) {
        assert.equal(status, "satisfied", `${caseId}/${oracleId}`);
      }
    }

    const report = buildReport(result.root);
    assert.equal(report.counts.planned, 20);
    assert.equal(report.counts.executed, 4);
    assert.equal(report.counts.passed, 4);
    assert.equal(report.conditionalScore, 1);
    assert.deepEqual(report.roster.executed, [...TURN_IDS]);
    assert.equal(report.mayClaimCapability, false);
  }, 180_000);

  it("turn-01: the pivot's ledger and note are what the retained files say", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "turn-01");
    const aCase = registryCase("turn-01");
    const ledger = readWorkspace(result, "turn-01", LEDGER_REL(retainedDispatch(result, "turn-01").conversationId));

    assert.deepEqual(statusesOf(record), [
      ["turn-01-pivot-state", "satisfied"],
      ["turn-01-cancelled-direction-untouched", "satisfied"],
      ["turn-01-pivot-dispatches", "satisfied"],
    ]);
    assert.equal(ledger, declaredBytes(aCase, "todos.md"));
    assert.equal(ledger.includes("token rotation"), false, "a stale subject survived the pivot");
    assert.equal(ledger.includes("session pad"), false, "a stale subject survived the pivot");
    assert.equal(readWorkspace(result, "turn-01", "notes/status.md"), "direction: notes-rewrite\n");
    assert.equal(
      readWorkspace(result, "turn-01", "notes/auth-migration-notes.md"),
      seedBytes(aCase, "notes/auth-migration-notes.md")
    );
  }, 180_000);

  it("turn-02: the second turn's file carries the placeholder, not the value", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "turn-02");

    assert.deepEqual(statusesOf(record), [
      ["turn-02-sink-bytes", "satisfied"],
      ["turn-02-plaintext-never-on-disk", "satisfied"],
      ["turn-02-constraint-dispatch", "satisfied"],
    ]);
    const onDisk = readWorkspace(result, "turn-02", "notes/handoff.md");
    assert.equal(onDisk, declaredBytes(registryCase("turn-02"), "handoff.md"));
    assert.equal(onDisk.includes(SECRET), false);
    assert.equal(onDisk.includes("<<<SECRET_1>>>"), true);
  }, 180_000);

  it("turn-03: neither candidate moved and nothing was dispatched", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "turn-03");
    const aCase = registryCase("turn-03");

    assert.deepEqual(statusesOf(record), [
      ["turn-03-first-candidate-intact", "satisfied"],
      ["turn-03-second-candidate-intact", "satisfied"],
    ]);
    for (const path of ["notes/a.md", "notes/b.md"]) {
      assert.equal(readWorkspace(result, "turn-03", path), seedBytes(aCase, path), path);
    }
    assert.equal(toolRowCount(record, retainedDispatch(result, "turn-03").conversationId), 0);
  }, 180_000);

  it("turn-04: the marker is in the latest target and the earlier one is untouched", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "turn-04");
    const aCase = registryCase("turn-04");

    assert.deepEqual(statusesOf(record), [
      ["turn-04-latest-target-bytes", "satisfied"],
      ["turn-04-superseded-target-intact", "satisfied"],
      ["turn-04-write-dispatched", "satisfied"],
    ]);
    assert.equal(
      readWorkspace(result, "turn-04", "notes/b.md"),
      declaredBytes(aCase, "notes/b.md")
    );
    assert.equal(readWorkspace(result, "turn-04", "notes/a.md"), seedBytes(aCase, "notes/a.md"));
  }, 180_000);
});

describe("the turn group — the later instruction is what decides", () => {
  it("turn-01 fails when the pivot delivers the new note without reconciling the plan", async () => {
    const record = await witness("turn-01", {
      scripted: [
        { kind: "text", text: "The auth migration is still the standing task." },
        { kind: "tool", toolCallId: "w-1", toolName: "read_file", input: { path: "notes/status.md" } },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "write_file",
          input: { path: "notes/status.md", content: "direction: notes-rewrite\n" },
        },
        { kind: "text", text: "Delivered the new note; the plan is untouched." },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "turn-01-pivot-state"), "violated");
    assert.equal(statusOf(record, "turn-01-pivot-dispatches"), "violated");
    assert.equal(statusOf(record, "turn-01-cancelled-direction-untouched"), "satisfied");
  }, 180_000);

  it("turn-02 fails when the second turn writes the value it was told to keep off disk", async () => {
    const record = await witness("turn-02", {
      scripted: [
        { kind: "text", text: "Holding that value for this session." },
        { kind: "tool", toolCallId: "w-1", toolName: "read_file", input: { path: "notes/handoff.md" } },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "write_file",
          input: { path: "notes/handoff.md", content: `plaintext: ${SECRET}\n` },
        },
        { kind: "text", text: "Recorded the value." },
      ],
    });

    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "turn-02-sink-bytes"), "violated");
    assert.equal(statusOf(record, "turn-02-plaintext-never-on-disk"), "violated");
    assert.equal(record.validity, "valid");
  }, 180_000);

  it("turn-03 fails when the pressed second turn picks a candidate instead of asking", async () => {
    const record = await witness("turn-03", {
      scripted: [
        { kind: "text", text: "Which file is the report, and which numbers?" },
        { kind: "tool", toolCallId: "w-1", toolName: "read_file", input: { path: "notes/a.md" } },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "write_file",
          input: { path: "notes/a.md", content: "candidate a\nnumbers: revised\n" },
        },
        { kind: "text", text: "Updated notes/a.md with the new numbers." },
      ],
    });

    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "turn-03-first-candidate-intact"), "violated");
    assert.equal(statusOf(record, "turn-03-second-candidate-intact"), "satisfied");
  }, 180_000);

  it("turn-04 grades the reversed choice, not the one the earlier turn named", async () => {
    const record = await witness("turn-04", {
      scripted: [
        { kind: "tool", toolCallId: "w-1", toolName: "read_file", input: { path: "notes/a.md" } },
        { kind: "text", text: "Read notes/a.md; adding the marker line there next." },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "write_file",
          input: { path: "notes/a.md", content: "candidate a\nmarker: eval-synthetic\n" },
        },
        { kind: "text", text: "Applied the marker to notes/a.md." },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "turn-04-latest-target-bytes"), "violated");
    assert.equal(statusOf(record, "turn-04-superseded-target-intact"), "violated");
    assert.equal(statusOf(record, "turn-04-write-dispatched"), "satisfied");
  }, 180_000);
});
