/**
 * verify-loop outcome → goal.status write-back + recordGoal trace.
 *
 * The hub is the ONLY writer of goal.status. The OUTCOME_TO_STATUS data table
 * maps each VerifyLoopOutcome to a target status:
 *
 *   passed    → "achieved"
 *   aborted   → "aborted"
 *   escalated → "aborted"
 *   failed    → "active"    (no status change; trace-only)
 *   unstable  → "active"    (no status change; trace-only)
 *   disabled  → undefined   (no status change; trace-only)
 *
 * `applyTransition` runs only when target is a valid forward edge from current
 * (assertValidTransition rejects self-transitions, so active→active etc.
 * are no-ops). recordGoal fires for every outcome with a goal present
 * (trace written even when no status change).
 *
 * Fixture: a user-pinned active goal (source === "user_pin") survives
 * sanitize-on-load (sanitize unconditionally drops the legacy `taskFocus`
 * key, but never touches a user-pinned `goal`).
 *
 * Trace assertions: writeback recordGoal writes a JSONL line via the real
 * JsonlTraceService — read the per-session trace file and filter
 * `record_type === "goal"` + `action === "writeback"`.
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runVerifyLoopMock, setOutcome } = vi.hoisted(() => {
  let outcome: VerifyLoopOutcome = "passed";
  const fn = vi.fn(
    async (opts: {
      runFn: (
        text: string,
        o?: unknown
      ) => Promise<{
        result: {
          readonly finalText: string | null;
          readonly messages: ReadonlyArray<unknown>;
          readonly turnCount: number;
          readonly stopReason: "completed" | "maxTurns" | "cancelled";
          readonly lastUsage: null;
        };
        trace: unknown;
      }>;
    }) => {
      const r = await opts.runFn("whatever", {});
      return {
        result: r.result,
        trace: r.trace,
        rounds: 0,
        enabled: true,
        outcome,
        records: [],
      };
    }
  );
  return {
    runVerifyLoopMock: fn,
    setOutcome: (o: VerifyLoopOutcome) => {
      outcome = o;
    },
  };
});

vi.mock("../../src/harness/verify/index.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/harness/verify/index.ts")
  >("../../src/harness/verify/index.ts");
  return {
    ...actual,
    runVerifyLoop: runVerifyLoopMock,
  };
});

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationTraceFilePath,
  resolveProjectSessionDir,
  SessionStore,
  type GoalState,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";
import type { VerifyLoopOutcome } from "../../src/harness/verify/verify-loop.ts";

let baseDir: string;
let store: SessionStore;
let traceDir: string;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-goalstatus-"));
  // traceOut points at the same temp root; same pattern as
  // hub-violation.test.ts.
  traceDir = baseDir;
  // hub.store.projectDir is the trace anchor base, derived jointly with hub.
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const activeGoal: GoalState = {
  text: "Type-system-validate-LSP",
  // Fixture uses user_pin (sanitize keeps the user_pin vertex; a
  // user_initial vertex would be migrated to taskFocus); the write-back
  // path only acts on explicitly pinned goals.
  source: "user_pin",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function seedSession(id: string, goal: GoalState): Promise<void> {
  await store.save({
    id,
    file: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "",
      cwd: process.cwd(),
      sanitized_at: "2026-01-01T00:00:00.000Z",
      checkpoints: [],
      workspaceRoot: process.cwd(),
      goal,
    } as SessionFileV1,
  });
}

function makeHub(): SessionHub {
  const verifyConfig: VerifyConfig = { command: "/bin/true" };
  return new SessionHub({
    store,
    deps: makeDeps(
      Array.from({ length: 8 }, (_, i) =>
        assistantResult({ texts: [`ok-${i}`] })
      )
    ),
    verifyConfig,
    traceOut: traceDir,
  });
}

async function load(id: string): Promise<SessionFileV1> {
  return store.load(id);
}

/** Read the per-session JSONL trace file and filter for goal writeback records. */
async function readWritebackGoalRecord(
  conversationId: string
): Promise<Record<string, unknown>> {
  // The reader derives `<projectDir>/<convId>/trace.jsonl`, sharing
  // `resolveConversationTraceFilePath` with the hub writer — same convId
  // always means the same file.
  const projectDir = store.getProjectDir();
  const tracePath = resolveConversationTraceFilePath({
    projectDir,
    conversationId,
  });
  assert.ok(
    await stat(tracePath).then(
      () => true,
      () => false
    ),
    `expected trace file at ${tracePath}`
  );
  const raw = await readFile(tracePath, "utf8");
  const lines = raw
    .trim()
    .split("\n")
    .filter((l) => l.includes('"record_type":"goal"'))
    .filter((l) => l.includes('"action":"writeback"'));
  assert.ok(
    lines.length >= 1,
    `expected ≥1 goal writeback record, got: ${raw}`
  );
  return JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
}

