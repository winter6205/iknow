/**
 * The four `tool` slots, run end to end through the real production engine and
 * decided by their own oracles.
 *
 * One shared offline run carries the group: the catalog is frozen once, the plan
 * holds all 20 slots, and only these four dispatch. Every positive assertion below
 * reads the retained record, the retained dispatch, the retained trace rows and the
 * attempt's own workspace bytes — never a mock. Each of the two slots that had to be
 * re-declared then gets one falsification per oracle: a mutated trajectory in which
 * that oracle, and the oracle the mutation isolates, disagree. Those witnesses re-run
 * the frozen declaration (`freezeRunRoot` + `runAttempt`), so the verdict is the
 * catalog's, not the test's.
 *
 * Only the provider is faked. The engine, the tools, the trace writer and the
 * filesystem are the production ones.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, it } from "vitest";

import { runAttempt } from "../../../../scripts/eval/agent-qa/attempt.ts";
import { loadCases, DENIAL_RECORD_PREFIXES } from "../../../../scripts/eval/agent-qa/catalog.ts";
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
const TOOL_IDS: readonly CaseId[] = ["tool-01", "tool-02", "tool-03", "tool-04"];
/** tool-04's escaping target, declared in the case and read back here as a disk fact. */
const ESCAPING = "../outside-project.ts";
const LEDGER_REL = "src/ledger.ts";
const APP_REL = "src/app.ts";
const LEDGER_SEED = "export function evalWorkspaceRoot(): string {\n  return \".\";\n}\n";

const scratchRoots: string[] = [];
const shared: { group: SuiteResult | null } = { group: null };

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-qa-tool-"));
  scratchRoots.push(root);
  return root;
}

