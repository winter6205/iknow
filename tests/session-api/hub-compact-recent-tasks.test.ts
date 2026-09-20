/**
 * Hub wiring of boundaryAttachment — integration with real SessionHub +
 * real SessionStore (mkdtemp) + long messages triggering proactive
 * compact; asserts the attachment user message is inside messages and
 * holds the verbatim text of the most recent ≤3 qualifying user tasks
 * (exact after trim), newest last in chronological order.
 *
 * Contrast with `hub-taskfocus-compact.test.ts` (the old focus-rendering
 * shape, 240+history+cap720): this version asserts
 * `[Recent user tasks] — N` + a numbered list, full sentences into the
 * excerpt, no truncation.
 *
 * Test matrix:
 *   a. HITL + ≥3 qualifying user tasks → attachment carries all 3 verbatim
 *      (equal after trim), newest last;
 *   b. HITL + 0 qualifying (chit-chat / tool_result+drain only / none) → no attachment;
 *   c. auto mode (goal active) → no attachment (negative);
 *   d. HITL + 1 qualifying → reactive compact (flaky adapter throws
 *      PromptTooLongError) → attachment carries that 1 task;
 *   e. HITL → second compact round → the second attachment does not contain
 *      the first excerpt text (self-reference isolation).
 *
 * harness never imports session-api; `renderRecentUserTasksBoundary` is a
 * hub-private closure injected into runDeps via the optional
 * `boundaryAttachment` seam.
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
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

/** Build a long user message (~33 tokens via estimate: ceil(132/4) * 4/3 ≈ 44).
 *  Uses the same z-pad template as the original so the estimated message
 *  total exceeds the 1000-token threshold and proactive compact fires. */
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
    workspaceRoot: process.cwd(),
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

/** Flaky adapter: first step throws PromptTooLongError, later steps return
 *  normally. Shaped after makeFlakyAdapter in _compact-integration.test.ts. */
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
      // Summary round of full compact (tools === undefined) returns empty
      // text → fallback placeholder (keeps the test's geometry invariant).
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

