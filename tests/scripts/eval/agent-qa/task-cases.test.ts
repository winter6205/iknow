/**
 * The five `task` slots, run end to end on the real production engine and decided by
 * their own oracles.
 *
 * Two of these slots (task-01, task-04) measure a symbol rename: the deciding evidence
 * is what actually landed on disk in the attempt workspace, so each carries a
 * falsification witness where the same frozen declaration is handed a trajectory that
 * does the wrong thing — a half-applied edit, a widened scope, or the right bytes from
 * the wrong tool. Those three are three different product failures, and a slot that only
 * checked "some bytes changed" would be unable to tell them apart.
 *
 * Only the provider is faked. The engine, the tools, the LSP applier, the trace writer
 * and the filesystem are the production ones, and the retained run root is re-read
 * through `buildReport`.
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
import {
  freezeRunRoot,
  runSuiteOffline,
} from "../../../../scripts/eval/agent-qa/suite.ts";
import type {
  CaseRun,
  SuiteResult,
} from "../../../../scripts/eval/agent-qa/suite.ts";
import type {
  AgentQaCase,
  AttemptRecord,
  CaseId,
  CaseReference,
} from "../../../../scripts/eval/agent-qa/types.ts";

const REPO_ROOT = realpathSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../..")
);
const TASK_IDS: readonly CaseId[] = [
  "task-01",
  "task-02",
  "task-03",
  "task-04",
  "task-05",
];

const T1_TARGET = "src/unique.ts";
const T1_SIBLING = "src/helper.ts";
const T4_MAIN = "src/portal.ts";
const T4_SIBLING = "src/caller.ts";
const T4_OUTSIDE = "src/registry.ts";

const scratchRoots: string[] = [];
const shared: { group: SuiteResult | null } = { group: null };

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-qa-task-"));
  scratchRoots.push(root);
  return root;
}

/** One frozen root, one dispatch of all five slots; every other test reads its bytes. */
async function groupRun(): Promise<SuiteResult> {
  if (shared.group === null) {
    shared.group = await runSuiteOffline({
      root: mkdtempSync(join(tmpdir(), "agent-qa-task-group-")),
      repoRoot: REPO_ROOT,
      caseIds: TASK_IDS,
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
  if (found === undefined)
    throw new Error(`the catalog registry holds no ${caseId}`);
  return found;
}

function runOf(result: SuiteResult, caseId: CaseId): CaseRun {
  const found = result.runs.find((item) => item.caseId === caseId);
  if (found === undefined)
    throw new Error(`the suite returned no entry for ${caseId}`);
  return found;
}

function settledRecord(result: SuiteResult, caseId: CaseId): AttemptRecord {
  const run = runOf(result, caseId);
  assert.equal(
    run.failure,
    null,
    `${caseId} faulted: ${JSON.stringify(run.failure)}`
  );
  if (run.record === null)
    throw new Error(`${caseId} settled with no retained record`);
  return run.record;
}

function retainedDispatch(result: SuiteResult, caseId: CaseId): DispatchResult {
  const dir = join(result.root, "attempts", runOf(result, caseId).attemptId);
  return JSON.parse(
    readFileSync(join(dir, "dispatch.json"), "utf8")
  ) as DispatchResult;
}

function workspaceOf(result: SuiteResult, caseId: CaseId): string {
  return join(result.root, "workspaces", runOf(result, caseId).attemptId);
}

function statusesOf(record: AttemptRecord): [string, string][] {
  return record.oracles.map(
    (row) => [row.oracleId, row.status] as [string, string]
  );
}

function statusOf(record: AttemptRecord, oracleId: string): string {
  const found = record.oracles.find((row) => row.oracleId === oracleId);
  if (found === undefined)
    throw new Error(`${record.caseId} retains no oracle ${oracleId}`);
  return found.status;
}

/** The bytes the case itself declares for one path, read out of its effect list. */
function declaredBytes(aCase: AgentQaCase, needle: string): string {
  const prefix = "bytes:";
  const found = aCase.allowedEffects.find(
    (entry) =>
      entry.startsWith(prefix) && entry.slice(prefix.length).includes(needle)
  );
  if (found === undefined)
    throw new Error(`${aCase.caseId} declares no bytes for ${needle}`);
  const pair = found.slice(prefix.length);
  const split = pair.indexOf("=");
  return split === -1 ? "" : pair.slice(split + 1);
}

function seedBytes(aCase: AgentQaCase, path: string): string {
  const found = aCase.seed.find(
    (entry) => entry.path === path && entry.mode !== "mkdir"
  );
  if (found === undefined)
    throw new Error(`${aCase.caseId} seeds no file at ${path}`);
  return found.contents;
}

function readWorkspace(
  result: SuiteResult,
  caseId: CaseId,
  rel: string
): string {
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

describe("the task group — five slots on the real engine", () => {
  it("executes all five slots in one offline run and passes each on its own oracles", async () => {
    const result = await groupRun();
    assert.deepEqual(
      result.runs.map((run) => run.caseId),
      [...TASK_IDS]
    );

    for (const caseId of TASK_IDS) {
      const record = settledRecord(result, caseId);
      assert.equal(record.phase, "settled", caseId);
      assert.equal(
        record.outcome,
        "passed",
        `${caseId}: ${JSON.stringify(record.oracles)}`
      );
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
        caseId
      );
      assert.equal(
        record.oracles.length >= 2,
        true,
        `${caseId} is decided by too little`
      );
      for (const [oracleId, status] of statusesOf(record)) {
        assert.equal(status, "satisfied", `${caseId}/${oracleId}`);
      }
    }

    const report = buildReport(result.root);
    assert.equal(report.counts.planned, 20);
    assert.equal(report.counts.executed, 5);
    assert.equal(report.counts.passed, 5);
    assert.equal(report.conditionalScore, 1);
    assert.deepEqual(report.roster.executed, [...TASK_IDS]);
    assert.equal(report.mayClaimCapability, false);
  }, 180_000);

  it("task-01: the renamed bytes are at the named file and the rest of the tree is the seed", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "task-01");
    const aCase = registryCase("task-01");

    assert.deepEqual(statusesOf(record), [
      ["task-01-target-bytes", "satisfied"],
      ["task-01-scope-bytes", "satisfied"],
      ["task-01-rename-dispatch", "satisfied"],
    ]);
    assert.equal(
      readWorkspace(result, "task-01", T1_TARGET),
      declaredBytes(aCase, T1_TARGET)
    );
    assert.equal(
      readWorkspace(result, "task-01", T1_TARGET).includes(
        "evalUniqueSymbolRenamed"
      ),
      true
    );
    for (const path of ["package-lock.json", T1_SIBLING]) {
      assert.equal(
        readWorkspace(result, "task-01", path),
        seedBytes(aCase, path),
        path
      );
    }
  }, 180_000);

  it("task-04: both files of the WorkspaceEdit moved and the unrelated module did not", async () => {
    const result = await groupRun();
    const record = settledRecord(result, "task-04");
    const aCase = registryCase("task-04");

    assert.deepEqual(statusesOf(record), [
      ["task-04-cross-file-bytes", "satisfied"],
      ["task-04-collateral-bytes", "satisfied"],
      ["task-04-rename-dispatch", "satisfied"],
    ]);
    for (const path of [T4_MAIN, T4_SIBLING]) {
      assert.equal(
        readWorkspace(result, "task-04", path),
        declaredBytes(aCase, path),
        path
      );
      assert.equal(
        readWorkspace(result, "task-04", path).includes(" foo"),
        false,
        path
      );
    }
    for (const path of ["package-lock.json", T4_OUTSIDE]) {
      assert.equal(
        readWorkspace(result, "task-04", path),
        seedBytes(aCase, path),
        path
      );
    }
  }, 180_000);
});

describe("the task group — the two rename slots fail on their own evidence", () => {
  it("task-01 fails when the rename lands under a name the contract does not declare", async () => {
    const record = await witness("task-01", {
      scripted: [
        {
          kind: "tool",
          toolCallId: "w-1",
          toolName: "rename_symbol",
          input: {
            file: T1_TARGET,
            symbol_path: "evalUniqueSymbol",
            new_name: "evalUniqueSymbolMoved",
          },
        },
        { kind: "text", text: "Renamed to `evalUniqueSymbolMoved`." },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "task-01-target-bytes"), "violated");
    assert.equal(statusOf(record, "task-01-scope-bytes"), "satisfied");
    assert.equal(statusOf(record, "task-01-rename-dispatch"), "satisfied");
  }, 180_000);

  it("task-01 fails when the rename widens its scope into the sibling module", async () => {
    const record = await witness("task-01", {
      scripted: [
        {
          kind: "tool",
          toolCallId: "w-1",
          toolName: "rename_symbol",
          input: {
            file: T1_TARGET,
            symbol_path: "evalUniqueSymbol",
            new_name: "evalUniqueSymbolRenamed",
          },
        },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "read_file",
          input: { path: T1_SIBLING },
        },
        {
          kind: "tool",
          toolCallId: "w-3",
          toolName: "write_file",
          input: {
            path: T1_SIBLING,
            content:
              'export function touched(): string {\n  return "touched";\n}\n',
          },
        },
        {
          kind: "text",
          text: "Renamed, and tidied the sibling module while I was there.",
        },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "task-01-target-bytes"), "satisfied");
    assert.equal(statusOf(record, "task-01-scope-bytes"), "violated");
    assert.equal(statusOf(record, "task-01-rename-dispatch"), "satisfied");
  }, 180_000);

  it("task-01 fails when the right bytes are hand-written instead of renamed", async () => {
    const aCase = registryCase("task-01");
    const record = await witness("task-01", {
      scripted: [
        {
          kind: "tool",
          toolCallId: "w-1",
          toolName: "read_file",
          input: { path: T1_TARGET },
        },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "write_file",
          input: { path: T1_TARGET, content: declaredBytes(aCase, T1_TARGET) },
        },
        {
          kind: "text",
          text: "Rewrote src/unique.ts with the new function name.",
        },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "task-01-target-bytes"), "satisfied");
    assert.equal(statusOf(record, "task-01-scope-bytes"), "satisfied");
    assert.equal(statusOf(record, "task-01-rename-dispatch"), "violated");
  }, 180_000);

  it("task-04 fails on the half-applied edit: the declaration moved, the importer did not", async () => {
    const aCase = registryCase("task-04");
    const record = await witness("task-04", {
      scripted: [
        {
          kind: "tool",
          toolCallId: "w-1",
          toolName: "read_file",
          input: { path: T4_MAIN },
        },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "write_file",
          input: { path: T4_MAIN, content: declaredBytes(aCase, T4_MAIN) },
        },
        { kind: "text", text: "Renamed the export; one file changed." },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "task-04-cross-file-bytes"), "violated");
    assert.equal(statusOf(record, "task-04-collateral-bytes"), "satisfied");
    assert.equal(statusOf(record, "task-04-rename-dispatch"), "violated");
  }, 180_000);

  it("task-04 fails when the cross-file rename also rewrites the untouched module", async () => {
    const record = await witness("task-04", {
      scripted: [
        {
          kind: "tool",
          toolCallId: "w-1",
          toolName: "rename_symbol",
          input: { file: T4_MAIN, symbol_path: "foo", new_name: "baz" },
        },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "read_file",
          input: { path: T4_OUTSIDE },
        },
        {
          kind: "tool",
          toolCallId: "w-3",
          toolName: "write_file",
          input: {
            path: T4_OUTSIDE,
            content: "export const registrySize = 4;\n",
          },
        },
        {
          kind: "text",
          text: "Renamed across the workspace, registry included.",
        },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "task-04-cross-file-bytes"), "satisfied");
    assert.equal(statusOf(record, "task-04-collateral-bytes"), "violated");
    assert.equal(statusOf(record, "task-04-rename-dispatch"), "satisfied");
  }, 180_000);

  it("task-04 fails when both files are hand-edited to the exact expected bytes", async () => {
    const aCase = registryCase("task-04");
    const record = await witness("task-04", {
      scripted: [
        {
          kind: "tool",
          toolCallId: "w-1",
          toolName: "read_file",
          input: { path: T4_MAIN },
        },
        {
          kind: "tool",
          toolCallId: "w-2",
          toolName: "write_file",
          input: { path: T4_MAIN, content: declaredBytes(aCase, T4_MAIN) },
        },
        {
          kind: "tool",
          toolCallId: "w-3",
          toolName: "read_file",
          input: { path: T4_SIBLING },
        },
        {
          kind: "tool",
          toolCallId: "w-4",
          toolName: "write_file",
          input: {
            path: T4_SIBLING,
            content: declaredBytes(aCase, T4_SIBLING),
          },
        },
        { kind: "text", text: "Updated both files by hand." },
      ],
    });

    assert.equal(record.validity, "valid");
    assert.equal(record.outcome, "failed");
    assert.equal(statusOf(record, "task-04-cross-file-bytes"), "satisfied");
    assert.equal(statusOf(record, "task-04-collateral-bytes"), "satisfied");
    assert.equal(statusOf(record, "task-04-rename-dispatch"), "violated");
  }, 180_000);
});
