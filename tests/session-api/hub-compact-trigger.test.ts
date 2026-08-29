/**
 * plan compress-trigger-gate T2: hub.compactSession token-gate + reason 透传。
 *
 * #607 把 `_compact-integration.test.ts` 整文件归档（reactive compact +
 * taskFocus 边界已由 `hub-compact-recent-tasks.test.ts` 覆盖）。本文件只
 * 保留 #601 加的 trigger/reason 集成：真实 SessionStore + temp dir。
 */
import { afterAll, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
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

describe("plan compress-trigger-gate T2: hub.compactSession token-gate + reason 透传", () => {
  it("fresh session 消息 ≤ 6 + 低 token → compacted:false + reason:below_token_threshold", async () => {
    const { store } = await storeFor();
    const id = "below-threshold";
    const messages = Array.from({ length: 3 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `msg-${i}` }],
    }));
    await seedSession(store, id, messages);

    const hub = new SessionHub({
      store,
      deps: makeCompactDeps({ adapter: makeOkAdapter("ok") }),
    });
    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(false);
    assert.equal(res.reason, "below_token_threshold");
    assert.equal(res.beforeCount, 3);
    assert.equal(res.afterCount, 3);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 3);
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
