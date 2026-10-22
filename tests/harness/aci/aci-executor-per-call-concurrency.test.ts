/**
 * ACI executor decorator layer — PER-CALL concurrency safety.
 *
 * A tool may declare `aci.isConcurrencySafeForInput`: a predicate that
 * decides, for ONE call, whether that call may run concurrently with its
 * neighbours. When the predicate is declared it is AUTHORITATIVE for that
 * call; the static `isConcurrencySafe` flag is only the tool-level default
 * used by tools that declare no predicate.
 *
 * Authenticates (through the wave structure the executor actually produced):
 *  - a predicate that is true for one input and false for another splits the
 *    batch: the false call breaks the wave and runs alone.
 *  - a predicate that is true for every input keeps the calls in ONE wave.
 *  - a declared predicate is AUTHORITATIVE for the calls of the tool that
 *    declares it: it overrides a permissive static flag downwards AND a
 *    restrictive static flag upwards. Only UNCERTAINTY is one-directional
 *    (an unknown tool, a predicate that throws, or a return value other
 *    than exactly `true` ⇒ not concurrency-safe).
 *  - a predicate that throws, or that returns anything but exactly `true`,
 *    means "not concurrency-safe" (the call runs alone), and no exception
 *    escapes `executeAll`.
 *  - the static-only tools keep their previous behaviour (one wave when
 *    `isConcurrencySafe: true`, one wave per call when it is false).
 *  - an unknown tool (catalog miss) stays not concurrency-safe and is still
 *    delegated to inner.
 *
 * NOTE on the observation: the permission runtime calls
 * `inner.executeAll([call])` per CALL (the two-stage wave gate runs one call
 * at a time through inner), so the inner executor's batch sizes cannot show
 * a wave. The wave is observed the way it is actually observable — the calls
 * of one wave START CONCURRENTLY: a call that starts before the previous
 * wave's last call finished belongs to the same wave.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { isConcurrencySafeForCall } from "../../../src/harness/tools/concurrency-waves.ts";
import type { AciCatalog, AciToolDef } from "../../../src/harness/aci/types.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";

/* ---------------------------------------------------------------------------
 * helpers
 * ------------------------------------------------------------------------- */

/** One recorded inner-event: a call's inner execution started or finished. */
interface InnerEvent {
  readonly kind: "enter" | "exit";
  readonly id: string;
}

interface Recorder {
  readonly executor: Executor;
  readonly events: InnerEvent[];
}

/**
 * Recording executor: logs the start/end of every call's inner execution.
 * The per-call sleep keeps the execution windows open long enough for the
 * concurrent starts of one wave to be observable.
 */
function makeRecordingExecutor(sleepMs = 5): Recorder {
  const events: InnerEvent[] = [];
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const results: ToolExecutionResult[] = [];
      for (const c of batch) {
        events.push({ kind: "enter", id: c.id });
        await new Promise((r) => setTimeout(r, sleepMs));
        events.push({ kind: "exit", id: c.id });
        results.push({
          kind: "ok",
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: `done:${c.name}` }],
        });
      }
      return results;
    },
  });
  return { executor, events };
}

/**
 * The wave structure the executor produced, derived from the inner events:
 * a call belongs to the previous group when it STARTED before that group's
 * last call FINISHED (concurrent start = same wave).
 */