describe("goal.status write-back on verify-loop outcome (#458 T5 SC8)", () => {
  it("outcome 'passed' → goal.status === 'achieved' + recordGoal writeback(status: achieved)", async () => {
    setOutcome("passed");
    const id = "t5-passed";
    await seedSession(id, activeGoal);
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(after.goal?.status, "achieved");
    assert.equal(after.goal?.text, "Type-system-validate-LSP");
    const rec = await readWritebackGoalRecord(id);
    assert.equal(rec["action"], "writeback");
    assert.equal(rec["status"], "achieved");
  });

  it("outcome 'aborted' → goal.status === 'aborted' + recordGoal writeback(status: aborted)", async () => {
    setOutcome("aborted");
    const id = "t5-aborted";
    await seedSession(id, activeGoal);
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(after.goal?.status, "aborted");
    const rec = await readWritebackGoalRecord(id);
    assert.equal(rec["status"], "aborted");
  });

  it("outcome 'escalated' → goal.status === 'aborted' (NEW SC8) + recordGoal writeback(status: aborted)", async () => {
    setOutcome("escalated");
    const id = "t5-escalated";
    await seedSession(id, activeGoal);
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(after.goal?.status, "aborted");
    const rec = await readWritebackGoalRecord(id);
    assert.equal(rec["status"], "aborted");
  });

  it("outcome 'failed' → goal.status stays 'active' (self-transition skipped) + recordGoal writeback(status: active)", async () => {
    setOutcome("failed");
    const id = "t5-failed";
    await seedSession(id, activeGoal);
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(after.goal?.status, "active");
    const rec = await readWritebackGoalRecord(id);
    assert.equal(rec["status"], "active");
  });

  it("outcome 'unstable' → goal.status stays 'active' + recordGoal writeback(status: active)", async () => {
    setOutcome("unstable");
    const id = "t5-unstable";
    await seedSession(id, activeGoal);
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(after.goal?.status, "active");
    const rec = await readWritebackGoalRecord(id);
    assert.equal(rec["status"], "active");
  });

  it("outcome 'disabled' → goal.status stays 'active' (no target) + recordGoal writeback(status: active)", async () => {
    setOutcome("disabled");
    const id = "t5-disabled";
    await seedSession(id, activeGoal);
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(after.goal?.status, "active");
    const rec = await readWritebackGoalRecord(id);
    assert.equal(rec["status"], "active");
  });
});

describe("VALID_GOAL_TRANSITIONS defensive guard on write-back (post-#605)", () => {
  it("achieved goal + outcome 'failed' → 非法反向边被 assertValidTransition 拦截, status 保持 achieved, recordGoal 留痕(status: active)", async () => {
    // assertValidTransition guard on write-back (independent of any
    // lifecycle): OUTCOME_TO_STATUS target='active' is a backward edge from
    // achieved; the write-back branch is intercepted, the goal stays
    // unchanged, and only the recordGoal trace line is written.
    setOutcome("failed");
    const id = "t5-achieved-failed";
    await seedSession(id, {
      ...activeGoal,
      status: "achieved",
    });
    const hub = makeHub();
    await hub.postMessage({ conversationId: id, text: "test it" });
    const after = await load(id);
    assert.equal(
      after.goal?.status,
      "achieved",
      "achieved→active 非法反向边必须被拦截, status 保持 achieved"
    );
    const rec = await readWritebackGoalRecord(id);
    assert.equal(rec["action"], "writeback");
    assert.equal(rec["status"], "active");
  });
});
