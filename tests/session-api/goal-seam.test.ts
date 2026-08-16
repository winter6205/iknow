/**
 * #408 T4 + #449 B8 (修订 per #473): verify-loop seam — userText =
 * `goal.text ?? query`. The taskFocus segment was removed from the CONSUMER
 * side (#473): taskFocus is the stable focus anchor (seeded once, never
 * switched by plain queries per OQ2), so feeding it into the verify input
 * made a new task B re-verify the stale task A and short-circuit PASS.
 * The DATA-side three-segment formula `goal.text ?? taskFocus.text ?? query`
 * (SC3, #458 T8) is UNCHANGED — see the dedicated SC3 describe block below.
 *
 * History:
 *   - #408 T4: hub.ts userText seam = `goal.text ?? query`. user_initial
 *     fixtures bound goal to verify-loop's userText.
 *   - #458 T2 (SC4): sanitize migration moved `user_initial` goals to
 *     `taskFocus` on load (the legacy propose/confirm lifecycle is gone).
 *     To keep T4 assertions valid as unit-level tests of the **seam
 *     binding** itself, fixtures in this file use `source === "user_pin"`
 *     — the only `GoalSource` value that survives load as a goal (SC1).
 *   - #449 B8: hub.ts userText seam 升级到三段 fallback
 *     (`goal.text ?? taskFocus.text ?? query`)。
 *   - #473 (this revision): 消费端 taskFocus 段移除 → `goal.text ?? query`。
 *     原因:taskFocus 稳定焦点锚导致新任务被旧焦点遮蔽。
 *
 * DATA-side three-segment formula 仍由本文件独立断言 (从 loaded session
 * 派生 final-task-text,不经过 verify-loop seam),与 CONSUMER-side seam
 * 测试互不重叠,两条测试线并行守护。
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub runVerifyLoop BEFORE importing the hub. vi.mock is hoisted to the
// top of the file, so the mock fn + captured state must be declared via
// vi.hoisted to be initialized before the factory runs.
const { runVerifyLoopMock, getLastVerifyLoopOpts } = vi.hoisted(() => {
  let lastOpts: unknown = undefined;
  const fn = vi.fn(async (opts: unknown) => {
    lastOpts = opts;
    // Disable outcome: the test seam returns passed after a single round.
    const o = opts as {
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
    };
    const r = await o.runFn("ignored-then-overridden-by-userText", {});
    return {
      result: r.result,
      trace: r.trace,
      rounds: 0,
      enabled: true,
      outcome: "passed",
      records: [],
    };
  });
  return {
    runVerifyLoopMock: fn,
    getLastVerifyLoopOpts: () => lastOpts,
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
  pinGoal,
  resolveProjectSessionDir,
  SessionStore,
  type GoalState,
  type SessionFileV1,
  type TaskFocusState,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-goalseam-"));
  resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

async function seedSession(opts: {
  readonly id: string;
  readonly goal?: GoalState;
  readonly taskFocus?: TaskFocusState;
}): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  const base = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: opts.id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    summary: "",
    cwd: process.cwd(),
    sanitized_at: now,
    checkpoints: [],
  } satisfies Omit<SessionFileV1, "goal" | "taskFocus">;
  await store.save({
    id: opts.id,
    file:
      opts.goal !== undefined || opts.taskFocus !== undefined
        ? ({
            ...base,
            ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
            ...(opts.taskFocus !== undefined
              ? { taskFocus: opts.taskFocus }
              : {}),
          } as SessionFileV1)
        : (base as SessionFileV1),
  });
}

function makeHub(): SessionHub {
  // verifyConfig present → runVerifyLoop is invoked. The command is
  // irrelevant because runVerifyLoop itself is stubbed; the mock just
  // captures the userText and calls runFn directly.
  const verifyConfig: VerifyConfig = { command: "/bin/true" };
  return new SessionHub({
    store,
    deps: makeDeps([assistantResult({ texts: ["ok"] })]),
    verifyConfig,
  });
}

function capturedUserText(): string {
  const opts = getLastVerifyLoopOpts() as { userText?: unknown } | undefined;
  assert.ok(opts !== undefined, "runVerifyLoop was not called");
  assert.equal(
    typeof opts.userText,
    "string",
    `expected string userText, got ${typeof opts.userText}`
  );
  return opts.userText as string;
}

describe("verify-loop seam: userText = goal.text ?? query (#408 T4 / #458 T8)", () => {
  it("session carrying user_pin goal.text binds userText === goal.text (NOT current query)", async () => {
    const id = "goal-bearing";
    // #458 T2 (SC4): use user_pin so the goal survives sanitize (user_initial
    // would migrate to taskFocus on load).
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "Type-system-validate-LSP",
        now: "2026-01-01T00:00:00.000Z",
      }),
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "test it",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Type-system-validate-LSP",
      "session goal must bind to verify-loop userText"
    );
  });

  it("session without goal → userText === query (byte-identical to pre-#408)", async () => {
    const id = "no-goal-baseline";
    await seedSession({ id });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "build the thing",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "build the thing");
  });

  it("goal.text === '' falls back to query (defensive — empty goal must NOT be re-fed)", async () => {
    const id = "empty-goal-text";
    await seedSession({
      id,
      goal: {
        text: "",
        source: "user_pin",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [
          {
            text: "previous-pinned-text",
            source: "user_pin",
            status: "superseded",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "non-empty query",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "non-empty query");
  });

  it("user_pin goal persists across the turn (no overwrite from conditionalSave's seed path)", async () => {
    const id = "goal-persistence";
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "Type-system-validate-LSP",
        now: "2026-01-01T00:00:00.000Z",
      }),
    });
    const hub = makeHub();
    await hub.postMessage({
      conversationId: id,
      text: "test it",
    });
    const after = await store.load(id);
    assert.equal(after.goal?.text, "Type-system-validate-LSP");
    assert.equal(after.goal?.source, "user_pin");
  });

  // -- #449 B8 (SC5, 修订 per #473): userText 消费端公式
  // `goal.text ?? query`。taskFocus 段已从 verify 输入移除 (#473 根因:
  // taskFocus 是稳定焦点锚,喂进 verify 会让新任务被旧焦点遮蔽而误判
  // PASS)。数据侧三段公式(SC3)见下方独立 describe 块,不受影响。
  // empty-goal-skip 纪律不变(空文本不喂 verify-loop)。

  it("goal absent + taskFocus present → userText === query (taskFocus 不遮蔽当前 query, #473)", async () => {
    const id = "taskfocus-binds";
    await seedSession({
      id,
      taskFocus: {
        text: "TF: implement AST visitors",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "Q",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Q",
      "goal 缺席 + taskFocus 在场 → userText 应取当前 query (taskFocus 不进 verify 输入, #473)"
    );
  });

  it("goal.text === '' + taskFocus present → userText === query (空 goal 按缺席算 → 兜底 query, #473)", async () => {
    const id = "empty-goal-taskfocus-binds";
    await seedSession({
      id,
      goal: {
        text: "",
        source: "user_pin",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
      taskFocus: {
        text: "TF takes over empty goal",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "Q",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Q",
      "goal.text === '' 跳过第一段 → 兜底 query (taskFocus 不进 verify 输入, #473)"
    );
  });

  it("taskFocus.text === '' → falls back to query (空 taskFocus 不进 verify 输入, #449 B8)", async () => {
    const id = "empty-taskfocus";
    await seedSession({
      id,
      taskFocus: {
        text: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const hub = makeHub();
    const res = await hub.postMessage({
      conversationId: id,
      text: "Q",
    });
    assert.equal(res.turn.answer.stopReason, "completed");
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "Q", "taskFocus.text === '' → 兜底 query");
  });
});

// -- #458 T8 (SC3 acceptance) ---------------------------------------------
//
// SC3 任务公式: `goal.text ?? taskFocus.text ?? query` 数据侧就位
// (供 #449 B8 在消费端接入)。本块独立断言 数据侧 三段 fallback,
// 不走 verify-loop seam — 用 `store.load` 直接读盘,从 loaded.session
// 派生 final-task-text,验证三段优先级一致。
//
// 这把 consumer-side upgrade 留给 #449 B8 (hub.ts userText 缝加 taskFocus 段)
// 而不阻塞 #458 T8 的回归矩阵收尾。

describe("SC3 data-side three-segment fallback: goal.text ?? taskFocus.text ?? query (#458 T8)", () => {
  it("仅 taskFocus 在场 → final-task-text === taskFocus.text (goal 缺席走第二段)", async () => {
    const id = "taskfocus-only";
    await seedSession({
      id,
      taskFocus: {
        text: "TF: implement AST visitors",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const loaded = await store.load(id);
    const query = "Q";
    const finalTaskText = loaded.goal?.text ?? loaded.taskFocus?.text ?? query;
    assert.equal(finalTaskText, "TF: implement AST visitors");
  });

  it("仅 goal 在场 → final-task-text === goal.text (第一段命中)", async () => {
    const id = "goal-only";
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "G: ship plan 458",
        now: "2026-01-01T00:00:00.000Z",
      }),
    });
    const loaded = await store.load(id);
    const query = "Q";
    const finalTaskText = loaded.goal?.text ?? loaded.taskFocus?.text ?? query;
    assert.equal(finalTaskText, "G: ship plan 458");
  });

  it("两者皆缺席 → final-task-text === query (兜底段)", async () => {
    const id = "neither";
    await seedSession({ id });
    const loaded = await store.load(id);
    const query = "Q";
    const finalTaskText = loaded.goal?.text ?? loaded.taskFocus?.text ?? query;
    assert.equal(finalTaskText, "Q");
  });

  it("goal 与 taskFocus 共存 → final-task-text === goal.text (第一段优先)", async () => {
    const id = "both-present";
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "G dominates",
        now: "2026-01-01T00:00:00.000Z",
      }),
      taskFocus: {
        text: "TF subordinate",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const loaded = await store.load(id);
    const query = "Q";
    const finalTaskText = loaded.goal?.text ?? loaded.taskFocus?.text ?? query;
    assert.equal(finalTaskText, "G dominates");
    // 顺序敏感:反转测试,确保是 `goal ?? taskFocus ?? query`,不是别的顺序。
    const reversed = loaded.taskFocus?.text ?? loaded.goal?.text ?? query;
    assert.notEqual(reversed, "G dominates");
  });

  it("goal.text === '' → literal `??` chain yields '' (nullish vs empty-string semantics; consumer skip owned by #449 B8)", async () => {
    const id = "empty-goal-but-taskfocus";
    await seedSession({
      id,
      goal: {
        text: "",
        source: "user_pin",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
      taskFocus: {
        text: "TF takes over empty goal",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const loaded = await store.load(id);
    const query = "Q";
    // 数据侧公式是 `??` 空值合并:`''` 不是 nullish,因此空字符串会“占住”
    // 第一段而不落入 taskFocus。empty-goal-skip 属于消费端语义
    // (hub.ts userText 需 `text.length > 0` 判断),由 #449 B8 决定。
    const finalTaskText = loaded.goal?.text ?? loaded.taskFocus?.text ?? query;
    assert.equal(finalTaskText, "");
    assert.equal(loaded.taskFocus?.text, "TF takes over empty goal");
  });
});
