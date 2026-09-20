/**
 * Integration test — loop-engine compress wiring, end to end.
 *
 * Builds a scripted long conversation with a stub model (run() never calls a
 * real LLM) and verifies:
 *   a. deps.compress absent -> zero behavior change (no compaction, no boundary placeholder);
 *   b. deps.compress present + low threshold -> compactMessages fires, messages
 *      shrink, and the system seam (deps.system) is untouched;
 *   c. after compaction every tool_use<->tool_result pair stays intact;
 *   d. turnCount anchor: no repeat firing within one turn, lastCompactTurn holds
 *      the anchor (extreme-length conversation + low threshold -> compaction
 *      happens >= 1 and <= N/2 times);
 *   e. deps.compress.thresholdTokens = undefined -> default floor(0.95 × window)
 *      (ADR-0100); huge contextWindow -> no trigger; tiny contextWindow -> triggers.
 *
 * No real-LLM token values are hardcoded; only estimate-function semantics
 * (constant layer) + custom thresholds simulate triggering.
 *
 * Compact boundary rendering seam: `deps.boundaryAttachment` is an optional
 * closure that, on compaction, appends rendered text as one user message right
 * after the boundary placeholder. Both compact call sites (reactive and
 * proactive) share the `applyCompactAttachment` helper; its render source is a
 * hub-injected `renderRecentUserTasksBoundary` that freshly extracts up to the
 * 3 most recent eligible user task utterances. This file tests only the
 * `applyCompactAttachment` seam, not the hub closure:
 *   f. proactive compact + boundaryAttachment -> messages[0]=placeholder,
 *      messages[1]=attachment user message, messages[2+]=kept tail;
 *   g. boundaryAttachment absent -> placeholder only (byte-stable);
 *   h. the reactive compact path hits the same shared helper;
 *   i. ordinary turn (threshold not reached) -> boundaryAttachment never called (no-op).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { run } from "../../../src/harness/loop-engine.ts";
import type { LoopAdapter } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../../cli/_fixtures.ts";
import {
  COMPACTION_BOUNDARY_PLACEHOLDER,
  DEFAULT_KEEP_RECENT,
  estimateMessagesTokens,
  getAutoCompactThreshold,
} from "../../../src/harness/compress/index.ts";
import { PromptTooLongError } from "../../../src/harness/errors.ts";

// The compact-triggered "boundary" message can be either the old pure-truncation
// placeholder (COMPACTION_BOUNDARY_PLACEHOLDER) or the new LLM summary round
// (SUMMARY_PREAMBLE + summary text). One predicate must accept both forms —
// isCompactBoundaryMessage. Placeholder compatibility is kept so older
// contract assertions don't break (blue-green transition).
const SUMMARY_PREAMBLE_FRAGMENT =
  "This session is being continued from a previous conversation";
function isCompactBoundaryMessage(m: AnthropicNativeMessage): boolean {
  if (m.role !== "user") return false;
  return m.content.some(
    (b): b is { type: "text"; text: string } =>
      b.type === "text" &&
      (b.text === COMPACTION_BOUNDARY_PLACEHOLDER ||
        b.text.startsWith(SUMMARY_PREAMBLE_FRAGMENT))
  );
}
/** LLM summary-round user message (SUMMARY_PREAMBLE + summary text). */
function isSummaryMessage(m: AnthropicNativeMessage | undefined): boolean {
  if (m === undefined || m.role !== "user") return false;
  return m.content.some(
    (b): b is { type: "text"; text: string } =>
      b.type === "text" && b.text.startsWith(SUMMARY_PREAMBLE_FRAGMENT)
  );
}
function textOf(m: AnthropicNativeMessage): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../../src/harness/model-adapter/types.ts";
import type { LoopAdapter } from "../../../src/harness/loop-engine.ts";
import { toAnthropicToolResults } from "../../../src/harness/tools/tool-result.ts";
import type { ToolExecutionResult } from "../../../src/harness/tools/types.ts";

