/**
 * Runtime-state publications at the loop's four durable boundaries.
 *
 * The neutral `RuntimePersistenceSink` port (src/shared/runtime-persistence.ts)
 * is the engine's only write seam for session state: the engine assembles the
 * context and the facts, the host owns the storage. This file pins the engine
 * half of that split:
 *
 *   1. accepted input: an awaited full-state write carrying the context the
 *      first model request actually sees, before that request is dispatched;
 *   2. per-result facts: one per settled call, carrying tool-use identity +
 *      batch position/size, appended as each call returns even while an
 *      earlier call is still blocked;
 *   3. batch boundary: a full-state write only once every returned call is
 *      inside the context — never for a batch with a detached handler still
 *      running;
 *   4. compaction + terminal: the exact post-compaction array, and the
 *      observed stop reason on the returned-stop path only.
 *
 * Ordering is asserted on a recorded sequence (sink writes, fact appends and
 * model dispatches share one ordered log), not on call counts. Concurrency
 * tests use explicit deferred barriers, never timers.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/harness/loop-engine.ts";
import {
  MaxTurnsExceeded,
  MessageCommitError,
  PromptTooLongError,
  RuntimeStatePersistenceError,
} from "../../src/harness/errors.ts";
import {
  createRuntimePersistenceBinder,
  CURRENT_SCHEMA_VERSION,
  NATIVE_STATE_FORMAT_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type {
  RuntimeOperationFact,
  RuntimePersistenceSink,
  RuntimeSavedStateRequest,
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
  Executor,
  ToolCall,
  ToolDef,
  ToolExecutionResult,
} from "../../src/harness/tools/types.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import type { StubModelFull } from "../../src/harness/stubs/stub-model.ts";
import { assistantResult } from "../cli/_fixtures.ts";

// -- fixtures ----------------------------------------------------------------

/** Root writes a 0o444 file, so the chmod-refused append the SC3 arm depends
 *  on cannot be constructed there. The repo's own convention for this case is
 *  `it.skipIf(isRoot)` — see `tests/session-api/store/runtime-persistence-host.test.ts`. */
const isRoot = process.getuid?.() === 0;

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * One recorder shared by the sink and the adapter, so the recorded log is a
 * single total order across both seams. `modelSeen` keeps the (frozen) message
 * array reference each dispatch was handed — the exact context, not a copy.
 */
interface Recorder {
  readonly log: string[];
  readonly published: RuntimeSavedStateRequest<AnthropicNativeMessage>[];
  readonly facts: RuntimeToolResultFact<AnthropicNativeMessage>[];
  readonly modelSeen: ReadonlyArray<AnthropicNativeMessage>[];
  readonly commits: ReadonlyArray<AnthropicNativeMessage>[];
}

function createRecorder(): Recorder {
  return { log: [], published: [], facts: [], modelSeen: [], commits: [] };
}

interface SinkOpts {
  /** Runs before the write is recorded; returning an error makes it fail. */
  readonly beforePublish?: (
    request: RuntimeSavedStateRequest<AnthropicNativeMessage>
  ) => unknown;
  readonly beforeFact?: (
    fact: RuntimeOperationFact<AnthropicNativeMessage>
  ) => unknown;
  readonly onFact?: (
    fact: RuntimeToolResultFact<AnthropicNativeMessage>
  ) => void;
}

function createRecordingSink(
  rec: Recorder,
  opts?: SinkOpts
): RuntimePersistenceSink<AnthropicNativeMessage> {
  return {
    async publishSavedState(request) {
      const failure = await opts?.beforePublish?.(request);
      if (failure !== undefined) throw failure;
      rec.published.push(request);
      rec.log.push(`publish:${request.boundary}`);
    },
    async appendOperationFact(fact) {
      const failure = await opts?.beforeFact?.(fact);
      if (failure !== undefined) throw failure;
      rec.log.push(`fact:${fact.kind}`);
      if (fact.kind === "tool_result") {
        rec.facts.push(fact);
        opts?.onFact?.(fact);
      }
    },
  };
}

function recordingAdapter(base: StubModelFull, rec: Recorder): StubModelFull {
  return Object.freeze({
    ...base,
    async step(
      state: LoopState,
      request: {
        tools?: unknown;
        onStream?: (event: HarnessStreamEvent) => void;
      },
      signal?: AbortSignal
    ): Promise<AssistantTurnResult> {
      // A compaction summary round goes through the same adapter with no tool
      // schema (that is the stub-model convention for "not a main-loop
      // request"), so it is logged apart and kept out of `modelSeen` — the
      // main-loop dispatches are the ones a boundary must line up with.
      if (request.tools === undefined) {
        rec.log.push("model-step:summary");
        return base.step(state, request, signal);
      }
      rec.modelSeen.push(state.messages);
      rec.log.push("model-step");
      return base.step(state, request, signal);
    },
  });
}