function waveGroups(recorder: Recorder, ids: readonly string[]): string[][] {
  const enterAt = new Map<string, number>();
  const exitAt = new Map<string, number>();
  recorder.events.forEach((e, i) => {
    if (e.kind === "enter") enterAt.set(e.id, i);
    else exitAt.set(e.id, i);
  });
  const groups: string[][] = [];
  let current: string[] = [];
  let currentEnd = -1;
  for (const id of ids) {
    const enter = enterAt.get(id);
    assert.ok(
      enter !== undefined,
      `call ${id} never reached the inner executor`
    );
    const exit = exitAt.get(id) ?? enter;
    if (current.length > 0 && enter < currentEnd) {
      current.push(id);
      currentEnd = Math.max(currentEnd, exit);
      continue;
    }
    if (current.length > 0) groups.push(current);
    current = [id];
    currentEnd = exit;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** A tool with a per-call concurrency-safety predicate. */
function makePredicatedTool(
  name: string,
  staticSafe: boolean,
  predicate: (input: unknown) => boolean
): AciToolDef {
  return Object.freeze({
    name,
    description: `predicated ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: staticSafe,
      isConcurrencySafeForInput: predicate,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

/** A tool with the static flag only (no per-call predicate). */
function makeStaticTool(name: string, staticSafe: boolean): AciToolDef {
  return Object.freeze({
    name,
    description: `static ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: staticSafe,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

function makeCatalog(tools: AciToolDef[]): AciCatalog {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return Object.freeze({
    get: (n: string) => byName.get(n),
    all: () => Object.freeze([...tools]) as ReadonlyArray<AciToolDef>,
  });
}

/* ---------------------------------------------------------------------------
 * tests — the executor's wave structure
 * ------------------------------------------------------------------------- */

describe("createAciExecutor — per-call concurrency safety (isConcurrencySafeForInput)", () => {
  it("predicate false for one input: the false call breaks the wave and runs alone", async () => {
    // The static flag says "safe"; the PREDICATE decides, so the call with
    // the mutating input is not concurrency-safe and breaks the wave.
    const tool = makePredicatedTool("mixed_tool", true, (input) => {
      const path = (input as { path?: unknown } | null)?.path;
      return path === "safe";
    });
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([tool]),
    });

    const results = await aciExec.executeAll([
      { id: "c1", name: "mixed_tool", input: { path: "safe" } },
      { id: "c2", name: "mixed_tool", input: { path: "mutating" } },
    ]);

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.kind === "ok"));
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["c1", "c2"]
    );
    // Two waves: the safe call, then the unsafe one alone.
    assert.deepEqual(waveGroups(recorder, ["c1", "c2"]), [["c1"], ["c2"]]);
  });

  it("predicate true for every input: the calls share ONE wave", async () => {
    // The static flag says "unsafe"; the PREDICATE decides, so all three
    // calls are concurrency-safe and share one wave.
    const tool = makePredicatedTool("always_safe", false, () => true);
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([tool]),
    });

    const results = await aciExec.executeAll([
      { id: "a", name: "always_safe", input: { path: "x" } },
      { id: "b", name: "always_safe", input: { path: "y" } },
      { id: "c", name: "always_safe", input: { path: "z" } },
    ]);

    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.kind === "ok"));
    // ONE wave of three.
    assert.deepEqual(waveGroups(recorder, ["a", "b", "c"]), [["a", "b", "c"]]);
  });

  it("static flag only (isConcurrencySafe: true): unchanged — one wave", async () => {
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([makeStaticTool("static_safe", true)]),
    });

    const results = await aciExec.executeAll([
      { id: "a", name: "static_safe", input: {} },
      { id: "b", name: "static_safe", input: {} },
    ]);

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.kind === "ok"));
    assert.deepEqual(waveGroups(recorder, ["a", "b"]), [["a", "b"]]);
  });

  it("static flag only (isConcurrencySafe: false): unchanged — one wave per call", async () => {
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([makeStaticTool("static_unsafe", false)]),
    });

    const results = await aciExec.executeAll([
      { id: "a", name: "static_unsafe", input: {} },
      { id: "b", name: "static_unsafe", input: {} },
    ]);

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.kind === "ok"));
    assert.deepEqual(waveGroups(recorder, ["a", "b"]), [["a"], ["b"]]);
  });

  it("throwing predicate: the call is not concurrency-safe, runs alone, and no exception escapes", async () => {
    const tool = makePredicatedTool("throwing_tool", true, () => {
      throw new Error("synthetic predicate failure");
    });
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([tool]),
    });

    // executeAll must not throw: the predicate's failure is answered with
    // "not concurrency-safe", never with an exception.
    const results = await aciExec.executeAll([
      { id: "a", name: "throwing_tool", input: {} },
      { id: "b", name: "throwing_tool", input: {} },
    ]);

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.kind === "ok"));
    // Neither call is concurrency-safe → each one its own wave.
    assert.deepEqual(waveGroups(recorder, ["a", "b"]), [["a"], ["b"]]);
  });

  it("predicate returning a non-boolean truthy value: not concurrency-safe", async () => {
    // The resolver requires exactly `true`; `1` is not `true`.
    const truthyButNotTrue = (() => 1) as unknown as (
      input: unknown
    ) => boolean;
    const tool = makePredicatedTool("truthy_tool", true, truthyButNotTrue);
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([tool]),
    });

    const results = await aciExec.executeAll([
      { id: "a", name: "truthy_tool", input: {} },
      { id: "b", name: "truthy_tool", input: {} },
    ]);

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.kind === "ok"));
    assert.deepEqual(waveGroups(recorder, ["a", "b"]), [["a"], ["b"]]);
  });

  it("unknown tool (catalog miss): not concurrency-safe, still delegated to inner", async () => {
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([makeStaticTool("known_tool", true)]),
    });

    const results = await aciExec.executeAll([
      { id: "known", name: "known_tool", input: {} },
      { id: "unknown", name: "missing_tool", input: {} },
      { id: "known2", name: "known_tool", input: {} },
    ]);

    assert.equal(results.length, 3);
    // The catalog miss still ran (delegated to inner) and kept the order.
    assert.ok(results.every((r) => r.kind === "ok"));
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["known", "unknown", "known2"]
    );
    // The unknown call is not concurrency-safe → it breaks the wave and runs
    // alone; the two known calls are split around it.
    assert.deepEqual(waveGroups(recorder, ["known", "unknown", "known2"]), [
      ["known"],
      ["unknown"],
      ["known2"],
    ]);
  });
});

