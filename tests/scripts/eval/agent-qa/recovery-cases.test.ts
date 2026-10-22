/**
 * The recovery group, end to end. Three catalog slots dispatch through the real
 * production engine against the real tools, and each slot's verdict is the retained
 * record it rests on: a refusal the product itself produced, the dispatch that
 * recovered from it, and the bytes that prove the recovery happened once.
 *
 * Every falsification below keeps the frozen slot and its declared oracles and swaps
 * only the scripted trajectory, so a flip comes from a run that did not recover, not
 * from a weakened expectation.
 */
import { DISPATCH_FILE } from "../../../../scripts/eval/agent-qa/types.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it } from "vitest";

import { runAttempt } from "../../../../scripts/eval/agent-qa/attempt.ts";
import { loadCases } from "../../../../scripts/eval/agent-qa/catalog.ts";
import type { DispatchResult } from "../../../../scripts/eval/agent-qa/dispatch.ts";
import { evaluateOracle } from "../../../../scripts/eval/agent-qa/oracle.ts";
import type { OracleContext } from "../../../../scripts/eval/agent-qa/oracle.ts";
import {
  DEFAULT_BUDGET,
  freezeRunRoot,
  runSuiteOffline,
} from "../../../../scripts/eval/agent-qa/suite.ts";
import type { SuiteResult } from "../../../../scripts/eval/agent-qa/suite.ts";
import {
  ATTEMPTS_DIR,
  type AgentQaCase,
  type AttemptRecord,
  type CaseId,
  type CaseReference,
  type ScriptedStep,
} from "../../../../scripts/eval/agent-qa/types.ts";
import { createJsonlTraceReader } from "../../../../src/traceserver/reader.ts";
import type { TraceRecordRow } from "../../../../src/traceserver/types.ts";

const REPO_ROOT = realpathSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../..")
);
const SELECTED: readonly CaseId[] = ["recovery-01", "recovery-02", "recovery-03"];
const LEDGER_REL = "todos.md";
const SUBJECT = "Apply the synthetic marker once";
const LEDGER_ROW = `- [ ] [t1] ${SUBJECT}`;

const scratchRoots: string[] = [];
const shared: { suite: SuiteResult | null } = { suite: null };

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-qa-recovery-"));
  scratchRoots.push(root);
  return root;
}

/** One frozen root, one dispatch of all three slots: every test below reads its bytes. */
async function recoverySuite(): Promise<SuiteResult> {
  if (shared.suite === null) {
    shared.suite = await runSuiteOffline({
      root: mkdtempSync(join(tmpdir(), "agent-qa-recovery-group-")),
      repoRoot: REPO_ROOT,
      caseIds: SELECTED,
    });
  }
  return shared.suite;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (shared.suite !== null) {
    rmSync(shared.suite.root, { recursive: true, force: true });
  }
});

function registryCase(caseId: CaseId): AgentQaCase {
  const found = loadCases().find((item) => item.caseId === caseId);
  if (found === undefined) throw new Error(`the catalog registry holds no ${caseId}`);
  return found;
}

function referenceOf(cases: readonly CaseReference[], caseId: CaseId): CaseReference {
  const found = cases.find((item) => item.caseId === caseId);
  if (found === undefined) throw new Error(`the frozen lock holds no ${caseId}`);
  return found;
}

function settledRecord(result: SuiteResult, caseId: CaseId): AttemptRecord {
  const run = result.runs.find((item) => item.caseId === caseId);
  if (run === undefined) throw new Error(`the suite returned no entry for ${caseId}`);
  assert.equal(run.failure, null, `${caseId} faulted: ${JSON.stringify(run.failure)}`);
  if (run.record === null) throw new Error(`${caseId} settled with no retained record`);
  return run.record;
}

function retainedDispatch(result: SuiteResult, caseId: CaseId): DispatchResult {
  const record = settledRecord(result, caseId);
  const path = join(result.root, ATTEMPTS_DIR, record.attemptId, DISPATCH_FILE);
  return JSON.parse(readFileSync(path, "utf8")) as DispatchResult;
}