/**
 * Concurrency-safe stub def: the loop partitions waves on
 * `aci.isConcurrencySafe`, and plain `createStubTool` defs read as unsafe
 * (one call per wave), so a same-wave double needs the metadata.
 */
function safeTool(name: string, handler: ToolDef["handler"]): ToolDef {
  return Object.freeze({
    name,
    description: `safe ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

/**
 * Executor double with real per-call concurrency and explicit settlement order:
 * every call in the wave is launched, `gate` holds the first one, and
 * `onSettled` fires as each call returns (the shape the production ACI
 * executor uses).
 */
function parallelExecutor(opts: {
  readonly gate: Promise<void>;
  readonly settleFor?: (call: ToolCall, index: number) => ToolExecutionResult;
}): Executor {
  return Object.freeze({
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
      return await Promise.all(
        batch.map(async (call, index) => {
          if (index === 0) await opts.gate;
          const result: ToolExecutionResult = opts.settleFor?.(call, index) ?? {
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text: `ran:${call.name}` }],
          };
          await onSettled?.(result, index);
          return result;
        })
      );
    },
  });
}

const okResult = (id: string, text: string): ToolExecutionResult => ({
  kind: "ok",
  toolUseId: id,
  payload: [{ type: "text", text }],
});

/** One assistant turn with two tool_use blocks, then a text-only turn. */
function twoCallDeps(opts: {
  readonly rec: Recorder;
  readonly executor?: Executor;
  readonly sink?: SinkOpts;
  readonly settleFor?: (call: ToolCall, index: number) => ToolExecutionResult;
  readonly gate?: Promise<void>;
}): LoopEngineDeps {
  const a = safeTool("alpha", (async () => "result-a") as ToolDef["handler"]);
  const b = safeTool("beta", (async () => "result-b") as ToolDef["handler"]);
  const registry = createRegistry([a, b]);
  const model = createStubModel({
    responses: [
      assistantResult({
        texts: [],
        toolCalls: [
          { id: "a", name: "alpha", input: {} },
          { id: "b", name: "beta", input: {} },
        ],
      }),
      assistantResult({
        texts: ["done"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  return {
    adapter: recordingAdapter(model, opts.rec),
    executor:
      opts.executor ??
      parallelExecutor({
        gate: opts.gate ?? Promise.resolve(),
        ...(opts.settleFor !== undefined ? { settleFor: opts.settleFor } : {}),
      }),
    registry,
    maxTurns: 5,
    commitMessages: async (messages) => {
      opts.rec.commits.push(messages);
    },
    runtimePersistence: createRecordingSink(opts.rec, opts.sink),
  };
}

/** Single text-only turn: one model call, one completed stop. */
function textDeps(
  rec: Recorder,
  extra?: Partial<LoopEngineDeps>
): LoopEngineDeps {
  const model = createStubModel({
    responses: [
      assistantResult({
        texts: ["ok"],
        toolCalls: [],
        supplierStop: "success",
      }),
    ],
  });
  return {
    adapter: recordingAdapter(model, rec),
    executor: createExecutor(createRegistry([])),
    registry: createRegistry([]),
    maxTurns: 5,
    runtimePersistence: createRecordingSink(rec),
    ...extra,
  };
}

function boundaries(rec: Recorder): ReadonlyArray<string> {
  return rec.published.map((p) => p.boundary);
}

const prior12: ReadonlyArray<AnthropicNativeMessage> = Array.from(
  { length: 12 },
  (_, i) => ({ role: "user", content: [{ type: "text", text: `prior-${i}` }] })
);

// -- 1. accepted input before the first model dispatch ------------------------

describe("runtime state: accepted-input boundary", () => {
  it("publishes the accepted input as an awaited write before the first model dispatch", async () => {
    const rec = createRecorder();
    const entered = deferred();
    const release = deferred();
    const deps = textDeps(rec, {
      runtimePersistence: createRecordingSink(rec, {
        beforePublish: async (request) => {
          if (request.boundary !== "accepted_input") return undefined;
          entered.resolve();
          await release.promise;
          return undefined;
        },
      }),
    });

    const running = run("go", deps);
    await entered.promise;
    // The write is still pending: a non-awaiting seam would already have
    // dispatched the model request.
    assert.equal(
      rec.modelSeen.length,
      0,
      "model dispatched before the accepted-input write resolved"
    );

    release.resolve();
    const { result } = await running;
    assert.equal(result.stopReason, "completed");
    const accepted = rec.published.filter(
      (p) => p.boundary === "accepted_input"
    );
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.turnId, null, "no engine turn exists yet");
    assert.deepEqual(accepted[0]!.messages, [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ]);
    // The published context is the one the first request actually saw.
    assert.equal(rec.log[0], "publish:accepted_input");
    assert.equal(rec.log[1], "model-step");
  });

  it("publishes priorMessages + accepted text for a continuing session", async () => {
    const rec = createRecorder();
    const prior: ReadonlyArray<AnthropicNativeMessage> = [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "earlier answer" }],
      },
    ];
    await run("go", textDeps(rec), undefined, { priorMessages: prior });
    const accepted = rec.published.filter(
      (p) => p.boundary === "accepted_input"
    );
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0]!.messages, [
      ...prior,
      { role: "user", content: [{ type: "text", text: "go" }] },
    ]);
  });

  it("publishes no accepted input for a continuation run that appended nothing", async () => {
    const rec = createRecorder();
    const prior: ReadonlyArray<AnthropicNativeMessage> = [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
    ];
    const { result } = await run("", textDeps(rec), undefined, {
      appendUserText: false,
      priorMessages: prior,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(
      boundaries(rec).includes("accepted_input"),
      false,
      "a run that accepted no user input must not publish an input boundary"
    );
    assert.equal(boundaries(rec).at(-1), "terminal_turn");
  });
});

// -- 2. per-result facts ------------------------------------------------------

describe("runtime state: per-result tool facts", () => {
  it("appends one fact per settled call as it returns, keeping position for reconstruction", async () => {
    const rec = createRecorder();
    const gate = deferred();
    const firstFact = deferred();
    const deps = twoCallDeps({
      rec,
      gate: gate.promise,
      sink: { onFact: () => firstFact.resolve() },
    });

    const running = run("go", deps);
    await firstFact.promise;

    // The second call settled while the first is still blocked: its fact is
    // already durable, and the first call's fact is not invented early.
    assert.equal(rec.facts.length, 1);
    assert.equal(rec.facts[0]!.kind, "tool_result");
    assert.equal(rec.facts[0]!.toolUseId, "b");
    assert.equal(rec.facts[0]!.batchPosition, 1);
    assert.equal(rec.facts[0]!.batchSize, 2);
    assert.deepEqual(rec.facts[0]!.resultMessage, {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "b",
          content: [{ type: "text", text: "ran:beta" }],
        },
      ],
    });
    assert.equal(
      boundaries(rec).includes("tool_batch_settled"),
      false,
      "no batch publication while a call is still in flight"
    );

    gate.resolve();
    const { result } = await running;
    assert.equal(result.stopReason, "completed");

    // Settlement order is preserved as append order; batchPosition keeps
    // protocol order recoverable without relying on it.
    assert.deepEqual(
      rec.facts.map((f) => f.toolUseId),
      ["b", "a"]
    );
    const byPosition = [...rec.facts].sort(
      (x, y) => x.batchPosition - y.batchPosition
    );
    assert.deepEqual(
      byPosition.map((f) => f.toolUseId),
      ["a", "b"]
    );
    // Both facts belong to the same engine turn.
    assert.equal(new Set(rec.facts.map((f) => f.turnId)).size, 1);
    assert.equal(typeof rec.facts[0]!.turnId, "string");
  });

  it("records a returned tool error as a settled fact", async () => {
    const rec = createRecorder();
    const deps = twoCallDeps({
      rec,
      settleFor: (call) =>
        call.id === "a"
          ? okResult("a", "ran:alpha")
          : { kind: "execution_failed", toolUseId: "b", message: "boom" },
    });

    const { result } = await run("go", deps);
    assert.equal(result.stopReason, "completed");
    const failed = rec.facts.find((f) => f.toolUseId === "b");
    assert.ok(
      failed,
      "an execution_failed result is settled, not a silent drop"
    );
    assert.deepEqual(failed.resultMessage, {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "b",
          is_error: true,
          content: [{ type: "text", text: "[execution_failed] boom" }],
        },
      ],
    });
    assert.equal(
      boundaries(rec).includes("tool_batch_settled"),
      true,
      "an error result is incorporated, so the batch does settle"
    );
  });

  it("keeps a detached handler outstanding: no fact, no batch publication", async () => {
    const rec = createRecorder();
    const deps = twoCallDeps({
      rec,
      settleFor: (call) =>
        call.id === "a"
          ? okResult("a", "ran:alpha")
          : {
              kind: "execution_failed",
              toolUseId: "b",
              message: "cancelled",
              background: true,
            },
    });

    const { result } = await run("go", deps);
    assert.equal(result.stopReason, "cancelled");
    assert.deepEqual(
      rec.facts.map((f) => f.toolUseId),
      ["a"],
      "a still-running call must not be recorded as settled"
    );
    assert.equal(
      boundaries(rec).includes("tool_batch_settled"),
      false,
      "no full batch state while a call is still outstanding"
    );
  });

  it("claims no batch state when a call produced no result at all", async () => {
    const rec = createRecorder();
    // A contract-breaking executor: one call of the batch never comes back, so
    // the merged message carries only the first result. The boundary is a claim
    // about the context, and a recovery reader must not be told a batch settled
    // that the context cannot assemble.
    const shortExecutor: Executor = Object.freeze({
      async executeAll(
        batch: ReadonlyArray<ToolCall>,
        _signal: AbortSignal | undefined,
        _timeoutMs: number | undefined,
        _conversationId: string | undefined,
        onSettled?: (result: ToolExecutionResult, index: number) => void
      ): Promise<ReadonlyArray<ToolExecutionResult>> {
        const first = okResult(batch[0]!.id, `ran:${batch[0]!.name}`);
        await onSettled?.(first, 0);
        return [first];
      },
    });
    const deps = twoCallDeps({ rec, executor: shortExecutor });
    await run("go", deps);
    assert.deepEqual(
      rec.facts.map((f) => f.toolUseId),
      ["a"],
      "the result that did arrive is still a settled fact"
    );
    assert.equal(
      boundaries(rec).includes("tool_batch_settled"),
      false,
      "a batch missing a result has no settled end to publish"
    );
  });
});

// -- 3. batch boundary --------------------------------------------------------

describe("runtime state: tool-batch boundary", () => {
  it("publishes the batch only after every result is inside the context", async () => {
    const rec = createRecorder();
    const gate = deferred();
    const firstFact = deferred();
    const deps = twoCallDeps({
      rec,
      gate: gate.promise,
      sink: { onFact: () => firstFact.resolve() },
    });

    const running = run("go", deps);
    await firstFact.promise;
    assert.equal(
      boundaries(rec).includes("tool_batch_settled"),
      false,
      "batch state must wait for the whole batch"
    );

    gate.resolve();
    await running;

    const batch = rec.published.filter(
      (p) => p.boundary === "tool_batch_settled"
    );
    assert.equal(batch.length, 1);
    const merged = batch[0]!.messages.at(-1)!;
    assert.equal(merged.role, "user");
    assert.deepEqual(
      merged.content.map((b) =>
        b.type === "tool_result" ? b.tool_use_id : "not-a-tool-result"
      ),
      ["a", "b"],
      "protocol order, both results incorporated"
    );
    // The batch write lands after both facts and before the next dispatch.
    const log = rec.log;
    const lastFact = log.reduce(
      (last, entry, i) => (entry.startsWith("fact:") ? i : last),
      -1
    );
    const batchAt = log.indexOf("publish:tool_batch_settled");
    const nextStep = log.indexOf("model-step", log.indexOf("model-step") + 1);
    assert.ok(lastFact < batchAt);
    assert.ok(batchAt < nextStep);
    assert.equal(batch[0]!.turnId, rec.facts[0]!.turnId);
  });
});

// -- 4. failure atomicity -----------------------------------------------------

describe("runtime state: write failure blocks dependent execution", () => {
  it("aborts before the first dispatch and starts no handler", async () => {
    const rec = createRecorder();
    const boom = new Error("saved-state write refused");
    let handlersStarted = 0;
    const registry = createRegistry([
      safeTool("counter", (async () => {
        handlersStarted += 1;
        return "counted";
      }) as ToolDef["handler"]),
    ]);

    await assert.rejects(
      run("go", {
        adapter: textDeps(rec).adapter,
        executor: createExecutor(registry),
        registry,
        maxTurns: 5,
        runtimePersistence: createRecordingSink(rec, {
          beforePublish: (request) =>
            request.boundary === "accepted_input" ? boom : undefined,
        }),
      }),
      (err: unknown) => {
        assert.ok(
          err instanceof RuntimeStatePersistenceError,
          `expected RuntimeStatePersistenceError, got ${String(err)}`
        );
        assert.equal(err.boundary, "accepted_input");
        assert.equal(err.cause, boom, "host error is preserved as cause");
        return true;
      }
    );

    assert.equal(rec.modelSeen.length, 0, "no dependent model dispatch");
    assert.equal(handlersStarted, 0, "no dependent handler start");
    assert.equal(rec.published.length, 0, "a failed write is not recorded");
  });

  it("surfaces a fact-append failure as the typed error (no retry, no swallow)", async () => {
    const rec = createRecorder();
    const boom = new Error("fact append refused");
    const deps = twoCallDeps({
      rec,
      sink: { beforeFact: () => boom },
    });

    await assert.rejects(run("go", deps), (err: unknown) => {
      assert.ok(
        err instanceof RuntimeStatePersistenceError,
        `expected RuntimeStatePersistenceError, got ${String(err)}`
      );
      assert.equal(err.cause, boom);
      return true;
    });
    assert.equal(
      boundaries(rec).includes("tool_batch_settled"),
      false,
      "the dependent batch publication never runs"
    );
  });
});

// -- 5. compaction ------------------------------------------------------------

describe("runtime state: compaction boundary", () => {
  it("proactive: publishes the exact post-compacted context the first request sees", async () => {
    const rec = createRecorder();
    const { result } = await run(
      "Q",
      textDeps(rec, {
        // Threshold far below the estimate → the gate fires on turn 0.
        compress: { contextWindow: 200_000, thresholdTokens: 1 },
        runtimePersistence: createRecordingSink(rec),
      }),
      undefined,
      { priorMessages: prior12 }
    );
    assert.equal(result.stopReason, "completed");
    const compacted = rec.published.filter((p) => p.boundary === "compacted");
    assert.equal(compacted.length, 1);
    // Same array the first main-loop request was handed — no re-compaction, no
    // reset of the context the model actually reads.
    assert.equal(compacted[0]!.messages, rec.modelSeen[0]);
    assert.ok(
      compacted[0]!.messages.length < prior12.length + 1,
      "the published context is the compacted one"
    );
    const log = rec.log;
    assert.ok(
      log.indexOf("publish:compacted") < log.indexOf("model-step"),
      "published before the request that reads it"
    );
  });

  it("reactive: publishes the exact post-compacted context the retry sees", async () => {
    const rec = createRecorder();
    let attempts = 0;
    // Minimal adapter: the first call is the over-limit rejection, the summary
    // round (tools === undefined) returns nothing so the shared placeholder
    // fallback runs, the retry succeeds.
    const adapter = Object.freeze({
      encodeUserText: (t: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text: t }],
      }),
      encodeToolResults: (): AnthropicContentBlock[] => [],
      step: async (
        state: LoopState,
        request: { readonly tools?: unknown }
      ): Promise<AssistantTurnResult> => {
        if (request.tools === undefined) {
          rec.log.push("model-step:summary");
          return assistantResult({
            texts: [],
            toolCalls: [],
            supplierStop: "success",
          });
        }
        rec.modelSeen.push(state.messages);
        rec.log.push("model-step");
        attempts += 1;
        if (attempts === 1) {
          throw new PromptTooLongError("synthetic 400 prompt-too-long");
        }
        return assistantResult({
          texts: ["done after compact"],
          toolCalls: [],
          supplierStop: "success",
        });
      },
    });

    const { result } = await run(
      "Q",
      {
        adapter,
        executor: createExecutor(createRegistry([])),
        registry: createRegistry([]),
        maxTurns: 5,
        // High threshold: the estimate cannot cross it, so only the reactive
        // error path can compact.
        compress: { contextWindow: 200_000, thresholdTokens: 10_000 },
        runtimePersistence: createRecordingSink(rec),
      },
      undefined,
      { priorMessages: prior12 }
    );
    assert.equal(result.stopReason, "completed");
    const compacted = rec.published.filter((p) => p.boundary === "compacted");
    assert.equal(compacted.length, 1);
    assert.equal(typeof compacted[0]!.turnId, "string", "a turn is in flight");
    // The retry dispatch saw exactly the published array.
    assert.equal(compacted[0]!.messages, rec.modelSeen[1]);
    const log = rec.log;
    const compactAt = log.indexOf("publish:compacted");
    assert.ok(
      compactAt > log.indexOf("model-step"),
      "published after the rejection"
    );
    assert.ok(
      compactAt < log.lastIndexOf("model-step"),
      "published before the retry"
    );
  });
});

// -- 6. terminal boundary -----------------------------------------------------

describe("runtime state: terminal boundary", () => {
  it("publishes the observed stop reason on the returned-stop path", async () => {
    const rec = createRecorder();
    const { result } = await run("go", textDeps(rec));
    const terminal = rec.published.filter(
      (p) => p.boundary === "terminal_turn"
    );
    assert.equal(terminal.length, 1);
    assert.deepEqual(terminal[0]!.terminal, { stopReason: "completed" });
    assert.equal(
      "supplierDetail" in (terminal[0]!.terminal ?? {}),
      false,
      "absent detail stays absent"
    );
    assert.equal(terminal[0]!.messages, result.messages);
    assert.equal(boundaries(rec).at(-1), "terminal_turn");
  });

  it("carries the supplier detail behind a non-success stop", async () => {
    const rec = createRecorder();
    const model = createStubModel({
      responses: [
        assistantResult({ texts: [], toolCalls: [], supplierStop: "refusal" }),
      ],
    });
    const { result } = await run("go", {
      adapter: recordingAdapter(model, rec),
      executor: createExecutor(createRegistry([])),
      registry: createRegistry([]),
      maxTurns: 5,
      runtimePersistence: createRecordingSink(rec),
    });
    assert.equal(result.stopReason, "nonSuccessStop");
    const terminal = rec.published.filter(
      (p) => p.boundary === "terminal_turn"
    );
    assert.deepEqual(terminal[0]!.terminal, {
      stopReason: "nonSuccessStop",
      supplierDetail: "refusal",
    });
  });

  it("publishes no terminal state on the maxTurns throw path", async () => {
    const rec = createRecorder();
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a", name: "alpha", input: {} }],
        }),
        assistantResult({
          texts: [],
          toolCalls: [{ id: "a", name: "alpha", input: {} }],
        }),
      ],
    });
    const registry = createRegistry([
      safeTool("alpha", (async () => "r") as ToolDef["handler"]),
    ]);
    await assert.rejects(
      run("go", {
        adapter: recordingAdapter(model, rec),
        executor: createExecutor(registry),
        registry,
        maxTurns: 1,
        runtimePersistence: createRecordingSink(rec),
      }),
      MaxTurnsExceeded
    );
    assert.deepEqual(boundaries(rec), ["accepted_input", "tool_batch_settled"]);
    assert.equal(
      boundaries(rec).includes("terminal_turn"),
      false,
      "an unsettled turn has no terminal record to publish"
    );
  });
});

// -- 7. absent port -----------------------------------------------------------

describe("runtime state: absent port", () => {
  it("leaves the run byte-identical to the same fixture with a sink present", async () => {
    const absentRec = createRecorder();
    const withRec = createRecorder();
    const runOpts = { priorMessages: prior12 } as const;

    const absentDeps = twoCallDeps({ rec: absentRec });
    delete (absentDeps as { runtimePersistence?: unknown }).runtimePersistence;
    const { result: absentResult } = await run(
      "go",
      absentDeps,
      undefined,
      runOpts
    );
    const { result: withResult } = await run(
      "go",
      twoCallDeps({ rec: withRec }),
      undefined,
      runOpts
    );

    assert.equal(absentRec.published.length, 0, "no port, no requests");
    assert.equal(absentRec.modelSeen.length, withRec.modelSeen.length);
    assert.deepEqual(absentResult, withResult, "the port is observation-only");
    assert.deepEqual(
      absentRec.commits,
      withRec.commits,
      "the commit chain is unchanged"
    );
  });
});

// -- 8. SC3 on the real session file -------------------------------------------

/**
 * The SC3 ordering claims, proved against the REAL session file instead of a
 * recorder. Every write here goes through the production `SessionStore` and the
 * production `RuntimePersistenceBinder` into a temp JSONL, and every assertion
 * reads that file back with a fresh parse — so "persisted before the handler
 * started" is a fact about bytes, not about a shared ordered array.
 */
interface RealSession {
  readonly store: SessionStore;
  readonly conversationId: string;
  readonly logPath: string;
  readonly dispose: () => Promise<void>;
}

async function createRealSession(): Promise<RealSession> {
  const root = await mkdtemp(join(tmpdir(), "iknow-sc3-disk-"));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const store = new SessionStore(join(root, "sessions"), workspaceRoot);
  const conversationId = "sc3-tool-response";
  await store.save({
    id: conversationId,
    file: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: conversationId,
      title: "",
      cwd: workspaceRoot,
      sanitized_at: new Date().toISOString(),
      messages: [],
      jsonMode: false,
      turnCount: 0,
      updatedAt: new Date().toISOString(),
      checkpoints: [],
      nativeStateFormat: NATIVE_STATE_FORMAT_VERSION,
      workspaceRoot,
    },
  });
  const logPath = join(
    resolveConversationDir({
      projectDir: store.getProjectDir(),
      conversationId,
    }),
    `${conversationId}${SESSION_JSONL_EXT}`
  );
  // A persisted head: every native-state record anchors to a committed event,
  // and the tool-request response is persisted as exactly such an event.
  await store.appendEvents({
    id: conversationId,
    events: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  });
  return {
    store,
    conversationId,
    logPath,
    dispose: async () => {
      // The refusal case leaves the log read-only; restore it so the temp root
      // does not depend on who may unlink the file.
      chmodSync(logPath, 0o644);
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Both of the engine's write seams, backed by the real store. */
function realStoreDeps(
  session: RealSession,
  over: Partial<LoopEngineDeps> = {}
): LoopEngineDeps {
  return {
    adapter: textDeps(createRecorder()).adapter,
    executor: createExecutor(createRegistry([])),
    registry: createRegistry([]),
    maxTurns: 5,
    commitMessages: async (messages) => {
      await session.store.appendEvents({
        id: session.conversationId,
        events: messages,
      });
    },
    runtimePersistence: createRuntimePersistenceBinder({
      store: session.store,
      serialize: (_id, work) => work(),
      shouldPublish: () => true,
    }).bind(session.conversationId),
    ...over,
  };
}

function blockIds(
  message: AnthropicNativeMessage,
  type: "tool_use" | "tool_result"
): ReadonlyArray<string> {
  return message.content.flatMap((block) => {
    if (type === "tool_use") return block.type === "tool_use" ? [block.id] : [];
    return block.type === "tool_result" ? [block.tool_use_id] : [];
  });
}

/** What the real log holds at the moment it is read. */
interface LogView {
  readonly toolUseIds: ReadonlyArray<string>;
  readonly toolResultIds: ReadonlyArray<string>;
  readonly factCount: number;
}

function readLogView(logPath: string): LogView {
  const log = parseSessionJsonl(readFileSync(logPath, "utf8"));
  return {
    toolUseIds: log.events.flatMap((e) => blockIds(e.message, "tool_use")),
    toolResultIds: log.events.flatMap((e) =>
      blockIds(e.message, "tool_result")
    ),
    factCount: log.records.filter((r) => r.type === "operation_fact").length,
  };
}

/** One label per record in file order, read off disk. */
function recordTimeline(logPath: string): ReadonlyArray<string> {
  return parseSessionJsonl(readFileSync(logPath, "utf8")).records.map((r) => {
    if (r.type === "message") return `event:${r.message.role}`;
    if (r.type === "native_state") return `native_state:${r.boundary}`;
    if (r.type === "operation_fact") return `fact:${r.fact.kind}`;
    return r.type;
  });
}

const threeCallResponse = (supplierStop: "success" | "truncation") =>
  assistantResult({
    texts: [],
    toolCalls: [
      { id: "a", name: "alpha", input: {} },
      { id: "b", name: "beta", input: {} },
      { id: "c", name: "gamma", input: {} },
    ],
    supplierStop,
  });

describe("SC3 — tool-response boundary on the real session file", () => {
  it("SC3: the complete tool-request response is committed to the real log before any tool handler starts", async () => {
    const session = await createRealSession();
    try {
      // Every handler's FIRST act is to read the real file. The production
      // executor runs a wave call by call, so the first handler to start is the
      // earliest moment a handler could have observed anything at all.
      const seenAtStart: LogView[] = [];
      const probe = (name: string) =>
        (async () => {
          seenAtStart.push(readLogView(session.logPath));
          return `${name}-done`;
        }) as ToolDef["handler"];

      const registry = createRegistry([
        safeTool("alpha", probe("alpha")),
        safeTool("beta", probe("beta")),
        safeTool("gamma", probe("gamma")),
      ]);
      const model = createStubModel({
        responses: [
          threeCallResponse("success"),
          assistantResult({
            texts: ["done"],
            toolCalls: [],
            supplierStop: "success",
          }),
        ],
      });

      const { result } = await run(
        "go",
        realStoreDeps(session, {
          adapter: model,
          registry,
          executor: createExecutor(registry),
        })
      );
      assert.equal(result.stopReason, "completed");
      assert.equal(seenAtStart.length, 3, "every handler started and looked");

      // The claim, read off disk from inside each handler: the whole
      // tool-request response — all three ids, one committed event — was
      // already durable before that handler's first line ran.
      for (const [index, view] of seenAtStart.entries()) {
        assert.deepEqual(
          view.toolUseIds,
          ["a", "b", "c"],
          `handler ${index} started before the complete tool-request response was on disk`
        );
      }
      // The earliest one saw a batch with nothing settled yet, so nothing about
      // this batch was durable when it started.
      assert.deepEqual(seenAtStart[0]!.toolResultIds, []);
      assert.equal(seenAtStart[0]!.factCount, 0);

      // And the file's own record order carries the whole contract.
      const timeline = recordTimeline(session.logPath);
      const assistantAt = timeline.indexOf("event:assistant");
      const factsAt = timeline.flatMap((label, i) =>
        label.startsWith("fact:") ? [i] : []
      );
      const batchAt = timeline.indexOf("native_state:tool_batch");
      assert.ok(assistantAt >= 0, "the tool-request response is on disk");
      assert.equal(factsAt.length, 3, "one fact per settled call");
      assert.ok(
        assistantAt < Math.min(...factsAt),
        `assistant response must precede every fact: ${timeline.join(" -> ")}`
      );
      assert.ok(
        Math.max(...factsAt) < batchAt,
        `the batch state must be published after every fact: ${timeline.join(" -> ")}`
      );
    } finally {
      await session.dispose();
    }
  });

  it.skipIf(isRoot)(
    "SC3: a real refused write of the tool-request response starts no handler and records no fact",
    async () => {
      const session = await createRealSession();
      try {
        let handlersStarted = 0;
        const registry = createRegistry([
          safeTool("alpha", (async () => {
            handlersStarted += 1;
            return "counted";
          }) as ToolDef["handler"]),
          safeTool("beta", (async () => {
            handlersStarted += 1;
            return "counted";
          }) as ToolDef["handler"]),
          safeTool("gamma", (async () => {
            handlersStarted += 1;
            return "counted";
          }) as ToolDef["handler"]),
        ]);
        const base = createStubModel({
          responses: [threeCallResponse("success")],
        });
        const step = base.step.bind(base);
        // The fault is a real one: the log is made un-appendable by the OS at the
        // moment the response exists but the engine has not committed it. No mock
        // store and no injected rejection — the production append really fails.
        const adapter: StubModelFull = Object.freeze({
          ...base,
          step: async (
            state: LoopState,
            request: { readonly tools?: unknown },
            signal?: AbortSignal
          ): Promise<AssistantTurnResult> => {
            const result = await step(state, request, signal);
            if (request.tools !== undefined) chmodSync(session.logPath, 0o444);
            return result;
          },
        });

        await assert.rejects(
          run(
            "go",
            realStoreDeps(session, {
              adapter,
              registry,
              executor: createExecutor(registry),
            })
          ),
          (err: unknown) => {
            assert.ok(
              err instanceof MessageCommitError,
              `expected MessageCommitError, got ${String(err)}`
            );
            return true;
          }
        );

        assert.equal(handlersStarted, 0, "no dependent call may start");
        const view = readLogView(session.logPath);
        assert.deepEqual(
          view.toolUseIds,
          [],
          "the refused response must not be on disk"
        );
        assert.equal(
          view.factCount,
          0,
          "no fact follows an uncommitted response"
        );
        assert.equal(
          recordTimeline(session.logPath).includes("native_state:tool_batch"),
          false,
          "the dependent batch publication never runs"
        );
      } finally {
        await session.dispose();
      }
    }
  );

  it("SC3: an incomplete response dispatches no enclosed tool call and its closeout lands on the real log", async () => {
    const session = await createRealSession();
    try {
      let handlersStarted = 0;
      const counting = (async () => {
        handlersStarted += 1;
        return "counted";
      }) as ToolDef["handler"];
      const registry = createRegistry([
        safeTool("alpha", counting),
        safeTool("beta", counting),
        safeTool("gamma", counting),
      ]);
      const base = createStubModel({
        responses: [threeCallResponse("truncation")],
      });

      const { result } = await run(
        "go",
        realStoreDeps(session, {
          adapter: base,
          registry,
          executor: createExecutor(registry),
        })
      );

      assert.equal(handlersStarted, 0, "no enclosed tool call may run");
      const view = readLogView(session.logPath);
      assert.deepEqual(
        view.toolUseIds,
        ["a", "b", "c"],
        "the incomplete response itself is on disk"
      );
      // The closeout contract, proven on disk: one is_error tool_result per
      // returned id, closing the batch in the same host turn.
      assert.deepEqual(view.toolResultIds, ["a", "b", "c"]);
      assert.equal(view.factCount, 0, "nothing settled, so nothing recorded");
      const timeline = recordTimeline(session.logPath);
      assert.equal(
        timeline.includes("native_state:tool_batch"),
        false,
        "no batch state for a batch that never ran"
      );
      assert.equal(
        timeline.includes("native_state:terminal"),
        true,
        `the turn still closes out: ${timeline.join(" -> ")}`
      );
      assert.equal(result.stopReason, "nonSuccessStop");
      assert.equal(
        (result as { readonly supplierDetail?: string }).supplierDetail,
        "truncation"
      );
    } finally {
      await session.dispose();
    }
  });
});
