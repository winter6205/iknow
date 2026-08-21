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
      request: { readonly tools?: unknown }
    ): Promise<AssistantTurnResult> => {
      opts.attemptCount.value += 1;
      if (opts.attemptCount.value === 1) {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      // #467 step 2:full-compact 摘要轮(tools === undefined)返回空文本 →
      // empty_response → fallback placeholder(保留本组测试的几何不变式)。
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
      title: "",
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
      title: "",
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

/**
 * plan compress-trigger-gate T2:hub.compactSession 接入 token-gate + reason
 * 透传。3 case 覆盖 token 未达阈值、full summary 路径、runFullCompact 抛错。
 * 装配模式沿用既有的 `makeCompactDeps`(真实 SessionStore + temp dir + 真
 * conversationId,贴合 typed-error catch 契约测试矩阵 — `test.md`「命令 handler
 * 集成测试必须接真实 store + fresh conversationId」)。
 */

/** 让 runFullCompact 成功的 adapter (返回固定 summary 文本)。 */
function makeSummarizeAdapter(opts: {
  readonly summaryText: string;
}): LoopAdapter {
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (): AnthropicContentBlock[] => [],
    step: async (): Promise<AssistantTurnResult> =>
      assistantResult({
        texts: [
          `<analysis>scratchpad</analysis>\n<summary>${opts.summaryText}</summary>`,
        ],
        toolCalls: [],
        supplierStop: "success",
      }),
  });
}

/** 让 runFullCompact 抛错的 adapter — step() throws,触发 adapter_failed outcome。 */
function makeThrowingAdapter(message: string): LoopAdapter {
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (): AnthropicContentBlock[] => [],
    step: async (): Promise<AssistantTurnResult> => {
      throw new Error(message);
    },
  });
}

/** 预置带指定 messages 的 session 文件(不带 taskFocus,纯 compact 路径)。 */
async function seedSession(
  store: SessionStore,
  id: string,
  messages: ReadonlyArray<AnthropicNativeMessage>
): Promise<void> {
  const now = new Date().toISOString();
  await store.save({
    id,
    file: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      messages,
      jsonMode: false,
      turnCount: 0,
      updatedAt: now,
      title: "",
      cwd: process.cwd(),
      sanitized_at: now,
      checkpoints: [],
    } satisfies SessionFileV1,
  });
}

