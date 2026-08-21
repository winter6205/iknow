/**
 * #458 T5 (SC8): verify-loop outcome → goal.status write-back + recordGoal trace.
 *
 * The hub is the ONLY writer of goal.status. The OUTCOME_TO_STATUS data table
 * maps each VerifyLoopOutcome to a target status:
 *
 *   passed    → "achieved"
 *   aborted   → "aborted"
 *   escalated → "aborted"   (NEW in #458 SC8; pre-#458 kept active)
 *   failed    → "active"    (no status change; trace 留痕)
 *   unstable  → "active"    (no status change; trace 留痕)
 *   disabled  → undefined   (no status change; trace 留痕)
 *
 * `applyTransition` runs only when target is a valid forward edge from current
 * (T3 assertValidTransition rejects self-transitions, so active→active etc.
 * are no-ops). recordGoal fires for every outcome with a goal present
 * (write-back trace 留痕 even when no status change).
 *
 * Fixture: a user-pinned active goal (source === "user_pin") survives
 * sanitize-on-load (#605 T2 retired the taskFocus field — no seed path, so a
 * fresh session has neither goal nor taskFocus and writeback is inapplicable).
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
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
  // traceOut 指向同一个临时根; hub-violation.test.ts 同模式。
  traceDir = baseDir;
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const activeGoal: GoalState = {
  text: "Type-system-validate-LSP",
  // SC8: fixture 用 user_pin (sanitize 保留 user_pin 顶点, user_initial 顶点会
  // 被 T2 sanitize 迁移到 taskFocus); writeback 路径只作用于显式 pin 的 goal。
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
  const tracePath = join(traceDir, `${conversationId}.jsonl`);
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

describe("post-#605 T2: no taskFocus seed on fresh session (seed path retired)", () => {
  it("fresh session: no taskFocus on disk and NO goal seed trace record", async () => {
    // #458 T5 SC2 seeded taskFocus on the first postMessage; #605 T2
    // retired the field — conditionalSave only merges messages/turnCount/
    // title. The T12 `action=seed` trace emission point is gone with it.
    const id = "t5-fresh-seed";
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
      } as SessionFileV1,
    });
    const hub = new SessionHub({
      store,
      deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      traceOut: traceDir,
    });
    await hub.postMessage({ conversationId: id, text: "Build a thing" });
    const after = await load(id);
    assert.equal(after.goal, undefined, "fresh session must NOT seed goal");
    assert.equal(
      (after as unknown as Record<string, unknown>)["taskFocus"],
      undefined,
      "#605 T2: taskFocus seed path is gone"
    );
    // The seed 发射点 must not fire: no action="seed" goal record in trace.
    const tracePath = join(traceDir, `${id}.jsonl`);
    let raw = "";
    try {
      raw = await readFile(tracePath, "utf8");
    } catch {
      raw = ""; // no trace file at all is also a valid "no seed" outcome
    }
    const seedLines = raw
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .filter((l) => l.includes('"record_type":"goal"'))
      .filter((l) => l.includes('"action":"seed"'));
    assert.equal(
      seedLines.length,
      0,
      `no goal seed record expected, got: ${raw}`
    );
  });

  it("achieved goal + outcome 'failed' → 非法反向边被 assertValidTransition 拦截, status 保持 achieved, recordGoal 留痕(status: active)", async () => {
    // Reviewer 补强（standards+spec 双轴同指）：OUTCOME_TO_STATUS 的
    // target="active"（failed/unstable 保持态）对已 achieved 的 goal 是
    // 非法反向边（achieved→active 不在 VALID_GOAL_TRANSITIONS）。write-back
    // 分支经 assertValidTransition 守卫拦截，goal 不变，仅 recordGoal trace 留痕。
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
    // trace 仍留痕（writeback action, status 报当前 active 目标）。
    const rec = await readWritebackGoalRecord(id);
    assert.equal(rec["action"], "writeback");
    assert.equal(rec["status"], "active");
  });
});
