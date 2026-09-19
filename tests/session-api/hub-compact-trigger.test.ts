/**
 * plan manual-compact-trigger T1: 手动 /compact 视作已过 auto-compact
 * token 门。覆盖 session-api hub.compactSession 在「短会话 + 缺省 167k
 * 阈值 / 0 消息 / abort / fresh conversationId」等场景下的 reason 透传
 * 与落盘契约,与 loop-engine proactive 行为互不串扰(后者有独立测试
 * 见 `tests/harness/loop-engine.test.ts` 的 compress-trigger-gate 块)。
 *
 * 真实 SessionStore + temp dir(命令 handler 集成测试契约)。
 */
import { afterAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  extractTitle,
  SessionStore,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { assistantResult } from "../cli/_fixtures.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopAdapter,
} from "../../src/harness/model-adapter/types.ts";

const baseDirs: string[] = [];

async function storeFor(): Promise<{ store: SessionStore; baseDir: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), "iknow-compact-trigger-"));
  baseDirs.push(baseDir);
  return { store: new SessionStore(baseDir, process.cwd()), baseDir };
}

afterAll(async () => {
  for (const dir of baseDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

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

function textOf(msg: AnthropicNativeMessage): string {
  const block = msg.content.find(
    (b): b is { type: "text"; text: string } => b.type === "text"
  );
  return block ? block.text : "";
}

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
      workspaceRoot: process.cwd(),
    } satisfies SessionFileV1,
  });
}

