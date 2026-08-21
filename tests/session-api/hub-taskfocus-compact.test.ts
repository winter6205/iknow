/**
 * #604 T1 (SC1-SC5): hub 接线 boundaryAttachment — 集成真实 SessionHub +
 * 真实 SessionStore (mkdtemp) + 长 messages 触发 proactive compact,断言
 * attachment user 消息在 messages 内,且为最近 ≤3 句合格用户任务原文(trim
 * 后完全相等),时间顺序最新在最后。
 *
 * 与 `hub-taskfocus-compact.test.ts` (历史版 #458 T7 SC11)对照:旧版本断言
 * 240+history+cap720 焦点渲染形态;本版断言 `[Recent user tasks] — N` +
 * 编号列表,整句进入摘录,无截断。
 *
 * 测试矩阵(spec acceptance):
 *   a. HITL + ≥3 句合格 user 任务 → attachment 含 3 句原文(trim 后相等),
 *      时间顺序最新在最后;
 *   b. HITL + 0 句合格(仅寒暄 / 仅 tool_result+drain / 0 句) → 不贴;
 *   c. auto 模式(goal active)→ 不贴(negative);
 *   d. HITL + 1 句合格 → reactive compact (flaky adapter 抛
 *      PromptTooLongError) → attachment 含该 1 句;
 *   e. HITL → 第二轮 compact → 第二段 attachment 不含第一段摘录文本
 *      (concurrent 自引用隔离)。
 *
 * harness 不 import session-api;`renderRecentUserTasksBoundary` 是 hub 内
 * 私有 closure,通过 `boundaryAttachment` 可选缝注入 runDeps。
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

// Stub runVerifyLoop BEFORE importing the hub (mirrors goal-seam.test.ts
// pattern). vi.mock is hoisted, so the mock fn must be declared via
// vi.hoisted to be initialized before the factory runs.
const { runVerifyLoopMock } = vi.hoisted(() => {
  const fn = vi.fn(
    async (opts: {
      runFn: (
        text: string,
        o?: { signal?: AbortSignal; priorMessages?: ReadonlyArray<unknown> }
      ) => Promise<{
        result: {
          readonly finalText: string | null;
          readonly messages: ReadonlyArray<unknown>;
          readonly turnCount: number;
          readonly stopReason: "completed";
          readonly lastUsage: null;
        };
        trace: unknown;
      }>;
    }) => {
      const r = await opts.runFn("ignored", {});
      return {
        result: r.result,
        trace: r.trace,
        rounds: 0,
        enabled: true,
        outcome: "passed" as const,
        records: [],
      };
    }
  );
  return { runVerifyLoopMock: fn };
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
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import { TASK_EXCERPT_PREFIX } from "../../src/session-api/turn-projection.ts";
import { PromptTooLongError } from "../../src/harness/errors.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import type {
  AnthropicContentBlock,
  AssistantTurnResult,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import type { LoopAdapter } from "../../src/harness/loop-engine.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-taskfocus-compact-"));
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

/** Build a long user message (~33 tokens via estimate: ceil(132/4) * 4/3 ≈ 44).
 *  模板采用与原版相同的 z-pad,确保 messages 估计 token > 1000 阈值,
 *  触发 proactive compact。 */
function longUserMessage(index: number): AnthropicNativeMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `prior-msg-${index} ${"z".repeat(120)}`,
      },
    ],
  };
}

/** Seed a session file with `messages` (+ optional goal for auto-mode tests). */
async function seedSession(opts: {
  readonly id: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly goal?: SessionFileV1["goal"];
}): Promise<void> {
  const base = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: opts.id,
    messages: opts.messages,
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    title: "",
    cwd: process.cwd(),
    sanitized_at: new Date().toISOString(),
    checkpoints: [],
    ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
  } satisfies Omit<SessionFileV1, never>;
  await store.save({ id: opts.id, file: base });
}

/** Extract text from a user message (first text block). */
function textOf(msg: AnthropicNativeMessage): string {
  const block = msg.content.find(
    (b): b is { type: "text"; text: string } => b.type === "text"
  );
  return block ? block.text : "";
}

/** Flaky adapter:首次 step 抛 PromptTooLongError,后续返回正常。
 *  仿 _compact-integration.test.ts:makeFlakyAdapter 形态。 */
