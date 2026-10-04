/**
 * Frozen session assembly on every published state (plan B2: "required frozen
 * session context ... available without consulting current settings").
 *
 * The defect this pins: `RuntimeSavedStateRequest.assembly` was declared and
 * no publish site ever set it, so a reopened session had to re-derive its prompt
 * prefix from current settings — exactly what the clause forbids. The prefix
 * published here is the one the request was *sent*, so the assertions read what
 * the adapter received; a re-derived prefix that drifted by one byte fails.
 *
 * Also pinned: the append-order binding of a tool_result fact to its base state
 * (the port states no base-state field, so the order is the only binding — a
 * buffered or reordered fact would be silently re-attached to a state that
 * already contains its result).
 *
 * Not proven here: the fresh-process reopen that consumes a published assembly
 * state. The three fields the kernel has no owner for are not assembly inputs
 * at all any more — the contract dropped them, and the last block of this file
 * pins that removal per field rather than leaving them declared and unwritten.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../../src/harness/loop-engine.ts";
import type {
  RuntimeOperationFact,
  RuntimePersistenceSink,
  RuntimeSavedStateRequest,
  RuntimeToolResultFact,
} from "../../src/shared/runtime-persistence.ts";
import type {
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
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import type { StubModelFull } from "../../src/harness/stubs/stub-model.ts";
import { assistantResult } from "../cli/_fixtures.ts";

const PREFIX = "system-prefix-v1";

/**
 * One ordered log across the sink and the adapter, so a fact's base state is
 * the last publication *before* its append rather than whatever a per-kind
 * array happens to hold.
 */
interface Recorder {
  readonly log: string[];
  readonly published: RuntimeSavedStateRequest<AnthropicNativeMessage>[];
  readonly facts: RuntimeToolResultFact<AnthropicNativeMessage>[];
  /** The `system` field of each main-loop request, exactly as sent. */
  readonly systemSeen: Array<string | undefined>;
  /** How many times the `deps.system` seam was resolved this run. */
  seamCalls: number;
  /** Fires on the first tool_result fact, so a test can look mid-flight. */
  onFact?: () => void;
}

function createRecorder(): Recorder {
  return { log: [], published: [], facts: [], systemSeen: [], seamCalls: 0 };
}

function recordingSink(
  rec: Recorder
): RuntimePersistenceSink<AnthropicNativeMessage> {
  return {
    async publishSavedState(request) {
      rec.published.push(request);
      rec.log.push(`publish:${request.boundary}`);
    },
    async appendOperationFact(
      fact: RuntimeOperationFact<AnthropicNativeMessage>
    ) {
      if (fact.kind === "tool_result") {
        rec.facts.push(fact);
        rec.log.push(`fact:${fact.toolUseId}`);
        rec.onFact?.();
      } else {
        rec.log.push(`fact:${fact.kind}`);
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
        system?: string;
        onStream?: (event: HarnessStreamEvent) => void;
      },
      signal?: AbortSignal
    ): Promise<AssistantTurnResult> {
      // A compaction summary round carries no tool schema; only main-loop
      // dispatches are the requests whose `system` the publication must match.
      if (request.tools === undefined) return base.step(state, request, signal);
      rec.systemSeen.push(request.system);
      rec.log.push("model-step");
      return base.step(state, request, signal);
    },
  });
}

/** The per-turn prompt seam, counted so "one extra resolution" is observable. */
function countingSystemSeam(
  rec: Recorder,
  value: string | undefined = PREFIX
): () => Promise<string | undefined> {
  return async () => {
    rec.seamCalls += 1;
    return value;
  };
}

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

/** Single text-only turn: one model request, one completed stop. */
function textDeps(
  rec: Recorder,
  opts?: {
    readonly withSystem?: boolean;
    readonly extra?: Partial<LoopEngineDeps>;
  }
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
  const registry = createRegistry([]);
  return {
    adapter: recordingAdapter(model, rec),
    executor: createExecutor(registry),
    registry,
    maxTurns: 5,
    runtimePersistence: recordingSink(rec),
    ...(opts?.withSystem === false ? {} : { system: countingSystemSeam(rec) }),
    ...opts?.extra,
  };
}

/**
 * One assistant turn with two tool_use blocks (one concurrency-safe wave, the
 * first call held behind `gate`), then a text-only turn.
 */
function toolDeps(
  rec: Recorder,
  gate: Promise<void> = Promise.resolve()
): LoopEngineDeps {
  const registry = createRegistry([
    safeTool("alpha", (async () => "result-a") as ToolDef["handler"]),
    safeTool("beta", (async () => "result-b") as ToolDef["handler"]),
  ]);
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
    adapter: recordingAdapter(model, rec),
    // Real per-call concurrency with an explicit settlement order: the first
    // call waits on the gate, so the second one's fact is the only one that can
    // exist while the run is still blocked.
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
        return await Promise.all(
          batch.map(async (call, index) => {
            if (index === 0) await gate;
            const result: ToolExecutionResult = {
              kind: "ok",
              toolUseId: call.id,
              payload: [{ type: "text", text: `ran:${call.name}` }],
            };
            await onSettled?.(result, index);
            return result;
          })
        );
      },
    }),
    registry,
    maxTurns: 5,
    system: countingSystemSeam(rec),
    runtimePersistence: recordingSink(rec),
  };
}

