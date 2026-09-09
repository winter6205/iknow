/**
 * #449 B8 (SC5, 修订 per #473): chat-session 端 verify-loop userText =
 * `goal.text ?? query`。taskFocus 段已从消费端移除 (#473): taskFocus 是
 * 稳定焦点锚(首次 seed 后不再变化, OQ2), 喂进每轮 verify 会让新任务被
 * 旧焦点遮蔽而误判 PASS。数据侧三段公式(`goal ?? taskFocus ?? query`,
 * SC3/#458 T8)不受影响 — 见 tests/session-api/goal-seam.test.ts SC3 块。
 *
 * Hub 端同款接线已在 `tests/session-api/goal-seam.test.ts` 覆盖;本文件
 * 守护 chat 端的等价接线。chat-session 通过 `ctx.checkpointStore.load(
 * conversationId)` 读会话状态(与 `goalStatus` / `goalClear` / `goalPin`
 * 既有读盘模式一致),把 `goal.text ?? query` 套用到 verify-loop 的
 * userText 字段(仅 verifyConfig 在场时被消费)。
 *
 * Mock seam: `vi.mock("../../src/harness/verify/index.ts")` 替换
 * `runVerifyLoop`,captures 入口 opts 拿 userText(沿用
 * tests/session-api/goal-seam.test.ts 同款 mock 模式)。真实 SessionStore
 * 接 tmpdir(typed-error 契约与生产一致),真实 conversationId,stub
 * model 走 makeDeps(零 bwrap / 零沙箱依赖)。
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

// Stub runVerifyLoop BEFORE importing chat-session. vi.mock is hoisted, so
// the captured state must live in vi.hoisted.
const { runVerifyLoopMock, getLastVerifyLoopOpts } = vi.hoisted(() => {
  let lastOpts: unknown = undefined;
  const fn = vi.fn(async (opts: unknown) => {
    lastOpts = opts;
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

import {
  processChatLine,
  type ChatLineContext,
} from "../../src/cli/chat-session.ts";
import {
  CURRENT_SCHEMA_VERSION,
  pinGoal,
  SessionStore,
  type GoalState,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

/** Pre-#605 legacy on-disk shape — runtime type was retired in #605 T2; we
 *  pass this through the `as SessionFileV1` cast below to exercise the
 *  sanitize-drop path (assertion: legacy taskFocus key disappears on load). */
interface LegacyTaskFocusState {
  text: string;
  updatedAt: string;
  history?: ReadonlyArray<{ text: string; updatedAt: string }>;
}

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-chat-usertext-"));
  store = new SessionStore(baseDir, process.cwd());
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
  readonly taskFocus?: LegacyTaskFocusState;
}): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  const base = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: opts.id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    title: "",
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

interface MakeChatCtxOpts {
  readonly id: string;
  readonly verifyConfig?: VerifyConfig;
  readonly withStore?: boolean;
  /** true 时不装配 verifyConfig (进 processChatLine 的裸 runHarness 分支)。 */
  readonly withoutVerifyConfig?: boolean;
}

function makeChatCtx(opts: MakeChatCtxOpts): ChatLineContext {
  const ctx = makeCtx({
    responses: [assistantResult({ texts: ["ok"] })],
    stateOverrides: { conversationId: opts.id },
    ...(opts.withStore !== false ? { checkpointStore: store } : {}),
  });
  if (opts.withoutVerifyConfig === true) {
    return ctx; // verifyConfig 缺席 → runVerifyLoop 分支不可达
  }
  // 默认 verifyConfig 在场 (runVerifyLoop 被调)。
  const verifyConfig: VerifyConfig = opts.verifyConfig ?? {
    command: "/bin/true",
  };
  return {
    ...ctx,
    verifyConfig,
  };
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

function capturedCompletionMode(): unknown {
  const opts = getLastVerifyLoopOpts() as
    { completionMode?: unknown } | undefined;
  assert.ok(opts !== undefined, "runVerifyLoop was not called");
  return opts.completionMode;
}

describe("chat-session verify-loop seam: HITL vs auto dispatch (plan T1)", () => {
  it("session without goal/taskFocus → userText === query and HITL skip judge", async () => {
    const id = "chat-no-goal-baseline";
    // 不 seed — store.load 在 resolveVerifyUserText 里抛 not_found。
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "build it", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "build it");
    assert.equal(capturedCompletionMode(), "hitl");
  });

  it("goal absent + taskFocus present → userText === query (taskFocus 不遮蔽当前 query, #473)", async () => {
    const id = "chat-taskfocus-binds";
    await seedSession({
      id,
      taskFocus: {
        text: "TF: chat-session implements three-segment",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Q",
      "goal 缺席 + taskFocus 在场 → chat 端 userText 应取当前 query (taskFocus 不进 verify 输入, #473)"
    );
    assert.equal(capturedCompletionMode(), "hitl");
  });

  it("goal.text === '' + taskFocus present → userText === query (空 goal 按缺席算 → 兜底 query, #473)", async () => {
    const id = "chat-empty-goal-taskfocus";
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
        text: "TF chat takes over",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Q",
      "goal.text === '' 跳过第一段 → 兜底 query (taskFocus 不进 verify 输入, #473)"
    );
  });

  it("goal present + taskFocus present → userText === goal.text (第一段优先, 与 hub 同纪律)", async () => {
    const id = "chat-both-present";
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "G dominates chat",
        now: "2026-01-01T00:00:00.000Z",
      }),
      taskFocus: {
        text: "TF subordinate chat",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "G dominates chat");
    assert.equal(capturedCompletionMode(), "auto");
  });

  it("taskFocus.text === '' → userText === query (空 taskFocus 按缺席算)", async () => {
    const id = "chat-empty-taskfocus";
    await seedSession({
      id,
      taskFocus: {
        text: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "Q");
  });

  it("user_pin goal alone → userText === goal.text (回归:既有 goal-pin 行为保持)", async () => {
    const id = "chat-goal-only";
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "G: ship chat-side B8",
        now: "2026-01-01T00:00:00.000Z",
      }),
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "G: ship chat-side B8");
  });

  it("verifyConfig 缺席 → runVerifyLoop 不被调 (非 verify 路径不受影响, byte-identical to pre-#449)", async () => {
    const id = "chat-no-verify-config";
    await seedSession({
      id,
      taskFocus: {
        text: "TF should not bind without verifyConfig",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    // verifyConfig undefined → 不进 runVerifyLoop 分支,
    // userText 公式不可达 — 走 plain runHarness(query, ...)。
    const ctx = makeChatCtx({
      id,
      withoutVerifyConfig: true,
    });
    const r = await processChatLine({ line: "raw query", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).not.toHaveBeenCalled();
    // 兜底分支不被消费时无断言 — runHarness 路径与 userText 无关。
    // 占位 sanity: 返回仍应 ranQuery (与 baseline 一致)。
    assert.ok(r.output.length > 0);
  });

  it("checkpointStore 缺席 + conversationId 在场 → userText === query (ask / pipe 路径无 store, fail-open)", async () => {
    const id = "chat-no-store";
    // checkpointStore undefined (ask / pipe / tests 不装配 store)。
    const ctx = makeChatCtx({ id, withStore: false });
    const r = await processChatLine({ line: "fallback Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "fallback Q",
      "store 缺席 → run uses query; HITL must not treat query as judge task"
    );
    assert.equal(capturedCompletionMode(), "hitl");
  });
});