/** Per-turn text volume: makes the estimate cross the low threshold (~1000) in ~5 turns. */
const BIG_TEXT = "payload ".repeat(40); // ~320 chars → ~80 tokens/turn
const TOOL_RESULT_TEXT = "tool-result-body ".repeat(60); // tool_result inflates too

const TURNS = 100;

/**
 * Scripted stub responses: an N-turn tool-call conversation + one completed
 * closing turn. Each turn's assistant carries a big text + one tool_use;
 * tool_result is produced by the executor.
 */
function buildResponses(n: number) {
  const responses = [];
  for (let i = 0; i < n; i++) {
    responses.push(
      assistantResult({
        texts: [BIG_TEXT],
        toolCalls: [{ id: `call-${i}`, name: "noop", input: { i } }],
      })
    );
  }
  // Closer: plain-text completed (no tool call).
  responses.push(
    assistantResult({
      texts: ["completed"],
      toolCalls: [],
      supplierStop: "success",
    })
  );
  return responses;
}

/** Count tool_use blocks across messages. */
function toolUses(
  messages: ReadonlyArray<{
    readonly content: ReadonlyArray<AnthropicContentBlock>;
  }>
): ReadonlyArray<{ id: string }> {
  const out: { id: string }[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") out.push({ id: b.id });
    }
  }
  return out;
}

/** Collect tool_use_ids of tool_result blocks across messages. */
function toolResultIds(
  messages: ReadonlyArray<{
    readonly content: ReadonlyArray<AnthropicContentBlock>;
  }>
): ReadonlyArray<string> {
  const out: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_result") out.push(b.tool_use_id);
    }
  }
  return out;
}

/** Assert the completion closing message survives (the tail must never be mutated). */
function assertCompletionTail(
  messages: ReadonlyArray<{
    readonly content: ReadonlyArray<AnthropicContentBlock>;
  }>
): void {
  const last = messages[messages.length - 1]!;
  const text = last.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  assert.ok(
    text.includes("completed"),
    "final assistant message must survive compaction"
  );
}