function makeFlakyAdapter(opts: {
  readonly retryText: string;
  readonly attemptCount: { value: number };
}): LoopAdapter {
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (): AnthropicContentBlock[] => [],
    step: async (
      _state: LoopState,
      request: { readonly tools?: unknown }
    ): Promise<AssistantTurnResult> => {
      opts.attemptCount.value += 1;
      if (opts.attemptCount.value === 1) {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      // #467 step 2:full-compact 摘要轮(tools === undefined)返空文本 →
      // fallback placeholder(保留测试几何不变式)。
      if (request.tools === undefined) {
        return assistantResult({
          texts: [],
          toolCalls: [],
          supplierStop: "success",
        });
      }
      return assistantResult({
        texts: [opts.retryText],
        toolCalls: [],
        supplierStop: "success",
      });
    },
  });
}

/** 组装 reactive compact 的 deps:flaky adapter + executor/registry +
 *  compress + maxTurns=5。 */
function makeCompactDeps(opts: {
  readonly adapter: LoopAdapter;
}): import("../../src/harness/index.ts").LoopEngineDeps {
  const tool = createStubTool({ name: "noop", next: () => ({}) });
  const registry = createRegistry([tool]);
  const executor = createExecutor(registry);
  return {
    adapter: opts.adapter,
    executor,
    registry,
    maxTurns: 5,
    compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
  };
}