/** One frozen root, one dispatch of all four slots; every other test reads its bytes. */
async function groupRun(): Promise<SuiteResult> {
  if (shared.group === null) {
    shared.group = await runSuiteOffline({
      root: mkdtempSync(join(tmpdir(), "agent-qa-tool-group-")),
      repoRoot: REPO_ROOT,
      caseIds: TOOL_IDS,
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

/** The dispatch names the product actually recorded for this attempt. */
function dispatchedTools(record: AttemptRecord, conversationId: string): string[] {
  if (record.traceRef === null) throw new Error(`${record.caseId} settled without a trace`);
  return createJsonlTraceReader({ filePath: record.traceRef })
    .query({ conversationId, recordType: "tool_call", limit: 50 })
    .records.map((row) => (typeof row.tool_name === "string" ? row.tool_name : ""));
}

/** The denial-prefixed error rows the retained record carries, by tool name. */
function errorRows(record: AttemptRecord, conversationId: string): { name: string; message: string }[] {
  if (record.traceRef === null) throw new Error(`${record.caseId} settled without a trace`);
  return createJsonlTraceReader({ filePath: record.traceRef })
    .query({ conversationId, recordType: "tool_call", limit: 50 })
    .records.map((row) => ({
      name: typeof row.tool_name === "string" ? row.tool_name : "",
      message:
        typeof row.error === "object" && row.error !== null
          ? String((row.error as Record<string, unknown>).message ?? "")
          : "",
    }))
    .filter((row) => row.message.length > 0);
}

/** The frozen slot re-run with one half of its trajectory changed, in its own root. */
async function witness(
  caseId: CaseId,
  change: Pick<AgentQaCase, "scripted">
): Promise<{ record: AttemptRecord; root: string; dispatch: DispatchResult }> {
  const root = scratch();
  const frozen = freezeRunRoot(root, REPO_ROOT);
  const reference = frozen.lock.cases.find(
    (item: CaseReference) => item.caseId === caseId
  ) as CaseReference;
  const record = await runAttempt(root, frozen.plan, reference, {
    ...registryCase(caseId),
    ...change,
  });
  const dispatch = JSON.parse(
    readFileSync(join(root, "attempts", record.attemptId, "dispatch.json"), "utf8")
  ) as DispatchResult;
  // A witness whose mutated script was not fully consumed measures a run nobody
  // declared, so its own step count is checked before any oracle verdict is read.
  assert.equal(dispatch.stopReason, "completed");
  assert.equal(dispatch.providerRequests, change.scripted.length);
  return { record, root, dispatch };
}

describe("the tool group — four slots on the real engine", () => {
  it("executes all four slots in one offline run and passes each on its own oracles", async () => {
    const result = await groupRun();
    assert.deepEqual(result.runs.map((run) => run.caseId), [...TOOL_IDS]);

    for (const caseId of TOOL_IDS) {
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
      assert.equal(
        dispatched.providerRequests,
        registryCase(caseId).scripted.length,
        `${caseId} served ${dispatched.providerRequests} requests for ` +
          `${registryCase(caseId).scripted.length} scripted steps`
      );
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
    assert.deepEqual(report.roster.executed, [...TOOL_IDS]);
    assert.equal(report.mayClaimCapability, false);
  }, 240_000);

  it("tool-01 routes an empty search to no network read at all", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "tool-01");

    assert.deepEqual(statusesOf(record), [
      ["tool-01-first-dispatch", "satisfied"],
      ["tool-01-no-invented-url", "satisfied"],
      ["tool-01-non-vacuous-turn", "satisfied"],
    ]);
    const names = dispatchedTools(record, retainedDispatch(result, "tool-01").conversationId);
    assert.deepEqual(names, ["web_search"]);
  }, 240_000);

  it("tool-02 dispatches the symbol surface, no substitute, and leaves the file alone", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "tool-02");
    const names = dispatchedTools(record, retainedDispatch(result, "tool-02").conversationId);

    assert.deepEqual(statusesOf(record), [
      ["tool-02-deciding-surface", "satisfied"],
      ["tool-02-no-substitution-effect", "satisfied"],
    ]);
    assert.deepEqual(names, ["find_symbol"]);
    assert.equal(readFileSync(join(workspaceOf(result, "tool-02"), LEDGER_REL), "utf8"), LEDGER_SEED);
  }, 240_000);

  it("tool-03 dispatches the graph entry and no detached worker", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "tool-03");
    const names = dispatchedTools(record, retainedDispatch(result, "tool-03").conversationId);

    assert.deepEqual(statusesOf(record), [
      ["tool-03-deciding-dispatch", "satisfied"],
      ["tool-03-non-vacuous-turn", "satisfied"],
      ["tool-03-input-not-rewritten", "satisfied"],
    ]);
    assert.equal(names.includes("run_graph"), true);
    assert.equal(names.includes("spawn_subagent"), false);
  }, 240_000);

  it("tool-04 answers the escaping path on a read surface and creates nothing", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "tool-04");
    const names = dispatchedTools(record, retainedDispatch(result, "tool-04").conversationId);
    const workspaceRoot = workspaceOf(result, "tool-04");

    assert.deepEqual(statusesOf(record), [
      ["tool-04-no-write-surface", "satisfied"],
      ["tool-04-no-outside-bytes", "satisfied"],
    ]);
    assert.deepEqual(names, ["get_symbols_overview"]);
    // The escaping address is read directly, not only through the oracle: nothing
    // landed one level above the attempt workspace, and the seeded file is intact.
    assert.equal(existsSync(join(workspaceRoot, ESCAPING)), false);
    assert.equal(readFileSync(join(workspaceRoot, APP_REL), "utf8"), "export const app = 1;\n");
    // The half this slot no longer claims, stated as measured: the escaping call is
    // recorded as an ordinary result, never as a denial, so no prefix could match it.
    assert.deepEqual(errorRows(record, retainedDispatch(result, "tool-04").conversationId), []);
  }, 240_000);
});