describe("plan compress-trigger-gate T2: hub.compactSession token-gate + reason 透传", () => {
  it("fresh session 消息 ≤ 6 + 低 token → compacted:false + reason:below_token_threshold", async () => {
    // 3 条 100-char 短消息 → 单条 estimate = floor(103/4) = 25;
    // 总 raw ≈ 75 → estimate ≈ 100;thresholdTokens=10_000 远高于 estimate →
    // evaluateCompactTrigger → action=noop,reason=below_token_threshold。
    // fresh conversationId:不预存 session 文件,store.load 抛 not_found 是真实边界;
    // 本 case 用 seedSession 注入 3 条以构造"非空 + 低 token"组合。
    const { store } = await storeFor();
    const id = "below-threshold";
    const messages = Array.from({ length: 3 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `msg-${i}` }],
    }));
    await seedSession(store, id, messages);

    // 即使有 adapter,noop 路径不会调到(runFullCompact / compactMessages 都不进)。
    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({ adapter: makeOkAdapter("ok") }),
    });
    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(false);
    assert.equal(res.reason, "below_token_threshold");
    assert.equal(res.beforeCount, 3);
    assert.equal(res.afterCount, 3);
    // 不落盘 — updatedAt 不变;no-op 边界。
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 3);
  });

  it("5 条 + 高 token (每条灌 50k chars) → compacted:true + reason:full_summary", async () => {
    // 5 条 50_000-char 文本 → 单条 estimate = floor(50_003/4) = 12_500;
    // 总 raw = 62_500 → estimate ≈ 83_333;thresholdTokens=10_000 远低于 →
    // 走 token 已超分支。messages.length=5 ≤ DEFAULT_KEEP_RECENT=6 → slicedFrom=0
    // → compact_via_full_summary / messages_too_few。runFullCompact 成功 →
    // reason 强制 full_summary。
    const { store } = await storeFor();
    const id = "full-summary-path";
    const messages = Array.from({ length: 5 }, () => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x".repeat(50_000) }],
    }));
    await seedSession(store, id, messages);

    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({
        adapter: makeSummarizeAdapter({ summaryText: "sum-body" }),
      }),
    });
    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(true);
    assert.equal(res.reason, "full_summary");
    assert.equal(res.beforeCount, 5);
    // 落盘后 = [summaryUserMessage] + 0 tail = 1 条。
    assert.equal(res.afterCount, 1);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 1);
    const firstText = textOf(loaded.messages[0]!);
    assert.ok(firstText.includes("This session is being continued"));
    assert.ok(firstText.includes("sum-body"));
  });

  it("runFullCompact 抛错 → compacted:false + reason:messages_too_few", async () => {
    // 5 条高 token + adapter 抛错 → evaluateCompactTrigger 仍判 full_summary →
    // split = { dropped: before, kept: [] } → runFullCompact 走 throwing adapter
    // 返回 { kind: "adapter_failed" } → nextMessages 仍 undefined →
    // compactMessages(before) 因 slicedFrom=0 返回原数组(5 条)== before.length →
    // 走 messages_too_few 路径。compacted:false + 不落盘。
    const { store } = await storeFor();
    const id = "throw-full-compact";
    const messages = Array.from({ length: 5 }, () => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x".repeat(50_000) }],
    }));
    await seedSession(store, id, messages);

    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({
        adapter: makeThrowingAdapter("synthetic full-compact throw"),
      }),
    });
    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(false);
    assert.equal(res.reason, "messages_too_few");
    assert.equal(res.beforeCount, 5);
    assert.equal(res.afterCount, 5);
    // 不落盘(messages_too_few 路径与 no-op 一致:不 bump updatedAt)。
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 5);
  });

  // plan review-fix:补齐 test.md 「命令 handler 集成测试必须接真实 store +
  // fresh conversationId」与「fresh conversation 上的合法态与真实故障必须
  // 区分」要求 — 此前 3 个 case 都用 seedSession 预存文件,从未触达
  // store.load(id) 抛 not_found 的真实 typed-error 边界。
  it("review-fix: fresh conversationId (store.load raises not_found) → serialize 队列拒绝,hub 不落盘", async () => {
    const { store } = await storeFor();
    const id = "never-saved-conversation-id";
    // 不调 seedSession → store.load(id) 会抛 SessionStoreError kind:
    // 'not_found';serialize 队列把该异常向上抛,hub 不静默吞掉。
    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({ adapter: makeOkAdapter("ok") }),
    });
    await assert.rejects(
      () => hub.compactSession(id),
      (err: unknown) => {
        // typed-error 渲染契约:见 code-quality.md — `${kind}: ${conversation_id}`
        // 形式;plain object 必须能区分 kind,而不是 [object Object]。
        assert.ok(err !== null && typeof err === "object");
        const e = err as { kind?: string; conversation_id?: string };
        return e.kind === "not_found" && e.conversation_id === id;
      },
      "fresh conversationId 必须抛 SessionStoreError kind='not_found' 而非静默返回"
    );
  });

  // plan review-fix:test.md 6-bullet coverage 「并发或重复提交场景」 — 之前
  // 3 个 case 都没覆盖 serialize 队列在同一 conversationId 上并发调用的互斥
  // 语义。两次 Promise.all(hub.compactSession(id), hub.compactSession(id))
  // 必须串行执行,落盘文件最终状态一致(不是交错 race)。
  it("review-fix: 同 conversationId 两次并发 compactSession → serialize 串行,落盘一致", async () => {
    const { store } = await storeFor();
    const id = "concurrent-compact";
    // 灌 10 条 30k chars → estimate ≈ 30k > threshold=1000 → windowed 路径
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: [
        { type: "text" as const, text: `msg-${i} ${"x".repeat(30_000)}` },
      ],
    }));
    await seedSession(store, id, messages);

    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({ adapter: makeOkAdapter("ok") }),
    });
    const [a, b] = await Promise.all([
      hub.compactSession(id),
      hub.compactSession(id),
    ]);
    // 两次都应 compacted=true(windowed 路径,无 race);
    assert.equal(a.compacted, true);
    assert.equal(b.compacted, true);
    // afterCount 双方一致(serialize 串行的最终状态);
    assert.equal(a.afterCount, b.afterCount);
    // 落盘文件 messages 长度等于最终 afterCount。
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, a.afterCount);
    // updatedAt 应被 bump(serialize 串行的最终 save 写出合法 ISO 时间戳)。
    assert.ok(
      typeof loaded.updatedAt === "string" && loaded.updatedAt.length > 0,
      "updatedAt 必须有 ISO 时间戳(serialize 队列最终 save)"
    );
  });
});

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
    // #467 step 2:首次抛 + full-compact 摘要步(fallback → placeholder)+ 重试成功 = 3 次。
    expect(attemptCount.value).toBe(3);

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
    // #467 step 2:首次抛 + full-compact 摘要步 + 重试成功 = 3 次。
    expect(attemptCount.value).toBe(3);

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