describe("loop-engine compress 接线 (#119 T7)", () => {
  const noopTool = createStubTool({
    name: "noop",
    next: () => TOOL_RESULT_TEXT,
  });
  const registry = createRegistry([noopTool]);
  const executor = createExecutor(registry);

  it("deps.compress 缺席 → 行为零变化,run 不触发压缩", async () => {
    const model = createStubModel({ responses: buildResponses(3) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: 10,
    });
    assert.equal(result.stopReason, "completed");
    // 3 tool-call turns: user + 3×(assistant + user tool_result) + assistant closer.
    assert.equal(result.messages.length, 1 + 3 * 2 + 1);
    // No boundary placeholder -> compaction never ran.
    const serialized = JSON.stringify(result.messages);
    assert.ok(
      !serialized.includes(COMPACTION_BOUNDARY_PLACEHOLDER),
      "compress 缺席时不得插入边界占位符"
    );
  });

  it("deps.compress 就位 + 低阈值 → 触发压缩,messages 变短,system 不受影响", async () => {
    let systemCalls = 0;
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      // The system seam is independent of compaction; wire a constant-returning
      // resolver to prove it is untouched.
      system: async () => {
        systemCalls++;
        return "SYSTEM-PROMPT-CONST";
      },
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    });
    assert.equal(result.stopReason, "completed");
    // Compaction happened: a boundary message appears (placeholder or LLM summary round both qualify).
    assert.ok(
      result.messages.some(isCompactBoundaryMessage),
      "低阈值 + 长对话必须触发压缩 (placeholder 或 summary)"
    );
    // After compaction, messages are far shorter than the uncompressed 1+200+1=202.
    assert.ok(
      result.messages.length < 50,
      `压缩后 messages 应大幅变短,实际 ${result.messages.length}`
    );
    // The system seam is still called normally (compaction doesn't disturb system injection).
    assert.ok(systemCalls > 0, "deps.system 必须仍被调用");
    // The completed tail survives.
    assertCompletionTail(result.messages);
  });

  it("压缩后 tool_use↔tool_result 配对完整 (SC11)", async () => {
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    });
    assert.equal(result.stopReason, "completed");
    const uses = toolUses(result.messages);
    const resultIds = new Set(toolResultIds(result.messages));
    for (const u of uses) {
      assert.ok(
        resultIds.has(u.id),
        `kept messages 内 tool_use ${u.id} 必须存在配对 tool_result (SC11)`
      );
    }
  });

  it("turnCount 锚点:同一轮不重复触发,长对话压缩次数 ≥1 且 ≤ N/2", async () => {
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    });
    assert.equal(result.stopReason, "completed");
    // Boundary messages (placeholder or summary) count = compaction count (each
    // compact inserts exactly one boundary message; summary rounds count too).
    const boundaryCount = result.messages.filter(
      isCompactBoundaryMessage
    ).length;
    assert.ok(boundaryCount >= 1, "至少触发一次压缩");
    assert.ok(
      boundaryCount <= Math.floor(TURNS / 2),
      `压缩次数 ${boundaryCount} 应 ≤ ${Math.floor(TURNS / 2)}(turnCount 锚点守约)`
    );
    // Freeze gate: compaction results freeze each message and its content
    // blocks just like appendMessage, so later loop mutations fail silently
    // (strict mode).
    assert.ok(Object.isFrozen(result.messages), "messages 数组应被冻结");
    for (const m of result.messages) {
      assert.ok(Object.isFrozen(m), `message ${m.role} 应被冻结`);
      assert.ok(Object.isFrozen(m.content), `${m.role}.content 应被冻结`);
    }
  });

  it("thresholdTokens=undefined → 缺省推导 floor(0.95×window);极大 window 不触发,极小 window 触发", async () => {
    // (a) Huge contextWindow -> enormous default threshold -> no trigger.
    const bigModel = createStubModel({ responses: buildResponses(5) });
    const big = await run("hello", {
      adapter: bigModel,
      executor,
      registry,
      maxTurns: 10,
      compress: { contextWindow: 10_000_000, thresholdTokens: undefined },
    });
    assert.equal(big.result.stopReason, "completed");
    assert.ok(
      !JSON.stringify(big.result.messages).includes(
        COMPACTION_BOUNDARY_PLACEHOLDER
      ),
      "极大 contextWindow + 缺省阈值不得触发压缩"
    );

    // (b) Tiny contextWindow -> default gate = floor(0.95 × 2000) = 1900, and
    // the fixture's 5-turn conversation estimates far above it -> triggers.
    // The 95% ratio never lifts the gate out of triggering just because the window is small.
    const smallModel = createStubModel({ responses: buildResponses(5) });
    const small = await run("hello", {
      adapter: smallModel,
      executor,
      registry,
      maxTurns: 10,
      compress: { contextWindow: 2000, thresholdTokens: undefined },
    });
    assert.equal(small.result.stopReason, "completed");
    assert.ok(
      small.result.messages.some(isCompactBoundaryMessage),
      "极小 contextWindow + 缺省阈值必须触发压缩 (placeholder 或 summary)"
    );

    // (c) Semantics self-check: the default gate is a positive ratio, not the
    // old buffer formula's negative coincidence — the tiny-window trigger comes
    // from the estimate crossing floor(0.95 × window).
    assert.equal(getAutoCompactThreshold(2000, undefined), 1_900);
    assert.ok(getAutoCompactThreshold(2000, undefined) > 0);
    // The huge window's default gate still sits above the estimate -> same root cause as (a)'s no-trigger.
    assert.ok(
      getAutoCompactThreshold(10_000_000, undefined) >
        estimateMessagesTokens(big.result.messages)
    );
    const probe = estimateMessagesTokens([
      { role: "user", content: [{ type: "text", text: "x" }] },
    ]);
    assert.ok(probe >= 1);
  });
});

// -- compact boundary: boundaryAttachment rendering seam ----------------------

/** Construct a minimal prior-message array. */
const text = (value: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: value }],
});