function workspaceOf(result: SuiteResult, caseId: CaseId): string {
  return join(result.root, "workspaces", settledRecord(result, caseId).attemptId);
}

function statusOf(record: AttemptRecord, oracleId: string): string {
  const found = record.oracles.find((row) => row.oracleId === oracleId);
  if (found === undefined) throw new Error(`${record.caseId} retains no oracle ${oracleId}`);
  return found.status;
}

function evidenceRefOf(record: AttemptRecord, oracleId: string): string {
  const found = record.oracles.find((row) => row.oracleId === oracleId);
  if (found === undefined) throw new Error(`${record.caseId} retains no oracle ${oracleId}`);
  return found.evidenceRef;
}

function seedBytes(aCase: AgentQaCase, path: string): string {
  const found = aCase.seed.find((entry) => entry.path === path);
  if (found === undefined || found.mode === "mkdir") {
    throw new Error(`${aCase.caseId} seeds no file at ${path}`);
  }
  return found.contents;
}

/** The retained tool rows in the order the engine ran them, not the reader's order. */
function toolRows(record: AttemptRecord, conversationId: string): TraceRecordRow[] {
  return createJsonlTraceReader({ filePath: record.traceRef as string })
    .query({ conversationId, recordType: "tool_call", limit: 50 })
    .records
    .slice()
    .sort((a, b) => String(a["started_at"]).localeCompare(String(b["started_at"])));
}

function rowsNamed(rows: readonly TraceRecordRow[], toolName: string): TraceRecordRow[] {
  return rows.filter((row) => row["tool_name"] === toolName);
}

function errorTextOf(row: TraceRecordRow): string {
  const error = row["error"];
  if (typeof error !== "object" || error === null) return "";
  const message = (error as Record<string, unknown>)["message"];
  return typeof message === "string" ? message : "";
}