/* ---------------------------------------------------------------------------
 * tests — the resolution rules themselves
 * ------------------------------------------------------------------------- */

describe("isConcurrencySafeForCall — resolution rules", () => {
  it("unknown tool (no meta) → false (conservative)", () => {
    assert.equal(isConcurrencySafeForCall(undefined, {}), false);
  });

  it("no predicate → the static flag decides", () => {
    assert.equal(
      isConcurrencySafeForCall({ isConcurrencySafe: true }, {}),
      true
    );
    assert.equal(
      isConcurrencySafeForCall({ isConcurrencySafe: false }, {}),
      false
    );
  });

  it("a declared predicate decides for the call, both ways", () => {
    const meta = {
      isConcurrencySafe: true,
      isConcurrencySafeForInput: (input: unknown) =>
        (input as { safe?: unknown } | null)?.safe === true,
    };
    // The static flag says safe, the predicate says no → no.
    assert.equal(isConcurrencySafeForCall(meta, { safe: false }), false);
    assert.equal(isConcurrencySafeForCall(meta, { safe: true }), true);

    const restrictive = {
      isConcurrencySafe: false,
      isConcurrencySafeForInput: () => true,
    };
    // The static flag says unsafe, the predicate says yes → yes.
    assert.equal(isConcurrencySafeForCall(restrictive, {}), true);
  });

  it("a throwing predicate → false", () => {
    const meta = {
      isConcurrencySafe: true,
      isConcurrencySafeForInput: () => {
        throw new Error("synthetic predicate failure");
      },
    };
    assert.equal(isConcurrencySafeForCall(meta, {}), false);
  });

  it("a non-true return value → false", () => {
    const truthyButNotTrue = (() => 1) as unknown as (
      input: unknown
    ) => boolean;
    assert.equal(
      isConcurrencySafeForCall(
        {
          isConcurrencySafe: true,
          isConcurrencySafeForInput: truthyButNotTrue,
        },
        {}
      ),
      false
    );
  });
});