/**
 * Dedicated adapter for the proactive compact -> LLM summary success path.
 * Non-compact steps (tools passed) consume the script; the compact summary
 * step (tools === undefined) returns
 * `<analysis>…</analysis><summary>SUMMARY-OVER-DROPPED</summary>` so
 * runFullCompact takes the summarized branch -> buildCompactedMessages emits
 * the `SUMMARY_PREAMBLE + summary text` user message at messages[0].
 */
function makeCompactSummaryAdapter(opts: {
  readonly responses: ReadonlyArray<AssistantTurnResult>;
}): LoopAdapter & { readonly compactSteps: { value: number } } {
  const queue = opts.responses.slice();
  const compactSteps = { value: 0 };
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    // Must produce real tool_result blocks: this adapter runs full tool turns
    // and preserveToolPairs relies on tool_result blocks for the pairing guard.
    // An empty array would orphan tool_use and make splitForCompaction throw
    // "missing tool_result" (unlike the flaky adapter, where compact happens
    // before the first tool turn so split never sees orphaned tool_use).
    encodeToolResults: (
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] => toAnthropicToolResults(results),
    step: async (
      state: LoopState,
      request: { readonly tools?: unknown }
    ): Promise<AssistantTurnResult> => {
      if (request.tools === undefined) {
        // Same discrimination as stub-model: only a no-tools step carrying the
        // full-compact prompt is a summary step; the epilogue SUMMARY_PROMPT is
        // consumed via the normal queue.
        const lastUserText = [...state.messages]
          .reverse()
          .find((m) => m.role === "user")
          ?.content.filter(
            (b): b is { type: "text"; text: string } => b.type === "text"
          )
          .map((b) => b.text)
          .join("");
        if (
          lastUserText?.includes(
            "Your task is to create a detailed summary of the conversation so far"
          ) === true
        ) {
          compactSteps.value += 1;
          return assistantResult({
            texts: [
              "<analysis>scratch dropped detail</analysis>" +
                "<summary>SUMMARY-OVER-DROPPED</summary>",
            ],
            toolCalls: [],
            supplierStop: "success",
          });
        }
      }
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(
          "makeCompactSummaryAdapter: scripted responses exhausted"
        );
      }
      return next;
    },
    compactSteps,
  });
}

/**
 * Reactive-path trigger: the first attempt throws PromptTooLongError, the
 * second returns success — simulating "model rejects before compaction ->
 * reactive triggers compaction -> model accepts after compaction".
 */
