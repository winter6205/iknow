/**
 * Batch identity of a settled-result fact: the port says `batchPosition` is
 * "unique per batch, zero-based" and `batchSize` is "how many calls the batch
 * contained", and a reader restores protocol order by sorting on it.
 *
 * The defect this pins: the producer recorded the call's index WITHIN ITS
 * CONCURRENCY WAVE and the wave's length. A wave is a scheduling split inside
 * one assistant response's tool batch, so a batch mixing concurrency-safe and
 * unsafe calls produced several facts all claiming `batchPosition: 0,
 * batchSize: 1` — a reader could neither order them nor tell how many calls the
 * batch held. The port's documented meaning is the contract; the producer is
 * what was wrong.
 *
 * Settlement order is deliberately INVERTED inside every wave, so append order
 * can never stand in for protocol order: the reconstruction has to come from
 * the positions. Each case also asserts the wave partition it ran against, so a
 * case cannot pass by accidentally running a single-wave batch.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { run } from "../../src/harness/loop-engine.ts";
import type {
  RuntimeOperationFact,
  RuntimePersistenceSink,
  RuntimeToolResultFact,
} from "../../src/shared/runtime-persistence.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopEngineDeps,
  LoopState,
} from "../../src/harness/index.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";
import type {
  ToolCall,
  ToolDef,
  ToolExecutionResult,
} from "../../src/harness/tools/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { assistantResult } from "../cli/_fixtures.ts";

/** A tool whose scheduling class the engine reads off the registry entry. */
function toolDef(
  name: string,
  concurrencySafe: boolean,
  category: "read-only" | "write"
): ToolDef {
  return Object.freeze({
    name,
    description: `${name} fixture`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: (async () => `ran:${name}`) as ToolDef["handler"],
    aci: {
      category,
      isConcurrencySafe: concurrencySafe,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

const resultFor = (call: ToolCall): ToolExecutionResult => ({
  kind: "ok",
  toolUseId: call.id,
  payload: [{ type: "text", text: `ran:${call.name}` }],
});

interface Recorder {
  readonly facts: RuntimeToolResultFact<AnthropicNativeMessage>[];
  /** One entry per `executeAll` call: the wave partition really used. */
  readonly waves: string[][];
  readonly published: ReadonlyArray<AnthropicNativeMessage>[];
}

/**
 * One assistant turn whose batch is `names` in that exact order, then a
 * text-only turn. `concurrencySafe` decides the wave partition, so the caller
 * controls how many waves the batch splits into.
 */
function batchDeps(
  names: ReadonlyArray<{ readonly id: string; readonly safe: boolean }>,
  rec: Recorder
): LoopEngineDeps {
  const registry = createRegistry(
    names.map(({ id, safe }) => toolDef(id, safe, safe ? "read-only" : "write"))
  );
  const model = createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: names.map(({ id }) => ({ id, name: id, input: {} })),
      }),
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  const sink: RuntimePersistenceSink<AnthropicNativeMessage> = {
    async publishSavedState(request) {
      rec.published.push(request.messages);
    },
    async appendOperationFact(
      fact: RuntimeOperationFact<AnthropicNativeMessage>
    ) {
      if (fact.kind === "tool_result") rec.facts.push(fact);
    },
  };
  return {
    adapter: Object.freeze({
      ...model,
      step: (
        state: LoopState,
        request: {
          system?: string;
          onStream?: (e: HarnessStreamEvent) => void;
        },
        signal?: AbortSignal
      ): Promise<AssistantTurnResult> => model.step(state, request, signal),
    }),
    // The engine hands each WAVE to executeAll, so the partition is observable
    // from here; the calls of one wave are independent, so reporting them
    // last-to-first is a legal settlement order.
    executor: Object.freeze({
      async executeAll(
        batch: ReadonlyArray<ToolCall>,
        _signal: AbortSignal | undefined,
        _timeoutMs: number | undefined,
        _conversationId: string | undefined,
        onSettled?: (
          result: ToolExecutionResult,
          index: number
        ) => void | Promise<void>
      ): Promise<ReadonlyArray<ToolExecutionResult>> {
        rec.waves.push(batch.map((call) => call.id));
        const results = batch.map(resultFor);
        for (let i = batch.length - 1; i >= 0; i--) {
          await onSettled?.(results[i]!, i);
        }
        return results;
      },
    }),
    registry,
    maxTurns: 5,
    runtimePersistence: sink,
  };
}

/** `tool_use_id` order of the tool_results inside one published context. */
function resultOrder(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  const order: string[] = [];
  for (const message of messages) {
    for (const block of message.content as ReadonlyArray<AnthropicContentBlock>) {
      if (block.type === "tool_result") order.push(block.tool_use_id);
    }
  }
  return order;
}

const byPosition = (
  facts: ReadonlyArray<RuntimeToolResultFact<AnthropicNativeMessage>>
): string[] =>
  [...facts]
    .sort((x, y) => x.batchPosition - y.batchPosition)
    .map((f) => f.toolUseId);

describe("tool_result fact: batch identity, not wave identity", () => {
  it("numbers positions across every wave of the batch and sizes by the batch", async () => {
    const rec: Recorder = { facts: [], waves: [], published: [] };
    // Two waves of two plus one singleton: three waves, five calls.
    const deps = batchDeps(
      [
        { id: "a", safe: true },
        { id: "b", safe: true },
        { id: "c", safe: false },
        { id: "d", safe: true },
        { id: "e", safe: true },
      ],
      rec
    );

    const { result } = await run("go", deps);
    assert.equal(result.stopReason, "completed");
    // The partition really has several waves, so wave-local numbering could not
    // have produced a unique set of positions here.
    assert.deepEqual(rec.waves, [["a", "b"], ["c"], ["d", "e"]]);
    assert.equal(rec.facts.length, 5);

    assert.deepEqual(
      rec.facts.map((f) => f.batchPosition).sort((x, y) => x - y),
      [0, 1, 2, 3, 4],
      "positions are unique across the whole batch and zero-based"
    );
    assert.equal(
      new Set(rec.facts.map((f) => f.batchPosition)).size,
      5,
      "two calls of one batch must never claim the same position"
    );
    for (const fact of rec.facts) {
      assert.equal(
        fact.batchSize,
        5,
        `fact ${fact.toolUseId} sized by its wave instead of the batch`
      );
    }
  });

  it("restores the original call order from the positions alone", async () => {
    const rec: Recorder = { facts: [], waves: [], published: [] };
    const deps = batchDeps(
      [
        { id: "a", safe: true },
        { id: "b", safe: true },
        { id: "c", safe: false },
        { id: "d", safe: true },
        { id: "e", safe: true },
      ],
      rec
    );

    await run("go", deps);
    // Waves run in order but each wave's calls settle last-to-first, so the
    // append sequence is not the call sequence and cannot stand in for it.
    assert.deepEqual(
      rec.facts.map((f) => f.toolUseId),
      ["b", "a", "c", "e", "d"]
    );
    assert.deepEqual(
      byPosition(rec.facts),
      ["a", "b", "c", "d", "e"],
      "sorting the facts by position must rebuild the assistant's call order"
    );
    // The published batch context agrees, and it is the protocol order a reader
    // falls back to when a call is missing from the fact stream.
    assert.equal(rec.published.length, 3);
    assert.deepEqual(resultOrder(rec.published[1]!), ["a", "b", "c", "d", "e"]);
  });

  it("numbers a batch whose waves are all single calls", async () => {
    const rec: Recorder = { facts: [], waves: [], published: [] };
    // Every call is a wave of one — the shape that used to yield three facts
    // all claiming `batchPosition: 0, batchSize: 1`.
    const deps = batchDeps(
      [
        { id: "x", safe: false },
        { id: "y", safe: false },
        { id: "z", safe: false },
      ],
      rec
    );

    const { result } = await run("go", deps);
    assert.equal(result.stopReason, "completed");
    assert.deepEqual(rec.waves, [["x"], ["y"], ["z"]]);
    assert.deepEqual(
      rec.facts
        .slice()
        .sort((a, b) => a.batchPosition - b.batchPosition)
        .map((f) => [f.toolUseId, f.batchPosition, f.batchSize]),
      [
        ["x", 0, 3],
        ["y", 1, 3],
        ["z", 2, 3],
      ]
    );
  });

  it("keeps a settled/unsettled comparison meaningful across waves", async () => {
    const rec: Recorder = { facts: [], waves: [], published: [] };
    const deps = batchDeps(
      [
        { id: "a", safe: true },
        { id: "b", safe: true },
        { id: "c", safe: false },
      ],
      rec
    );

    await run("go", deps);
    // The reader's settled/unsettled test is "settled facts / batchSize"; with a
    // wave-sized denominator the ratio could exceed 1 and read as settled.
    const settled = rec.facts.length;
    assert.equal(settled, 3);
    assert.equal(settled / rec.facts[0]!.batchSize, 1);
  });
});