describe("hub boundaryAttachment 接线 — 任务摘录 compact 边界 (#604 T1 SC1-SC5)", () => {
  /**
   * Multi-turn stub responses: 20 tool-call turns + 1 completed turn.
   * Proactive compact check fires when `state.turnCount > lastCompactTurn`,
   * so the run must have at least one continuing turn (tool call) before
   * the threshold check can run on iteration 2+. The 50 prior messages
   * (~2200 estimated tokens) easily exceed the 1000-token threshold.
   */
  function buildResponses(n: number) {
    const BIG_TEXT = "payload ".repeat(40);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(
        assistantResult({
          texts: [BIG_TEXT],
          toolCalls: [{ id: `call-${i}`, name: "noop", input: { i } }],
        })
      );
    }
    out.push(
      assistantResult({
        texts: ["completed"],
        toolCalls: [],
        supplierStop: "success",
      })
    );
    return out;
  }

  it("HITL + ≥3 合格用户任务 → attachment 含 3 句原文(trim 后相等),最新在最后", async () => {
    const id = "long-with-tasks";
    // 50 条合格用户任务(每条 ~33 tokens → estimate 总 ~2200 tokens > 1000 阈值),
    // 配合 buildResponses(20) 触发 proactive compact;extractRecentUserTasks 截
    // 最近 3 句 — 即 last 3 条 prior-msg-X。
    const prior: AnthropicNativeMessage[] = Array.from({ length: 50 }, (_, i) =>
      longUserMessage(i)
    );
    await seedSession({ id, messages: prior });

    const baseDeps = makeDeps(buildResponses(20));
    const deps = {
      ...baseDeps,
      maxTurns: 30,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const verifyConfig: VerifyConfig = { command: "/bin/true" };
    const hub = new SessionHub({ store, deps, verifyConfig });

    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");

    const loaded = await store.load(id);
    // attachment 必须含 TASK_EXCERPT_PREFIX(本测试的 marker;旧 taskFocus
    // FOCUS- 标记反向 — 现在应该不出现)。
    const attachmentMsg = loaded.messages.find((m) => {
      if (m.role !== "user") return false;
      const t = textOf(m);
      return t.includes(TASK_EXCERPT_PREFIX);
    });
    expect(attachmentMsg).toBeDefined();
    const attachmentText = textOf(attachmentMsg!);

    // header line: "<prefix> — 3"
    const headerLine = attachmentText.split("\n")[0]!;
    assert.equal(
      headerLine,
      `${TASK_EXCERPT_PREFIX} — 3`,
      "header 必须为 '<prefix> — 3'"
    );

    // body 三行,原文(trim 后)相等,时间顺序最新在最后。
    const lines = attachmentText.split("\n").slice(1);
    assert.equal(lines.length, 3, "必须含 3 行编号列表");
    assert.equal(lines[0], "1. prior-msg-47 " + "z".repeat(120));
    assert.equal(lines[1], "2. prior-msg-48 " + "z".repeat(120));
    assert.equal(lines[2], "3. prior-msg-49 " + "z".repeat(120));

    // 旧 taskFocus 标记不该出现。
    assert.ok(
      !attachmentText.includes("FOCUS-"),
      "旧 taskFocus 焦点渲染标记不应出现"
    );
  });

  it("HITL + 0 句合格(仅 tool_result / drain) → 不贴 attachment", async () => {
    const id = "no-qualifying-tasks";
    // 50 条 tool_result-only user 消息 → isTurnQuery = false → extract 返回
    // [] → renderRecentUserTasksBoundary return undefined → boundaryAttachment
    // 注入文本为 undefined,no-op。
    const prior: AnthropicNativeMessage[] = Array.from(
      { length: 50 },
      (_, i) => ({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `t-${i}`,
            content: [{ type: "text", text: `result-${i}` }],
          },
        ],
      })
    );
    await seedSession({ id, messages: prior });

    const baseDeps = makeDeps(buildResponses(20));
    const deps = {
      ...baseDeps,
      maxTurns: 30,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const hub = new SessionHub({ store, deps });

    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");

    const loaded = await store.load(id);
    const serialized = JSON.stringify(loaded.messages);
    // compact 仍触发(因 50 条 tool_result user 消息长 ~3300 tokens)。
    assert.ok(
      serialized.includes("[compaction boundary — earlier messages cleared]") ||
        // #467 step 2:full-compact 摘要成功的 LLM 摘要路径同样以 SUMMARY 开头。
        serialized.includes("This session is being continued"),
      "compact 仍应触发,placeholder 或 summary 出现在 messages"
    );
    // 摘录哨兵不应出现 — 没有合格用户任务。
    assert.ok(
      !serialized.includes(TASK_EXCERPT_PREFIX),
      "0 句合格 → 不贴任务摘录段"
    );
  });

  it("auto 模式(goal active)+ ≥3 句合格 → 不贴(negative,spec SC3)", async () => {
    const id = "goal-active-skips-excerpt";
    const prior: AnthropicNativeMessage[] = Array.from({ length: 50 }, (_, i) =>
      longUserMessage(i)
    );
    await seedSession({
      id,
      messages: prior,
      goal: pinGoal({
        current: undefined,
        text: "ship the type checker",
        now: "2026-01-01T00:00:00.000Z",
      }),
    });
    const baseDeps = makeDeps(buildResponses(20));
    const deps = {
      ...baseDeps,
      maxTurns: 30,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const hub = new SessionHub({
      store,
      deps,
      verifyConfig: { command: "/bin/true" },
    });
    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");
    const loaded = await store.load(id);
    const serialized = JSON.stringify(loaded.messages);
    assert.ok(
      serialized.includes("[compaction boundary — earlier messages cleared]") ||
        serialized.includes("This session is being continued"),
      "compact 仍应触发"
    );
    // 自动模式 → 不注入 boundaryAttachment 闭包 → 摘录哨兵绝不出现。
    assert.ok(
      !serialized.includes(TASK_EXCERPT_PREFIX),
      "auto mode must NOT inject task excerpt attachment"
    );
  });

  it("超长单句:整句进入摘录,不再 240/120/720 截(spec SC4)", async () => {
    const id = "long-single-task";
    // 一条超长合格用户任务(800+ 字符)— spec 旧 240 cap 不再现,整句进入摘录。
    // 把它放在 recent 3 的最末(extractRecentUserTasks 取最近 3 合格用户任务),
    // 这样摘录 body 里就能出现它。
    const longText = "long-task " + "a".repeat(800);
    const prior: AnthropicNativeMessage[] = [
      // 47 条 z-pad 占位(撑 estimate 总量 > 1000 tokens 阈值)。
      ...Array.from({ length: 47 }, (_, i) => longUserMessage(i)),
      // 2 条短合格任务,接在 long-text 前。
      {
        role: "user",
        content: [{ type: "text", text: "task-before-long-A" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "task-before-long-B" }],
      },
      // long-text 收尾(recent 3 的最新一条)。
      {
        role: "user",
        content: [{ type: "text", text: longText }],
      },
    ];
    await seedSession({ id, messages: prior });

    const baseDeps = makeDeps(buildResponses(20));
    const deps = {
      ...baseDeps,
      maxTurns: 30,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const hub = new SessionHub({ store, deps });
    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");

    const loaded = await store.load(id);
    const attachmentMsg = loaded.messages.find((m) => {
      if (m.role !== "user") return false;
      return textOf(m).includes(TASK_EXCERPT_PREFIX);
    });
    expect(attachmentMsg).toBeDefined();
    const attachmentText = textOf(attachmentMsg!);
    // 整句进入 — 不再 240 截断。
    assert.ok(
      attachmentText.includes(longText),
      "超长单句必须整句进入摘录 (旧 240 cap 不再现)"
    );
    assert.ok(
      !attachmentText.includes("long-task " + "a".repeat(240) + "…"),
      "不应被截断 (无 ...)"
    );
  });

  it("HITL + 1 句合格 → reactive compact 触发 → attachment 含该 1 句", async () => {
    const id = "reactive-single-task";
    // 12 条 prior 消息(11 条 tool_result-only 续接 + 1 条合格 longText
    // 收尾)→ messages.length > DEFAULT_KEEP_RECENT(=6) 触发 reactive compact
    // 路径;longText 是会话里唯一一条合格用户任务 → attachment body 只含它。
    // 用 flaky adapter:首次抛 PromptTooLongError,后续返回成功(单 turn 完成)。
    const longText = "reactive-task-payload";
    const toolResultOnly = (i: number): AnthropicNativeMessage => ({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: `t-${i}`,
          content: [{ type: "text", text: `result-${i}` }],
        },
      ],
    });
    const prior: AnthropicNativeMessage[] = [
      // 11 条纯 tool_result 续接消息(> DEFAULT_KEEP_RECENT=6)。
      ...Array.from({ length: 11 }, (_, i) => toolResultOnly(i)),
      // 1 条合格 longText 收尾 — 唯一可被 extractRecentUserTasks 抽取的。
      { role: "user", content: [{ type: "text", text: longText }] },
    ];
    await seedSession({ id, messages: prior });

    const attemptCount = { value: 0 };
    const adapter = makeFlakyAdapter({ retryText: "done", attemptCount });
    const deps = makeCompactDeps({ adapter });
    const hub = new SessionHub({ store, deps });
    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");

    const loaded = await store.load(id);
    const attachmentMsg = loaded.messages.find((m) => {
      if (m.role !== "user") return false;
      return textOf(m).includes(TASK_EXCERPT_PREFIX);
    });
    expect(attachmentMsg).toBeDefined();
    const attachmentText = textOf(attachmentMsg!);
    // header = '<prefix> — 1',body = '1. reactive-task-payload'
    const headerLine = attachmentText.split("\n")[0]!;
    assert.equal(headerLine, `${TASK_EXCERPT_PREFIX} — 1`);
    assert.equal(attachmentText.split("\n")[1], "1. " + longText);
  });

  it("第二轮 compact:第二段 attachment 不含第一段摘录文本(自引用隔离 SC5)", async () => {
    const id = "two-compacts-no-self-ref";
    // 把 prior 故意组装成:长 prior 后跟一条"上一轮摘录"(self-reference
    // 候选)+ 一条新的合格用户任务。extractRecentUserTasks 必须把摘录段
    // 排除(不被当作合格用户任务),只抽到合格用户任务。
    const realTask = "real-follow-up-task";
    const previousExcerpt = `${TASK_EXCERPT_PREFIX} — 3\n1. older-task-A\n2. older-task-B\n3. older-task-C`;
    const prior: AnthropicNativeMessage[] = [
      // 47 条 z-pad 占位(撑 estimate 总量 > 1000 tokens 阈值)。
      ...Array.from({ length: 47 }, (_, i) => longUserMessage(i)),
      // 上一轮 compact 已写入的摘录段(self-reference 候选)。
      { role: "user", content: [{ type: "text", text: previousExcerpt }] },
      // 一条新的合格用户任务作为最近一条。
      { role: "user", content: [{ type: "text", text: realTask }] },
    ];
    await seedSession({ id, messages: prior });

    const baseDeps = makeDeps(buildResponses(20));
    const deps = {
      ...baseDeps,
      maxTurns: 30,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const hub = new SessionHub({ store, deps });
    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");

    const loaded = await store.load(id);
    const attachmentMsg = loaded.messages.find((m) => {
      if (m.role !== "user") return false;
      return textOf(m).includes(TASK_EXCERPT_PREFIX);
    });
    expect(attachmentMsg).toBeDefined();
    const attachmentText = textOf(attachmentMsg!);

    // 自引用隔离:body 内不能出现 previousExcerpt 内容(摘录段被排除)。
    assert.ok(
      !attachmentText.includes("older-task-A"),
      "上一轮摘录段内的合格用户任务原文不得被当作合格用户任务抽入"
    );
    assert.ok(
      !attachmentText.includes("older-task-B"),
      "上一轮摘录段内的合格用户任务原文不得被当作合格用户任务抽入"
    );
    assert.ok(
      !attachmentText.includes("older-task-C"),
      "上一轮摘录段内的合格用户任务原文不得被当作合格用户任务抽入"
    );

    // 真正的合格用户任务应被抽入。
    assert.ok(
      attachmentText.includes(realTask),
      "real-follow-up-task 应被抽入摘录"
    );

    // attachment 文本内 TASK_EXCERPT_PREFIX 仅出现 1 次(只在 header)。
    const occurrences = attachmentText.split(TASK_EXCERPT_PREFIX).length - 1;
    assert.equal(
      occurrences,
      1,
      "attachment 文本内 TASK_EXCERPT_PREFIX 必须仅出现 1 次 (header)"
    );
  });
});
