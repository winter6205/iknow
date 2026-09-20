/**
 * ACI executor decorator layer — parallel scheduling.
 *
 * Authenticates:
 *  - two `isConcurrencySafe: true` stubs overlap in wall-clock time (concurrent).
 *  - an `isConcurrencySafe: false` stub never intersects another call's interval.
 *  - `executeAll([])` returns `[]`.
 *  - a throwing handler fails only its own call; the next call still gets a result.
 *
 * Also covers:
 *  - overflow: 8 safe stubs all settle in input order.
 *  - safe + unsafe interleaving: unsafe runs alone, adjacent safe calls overlap.
 *  - permission deny: denied calls never enter the parallel set; safe calls still overlap.
 *
 * Per-call contract (unchanged by parallelism):
 *  - every call still runs preToolUse → checkPermission → inner → postToolUse;
 *    only start times of safe calls in the same wave may overlap.
 *  - result order = input call order.
 *  - catalog-miss calls are treated conservatively (not safe; existing behavior intact).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createPermissionPolicy } from "../../../src/harness/aci/permission.ts";
import type { AciCatalog, AciToolDef } from "../../../src/harness/aci/types.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";

/* ---------------------------------------------------------------------------
 * helpers
 * ------------------------------------------------------------------------- */

interface IntervalRecord {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

function makeSafeTool(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `safe ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

function makeUnsafeTool(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `unsafe ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: {
      category: "execute" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
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

/**
 * Recording executor: logs start/end per call; an injectable pre-return sleep
 * widens execution windows so overlap assertions can actually observe the concurrency.
 */
function makeRecordingExecutor(opts: {
  /** per-call async sleep in ms; 0 when absent. */
  readonly sleepMsById?: Record<string, number>;
  /** per-call handler rejection; normal return when absent. */
  readonly throwById?: Record<string, Error>;
}): {
  executor: Executor;
  intervals: IntervalRecord[];
  /**
   * At each call's start snapshot, how many other calls were also in-flight —
   * a second signal that overlap truly happened (not a sequencing misread).
   */
  inFlightById: Map<string, number>;
} {
  const intervals: IntervalRecord[] = [];
  const inFlightById = new Map<string, number>();
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      // count concurrent in-flight calls at each call's start
      for (const c of batch) {
        const cur = inFlightById.get(c.id) ?? 0;
        inFlightById.set(c.id, cur + 1);
      }
      const starts = new Map<string, number>();
      const results: ToolExecutionResult[] = [];
      for (const c of batch) {
        const start = Date.now();
        starts.set(c.id, start);
        const sleep = opts.sleepMsById?.[c.id] ?? 0;
        const throwOn = opts.throwById?.[c.id];
        try {
          if (sleep > 0) {
            await new Promise((r) => setTimeout(r, sleep));
          }
          if (throwOn) {
            throw throwOn;
          }
          results.push({
            kind: "ok",
            toolUseId: c.id,
            payload: [{ type: "text" as const, text: `done:${c.name}` }],
          });
        } catch (err) {
          // runOne normally normalizes a throw into execution_failed; build the
          // failure result directly here to match aci-executor's catch behavior.
          const message =
            err instanceof Error ? err.message : "execution_failed";
          results.push({
            kind: "execution_failed",
            toolUseId: c.id,
            message,
          });
        } finally {
          const end = Date.now();
          intervals.push({
            id: c.id,
            start: starts.get(c.id) ?? end,
            end,
          });
        }
      }
      return results;
    },
  });
  return { executor, intervals, inFlightById };
}

/** Wall-clock overlap: each interval starts before the other one ends. */
function overlaps(a: IntervalRecord, b: IntervalRecord): boolean {
  if (a.id === b.id) return false;
  return a.start < b.end && b.start < a.end;
}

/* ---------------------------------------------------------------------------
 * tests
 * ------------------------------------------------------------------------- */

