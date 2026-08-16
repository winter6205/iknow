/**
 * #458 T8: reactive compact + boundaryAttachment 注入 — 真实 SessionHub +
 * 真实 SessionStore (temp dir) + flaky adapter (首次抛 PromptTooLongError)。
 *
 * 与 `hub-taskfocus-compact.test.ts` (T7) 互补:T7 走 proactive compact
 * (长 messages 阈值触发);本文件专测 **reactive** 路径 (ADR-0013:
 * adapter 抛 PromptTooLongError → loop-engine 兜底 compact 一次 →
 * boundaryAttachment 渲染文本作为 user 消息注入 placeholder 之后)。
 *
 * 覆盖:
 *   a. taskFocus 在场 + 首轮 adapter 抛 PromptTooLongError → reactive
 *      compact 触发 → compact 后重试成功 (completed) → 落盘 messages 含
 *      boundary placeholder + attachment user 消息 (焦点/历史渲染文本);
 *   b. 普通 turn (taskFocus 在场 + adapter 正常完成) → compact 不触发 →
 *      boundaryAttachment 不注入 (SC11 no-op guard);
 *   c. taskFocus undefined + flaky adapter → reactive compact 仍触发
 *      (loop-engine 层不依赖 taskFocus) → 占位符存在但 attachment 缺席
 *      (hub 只在 taskFocus 在场时注入 boundaryAttachment 闭包)。
 *
 * 装配:deps 注入 flaky LoopAdapter (makeFlakyAdapter 同 harness
 * integration.test.ts) + compress 配置 + maxTurns;hub.postMessage 走
 * 真实 run() 回路。
 */
import { afterAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
  type TaskFocusState,
} from "../../src/session-api/store/index.ts";
import { PromptTooLongError } from "../../src/harness/errors.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopAdapter,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import { COMPACTION_BOUNDARY_PLACEHOLDER } from "../../src/harness/compress/index.ts";

const baseDirs: string[] = [];

async function storeFor(): Promise<{ store: SessionStore; baseDir: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), "iknow-compact-int-"));
  baseDirs.push(baseDir);
  return { store: new SessionStore(baseDir, process.cwd()), baseDir };
}

afterAll(async () => {
  for (const dir of baseDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** 渲染文本固定值(与 hub.renderTaskFocusBoundary 输出形态对齐,用于断言)。 */
const BOUNDARY_TEXT = "current-focus\n---\nh1";

/** Flaky adapter:首次 step 抛 PromptTooLongError,后续返回正常。 */
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
      _request: unknown
    ): Promise<AssistantTurnResult> => {
      opts.attemptCount.value += 1;
      if (opts.attemptCount.value === 1) {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      return assistantResult({
        texts: [opts.retryText],
        toolCalls: [],
        supplierStop: "success",
      });
    },
  });
}

/** 正常 adapter (每次 step 都返回成功文本)。 */
function makeOkAdapter(text: string): LoopAdapter {
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (): AnthropicContentBlock[] => [],
    step: async (): Promise<AssistantTurnResult> =>
      assistantResult({
        texts: [text],
        toolCalls: [],
        supplierStop: "success",
      }),
  });
}

/** 组装 hub 的 deps:flaky/ok adapter + executor/registry + compress + maxTurns。 */
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

/** 预置带 taskFocus + 长 messages 的 session 文件 (触发 reactive compact:
 *  compactMessages 要求 messages.length > DEFAULT_KEEP_RECENT (= 6),
 *  这里放 12 条 plain user text,run 会追加 query → state = 13 > 6
 *  → reactive compact 实际触发 → boundaryAttachment 注入)。 */
async function seedSessionWithFocus(
  store: SessionStore,
  id: string,
  taskFocus: TaskFocusState
): Promise<void> {
  const now = new Date().toISOString();
  const prior: AnthropicNativeMessage[] = Array.from(
    { length: 12 },
    (_, i) => ({
      role: "user",
      content: [{ type: "text", text: `prior-${i} ${"z".repeat(20)}` }],
    })
  );
  await store.save({
    id,
    file: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: prior,
      jsonMode: false,
      turnCount: 12,
      updatedAt: now,
      summary: "",
      cwd: process.cwd(),
      sanitized_at: now,
      checkpoints: [],
      taskFocus,
    } satisfies SessionFileV1,
  });
}

/** 预置带长 messages 但无 taskFocus 的 session 文件 (reactive compact 触发
 *  但 boundaryAttachment 不注入)。 */
async function seedSessionWithoutFocus(
  store: SessionStore,
  id: string
): Promise<void> {
  const now = new Date().toISOString();
  const prior: AnthropicNativeMessage[] = Array.from(
    { length: 12 },
    (_, i) => ({
      role: "user",
      content: [{ type: "text", text: `prior-${i} ${"z".repeat(20)}` }],
    })
  );
  await store.save({
    id,
    file: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages: prior,
      jsonMode: false,
      turnCount: 12,
      updatedAt: now,
      summary: "",
      cwd: process.cwd(),
      sanitized_at: now,
      checkpoints: [],
    } satisfies SessionFileV1,
  });
}

