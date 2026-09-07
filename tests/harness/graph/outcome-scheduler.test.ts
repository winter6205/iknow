/**
 * live-graph-phase2 T2 — outcome 驱动失败边调度器（spec SC1–SC3 / SC6 /
 * ADR-0053–0056、0062–0063）。
 *
 * 钉住的不变式：
 *   - **failed 才走失败边**：起点 done / skipped 不启动其 `onFailure`
 *     （ADR-0055 / 0056）；每个 failed 结局启动终点**一次**（ADR-0062）。
 *   - **同 id 再进入**：失败回走到未冻旧 id（含 self）复用同一 id 再进
 *     executor，不得换新 id（ADR-0053）—— entry log 断言两次进入同一 id。
 *   - **终点本段已 done → violation**：不 spawn、调度停止，violation 交给
 *     handler typed 拒（区别于提交期 schema 拒绝；部分结果保留在 execution
 *     里）。done 永不因失败边再跑（ADR-0060）。
 *   - **skipped 不走失败边**（SC3）：markSkipped 不产生 kick。
 *   - **失败边终点仍是普通节点**：deps 规则照常启用它（T1 已钉的两根
 *     wave-0 行为不回退）；要表达「失败才首跑」的新格，终点 deps 指向
 *     失败起点。
 *   - **abort 后不再启动新进入**：in-flight 排干即收敛，不空转。
 *
 * 本文件用 stub executor 精确断言 entry 序列（id 级）；wire 级（真
 * manager spawn）见 run-graph-failure-edges.test.ts。
 */

import { describe, expect, it } from "vitest";

import {
  runGraphWithFailureEdges,
  type FailureEdgeViolation,
} from "../../../src/harness/graph/outcome-scheduler.ts";
import type {
  GraphSpec,
  NodeExecutor,
  NodeOutcome,
} from "../../../src/harness/graph/types.ts";

/** 顺序记录 executor 进入的 id —— 「同 id 再跑」的 ground truth。 */
function recordingExec(
  entries: string[],
  decide: (id: string, entryIndex: number) => NodeOutcome | Promise<NodeOutcome>
): NodeExecutor {
  let count = 0;
  return async (id) => {
    entries.push(id);
    return decide(id, count++);
  };
}

describe("runGraphWithFailureEdges — failed 才走失败边", () => {
  it("self-onFailure：首进 failed → 同 id 第二次进入，次进 done 后收敛", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (_id, i) =>
      i === 0
        ? { status: "failed", error: "boom" }
        : { status: "done", output: "RETRY-OK" }
    );
    const spec: GraphSpec = {
      nodes: [{ id: "a", deps: [], onFailure: "a" }],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    // 同 id 两次 executor 进入（SC1 re-entry / SC6），最终 done
    expect(entries).toEqual(["a", "a"]);
    expect(execution.statuses.a).toBe("done");
    expect(execution.results.a?.status).toBe("done");
    expect(violation).toBeUndefined();
  });

  it("起点 done 不走失败边：终点只经 deps 进入一次", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, () => ({
      status: "done",
      output: "ok",
    }));
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [], onFailure: "b" },
        { id: "b", deps: ["a"] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    expect(entries).toEqual(["a", "b"]);
    expect(execution.statuses.b).toBe("done");
    expect(violation).toBeUndefined();
  });

  it("skipped 起点不走失败边：失败边不触发（SC3）", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (id) =>
      id === "b"
        ? { status: "failed", error: "boom" }
        : { status: "done", output: id }
    );
    const spec: GraphSpec = {
      nodes: [
        { id: "b", deps: [] },
        { id: "c", deps: ["b"], onFailure: "d" },
        { id: "d", deps: ["c"] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    // 只有 b 真跑；c 沿 deps fail-fast 被 skipped 且其失败边不触发；
    // d 随 c 一起 skipped。
    expect(entries).toEqual(["b"]);
    expect(execution.statuses.c).toBe("skipped");
    expect(execution.statuses.d).toBe("skipped");
    expect(violation).toBeUndefined();
  });
});