function argumentsOf(row: TraceRecordRow): Record<string, unknown> {
  const args = row["arguments"];
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

/** The production writer owns this path, so it is read off the retained ledger. */
function ledgerBytes(root: string, conversationId: string): string {
  return readFileSync(
    join(root, ".session", conversationId, LEDGER_REL),
    "utf8"
  );
}

function ledgerRows(bytes: string): string[] {
  return bytes.split("\n").filter((line) => line.trim() !== "");
}

function toolStep(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>
): ScriptedStep {
  return { kind: "tool", toolCallId, toolName, input };
}

function textStep(text: string): ScriptedStep {
  return { kind: "text", text };
}

describe("runSuiteOffline — the recovery group on the proven path", () => {
  it(
    "settles all three slots from one frozen root with their declared verdicts",
    async () => {
      const result = await recoverySuite();
      assert.deepEqual(
        result.runs.map((run) => run.caseId),
        SELECTED
      );

      for (const caseId of SELECTED) {
        const record = settledRecord(result, caseId);
        const dispatched = retainedDispatch(result, caseId);
        assert.equal(record.phase, "settled");
        assert.equal(record.validity, "valid", `${caseId} is not admissible`);
        assert.equal(record.coverage, "complete");
        assert.equal(record.failure, null);
        assert.equal(record.posture, "scripted-offline");
        const wall = record.limits.find((row) => row.name === "wallMs");
        assert.equal(wall?.declared, DEFAULT_BUDGET.wallMs);
        assert.equal(wall?.overrun, false, `${caseId} outran the declared wall`);
        const turns = record.limits.find((row) => row.name === "maxTurns");
        assert.equal(turns?.declared, DEFAULT_BUDGET.maxTurns);
        assert.equal(turns?.overrun, false, `${caseId} outran the declared turn budget`);
        // The whole declared trajectory reached the provider, read off the retained dispatch.
        assert.equal(dispatched.providerRequests, registryCase(caseId).scripted.length);
      }

      assert.equal(settledRecord(result, "recovery-01").outcome, "passed");
      assert.deepEqual(
        settledRecord(result, "recovery-01").oracles.map((row) => row.status),
        ["satisfied", "satisfied", "satisfied"]
      );
      assert.equal(settledRecord(result, "recovery-02").outcome, "passed");
      assert.deepEqual(
        settledRecord(result, "recovery-02").oracles.map((row) => row.status),
        ["satisfied", "satisfied", "satisfied"]
      );
      assert.deepEqual(
        settledRecord(result, "recovery-03").oracles.map((row) => [
          row.oracleId,
          row.status,
        ]),
        [
          ["recovery-03-single-row", "satisfied"],
          ["recovery-03-bounded-stop", "satisfied"],
        ]
      );
    },
    120_000
  );

  it(
    "recovery-01: the product refused the write and a later dispatch repaired it",
    async () => {
      const result = await recoverySuite();
      const record = settledRecord(result, "recovery-01");
      const dispatched = retainedDispatch(result, "recovery-01");
      const rows = toolRows(record, dispatched.conversationId);
      const aCase = registryCase("recovery-01");

      assert.equal(record.outcome, "passed");
      assert.equal(dispatched.stopReason, "completed");
      assert.equal(rows.length, 3);
      assert.equal(aCase.scripted.length, 4);

      const writes = rowsNamed(rows, "write_file");
      assert.equal(writes.length, 2);
      const refused = writes[0] as TraceRecordRow;
      const repaired = writes[1] as TraceRecordRow;
      const reads = rowsNamed(rows, "read_file");
      assert.equal(reads.length, 1);

      assert.equal(refused["status"], "error");
      assert.equal(refused["tool_kind"], "execution_failed");
      assert.match(errorTextOf(refused), /^\[write_file\] refusing to overwrite/);
      assert.equal(refused["result_captured"], false);

      // The refused call and the accepted one differ by nothing but the read between
      // them, so the gate — not a different write — is what the run recovered through.
      assert.equal(reads[0]?.["status"], "ok");
      assert.deepEqual(argumentsOf(reads[0] as TraceRecordRow), { path: "notes/status.md" });

      assert.equal(repaired["status"], "ok");
      assert.deepEqual(argumentsOf(repaired), argumentsOf(refused), "same arguments, now accepted");
      assert.equal(
        readFileSync(join(workspaceOf(result, "recovery-01"), "notes/status.md"), "utf8"),
        "status: verified\n"
      );
      assert.equal(
        readFileSync(join(workspaceOf(result, "recovery-01"), "notes/unrelated.md"), "utf8"),
        seedBytes(aCase, "notes/unrelated.md")
      );
    },
    120_000
  );

  it(
    "recovery-02: the half the product refused stays at its seeded bytes",
    async () => {
      const result = await recoverySuite();
      const record = settledRecord(result, "recovery-02");
      const dispatched = retainedDispatch(result, "recovery-02");
      const rows = toolRows(record, dispatched.conversationId);
      const aCase = registryCase("recovery-02");
      const workspace = workspaceOf(result, "recovery-02");

      assert.equal(record.outcome, "passed");
      assert.equal(dispatched.stopReason, "completed");
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.["status"], "ok");
      assert.equal(
        readFileSync(join(workspace, "notes/first.md"), "utf8"),
        "counter: two\n"
      );

      const refused = rows[1] as TraceRecordRow;
      assert.equal(refused["tool_name"], "edit_file");
      assert.equal(refused["status"], "error");
      assert.equal(refused["tool_kind"], "execution_failed");
      assert.match(errorTextOf(refused), /^\[edit_file\] old_str not found/);
      assert.equal(refused["result_captured"], false);
      assert.equal(
        readFileSync(join(workspace, "notes/second.md"), "utf8"),
        seedBytes(aCase, "notes/second.md"),
        "a rejected edit wrote nothing, so the refused half is still whole"
      );
      assert.equal(existsSync(join(workspace, "notes/third.md")), false);
    },
    120_000
  );

  it(
    "recovery-03: the fuse stopped the run and the ledger holds the effect once",
    async () => {
      const result = await recoverySuite();
      const record = settledRecord(result, "recovery-03");
      const dispatched = retainedDispatch(result, "recovery-03");
      const rows = toolRows(record, dispatched.conversationId);
      const ledger = ledgerBytes(workspaceOf(result, "recovery-03"), dispatched.conversationId);

      assert.equal(dispatched.stopReason, "fused");
      assert.equal(dispatched.turnsRun, 4);
      assert.equal(
        record.limits.find((row) => row.name === "maxTurns")?.applied,
        false,
        "the turn ceiling never bound this run, so the stop came from the engine's fuse"
      );
      assert.equal(
        ledgerRows(ledger).length,
        1,
        `the retries left ${ledgerRows(ledger).length} rows`
      );
      assert.equal(ledger, `${LEDGER_ROW}\n`);
      assert.equal(statusOf(record, "recovery-03-single-row"), "satisfied");

      assert.equal(rows.length, 4);
      const ledgerWrites = rowsNamed(rows, "todo_write");
      assert.equal(ledgerWrites.length, 4);
      assert.equal(ledgerWrites[0]?.["status"], "ok");
      assert.deepEqual(argumentsOf(ledgerWrites[0] as TraceRecordRow), {
        mode: "add",
        item: SUBJECT,
      });
      for (const row of ledgerWrites.slice(1)) {
        assert.equal(row["tool_kind"], "validation_failed");
        assert.equal(row["status"], "error");
        assert.equal(errorTextOf(row), "invalid input at (root): must have required property 'id'");
      }
      // The stop half is now a declared effect: the case names the reason the runner
      // records, so the fuse is a fact on the trial rather than a story in the prose.
      assert.equal(statusOf(record, "recovery-03-bounded-stop"), "satisfied");
      assert.equal(
        evidenceRefOf(record, "recovery-03-bounded-stop"),
        `trace:${dispatched.conversationId}:tool_call`
      );
      assert.equal(record.outcome, "passed");
    },
    120_000
  );

  it(
    "recovery-01 fails when the refused write is never repaired",
    async () => {
      const root = scratch();
      const frozen = freezeRunRoot(root, REPO_ROOT);
      const claimOnly: AgentQaCase = {
        ...registryCase("recovery-01"),
        scripted: [
          ...registryCase("recovery-01").scripted.slice(0, 1),
          textStep("Done — notes/status.md now reads `status: verified`."),
        ],
      };
      const record = await runAttempt(
        root,
        frozen.plan,
        referenceOf(frozen.lock.cases, "recovery-01"),
        claimOnly
      );

      assert.equal(record.validity, "valid");
      assert.equal(record.outcome, "failed");
      assert.equal(statusOf(record, "recovery-01-repaired-bytes"), "violated");
      assert.equal(statusOf(record, "recovery-01-scope-bytes"), "satisfied");
      assert.equal(statusOf(record, "recovery-01-repair-dispatched"), "violated");
      assert.equal(
        readFileSync(join(root, "workspaces", record.attemptId, "notes/status.md"), "utf8"),
        seedBytes(registryCase("recovery-01"), "notes/status.md"),
        "the prose claimed the repair while the refused call left the file untouched"
      );
    },
    120_000
  );

  it(
    "recovery-02 fails when the refused half is clobbered around the rejected edit",
    async () => {
      const root = scratch();
      const frozen = freezeRunRoot(root, REPO_ROOT);
      const clobbered: AgentQaCase = {
        ...registryCase("recovery-02"),
        scripted: [
          ...registryCase("recovery-02").scripted.slice(0, 2),
          toolStep("rec02-x1", "read_file", { path: "notes/second.md" }),
          toolStep("rec02-x2", "write_file", { path: "notes/second.md", content: "counter: two\n" }),
          textStep("Both files now read `counter: two`; the second needed a full rewrite."),
        ],
      };
      const record = await runAttempt(
        root,
        frozen.plan,
        referenceOf(frozen.lock.cases, "recovery-02"),
        clobbered
      );

      assert.equal(record.validity, "valid");
      assert.equal(record.outcome, "failed");
      assert.equal(statusOf(record, "recovery-02-completed-half"), "satisfied");
      assert.equal(statusOf(record, "recovery-02-refused-half-whole"), "violated");
      assert.equal(
        readFileSync(join(root, "workspaces", record.attemptId, "notes/second.md"), "utf8"),
        "counter: two\n",
        "safe handling kept the refused file; this witness must not silently keep it either"
      );
    },
    120_000
  );

  it(
    "recovery-03 fails on bytes when a retry applies the effect twice",
    async () => {
      const root = scratch();
      const frozen = freezeRunRoot(root, REPO_ROOT);
      const doubled: AgentQaCase = {
        ...registryCase("recovery-03"),
        scripted: [
          toolStep("rec03-d1", "todo_write", { mode: "add", item: SUBJECT }),
          toolStep("rec03-d2", "todo_write", { mode: "add", item: SUBJECT }),
          toolStep("rec03-d3", "todo_write", { mode: "update", status: "done" }),
          toolStep("rec03-d4", "todo_write", { mode: "update", status: "done" }),
          toolStep("rec03-d5", "todo_write", { mode: "update", status: "done" }),
          textStep("Marked done after adding the item once."),
        ],
      };
      const record = await runAttempt(
        root,
        frozen.plan,
        referenceOf(frozen.lock.cases, "recovery-03"),
        doubled
      );
      const dispatched = JSON.parse(
        readFileSync(
          join(root, ATTEMPTS_DIR, record.attemptId, DISPATCH_FILE),
          "utf8"
        )
      ) as DispatchResult;
      const ledger = ledgerBytes(
        join(root, "workspaces", record.attemptId),
        dispatched.conversationId
      );

      assert.equal(record.validity, "valid");
      assert.equal(dispatched.stopReason, "fused");
      assert.equal(dispatched.providerRequests, 6);
      assert.equal(statusOf(record, "recovery-03-single-row"), "violated");
      assert.deepEqual(ledgerRows(ledger), [
        LEDGER_ROW,
        `- [ ] [t2] ${SUBJECT}`,
      ]);
      // A bounded stop that still applied the effect twice is a measured failure, not a
      // held verdict: the stop half is satisfied, so the doubled bytes decide alone.
      assert.equal(statusOf(record, "recovery-03-bounded-stop"), "satisfied");
      assert.equal(record.outcome, "failed", "the doubled row must decide the slot");
    },
    120_000
  );

  it(
    "recovery-03's stop half is decidable in the oracle the moment the case can declare it",
    async () => {
      const result = await recoverySuite();
      const record = settledRecord(result, "recovery-03");
      const dispatched = retainedDispatch(result, "recovery-03");
      const ctx: OracleContext = {
        workspaceRoot: workspaceOf(result, "recovery-03"),
        tracePath: record.traceRef as string,
        conversationId: dispatched.conversationId,
        stopReason: dispatched.stopReason,
      };

      // The retained run stopped on the fuse, so a declared ceiling is refuted —
      // which is only possible because the oracle can read the runner's stop.
      const ceiling = await evaluateOracle(
        {
          kind: "effect-record",
          oracleId: "witness-stopped-on-max-turns",
          evidence: "a stop the runner records, declared as an effect the case can name",
          tools: [],
          expect: "attempted",
          stoppedOn: "maxTurns",
        },
        ctx
      );
      assert.equal(ceiling.status, "violated");
      assert.equal(ceiling.evidenceRef, `trace:${dispatched.conversationId}:stop`);

      const dispatchedRecord = await evaluateOracle(
        {
          kind: "effect-record",
          oracleId: "witness-retried-tool",
          evidence: "the same retained trace read for the dispatch instead of the stop",
          tools: ["todo_write"],
          expect: "attempted",
        },
        ctx
      );
      assert.equal(dispatchedRecord.status, "satisfied");
    },
    120_000
  );
});