describe("plan manual-compact-trigger T1: hub.compactSession 绕开 auto token 门", () => {
  // 本组用例钉住的不变式:manual /compact 视作已过 token 门 — 短会话(消息
  // 数 > keepRecent)必须压缩并落盘;proactive gate 仍走 evaluateCompactTrigger
  // (SSOT: src/harness/compress/index.ts),`below_token_threshold` 仅是那条
  // 路径的判据字面量。hub 手动入口空会话走 messages_too_few 幂等 noop。

  it("缺省阈值(thresholdTokens 缺席) + 8 短消息(> keepRecent=6)→ compacted:true + 落盘 + updatedAt bump", async () => {
    // 验收 T1 acceptance 第一条:manual /compact 视作已过 token 门 — 短会话
    // (消息数 > keepRecent)必须压缩并落盘,即便 token 估算远低于缺省阈值。
    // 注:此处 reason 取决于 LLM 摘要成败 — 走 windowed 路径但 makeOkAdapter
    // 返回 "ok" → summarized,所以 reason 走 "full_summary";windowed 路径
    // 的纯截断场景见 makeThrowingAdapter 那条(messages_too_few)与下面那条
    // 走 splitForCompaction 落到 placeholder 后 reason=windowed 的反向测试。
    const { store } = await storeFor();
    const id = "manual-windowed-default-threshold";
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `msg-${i}` }],
    }));
    await seedSession(store, id, messages);

    const hub = new SessionHub({
      store,
      // thresholdTokens 故意缺席 → getAutoCompactThreshold 缺省 =
      // floor(0.95 × contextWindow) = 190000。manual /compact 视作已过门,
      // 不调 evaluateCompactTrigger,直接走 splitForCompaction → windowed 支
      // (8 > 6 keepRecent → dropped=2, kept=6)。
      deps: {
        ...makeCompactDeps({ adapter: makeOkAdapter("ok") }),
        compress: { contextWindow: 200_000 },
      },
    });
    const beforeUpdatedAt = (await store.load(id)).updatedAt;
    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(true);
    assert.equal(res.beforeCount, 8);
    // 8 条 > keepRecent=6 → dropped=2, kept=6。LLM 摘要成功 → 1 条 preamble+summary
    // user + 6 kept = 7 条。
    assert.equal(res.afterCount, 7);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 7);
    assert.notEqual(loaded.updatedAt, beforeUpdatedAt, "updatedAt 必须 bump");
  });

  it("缺省阈值 + 8 短消息 + runFullCompact 失败 → 落 placeholder → compacted:true + reason:windowed", async () => {
    // 8 条 > keepRecent=6,默认阈值 ≈ 167k(手动不查),token 估 ≪ 167k。
    // 让 runFullCompact 抛错 → nextMessages 走 compactMessages(before) 截断 +
    // boundary placeholder(8 条 → placeholder + 6 kept = 7)。reason=windowed
    // (useCompactMessages=true → 走 windowed 文案)。
    const { store } = await storeFor();
    const id = "manual-windowed-placeholder";
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `msg-${i}` }],
    }));
    await seedSession(store, id, messages);

    const hub = new SessionHub({
      store,
      deps: {
        ...makeCompactDeps({
          adapter: makeThrowingAdapter("synthetic throw for windowed test"),
        }),
        compress: { contextWindow: 200_000 },
      },
    });
    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(true);
    assert.equal(res.reason, "windowed");
    assert.equal(res.beforeCount, 8);
    assert.equal(res.afterCount, 7);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 7);
    const firstText = textOf(loaded.messages[0]!);
    assert.ok(
      firstText.startsWith("[compaction boundary"),
      "placeholder fallback 时首条必须是 boundary placeholder,实际首条前 80 字: " +
        firstText.slice(0, 80)
    );
  });

  it("缺省阈值 + 3 短消息(≤ keepRecent)→ compacted:true + reason:full_summary(非 below_token_threshold noop)", async () => {
    // 验收 T1 acceptance 第三条:manual /compact 视作已过 token 门 — 消息不
    // 超过尾窗但非空时仍必须压缩(full_summary 支,与 auto 开火后同效),
    // 不是 noop。LLM 摘要成功 → 1 条 preamble+summary user 消息。
    const { store } = await storeFor();
    const id = "manual-full-summary-short";
    const messages = Array.from({ length: 3 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `msg-${i}` }],
    }));
    await seedSession(store, id, messages);

    const hub = new SessionHub({
      store,
      deps: {
        ...makeCompactDeps({
          adapter: makeSummarizeAdapter({ summaryText: "sum-body" }),
        }),
        compress: { contextWindow: 200_000 },
      },
    });
    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(true);
    assert.equal(res.reason, "full_summary");
    assert.equal(res.beforeCount, 3);
    // 3 条 ≤ keepRecent=6 → 整段视为 dropped,kept=[],摘要成功只产 1 条
    // preamble+summary user 消息。
    assert.equal(res.afterCount, 1);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 1);
    const firstText = textOf(loaded.messages[0]!);
    assert.ok(firstText.includes("This session is being continued"));
    assert.ok(firstText.includes("sum-body"));
    // ADR-0112 Does #1:compact 续传摘要在 hub 手动入口同样是宿主 commit。
    assert.equal(loaded.messages[0]!.hostInjected, true);
  });

  it("空会话(0 消息)→ compacted:false + reason:messages_too_few + 不落盘 + updatedAt 不变", async () => {
    // 验收 T1 acceptance 第二条:同配置下空会话仍 compacted:false 且 updatedAt 不变。
    const { store } = await storeFor();
    const id = "manual-empty";
    await seedSession(store, id, []);

    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({ adapter: makeOkAdapter("ok") }),
    });
    const before = await store.load(id);
    const beforeUpdatedAt = before.updatedAt;
    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(false);
    assert.equal(res.reason, "messages_too_few");
    assert.equal(res.beforeCount, 0);
    assert.equal(res.afterCount, 0);
    // 不落盘:store 文件内容应与 before 一致(消息数=0,updatedAt 不变)。
    const after = await store.load(id);
    assert.equal(after.messages.length, 0);
    assert.equal(after.updatedAt, beforeUpdatedAt, "updatedAt 必须不变");
  });

  it("5 条 + 高 token (每条灌 50k chars) → compacted:true + reason:full_summary", async () => {
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
    assert.equal(res.afterCount, 1);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 1);
    const firstText = textOf(loaded.messages[0]!);
    assert.ok(firstText.includes("This session is being continued"));
    assert.ok(firstText.includes("sum-body"));
  });

  it("runFullCompact 抛错 → compacted:false + reason:messages_too_few", async () => {
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
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 5);
  });

  it("signal abort 中途取消 → cancelled:true + compacted:false + 不落盘 + updatedAt 不变(契约 #548)", async () => {
    // 验收 T1 边界:abort 既有契约保留 — 与「未压缩」区分(cancelled:true),
    // 走 keep-state 路径,不落盘、不 bump updatedAt、不 fallback 截断。
    const { store } = await storeFor();
    const id = "manual-abort";
    const messages = Array.from({ length: 5 }, () => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: "x".repeat(50_000) }],
    }));
    await seedSession(store, id, messages);

    const controller = new AbortController();
    controller.abort();
    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({
        adapter: makeSummarizeAdapter({ summaryText: "never-used" }),
      }),
    });
    const before = await store.load(id);
    const beforeUpdatedAt = before.updatedAt;
    const res = await hub.compactSession(id, { signal: controller.signal });

    assert.equal(res.cancelled, true);
    assert.equal(res.compacted, false);
    assert.equal(res.beforeCount, 5);
    assert.equal(res.afterCount, 5);
    const after = await store.load(id);
    assert.equal(after.messages.length, 5, "abort 后消息数不变");
    assert.equal(after.updatedAt, beforeUpdatedAt, "abort 后 updatedAt 不变");
  });

  it("review-fix: fresh conversationId (store.load raises not_found) → serialize 队列拒绝,hub 不落盘", async () => {
    const { store } = await storeFor();
    const id = "never-saved-conversation-id";
    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({ adapter: makeOkAdapter("ok") }),
    });
    await assert.rejects(
      () => hub.compactSession(id),
      (err: unknown) => {
        assert.ok(err !== null && typeof err === "object");
        const e = err as { kind?: string; conversation_id?: string };
        return e.kind === "not_found" && e.conversation_id === id;
      },
      "fresh conversationId 必须抛 SessionStoreError kind='not_found' 而非静默返回"
    );
  });

  it("review-fix: 同 conversationId 两次并发 compactSession → serialize 串行,落盘一致", async () => {
    const { store } = await storeFor();
    const id = "concurrent-compact";
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
    assert.equal(a.compacted, true);
    assert.equal(b.compacted, true);
    assert.equal(a.afterCount, b.afterCount);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, a.afterCount);
    assert.ok(
      typeof loaded.updatedAt === "string" && loaded.updatedAt.length > 0,
      "updatedAt 必须有 ISO 时间戳(serialize 队列最终 save)"
    );
  });
});