describe("createAciExecutor — 并行调度 (spec #653 T2 / P)", () => {
  it("AC48 empty: executeAll([]) → []", async () => {
    const { executor } = makeRecordingExecutor({});
    const tools = [makeSafeTool("grep"), makeUnsafeTool("bash")];
    const catalog = makeCatalog(tools);
    const aciExec = createAciExecutor({ inner: executor, catalog });

    const results = await aciExec.executeAll([] as ReadonlyArray<ToolCall>);

    assert.deepEqual([...results], []);
  });

  it("AC46 concurrent: 两个 isConcurrencySafe:true stub 墙钟重叠", async () => {
    // each stub sleeps 80ms; serial would take ≥160ms, overlap ≤ ~120ms.
    const { executor, intervals } = makeRecordingExecutor({
      sleepMsById: { a: 80, b: 80 },
    });
    const tools = [makeSafeTool("safe_a"), makeSafeTool("safe_b")];
    const catalog = makeCatalog(tools);
    const aciExec = createAciExecutor({ inner: executor, catalog });

    const t0 = Date.now();
    const results = await aciExec.executeAll([
      { id: "a", name: "safe_a", input: {} },
      { id: "b", name: "safe_b", input: {} },
    ]);
    const elapsed = Date.now() - t0;

    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["a", "b"]
    );
    assert.ok(results.every((r) => r.kind === "ok"));

    const intervalA = intervals.find((i) => i.id === "a")!;
    const intervalB = intervals.find((i) => i.id === "b")!;
    assert.ok(
      overlaps(intervalA, intervalB),
      `expected intervals to overlap; got A=${JSON.stringify(intervalA)} B=${JSON.stringify(intervalB)}`
    );
    // with overlap the total is well under the 160ms serial bound; 30ms slack absorbs scheduling jitter.
    assert.ok(
      elapsed < 140,
      `expected overlap (≤140ms), got ${elapsed}ms (serial ≥160ms)`
    );
  });

  it("AC47 negative: isConcurrencySafe:false 与另一调用不相交", async () => {
    // safe stub sleeps 50ms; unsafe runs alone for 30ms — serial total ≥80ms, intervals disjoint.
    const { executor, intervals } = makeRecordingExecutor({
      sleepMsById: { u: 30, s: 50 },
    });
    const tools = [makeUnsafeTool("bash"), makeSafeTool("grep")];
    const catalog = makeCatalog(tools);
    const aciExec = createAciExecutor({ inner: executor, catalog });

    const results = await aciExec.executeAll([
      { id: "u", name: "bash", input: { command: "ls" } },
      { id: "s", name: "grep", input: {} },
    ]);

    assert.equal(results.length, 2);
    const intervalU = intervals.find((i) => i.id === "u")!;
    const intervalS = intervals.find((i) => i.id === "s")!;
    assert.ok(
      !overlaps(intervalU, intervalS),
      `expected no overlap; got U=${JSON.stringify(intervalU)} S=${JSON.stringify(intervalS)}`
    );
  });

  it("AC47 negative (reverse): unsafe 后面接 safe,仍不相交", async () => {
    const { executor, intervals } = makeRecordingExecutor({
      sleepMsById: { u: 30, s: 50 },
    });
    const tools = [makeUnsafeTool("bash"), makeSafeTool("grep")];
    const catalog = makeCatalog(tools);
    const aciExec = createAciExecutor({ inner: executor, catalog });

    const results = await aciExec.executeAll([
      { id: "s", name: "grep", input: {} },
      { id: "u", name: "bash", input: { command: "ls" } },
    ]);

    assert.equal(results.length, 2);
    const intervalU = intervals.find((i) => i.id === "u")!;
    const intervalS = intervals.find((i) => i.id === "s")!;
    assert.ok(
      !overlaps(intervalU, intervalS),
      `expected no overlap; got U=${JSON.stringify(intervalU)} S=${JSON.stringify(intervalS)}`
    );
  });

  it("overflow: 8 个 safe stub 按序全部 settle,不 hang", async () => {
    // each safe sleeps 20ms; fully serial ≥160ms, fully parallel ≤ ~60ms.
    const ids = Array.from({ length: 8 }, (_, i) => `s${i}`);
    const sleepMap: Record<string, number> = {};
    for (const id of ids) sleepMap[id] = 20;

    const { executor, intervals } = makeRecordingExecutor({
      sleepMsById: sleepMap,
    });
    const tools = [makeSafeTool("safe_only")];
    const catalog = makeCatalog(tools);
    const aciExec = createAciExecutor({ inner: executor, catalog });

    const t0 = Date.now();
    const calls = ids.map((id) => ({
      id,
      name: "safe_only",
      input: {},
    }));
    const results = await aciExec.executeAll(calls);
    const elapsed = Date.now() - t0;

    assert.equal(results.length, 8);
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ids
    );
    assert.ok(results.every((r) => r.kind === "ok"));

    // serial bound is 8 × 20ms = 160ms; well under it ⇒ real parallelism.
    assert.ok(
      elapsed < 140,
      `expected ≤140ms with overlap; got ${elapsed}ms (serial ≥160ms)`
    );

    // pairwise: every pair of intervals overlaps (same wave).
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = intervals.find((iv) => iv.id === ids[i]!)!;
        const b = intervals.find((iv) => iv.id === ids[j]!)!;
        assert.ok(
          overlaps(a, b),
          `expected ${ids[i]} ↔ ${ids[j]} overlap; got A=${JSON.stringify(a)} B=${JSON.stringify(b)}`
        );
      }
    }
  });

  it("AC49 exception: 第一个 handler throw → 第一个 execution_failed,第二个仍有结果", async () => {
    const { executor, intervals } = makeRecordingExecutor({
      sleepMsById: { bad: 10, good: 20 },
      throwById: {
        bad: new Error("synthetic handler failure"),
      },
    });
    const tools = [makeSafeTool("safe_throw")];
    const catalog = makeCatalog(tools);
    const aciExec = createAciExecutor({ inner: executor, catalog });

    const results = await aciExec.executeAll([
      { id: "bad", name: "safe_throw", input: {} },
      { id: "good", name: "safe_throw", input: {} },
    ]);

    assert.equal(results.length, 2);
    assert.equal(results[0]!.toolUseId, "bad");
    assert.equal(results[0]!.kind, "execution_failed");
    assert.equal(results[1]!.toolUseId, "good");
    assert.equal(results[1]!.kind, "ok");
    // isolation: good settles independently of bad's throw.
    const intervalGood = intervals.find((i) => i.id === "good")!;
    assert.ok(intervalGood.end > intervalGood.start);
  });

  it("safe + unsafe 交错:unsafe 单独,相邻 safe 重叠,顺序保持", async () => {
    // calls: [safe_a, unsafe, safe_b, safe_c]
    // expected: safe_a alone (wave 1, single safe), unsafe alone (wave 2),
    //           safe_b + safe_c overlapping in wave 3.
    // askUser:true routes bash through the allow branch (default ask → approve).
    const { executor, intervals } = makeRecordingExecutor({
      sleepMsById: {
        safe_a: 20,
        unsafe: 25,
        safe_b: 30,
        safe_c: 30,
      },
    });
    const tools = [makeSafeTool("safe_x"), makeUnsafeTool("bash")];
    const catalog = makeCatalog(tools);
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      askUser: async () => true,
    });

    const results = await aciExec.executeAll([
      { id: "safe_a", name: "safe_x", input: {} },
      { id: "unsafe", name: "bash", input: { command: "echo hi" } },
      { id: "safe_b", name: "safe_x", input: {} },
      { id: "safe_c", name: "safe_x", input: {} },
    ]);

    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["safe_a", "unsafe", "safe_b", "safe_c"]
    );
    assert.ok(results.every((r) => r.kind === "ok"));
    const getI = (id: string) => intervals.find((i) => i.id === id)!;
    // unsafe must not intersect any other call
    for (const id of ["safe_a", "safe_b", "safe_c"]) {
      assert.ok(
        !overlaps(getI("unsafe"), getI(id)),
        `unsafe must not overlap with ${id}`
      );
    }
    // safe_b and safe_c must overlap (same wave)
    assert.ok(
      overlaps(getI("safe_b"), getI("safe_c")),
      `safe_b and safe_c must overlap`
    );
    // ordering: unsafe strictly after safe_a and before safe_b
    assert.ok(getI("safe_a").end <= getI("unsafe").start);
    assert.ok(getI("unsafe").end <= getI("safe_b").start);
  });

  it("permission deny: 被拒调用不进入并行集,并行的两个 safe 仍重叠", async () => {
    // policy.byName denies bash (read-only defaults to allow; deny overrides).
    // calls: [grep_safe_1, bash_denied, grep_safe_2]
    // expected: bash_denied normalizes to execution_failed immediately and never
    //           enters the parallel set; the two greps overlap in one wave.
    const { executor, intervals } = makeRecordingExecutor({
      sleepMsById: { grep_safe_1: 40, grep_safe_2: 40 },
    });
    const tools = [makeSafeTool("grep"), makeUnsafeTool("bash")];
    const catalog = makeCatalog(tools);
    const policy = createPermissionPolicy({
      byName: { bash: "deny" },
    });
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy,
    });

    const results = await aciExec.executeAll([
      { id: "grep_safe_1", name: "grep", input: {} },
      { id: "bash_denied", name: "bash", input: { command: "echo" } },
      { id: "grep_safe_2", name: "grep", input: {} },
    ]);

    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["grep_safe_1", "bash_denied", "grep_safe_2"]
    );
    assert.equal(results[0]!.kind, "ok");
    assert.equal(results[1]!.kind, "execution_failed");
    assert.equal(results[2]!.kind, "ok");
    assert.ok(
      (results[1] as { message: string }).message.startsWith(
        "[permission_denied]"
      )
    );

    // the denied call never reaches inner (the spy records no interval for it)
    const intervalDenied = intervals.find((i) => i.id === "bash_denied");
    assert.equal(
      intervalDenied,
      undefined,
      "denied call must NOT reach the inner executor"
    );
    // the two safe calls must overlap
    const intervalG1 = intervals.find((i) => i.id === "grep_safe_1")!;
    const intervalG2 = intervals.find((i) => i.id === "grep_safe_2")!;
    assert.ok(
      overlaps(intervalG1, intervalG2),
      `expected grep_safe_1 and grep_safe_2 to overlap; got ${JSON.stringify(intervalG1)} ${JSON.stringify(intervalG2)}`
    );
  });

  it("permission deny: still runs preToolUse (does not skip the gate)", async () => {
    const preTools: string[] = [];
    const { executor } = makeRecordingExecutor({});
    const tools = [makeSafeTool("grep"), makeUnsafeTool("bash")];
    const catalog = makeCatalog(tools);
    const policy = createPermissionPolicy({
      byName: { bash: "deny" },
    });
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy,
      hooks: {
        preToolUse: ({ tool }) => {
          preTools.push(tool);
          return undefined;
        },
      },
    });
    await aciExec.executeAll([
      { id: "g", name: "grep", input: {} },
      { id: "b", name: "bash", input: { command: "echo" } },
    ]);
    assert.deepEqual(preTools, ["grep", "bash"]);
  });

  it("catalog miss(unknown tool): 当作 unsafe(单元素 wave),不参与并行", async () => {
    // Unknown tools must not be defaulted into the parallel set (conservative
    // contract): keep the existing "catalog miss → delegate to inner" semantics
    // without breaking result order.
    const { executor, intervals } = makeRecordingExecutor({
      sleepMsById: { safe_known: 30, unknown: 30, safe_known_2: 30 },
    });
    const tools = [makeSafeTool("safe_known")];
    const catalog = makeCatalog(tools); // "unknown" is not registered
    const aciExec = createAciExecutor({ inner: executor, catalog });

    const results = await aciExec.executeAll([
      { id: "safe_known", name: "safe_known", input: {} },
      { id: "unknown", name: "missing_tool", input: {} },
      { id: "safe_known_2", name: "safe_known", input: {} },
    ]);

    assert.equal(results.length, 3);
    // unknown goes through inner (catalog miss path); the result comes from the spy.
    assert.ok(results.every((r) => r.kind === "ok"));
    // Contract: on catalog miss the call is treated as unsafe (solo wave) but
    // still executed in order; the key invariant is stable result ordering,
    // so interval overlap between pairs is not asserted either way.
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["safe_known", "unknown", "safe_known_2"]
    );
    const safe1 = intervals.find((i) => i.id === "safe_known")!;
    const unk = intervals.find((i) => i.id === "unknown")!;
    const safe2 = intervals.find((i) => i.id === "safe_known_2")!;
    // unknown overlaps neither safe call (solo wave)
    assert.ok(
      !overlaps(unk, safe1),
      "unknown must not overlap with safe_known"
    );
    assert.ok(
      !overlaps(unk, safe2),
      "unknown must not overlap with safe_known_2"
    );
  });
});