const prior12: ReadonlyArray<AnthropicNativeMessage> = Array.from(
  { length: 12 },
  (_, i) => ({ role: "user", content: [{ type: "text", text: `prior-${i}` }] })
);

/** tool_use_ids whose tool_result is already inside a published state. */
function resultsIn(
  request: RuntimeSavedStateRequest<AnthropicNativeMessage>
): Set<string> {
  const ids = new Set<string>();
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_result") ids.add(block.tool_use_id);
    }
  }
  return ids;
}

// -- 1. the frozen prefix reaches every publication ---------------------------

describe("runtime state: frozen assembly on publications", () => {
  it("carries the prefix the model request was sent on every boundary", async () => {
    const rec = createRecorder();
    const { result } = await run("go", toolDeps(rec));
    assert.equal(result.stopReason, "completed");

    // Sanity on the fixture itself: the requests really were sent this prefix,
    // so a passing assertion below is about the publication, not a dead seam.
    assert.equal(rec.systemSeen.length, 2);
    assert.deepEqual([...new Set(rec.systemSeen)], [PREFIX]);
    assert.deepEqual(
      rec.published.map((p) => p.boundary),
      ["accepted_input", "tool_batch_settled", "terminal_turn"]
    );
    for (const request of rec.published) {
      assert.equal(
        request.assembly?.systemPrefix,
        PREFIX,
        `boundary ${request.boundary} published without the frozen prefix`
      );
    }
  });

  it("seeds the accepted-input publication before the first request is dispatched", async () => {
    const rec = createRecorder();
    const { result } = await run("go", textDeps(rec));
    assert.equal(result.stopReason, "completed");
    const accepted = rec.published.filter(
      (p) => p.boundary === "accepted_input"
    );
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.assembly?.systemPrefix, PREFIX);
    assert.equal(
      rec.log[0],
      "publish:accepted_input",
      "the prefix must be resolved before the first request, not after"
    );
  });

  it("resolves the prompt seam once for the port, not once per publication", async () => {
    const rec = createRecorder();
    await run("go", toolDeps(rec));
    // Two main-loop requests resolve the seam (pre-existing per-turn behavior)
    // plus exactly one resolution for the port, shared by all three
    // publications: a boundary must not re-assemble the prefix.
    assert.equal(rec.published.length, 3);
    assert.equal(
      rec.seamCalls,
      rec.systemSeen.length + 1,
      "more than one port resolution means a publication re-derived the prefix"
    );
  });

  it("carries the prefix on a compaction publication too", async () => {
    const rec = createRecorder();
    const { result } = await run(
      "Q",
      textDeps(rec, {
        // Threshold far below the estimate → the proactive gate fires on turn 0.
        extra: { compress: { contextWindow: 200_000, thresholdTokens: 1 } },
      }),
      undefined,
      { priorMessages: prior12 }
    );
    assert.equal(result.stopReason, "completed");
    const compacted = rec.published.filter((p) => p.boundary === "compacted");
    assert.equal(compacted.length, 1);
    assert.equal(compacted[0]!.assembly?.systemPrefix, PREFIX);
  });

  it("publishes no assembly when the run has no prompt prefix to freeze", async () => {
    const rec = createRecorder();
    const { result } = await run("go", textDeps(rec, { withSystem: false }));
    assert.equal(result.stopReason, "completed");
    assert.ok(rec.published.length > 0);
    for (const request of rec.published) {
      assert.equal(
        "assembly" in request,
        false,
        "no prefix means no assembly claim — same omission the request uses"
      );
    }
    assert.equal(rec.seamCalls, 0);
  });

  it("costs an unwired run no extra resolution", async () => {
    const rec = createRecorder();
    const deps = textDeps(rec);
    delete (deps as { runtimePersistence?: unknown }).runtimePersistence;
    const { result } = await run("go", deps);
    assert.equal(result.stopReason, "completed");
    assert.equal(rec.published.length, 0, "no port, no requests");
    assert.equal(
      rec.seamCalls,
      rec.systemSeen.length,
      "a run that reports through no port must not pay for a prefix it never publishes"
    );
  });

  it("publishes the prefix and nothing else, so absence stays readable", async () => {
    const rec = createRecorder();
    const { result } = await run("go", toolDeps(rec));
    assert.equal(result.stopReason, "completed");
    assert.ok(rec.published.length > 0);
    for (const request of rec.published) {
      // The whole assembly surface is one owned observation. A second key could
      // only be a default (`[]` / `false` / `""`) or a value this run never
      // resolved, and both would be indistinguishable from a real one.
      assert.deepEqual(Object.keys(request.assembly ?? {}), ["systemPrefix"]);
    }
  });
});

// -- 3. the fields with no engine-visible owner are gone ---------------------

/**
 * The port source is the assertion surface here: a declared field with no
 * producer is a guarantee the code does not make, so the contract must not
 * mention these names at all — neither as a field nor as a claim in the doc.
 */
