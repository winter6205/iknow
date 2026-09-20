/**
 * Manual /compact counts as already past the auto-compact token gate.
 * Covers session-api hub.compactSession reason pass-through and
 * persistence contract across scenarios (short session + default 167k
 * threshold / 0 messages / abort / fresh conversationId), without
 * cross-talk with loop-engine proactive behavior (that has its own tests
 * in the compress-trigger-gate block of `tests/harness/loop-engine.test.ts`).
 *
 * Real SessionStore + temp dir (command-handler integration test contract).
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
  // Invariant pinned by this group: manual /compact counts as already past
  // the token gate — a short session (message count > keepRecent) must
  // compact and persist; the proactive gate still goes through
  // evaluateCompactTrigger (SSOT: src/harness/compress/index.ts), and
  // `below_token_threshold` is only the decision literal on that path.
  // The hub manual entry with an empty session takes the messages_too_few
  // idempotent noop.

  it("缺省阈值(thresholdTokens 缺席) + 8 短消息(> keepRecent=6)→ compacted:true + 落盘 + updatedAt bump", async () => {
    // First acceptance case: manual /compact counts as past the token gate
    // — a short session (message count > keepRecent) must compact and
    // persist even when the token estimate is far below the default
    // threshold. Note: the reason here depends on LLM summary success —
    // the windowed path is taken but makeOkAdapter returns "ok" →
    // summarized, so reason is "full_summary"; the pure-truncation windowed
    // case is the makeThrowingAdapter entry (messages_too_few) and the
    // reverse test below, where splitForCompaction lands on a placeholder
    // and reason=windowed.
    const { store } = await storeFor();
    const id = "manual-windowed-default-threshold";
    const messages = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: [{ type: "text" as const, text: `msg-${i}` }],
    }));
    await seedSession(store, id, messages);

    const hub = new SessionHub({
      store,
      // thresholdTokens deliberately absent → getAutoCompactThreshold default
      // = floor(0.95 × contextWindow) = 190000. Manual /compact counts as
      // past the gate, skips evaluateCompactTrigger, and goes straight to
      // splitForCompaction → windowed branch (8 > 6 keepRecent → dropped=2, kept=6).
      deps: {
        ...makeCompactDeps({ adapter: makeOkAdapter("ok") }),
        compress: { contextWindow: 200_000 },
      },
    });
    const beforeUpdatedAt = (await store.load(id)).updatedAt;
    const res = await hub.compactSession(id);

    expect(res.compacted).toBe(true);
    assert.equal(res.beforeCount, 8);
    // 8 > keepRecent=6 → dropped=2, kept=6. LLM summary succeeds → 1 preamble+summary
    // user + 6 kept = 7 messages.
    assert.equal(res.afterCount, 7);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 7);
    assert.notEqual(loaded.updatedAt, beforeUpdatedAt, "updatedAt 必须 bump");
  });

  it("缺省阈值 + 8 短消息 + runFullCompact 失败 → 落 placeholder → compacted:true + reason:windowed", async () => {
    // 8 > keepRecent=6, default threshold ≈ 167k (not checked manually), token estimate ≪ 167k.
    // Make runFullCompact throw → nextMessages goes through compactMessages(before) truncation +
    // boundary placeholder (8 → placeholder + 6 kept = 7). reason=windowed
    // (useCompactMessages=true → windowed wording).
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
    // Third acceptance case: manual /compact counts as past the token gate
    // — messages not exceeding the tail window but non-empty must still
    // compact (full_summary branch, same effect as after auto fires), not a
    // noop. LLM summary succeeds → 1 preamble+summary user message.
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
    // 3 ≤ keepRecent=6 → the whole segment is dropped, kept=[]; a successful
    // summary yields only 1 preamble+summary user message.
    assert.equal(res.afterCount, 1);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 1);
    const firstText = textOf(loaded.messages[0]!);
    assert.ok(firstText.includes("This session is being continued"));
    assert.ok(firstText.includes("sum-body"));
    // ADR-0112: the compact continuation summary is also a host commit at
    // the hub manual entry.
    assert.equal(loaded.messages[0]!.hostInjected, true);
  });

  it("空会话(0 消息)→ compacted:false + reason:messages_too_few + 不落盘 + updatedAt 不变", async () => {
    // Second acceptance case: an empty session under the same config stays
    // compacted:false with updatedAt unchanged.
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
    // Not persisted: the store file must equal the before state (0 messages, unchanged updatedAt).
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
    // Abort boundary: the existing contract holds — distinguished from "not
    // compacted" via cancelled:true, keeps state, no persist, no updatedAt
    // bump, no fallback truncation.
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

// -- compact must not overwrite title events (specs/session-list-title.md / ADR-0113) --

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
        title: "msg-0", // placeholder = extractTitle(first user msg)
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

    // After compact the first user message is SUMMARY_PREAMBLE; the title must remain the event text.
    const loaded = await store.load(id);
    assert.equal(loaded.title, "事件标题");
    const firstText = textOf(loaded.messages[0]!);
    assert.notEqual(loaded.title, extractTitle(loaded.messages));
    assert.ok(!loaded.title.includes(firstText.slice(0, 20)));
    // The on-disk header cache is likewise not re-covered by extractTitle, and the title record survives.
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