// -- compact 不回盖标题事件 (session-list-title T3 / ADR-0113) -----------------

describe("compact 与标题事件: header title 只做缓存", () => {
  it("有 title 事件: compact 后 header/读路径仍为事件正文, preamble 不成标题", async () => {
    const { store } = await storeFor();
    const id = "compact-title-event";
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `msg-${i}` }],
    }));
    await seedSession(store, id, messages);
    await store.save({
      id,
      file: {
        ...(await store.load(id)),
        title: "msg-0", // 占位 = extractTitle(首条 user)
      },
    });
    await store.appendTitle({ id, text: "事件标题" });
    assert.equal((await store.load(id)).title, "事件标题");

    const hub = new SessionHub({
      store,
      deps: {
        ...makeCompactDeps({
          adapter: makeSummarizeAdapter({ summaryText: "摘要内容" }),
        }),
      },
    });
    const res = await hub.compactSession(id);
    expect(res.compacted).toBe(true);

    // compact 后首条 user 是 SUMMARY_PREAMBLE；标题必须仍是事件正文。
    const loaded = await store.load(id);
    assert.equal(loaded.title, "事件标题");
    const firstText = textOf(loaded.messages[0]!);
    assert.notEqual(loaded.title, extractTitle(loaded.messages));
    assert.ok(!loaded.title.includes(firstText.slice(0, 20)));
    // 盘上 header 缓存同样未被 extractTitle 回盖，且 title 记录存活。
    const lines = (
      await readFile(join(store.getProjectDir(), id, `${id}.jsonl`), "utf8")
    )
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines[0]?.["title"], "事件标题");
    assert.ok(
      lines.some((l) => l["type"] === "title" && l["text"] === "事件标题")
    );
  });

  it("回归: 无 title 事件时 compact 行为与今日一致 (title = extractTitle(before))", async () => {
    const { store } = await storeFor();
    const id = "compact-title-noevent";
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `msg-${i}` }],
    }));
    await seedSession(store, id, messages);
    const hub = new SessionHub({
      store,
      deps: {
        ...makeCompactDeps({
          adapter: makeSummarizeAdapter({ summaryText: "摘要内容" }),
        }),
      },
    });
    const res = await hub.compactSession(id);
    expect(res.compacted).toBe(true);
    const loaded = await store.load(id);
    assert.equal(loaded.title, "msg-0");
  });
});