const PORT_SOURCE = readFileSync(
  new URL("../../src/shared/runtime-persistence.ts", import.meta.url),
  "utf8"
);

describe("runtime state: assembly fields the engine cannot own", () => {
  it("keeps systemPrefix, the one field the engine produces", () => {
    // Producer: `publishSavedStateOrThrow` attaches the run's frozen prefix on
    // every boundary, so this is a real observation, not a declared wish.
    assert.match(PORT_SOURCE, /interface RuntimeAssemblyState/);
    assert.match(PORT_SOURCE, /readonly systemPrefix\?: string/);
  });

  it("does not declare skillIndexSeen — the entry ledger owns that set", () => {
    // No owner: the seen set lives in the persisted entry ledger
    // (harness/skill/index-ledger.ts, `snapshot()`), and the engine's only seam
    // reveals ONE ROUND's delta (`added`), never the earlier rounds' entries. A
    // run-accumulated list would be a subset presented as the whole set, and a
    // second authority for a set the ledger already owns.
    assert.equal(
      PORT_SOURCE.includes("skillIndexSeen"),
      false,
      "the contract must not declare a field nothing can fill"
    );
  });

  it("does not declare pendingContinuation — the session host owns that verdict", () => {
    // No owner: it is a session-api predicate over the transcript
    // (session-api/continue-pending.ts, evaluated by hub/CLI/TUI). LoopState is
    // `{messages, turnCount}` — the engine holds no continuation flag to read.
    assert.equal(
      PORT_SOURCE.includes("pendingContinuation"),
      false,
      "the contract must not declare a field nothing can fill"
    );
  });

  it("does not declare executionMode — the mode is a two-axis value the engine cannot see", () => {
    // No owner: the selected mode is the joint permission + graph snapshot. The
    // permission mode reaches the executor, not the engine (zero occurrences in
    // loop-engine), and the graph half is visible only as a boolean overlay and
    // only when a graph seam is wired. Publishing one half as the mode would be
    // a partial claim presented as the whole.
    assert.equal(
      PORT_SOURCE.includes("executionMode"),
      false,
      "the contract must not declare a field nothing can fill"
    );
  });

  it("declares no provenance field for the prefix it does produce", async () => {
    // The published bytes ARE the `system` the requests were sent, so the
    // request they travel on answers "which request was this assembled
    // against". Where those bytes ORIGINATE is the host's prompt seam, not an
    // engine observation — a constant stamped here would read as provenance the
    // engine never had. `hostInjected` is a per-message stamp and says nothing
    // about the prefix, which is not a message.
    const rec = createRecorder();
    const { result } = await run("go", toolDeps(rec));
    assert.equal(result.stopReason, "completed");
    assert.ok(rec.published.length > 0);
    for (const request of rec.published) {
      assert.deepEqual(Object.keys(request.assembly ?? {}), ["systemPrefix"]);
      assert.equal(request.assembly?.systemPrefix, PREFIX);
    }
  });
});

// -- 2. a fact is bound to its base state by append order ---------------------

describe("runtime state: fact/base-state ordering", () => {
  it("appends every fact before any state that already carries its result", async () => {
    const rec = createRecorder();
    let releaseGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let firstFactSeen = (): void => {};
    const firstFact = new Promise<void>((resolve) => {
      firstFactSeen = resolve;
    });
    rec.onFact = () => firstFactSeen();

    const running = run("go", toolDeps(rec, gate));
    await firstFact;

    // Promptness: the second call settled and became durable while the first
    // was still blocked, so its base state cannot be the post-batch state.
    assert.deepEqual(
      rec.facts.map((f) => f.toolUseId),
      ["b"]
    );
    assert.equal(
      rec.log.includes("publish:tool_batch_settled"),
      false,
      "the batch is not settled yet"
    );

    releaseGate();
    const { result } = await running;
    assert.equal(result.stopReason, "completed");
    assert.deepEqual(
      rec.facts.map((f) => f.toolUseId),
      ["b", "a"]
    );

    // The invariant: walking the one ordered log, a fact's base state is the
    // last publication before its append, and that state never contains the
    // fact's own result. A buffered fact (appended after the batch state) or a
    // fact emitted before any state breaks this.
    let base: RuntimeSavedStateRequest<AnthropicNativeMessage> | undefined;
    let seen = 0;
    let checked = 0;
    for (const entry of rec.log) {
      if (entry.startsWith("publish:")) {
        base = rec.published[seen++];
        assert.ok(base !== undefined, "a publish entry has a recorded request");
        continue;
      }
      if (!entry.startsWith("fact:")) continue;
      const toolUseId = entry.slice("fact:".length);
      assert.ok(
        base !== undefined,
        `fact ${toolUseId} was appended with no published state to attach to`
      );
      assert.equal(
        resultsIn(base!).has(toolUseId),
        false,
        `fact ${toolUseId} was appended after a state that already carries its result`
      );
      checked += 1;
    }
    assert.equal(
      checked,
      2,
      "both facts were checked against their base state"
    );
  });
});