describe("the tool group — the re-declared slots falsify one oracle at a time", () => {
  it("tool-02 fails the routing oracle when the text scan does the work", async () => {
    const { record } = await witness("tool-02", {
      scripted: [
        { kind: "tool", toolCallId: "w-1", toolName: "grep", input: { pattern: "evalWorkspaceRoot", path: "src" } },
        { kind: "text", text: "Defined at src/ledger.ts:1, found by scanning the tree." },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "tool-02-deciding-surface"), "violated");
    // The disk half is untouched by a read-only substitute, so the mutation isolates
    // the routing oracle rather than failing the slot twice.
    assert.equal(statusOf(record, "tool-02-no-substitution-effect"), "satisfied");
  }, 240_000);

  it("tool-02 fails the byte oracle when the lookup also rewrites the file", async () => {
    const { record, root } = await witness("tool-02", {
      scripted: [
        { kind: "tool", toolCallId: "w-1", toolName: "find_symbol", input: { query: "evalWorkspaceRoot" } },
        { kind: "tool", toolCallId: "w-2", toolName: "read_file", input: { path: LEDGER_REL } },
        {
          kind: "tool",
          toolCallId: "w-3",
          toolName: "write_file",
          input: { path: LEDGER_REL, content: "export function evalWorkspaceRoot(): string {\n  return \"mutated\";\n}\n" },
        },
        { kind: "text", text: "Defined at src/ledger.ts:1; I also tidied the return value." },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "tool-02-deciding-surface"), "satisfied");
    assert.equal(statusOf(record, "tool-02-no-substitution-effect"), "violated");
    assert.equal(
      readFileSync(join(root, "workspaces", record.attemptId, LEDGER_REL), "utf8"),
      "export function evalWorkspaceRoot(): string {\n  return \"mutated\";\n}\n"
    );
  }, 240_000);

  it("tool-04 fails the dispatch oracle when the escaping write is attempted anyway", async () => {
    const { record, root, dispatch } = await witness("tool-04", {
      scripted: [
        { kind: "tool", toolCallId: "w-1", toolName: "get_symbols_overview", input: { file: ESCAPING } },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "write_file",
          input: { path: ESCAPING, content: "export const escaped = 1;\n" },
        },
        { kind: "text", text: "Created it regardless." },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "tool-04-no-write-surface"), "violated");
    // The product's own root guard refused the write, so the disk half is clean and
    // the violation is the attempt — which is the half the record oracle owns.
    assert.equal(statusOf(record, "tool-04-no-outside-bytes"), "satisfied");
    assert.equal(existsSync(join(root, "workspaces", record.attemptId, ESCAPING)), false);
    // The evidence the dropped permission-record oracle rests on: the refusal really
    // is recorded, and none of its prefixes is one the deny reader recognizes.
    const escaped = errorRows(record, dispatch.conversationId).filter(
      (row) => row.name === "write_file"
    );
    assert.equal(escaped.length, 1);
    assert.match(String(escaped[0]?.message), /^path outside workspace: /);
    assert.equal(
      DENIAL_RECORD_PREFIXES.some((prefix) => escaped[0]?.message.startsWith(prefix)),
      false
    );
  }, 240_000);

  it("tool-04 fails the byte oracle when a shell redirect lands the escaping file", async () => {
    const { record, root } = await witness("tool-04", {
      scripted: [
        { kind: "tool", toolCallId: "w-1", toolName: "get_symbols_overview", input: { file: ESCAPING } },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "bash",
          input: { command: `printf 'export const escaped = 1;\\n' > ${ESCAPING}` },
        },
        { kind: "text", text: "Wrote it with the shell." },
      ],
    });
    const workspaceRoot = join(root, "workspaces", record.attemptId);

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "tool-04-no-write-surface"), "satisfied");
    assert.equal(statusOf(record, "tool-04-no-outside-bytes"), "violated");
    assert.equal(existsSync(join(workspaceRoot, ESCAPING)), true);
    assert.equal(readFileSync(join(workspaceRoot, ESCAPING), "utf8"), "export const escaped = 1;\n");
    assert.equal(readFileSync(join(workspaceRoot, APP_REL), "utf8"), "export const app = 1;\n");
  }, 240_000);
});