/** Assemble reactive-compact deps: flaky adapter + executor/registry +
 *  compress + maxTurns=5. */
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
   * Stub responses: n placeholder continuation beats + 1 completed closer.
   * The proactive check runs before every model call, including this run's
   * first step (anchor initial -1), so an over-threshold prior by itself
   * makes compaction fire at run entry, before the first model call — no
   * tool continuation beats are needed to "reach" the check. 50 priors
   * (~2200 estimated tokens > 1000 threshold) prove this. The stub model
   * does not distinguish the no-tools summary step: the entry-compaction
   * summary step consumes the first scripted response and the completed
   * closer the second, so n=1 is the shortest runnable geometry.
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
    // 50 qualifying user tasks (~33 tokens each → estimated total ~2200
    // tokens > 1000 threshold); the over-threshold prior makes proactive
    // compact fire at run entry before the first call, so a short run
    // suffices; extractRecentUserTasks keeps the last 3 — prior-msg-47..49.
    const prior: AnthropicNativeMessage[] = Array.from({ length: 50 }, (_, i) =>
      longUserMessage(i)
    );
    await seedSession({ id, messages: prior });

    const baseDeps = makeDeps(buildResponses(1));
    const deps = {
      ...baseDeps,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const verifyConfig: VerifyConfig = { command: "/bin/true" };
    const hub = new SessionHub({ store, deps, verifyConfig });

    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");

    const loaded = await store.load(id);
    // The attachment must carry TASK_EXCERPT_PREFIX (this test's marker);
    // the old taskFocus FOCUS- marker is inverted — it should now be absent.
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

    // Body: three lines, verbatim (equal after trim), newest last.
    const lines = attachmentText.split("\n").slice(1);
    assert.equal(lines.length, 3, "必须含 3 行编号列表");
    assert.equal(lines[0], "1. prior-msg-47 " + "z".repeat(120));
    assert.equal(lines[1], "2. prior-msg-48 " + "z".repeat(120));
    assert.equal(lines[2], "3. prior-msg-49 " + "z".repeat(120));

    // The old taskFocus marker must not appear.
    assert.ok(
      !attachmentText.includes("FOCUS-"),
      "旧 taskFocus 焦点渲染标记不应出现"
    );
  });

  it("HITL + 0 句合格(仅 tool_result / drain) → 不贴 attachment", async () => {
    const id = "no-qualifying-tasks";
    // 50 tool_result-only user messages → isTurnQuery = false → extract
    // returns [] → renderRecentUserTasksBoundary returns undefined → the
    // boundaryAttachment injection text is undefined, a no-op. tool_result
    // bodies are padded to ~210 chars each (estimated total ~3500 tokens >
    // 1000 threshold) so compaction fires at run entry before the first call.
    const prior: AnthropicNativeMessage[] = Array.from(
      { length: 50 },
      (_, i) => ({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `t-${i}`,
            content: [{ type: "text", text: `result-${i} ${"z".repeat(200)}` }],
          },
        ],
      })
    );
    await seedSession({ id, messages: prior });

    const baseDeps = makeDeps(buildResponses(1));
    const deps = {
      ...baseDeps,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const hub = new SessionHub({ store, deps });

    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");

    const loaded = await store.load(id);
    const serialized = JSON.stringify(loaded.messages);
    // Compact still fires (the over-threshold prior triggers it at run
    // entry, before the first call).
    assert.ok(
      serialized.includes("[compaction boundary — earlier messages cleared]") ||
        // The LLM-summary path of a successful full compact likewise starts with SUMMARY.
        serialized.includes("This session is being continued"),
      "compact 仍应触发,placeholder 或 summary 出现在 messages"
    );
    // The excerpt sentinel must not appear — no qualifying user tasks.
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
    const baseDeps = makeDeps(buildResponses(1));
    const deps = {
      ...baseDeps,
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
    // Auto mode → the boundaryAttachment closure is not injected → the
    // excerpt sentinel must never appear.
    assert.ok(
      !serialized.includes(TASK_EXCERPT_PREFIX),
      "auto mode must NOT inject task excerpt attachment"
    );
  });

  it("超长单句:整句进入摘录,不再 240/120/720 截(spec SC4)", async () => {
    const id = "long-single-task";
    // One overlong qualifying user task (800+ chars) — the old 240 cap is
    // gone; the full sentence enters the excerpt. Place it last within the
    // recent 3 (extractRecentUserTasks takes the 3 latest qualifying tasks)
    // so the excerpt body shows it.
    const longText = "long-task " + "a".repeat(800);
    const prior: AnthropicNativeMessage[] = [
      // 47 z-pad placeholders (push the estimated total over the 1000-token threshold).
      ...Array.from({ length: 47 }, (_, i) => longUserMessage(i)),
      // 2 short qualifying tasks right before the long text.
      {
        role: "user",
        content: [{ type: "text", text: "task-before-long-A" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "task-before-long-B" }],
      },
      // long-text closes the list (newest of the recent 3).
      {
        role: "user",
        content: [{ type: "text", text: longText }],
      },
    ];
    await seedSession({ id, messages: prior });

    const baseDeps = makeDeps(buildResponses(1));
    const deps = {
      ...baseDeps,
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
    // Full sentence included — no 240-char truncation anymore.
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
    // 12 prior messages (11 tool_result-only continuations + 1 qualifying
    // longText closer) → messages.length > DEFAULT_KEEP_RECENT (=6) takes
    // the reactive-compact path; longText is the conversation's only
    // qualifying user task → the attachment body contains just it. Flaky
    // adapter: first call throws PromptTooLongError, later ones succeed
    // (single-turn completion).
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
      // 11 pure tool_result continuation messages (> DEFAULT_KEEP_RECENT=6).
      ...Array.from({ length: 11 }, (_, i) => toolResultOnly(i)),
      // 1 qualifying longText closer — the only extractable task.
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
    // Prior deliberately assembled as: long prior + one "previous-round
    // excerpt" (self-reference candidate) + a new qualifying user task.
    // extractRecentUserTasks must exclude the excerpt segment (never count
    // it as a qualifying user task) and pick up only the real task.
    const realTask = "real-follow-up-task";
    const previousExcerpt = `${TASK_EXCERPT_PREFIX} — 3\n1. older-task-A\n2. older-task-B\n3. older-task-C`;
    const prior: AnthropicNativeMessage[] = [
      // 47 z-pad placeholders (push the estimated total over the 1000-token threshold).
      ...Array.from({ length: 47 }, (_, i) => longUserMessage(i)),
      // The excerpt segment a previous compact round already wrote (self-reference candidate).
      { role: "user", content: [{ type: "text", text: previousExcerpt }] },
      // A new qualifying user task as the latest entry.
      { role: "user", content: [{ type: "text", text: realTask }] },
    ];
    await seedSession({ id, messages: prior });

    const baseDeps = makeDeps(buildResponses(1));
    const deps = {
      ...baseDeps,
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

    // Self-reference isolation: the body must not contain previousExcerpt
    // content (the excerpt segment is excluded).
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

    // The genuinely qualifying user task should be extracted.
    assert.ok(
      attachmentText.includes(realTask),
      "real-follow-up-task 应被抽入摘录"
    );

    // TASK_EXCERPT_PREFIX appears exactly once in the attachment text (header only).
    const occurrences = attachmentText.split(TASK_EXCERPT_PREFIX).length - 1;
    assert.equal(
      occurrences,
      1,
      "attachment 文本内 TASK_EXCERPT_PREFIX 必须仅出现 1 次 (header)"
    );
  });
});
