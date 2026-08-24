/**
 * ACI executor 装饰层 — 并行调度（spec #653 T2 / P 包）。
 *
 * 覆盖 SC AC46/47/48/49：
 *  - AC46: 两个 `isConcurrencySafe: true` stub 墙钟重叠(concurrent)。
 *  - AC47: `isConcurrencySafe: false` stub 与另一调用执行区间不相交。
 *  - AC48: `executeAll([])` → `[]`。
 *  - AC49: 第一个 handler throw → 第一个 execution_failed,第二个仍有结果。
 *
 * 另覆盖：
 *  - overflow: 8 个安全 stub 仍按序全部 settle。
 *  - safe + unsafe 交错:unsafe 单独,相邻 safe 重叠。
 *  - permission deny:被拒调用不进入并行集;并行的两个 safe 仍重叠。
 *
 * 行为契约(per-call 不变):
 *  - 每个 call 仍走 preToolUse → checkPermission → inner → postToolUse,
 *    只是同一 wave 中安全的 call 启动时间可重叠。
 *  - 结果顺序 = 输入 calls 顺序。
 *  - catalog miss 的 call 单独处理(保守:不当 safe,不影响既有行为)。
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
 * Recording executor:每个 call 记录 start/end;handler 在返回前可注入 sleep
 * 以制造并发窗口供重叠断言用。
 */
function makeRecordingExecutor(opts: {
  /** per-call 异步 sleep ms 映射;未列则 0。 */
  readonly sleepMsById?: Record<string, number>;
  /** per-call handler 抛出;未列则正常返回。 */
  readonly throwById?: Record<string, Error>;
}): {
  executor: Executor;
  intervals: IntervalRecord[];
  /**
   * 计算「在调用 recordStart(record) 时,有多少其它 call 也在 in-flight」
   * —— 第二个 snapshot 用于排查重叠是否真实发生(而非顺序误判)。
   */
  inFlightById: Map<string, number>;
} {
  const intervals: IntervalRecord[] = [];
  const inFlightById = new Map<string, number>();
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      // 记录每个 call 的并发计数(在它 start 时)
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
          // executor.runOne 内部把 throw 归一为 execution_failed,
          // 但这里我们直接构造失败结果以匹配 aci-executor 的 catch 行为。
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

/** 「墙钟重叠」:interval A 起点早于 interval B 终点且反之亦然。 */
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
    // 每个 stub sleep 80ms;若串行则总耗时 ≥160ms,重叠则 ≤ ~120ms。
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
    // 重叠时总时长应明显小于串行 160ms;留 30ms 余量应对调度抖动。
    assert.ok(
      elapsed < 140,
      `expected overlap (≤140ms), got ${elapsed}ms (serial ≥160ms)`
    );
  });

  it("AC47 negative: isConcurrencySafe:false 与另一调用不相交", async () => {
    // safe stub sleep 50ms;unsafe 单独跑 30ms —— 串行总耗时 ≥80ms,且区间不相交。
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
    // 每个 safe sleep 20ms;若全串行 ≥160ms,全并行 ≤ ~60ms。
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

    // 重叠总时长上限:8 × 20ms 串行 = 160ms;若明显小于此值 ⇒ 真并行。
    assert.ok(
      elapsed < 140,
      `expected ≤140ms with overlap; got ${elapsed}ms (serial ≥160ms)`
    );

    // pairwise:任意两条的 interval 都应重叠(同 wave 并行)。
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
    // 隔离:good 的区间独立 settle,不被 bad 的 throw 干扰。
    const intervalGood = intervals.find((i) => i.id === "good")!;
    assert.ok(intervalGood.end > intervalGood.start);
  });

  it("safe + unsafe 交错:unsafe 单独,相邻 safe 重叠,顺序保持", async () => {
    // calls: [safe_a, unsafe, safe_b, safe_c]
    // 期望:safe_a 单独(wave 1,只有一个 safe);unsafe 单独(wave 2);
    //       safe_b + safe_c 同 wave 重叠(wave 3)。
    // 注入 askUser:true 让 bash 走 allow 分支(默认 ask → 默认 approve)。
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
    // unsafe 与任何其它 call 不相交
    for (const id of ["safe_a", "safe_b", "safe_c"]) {
      assert.ok(
        !overlaps(getI("unsafe"), getI(id)),
        `unsafe must not overlap with ${id}`
      );
    }
    // safe_b 与 safe_c 必须重叠(同 wave)
    assert.ok(
      overlaps(getI("safe_b"), getI("safe_c")),
      `safe_b and safe_c must overlap`
    );
    // 顺序约束:unsafe 必在 safe_a 之后、safe_b 之前
    assert.ok(getI("safe_a").end <= getI("unsafe").start);
    assert.ok(getI("unsafe").end <= getI("safe_b").start);
  });

  it("permission deny: 被拒调用不进入并行集,并行的两个 safe 仍重叠", async () => {
    // 用 policy.byName 让 bash deny(read-only 默认 allow,被 deny 覆盖)。
    // 三调用:[grep_safe_1, bash_denied, grep_safe_2]。
    // 期望:bash_denied 立即归一为 execution_failed,不进入并行集;
    //       grep_safe_1 与 grep_safe_2 同 wave 重叠。
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

    // denied 调用根本没进入 inner(spy 也不应记录)
    const intervalDenied = intervals.find((i) => i.id === "bash_denied");
    assert.equal(
      intervalDenied,
      undefined,
      "denied call must NOT reach the inner executor"
    );
    // 两个 safe 必须重叠
    const intervalG1 = intervals.find((i) => i.id === "grep_safe_1")!;
    const intervalG2 = intervals.find((i) => i.id === "grep_safe_2")!;
    assert.ok(
      overlaps(intervalG1, intervalG2),
      `expected grep_safe_1 and grep_safe_2 to overlap; got ${JSON.stringify(intervalG1)} ${JSON.stringify(intervalG2)}`
    );
  });

  it("catalog miss(unknown tool): 当作 unsafe(单元素 wave),不参与并行", async () => {
    // 未知工具不应被默认放行到并行集(保守契约):
    // 既保持既有「catalog 查不到 → 委托 inner」语义,也确保不破坏顺序。
    const { executor, intervals } = makeRecordingExecutor({
      sleepMsById: { safe_known: 30, unknown: 30, safe_known_2: 30 },
    });
    const tools = [makeSafeTool("safe_known")];
    const catalog = makeCatalog(tools); // 没有 unknown
    const aciExec = createAciExecutor({ inner: executor, catalog });

    const results = await aciExec.executeAll([
      { id: "safe_known", name: "safe_known", input: {} },
      { id: "unknown", name: "missing_tool", input: {} },
      { id: "safe_known_2", name: "safe_known", input: {} },
    ]);

    assert.equal(results.length, 3);
    // unknown 走 inner(catalog miss path),结果来自 spy。
    assert.ok(results.every((r) => r.kind === "ok"));
    // 既定契约:catalog miss 时把 call 视作 unsafe(单独 wave),但仍顺序执行。
    // 显式断言:三个 interval 之间 pairwise 可能重叠或不重叠
    // —— 关键是结果顺序稳定。
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["safe_known", "unknown", "safe_known_2"]
    );
    const safe1 = intervals.find((i) => i.id === "safe_known")!;
    const unk = intervals.find((i) => i.id === "unknown")!;
    const safe2 = intervals.find((i) => i.id === "safe_known_2")!;
    // unknown 不与 safe_known / safe_known_2 重叠(单独 wave)
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