function makeFlakyAdapter(opts: {
  readonly retryText: string;
  readonly attemptCount: { value: number };
}) {
  return Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (): AnthropicContentBlock[] => [],
    step: async (
      _state: LoopState,
      request: { readonly tools?: unknown; readonly onStream?: unknown }
    ): Promise<AssistantTurnResult> => {
      opts.attemptCount.value += 1;
      if (opts.attemptCount.value === 1) {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      // The full-compact summary round runs without tools (request.tools === undefined).
      // The summary step returns empty text -> runFullCompact reports empty_response ->
      // fallback placeholder; the test intent (verifying the fallback path) is kept,
      // and the summary-success path has its own dedicated cases.
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

describe("loop-engine compress boundaryAttachment (#458 T7 SC11)", () => {
  const noopTool = createStubTool({
    name: "noop",
    next: () => TOOL_RESULT_TEXT,
  });
  const registry = createRegistry([noopTool]);
  const executor = createExecutor(registry);

  it("proactive compact + boundaryAttachment → placeholder 后追加 attachment user 消息", async () => {
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
      boundaryAttachment: () => "focus@now\n---\nhist1",
    });
    assert.equal(result.stopReason, "completed");
    // The boundary may be an LLM summary round or a placeholder; the attachment
    // user message follows immediately after it (both buildCompactedMessages and
    // the fallback honor this layout).
    assert.ok(
      isCompactBoundaryMessage(result.messages[0]!),
      "messages[0] must be compact boundary (placeholder 或 summary)"
    );
    assert.deepStrictEqual(result.messages[1], {
      role: "user",
      content: [{ type: "text", text: "focus@now\n---\nhist1" }],
    });
    // Kept tail: the final assistant closer is still present.
    assertCompletionTail(result.messages);
  });

  it("boundaryAttachment 缺席 → 仅 placeholder 无 attachment 消息", async () => {
    const model = createStubModel({ responses: buildResponses(TURNS) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: TURNS + 1,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    });
    assert.equal(result.stopReason, "completed");
    // A boundary message appears (confirming compaction really fired): placeholder or LLM summary round both qualify.
    assert.ok(
      isCompactBoundaryMessage(result.messages[0]!),
      "messages[0] must be compact boundary (placeholder 或 summary)"
    );
    // messages[1] must not be attachment text; it is either the kept tail or a later assistant turn.
    const second = result.messages[1];
    assert.ok(second, "messages[1] must exist (kept tail or assistant)");
    const secondText = second.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    assert.ok(
      !secondText.includes("focus@now"),
      "messages[1] must NOT be attachment user message when boundaryAttachment absent"
    );
  });

  it("普通 turn(阈值未达)→ boundaryAttachment 不调用(no-op SC11)", async () => {
    let calls = 0;
    const model = createStubModel({ responses: buildResponses(3) });
    const { result } = await run("hello", {
      adapter: model,
      executor,
      registry,
      maxTurns: 10,
      // Huge contextWindow -> default gate floor(0.95 × 1e7) far above the estimate -> no trigger.
      compress: { contextWindow: 10_000_000, thresholdTokens: undefined },
      boundaryAttachment: () => {
        calls++;
        return "focus@now\n---\nhist1";
      },
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(calls, 0, "阈值未达 → boundaryAttachment 不得被调用");
    const serialized = JSON.stringify(result.messages);
    assert.ok(
      !serialized.includes(COMPACTION_BOUNDARY_PLACEHOLDER),
      "阈值未达 → 不得触发 compact,无占位符"
    );
    assert.ok(
      !serialized.includes("focus@now"),
      "阈值未达 → 不得注入 attachment 文本"
    );
  });

  it("reactive compact + boundaryAttachment → placeholder 后追加 attachment(共享 helper)", async () => {
    // 12 prior messages + 1 user text -> compactMessages yields placeholder + DEFAULT_KEEP_RECENT kept.
    const longPrior = Array.from({ length: 12 }, (_, i) =>
      text(`prior-${i} ${"z".repeat(20)}`)
    );
    const attemptCount = { value: 0 };
    const adapter = makeFlakyAdapter({
      retryText: "done after compact",
      attemptCount,
    });
    const { result } = await run(
      "Q",
      {
        adapter,
        executor,
        registry,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
        boundaryAttachment: () => "focus@now\n---\nhist1",
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    // applyCompactAttachment adds one extra adapter call overall (runFullCompact
    // summary step + PromptTooLongError trigger + successful retry); full-compact
    // fails -> fallback placeholder, and the geometry
    // (placeholder + attachment + kept + retry) stays unchanged.
    assert.equal(
      attemptCount.value,
      3,
      "首次抛 PromptTooLongError → 摘要步 + 重试成功"
    );
    // Geometry: placeholder + attachment + DEFAULT_KEEP_RECENT kept + 1 retry assistant.
    assert.equal(
      result.messages.length,
      1 + 1 + DEFAULT_KEEP_RECENT + 1,
      `expected 1 placeholder + 1 attachment + ${DEFAULT_KEEP_RECENT} kept + 1 assistant = ${
        1 + 1 + DEFAULT_KEEP_RECENT + 1
      }, got ${result.messages.length}`
    );
    assert.deepStrictEqual(result.messages[0], {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    });
    assert.deepStrictEqual(result.messages[1], {
      role: "user",
      content: [{ type: "text", text: "focus@now\n---\nhist1" }],
    });
    // The closer is the retry's successful assistant text.
    const finalText = result.finalText;
    assert.ok(
      finalText !== null && finalText.includes("done after compact"),
      `final text must contain retry output, got ${finalText}`
    );
  });

  // -- proactive compact -> LLM summary success injection ----------------------

  it("proactive compact → 摘要成功 → messages[0] 为 SUMMARY_PREAMBLE + 摘要内容,attachment 紧随", async () => {
    // 12 prior messages of ~360 chars each -> total estimate > 1000 threshold,
    // so proactive compaction fires before run's first model call (no tool
    // continuation turn needed to reach the gate). The adapter returns a
    // structured summary on the compact summary step (tools === undefined);
    // model steps only consume the completed-closer script.
    const longPrior = Array.from({ length: 12 }, (_, i) =>
      text(`prior-${i} ${"z".repeat(350)}`)
    );
    const adapter = makeCompactSummaryAdapter({
      responses: buildResponses(0),
    });
    const { result } = await run(
      "hello",
      {
        adapter,
        executor,
        registry,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 1000 },
        boundaryAttachment: () => "focus@now\n---\nhist1",
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    // Summary rounds >= 1 pins that the summary-success path is really wired up.
    // A successful compaction records lastCompactTurn as the current turnCount,
    // so the same turn is never re-scanned.
    assert.ok(
      adapter.compactSteps.value >= 1,
      "摘要轮至少 1 次,否则 LLM 摘要成功路径未被触发"
    );

    // messages[0] = SUMMARY_PREAMBLE + summary text (LLM summary success path).
    assert.ok(
      isSummaryMessage(result.messages[0]!),
      "messages[0] 必须是 LLM 摘要轮 user 消息"
    );
    const firstText = textOf(result.messages[0]!);
    assert.ok(
      firstText.includes("SUMMARY-OVER-DROPPED"),
      "摘要内容进入 messages[0]"
    );
    // messages[1] = boundaryAttachment rendered text (same geometry as the fallback path).
    assert.deepStrictEqual(result.messages[1], {
      role: "user",
      content: [{ type: "text", text: "focus@now\n---\nhist1" }],
    });
    // Kept tail: the final assistant closer is still present.
    assertCompletionTail(result.messages);
  });

  it("plan compress-trigger-gate T5: messages ≤ DEFAULT_KEEP_RECENT 但 token 超阈值 → 触发 full summary 路径,不静默 no-op", async () => {
    // 5 priors (≤ keepRecent=6) of 50k chars each -> estimate ≈ 100k tokens >> threshold=1000
    // -> evaluateCompactTrigger must return action: 'compact_via_full_summary'.
    // Over-threshold priors fire before run's first call, no tool continuation turn needed.
    // The old splitForCompaction-only path would no-op here (slicedFrom=0) and
    // never update lastCompactTurn -> a "re-check every turn, never compact"
    // livelock; this case pins that the new path really drives runFullCompact
    // through the LLM summary.
    const longPrior = Array.from({ length: 5 }, (_, i) =>
      text(`prior-${i} ${"x".repeat(50_000)}`)
    );
    const adapter = makeCompactSummaryAdapter({
      responses: buildResponses(0),
    });
    const { result } = await run(
      "hello",
      {
        adapter,
        executor,
        registry,
        maxTurns: 5,
        compress: { contextWindow: 200_000, thresholdTokens: 1_000 },
      },
      undefined,
      { priorMessages: longPrior }
    );
    assert.equal(result.stopReason, "completed");
    // Key assertion: full-summary rounds >= 1, proving proactive isn't stuck in the no-op livelock.
    assert.ok(
      adapter.compactSteps.value >= 1,
      `messages ≤ keepRecent 但 token 超阈值时必须触发 full summary 路径,实际 compactSteps=${adapter.compactSteps.value}`
    );
    // messages[0] should be the LLM summary round (SUMMARY_PREAMBLE + summary text), not the original 5 kept priors.
    assert.ok(
      isSummaryMessage(result.messages[0]!),
      "messages[0] 必须是 LLM 摘要轮 user 消息(full summary 路径落点)"
    );
    // Kept tail: the final assistant closer survives (run() still completes after proactive compaction)
    assertCompletionTail(result.messages);
  });
});