describe("runGraphWithFailureEdges — 同 id 再进入（SC6）", () => {
  it("刚 failed 的旧 id 被另一格的失败边再进：同 id 第三次落位", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (id, i) => {
      if (id === "a") {
        // a 首进 failed；被 b 的失败边再进后 done
        return i === 0
          ? { status: "failed", error: "a-boom" }
          : { status: "done", output: "a-retry" };
      }
      return { status: "failed", error: "b-boom" };
    });
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "b", deps: [], onFailure: "a" },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    expect(entries).toEqual(["a", "b", "a"]);
    expect(execution.statuses.a).toBe("done");
    expect(execution.statuses.b).toBe("failed");
    expect(violation).toBeUndefined();
  });
});

describe("runGraphWithFailureEdges — 终点本段已 done → violation", () => {
  it("终点先 done、起点后 failed → 返回 violation、不重跑终点", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (id) =>
      id === "b"
        ? { status: "done", output: "B" }
        : { status: "failed", error: "a-boom" }
    );
    const spec: GraphSpec = {
      nodes: [
        { id: "b", deps: [] },
        { id: "a", deps: ["b"], onFailure: "b" },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    const v: FailureEdgeViolation | undefined = violation;
    expect(v).toEqual({ from: "a", target: "b" });
    // 终点只进入一次（done 永不因失败边再跑，ADR-0060）
    expect(entries).toEqual(["b", "a"]);
    // 部分结果保留在 execution 里，handler 据此走 freeze + typed 拒
    expect(execution.statuses.b).toBe("done");
    expect(execution.statuses.a).toBe("failed");
  });
});

describe("runGraphWithFailureEdges — 新格失败边（SC2）", () => {
  it("终点 deps 指向失败起点：起点 failed 后终点首次进入", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (id) =>
      id === "c"
        ? { status: "failed", error: "c-boom" }
        : { status: "done", output: "D-OK" }
    );
    const spec: GraphSpec = {
      nodes: [
        { id: "c", deps: [], onFailure: "d" },
        { id: "d", deps: ["c"] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    expect(entries).toEqual(["c", "d"]);
    expect(execution.statuses.c).toBe("failed");
    expect(execution.statuses.d).toBe("done");
    expect(violation).toBeUndefined();
  });
});

describe("runGraphWithFailureEdges — 阶段 1 语义保持", () => {
  it("deps-only 链按依赖顺序跑完（与 runGraph Kahn 同结果）", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, () => ({
      status: "done",
      output: "ok",
    }));
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "b", deps: ["a"] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    expect(entries).toEqual(["a", "b"]);
    expect(execution.waveCount).toBe(2);
    expect(execution.statuses.a).toBe("done");
    expect(execution.statuses.b).toBe("done");
    expect(violation).toBeUndefined();
  });

  it("executor 抛错仍归 failed 并驱动其失败边", async () => {
    const entries: string[] = [];
    const exec: NodeExecutor = async (id) => {
      entries.push(id);
      if (entries.length === 1) throw new Error("executor threw");
      return { status: "done", output: "ok" };
    };
    const spec: GraphSpec = {
      nodes: [{ id: "a", deps: [], onFailure: "a" }],
    };
    const { execution } = await runGraphWithFailureEdges(spec, exec);
    expect(entries).toEqual(["a", "a"]);
    expect(execution.statuses.a).toBe("done");
  });
});

describe("runGraphWithFailureEdges — 调用侧 abort", () => {
  it("abort 后不再启动新进入：failed 结局的失败边不生效", async () => {
    const controller = new AbortController();
    const entries: string[] = [];
    let release!: (outcome: NodeOutcome) => void;
    const gate = new Promise<NodeOutcome>((resolve) => {
      release = resolve;
    });
    const exec: NodeExecutor = (id) => {
      entries.push(id);
      if (entries.length === 1) return gate;
      return Promise.resolve({ status: "done", output: id });
    };
    const spec: GraphSpec = {
      nodes: [{ id: "a", deps: [], onFailure: "a" }],
    };
    const pending = runGraphWithFailureEdges(spec, exec, {
      signal: controller.signal,
    });
    // 首进入已同步发出，挂在 gate 上
    expect(entries).toEqual(["a"]);
    controller.abort();
    release({ status: "failed", error: "cancelled by caller abort" });
    const { execution, violation } = await pending;
    // failed 结局本应 kick self 再进，但 abort 后调度停止（不空转）
    expect(entries).toEqual(["a"]);
    expect(execution.statuses.a).toBe("failed");
    expect(violation).toBeUndefined();
  });
});