/** 从 messages 抽取纯文本 user 消息内容 (首个 text block)。 */
function textOf(msg: AnthropicNativeMessage): string {
  const block = msg.content.find(
    (b): b is { type: "text"; text: string } => b.type === "text"
  );
  return block ? block.text : "";
}

describe("reactive compact + boundaryAttachment (#458 T8)", () => {
  it("taskFocus 在场 + flaky adapter → reactive compact 触发 → 落盘 messages 含 placeholder + attachment", async () => {
    const { store } = await storeFor();
    const id = "reactive-with-focus";
    await seedSessionWithFocus(store, id, {
      text: "current-focus",
      updatedAt: "2026-01-01T00:00:00.000Z",
      history: [{ text: "h1", updatedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const attemptCount = { value: 0 };
    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({
        adapter: makeFlakyAdapter({
          retryText: "done after compact",
          attemptCount,
        }),
      }),
    });
    const res = await hub.postMessage({ conversationId: id, text: "go" });
    expect(res.turn.answer.stopReason).toBe("completed");
    // 首次抛 + 重试成功 = step 被调 2 次。
    expect(attemptCount.value).toBe(2);

    // 从 store 读回:reactive compact 触发后 result.messages 落盘,
    // boundaryAttachment 注入的 user 消息应在 placeholder 之后。
    const loaded = await store.load(id);
    expect(loaded.messages.length).toBeGreaterThan(0);
    expect(textOf(loaded.messages[0]!)).toContain(
      COMPACTION_BOUNDARY_PLACEHOLDER
    );
    // messages[1] 是 attachment user 消息(renderTaskFocusBoundary 文本)。
    // 焦点截 240 + 历史截 120 + cap 3 的具体 truncation 已由
    // hub-taskfocus-compact.test.ts (T7) 覆盖;这里只断言渲染文本确实注入。
    expect(textOf(loaded.messages[1]!)).toContain("current-focus");
    expect(textOf(loaded.messages[1]!)).toContain("h1");
  });

  it("taskFocus undefined + flaky adapter → reactive compact 仍触发 → placeholder 有、attachment 无", async () => {
    const { store } = await storeFor();
    const id = "reactive-no-focus";
    // 不预置 taskFocus → hub 不注入 boundaryAttachment 闭包;仍预置长
    // messages 让 reactive compact 真正触发 (state > keepRecent)。
    await seedSessionWithoutFocus(store, id);
    const attemptCount = { value: 0 };
    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({
        adapter: makeFlakyAdapter({ retryText: "done", attemptCount }),
      }),
    });
    const res = await hub.postMessage({ conversationId: id, text: "go" });
    expect(res.turn.answer.stopReason).toBe("completed");
    expect(attemptCount.value).toBe(2);

    const loaded = await store.load(id);
    expect(loaded.messages.length).toBeGreaterThan(0);
    expect(textOf(loaded.messages[0]!)).toContain(
      COMPACTION_BOUNDARY_PLACEHOLDER
    );
    // attachment 由 boundaryAttachment 渲染;taskFocus undefined → 不注入。
    const allText = loaded.messages.map((m) => textOf(m)).join("\n");
    expect(allText).not.toContain("current-focus");
  });

  it("普通 turn (taskFocus 在场 + ok adapter) → compact 不触发 → attachment 不注入", async () => {
    const { store } = await storeFor();
    const id = "normal-no-compact";
    await seedSessionWithFocus(store, id, {
      text: "current-focus",
      updatedAt: "2026-01-01T00:00:00.000Z",
      history: [],
    });
    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({ adapter: makeOkAdapter("ok") }),
    });
    const res = await hub.postMessage({ conversationId: id, text: "go" });
    expect(res.turn.answer.stopReason).toBe("completed");
    // compact 未触发 → 无 placeholder,也无 attachment 渲染文本。
    const loaded = await store.load(id);
    const allText = loaded.messages.map((m) => textOf(m)).join("\n");
    expect(allText).not.toContain(COMPACTION_BOUNDARY_PLACEHOLDER);
    expect(allText).not.toContain("current-focus");
  });

  it("reactive compact 后 taskFocus 保留 (conditionalSave 不清空渲染源)", async () => {
    const { store } = await storeFor();
    const id = "reactive-preserves-focus";
    await seedSessionWithFocus(store, id, {
      text: "current-focus",
      updatedAt: "2026-01-01T00:00:00.000Z",
      history: [],
    });
    const attemptCount = { value: 0 };
    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({
        adapter: makeFlakyAdapter({ retryText: "done", attemptCount }),
      }),
    });
    const res = await hub.postMessage({ conversationId: id, text: "go" });
    expect(res.turn.answer.stopReason).toBe("completed");
    const loaded = await store.load(id);
    // reactive compact 只处理 messages;taskFocus 是持久化字段,必须保留
    // (否则下一轮 boundaryAttachment 渲染源丢失)。
    expect(loaded.taskFocus?.text).toBe("current-focus");
    assert.equal(loaded.taskFocus?.history?.length, 0);
  });
});
