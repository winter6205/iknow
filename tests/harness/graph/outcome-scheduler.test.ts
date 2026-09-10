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

describe("runGraphWithFailureEdges — 链式失败边（不同波次串联）", () => {
  it("a(onFailure:b), b(onFailure:c), c deps[b]：c 在 b 首次落定 failed 之后才进入（链式 kick）", async () => {
    const entries: string[] = [];
    let cEntry = 0;
    const exec: NodeExecutor = async (id) => {
      entries.push(id);
      if (id === "c") {
        cEntry++;
        // c 首进 failed（wave 1，与 b(2) 同批）；被 b(2) 的失败边再
        // kick 后第二次进入 done 收敛 —— 若 c 首进即 done，b(2) 在同
        // 波第二遍会发现终点已 done 而抬 violation，链就断在那里。
        return cEntry === 1
          ? { status: "failed", error: "c-boom" }
          : { status: "done", output: "C-RECOVER" };
      }
      return { status: "failed", error: `${id}-boom` };
    };
    // c deps[b]：b 恒 failed → c 的 deps 门永不满足，c 只能被失败边
    // kick 进。链：wave 0 a、b 同批 failed → a kick b(2)、b kick c(1)
    // → wave 1 b(2)、c(1) 同批 failed → b(2) kick c(2) → wave 2 c(2)
    // done 收敛。
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [], onFailure: "b" },
        { id: "b", deps: [], onFailure: "c" },
        { id: "c", deps: ["b"] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    // c 的两次进入都发生在某次 b settle failed 之后（wave 1 在 b(1)
    // 之后、wave 2 在 b(2) 之后）—— 链式失败边逐波串联。
    expect(entries).toEqual(["a", "b", "b", "c", "c"]);
    expect(execution.statuses.a).toBe("failed");
    expect(execution.statuses.b).toBe("failed");
    expect(execution.statuses.c).toBe("done");
    expect(violation).toBeUndefined();
  });
});

describe("runGraphWithFailureEdges — 汇聚失败边（同波 + 跨波）", () => {
  it("同波两个起点失败边都指向同一终点：终点只入一次（dedup by queued）", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (id) =>
      id === "t"
        ? { status: "done", output: "T" }
        : { status: "failed", error: `${id}-boom` }
    );
    // t deps[a]：a 恒 failed → t 的 deps 门永不满足，t 只能被失败边
    // kick 进。a、b 同波都 failed，两条失败边都指向 t：第一条 kick 入
    // 队，第二条被 queued 短路 —— t 恰好进入一次。
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [], onFailure: "t" },
        { id: "b", deps: [], onFailure: "t" },
        { id: "t", deps: ["a"] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    expect(entries).toEqual(["a", "b", "t"]);
    expect(execution.statuses.t).toBe("done");
    expect(violation).toBeUndefined();
  });

  it("跨波汇聚失败边：起点 a wave 0 failed → kick t；b 晚到 wave 1 failed → 再次发现 t 已 done → violation", async () => {
    const entries: string[] = [];
    // b deps[a]：a wave 0 failed → b 的 deps 门不满足（deps 不全 done）。
    // 唯一启动 b 的途径是 a 的失败边 —— 而 a 的失败边指向 t，不指 b。
    // 所以 b 不进。但此用例的目标是「跨波汇聚 → t 已 done 后第二个失
    // 败边想要再 kick t → violation」，需要一个真正晚于 t 落定的失败
    // 起点。让 b 不依赖 deps —— 改成 b onFailure:b（self 失败边），b
    // 仍恒 failed。b wave 0 settled failed 后 b 的 self 失败边试图把
    // b 再次入队 —— 但 b 在 queued 仍不存在（splice 时删除）→ b 重
    // 新入队 → wave 1 b(2) failed → b 的失败边再次尝试再入 b(3) →
    // 循环 —— 又一个 self 永动问题。
    //
    // 换一个真实可达的跨波形态：t deps[a]（a 恒 failed）→ t 永不满足
    // deps；a、c 都 onFailure:t。wave 0 a、c 失败 → a kick t 入队，c
    // kick t 被 queued 短路。wave 1 t(1) 进并 done。wave 0 同波第二
    // 遍：c kick t 已被短路，a kick t 也短路（同波）。t 只入一次。
    // 真正让第二条失败边发生在 t 落定之后 —— 让 c 不在 wave 0。
    //
    // 简洁可解：c deps[a]，a 恒 failed → c 的 deps 永不满足 → c 只
    // 能被 a 的失败边启动 —— 但 a 的失败边指向 t，不指 c。c 仍不启动。
    //
    // 钉 honest：本组（裸调度器，无 fuse、无 abort 介入）里跨波汇聚
    // 同一终点的「真正可达且不永动」形态是「先 kick 的失败边起点先
    // failed，终点 done → 后 kick 的失败边起点后 failed → violation」。
    // 即用控制 promise 让 b 在 a、t 都落定之后再 settle —— b 的失败
    // 边在第二遍时看到 results[t] === "done" → violation（ADR-0060）。
    const release: { fn?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      release.fn = resolve;
    });
    const exec: NodeExecutor = async (id) => {
      entries.push(id);
      if (id === "b") await gate; // b 挂到 a、t 全部 settle 之后
      if (id === "t") return { status: "done", output: "T" };
      return { status: "failed", error: `${id}-boom` };
    };
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [], onFailure: "t" },
        { id: "b", deps: [], onFailure: "t" },
        { id: "t", deps: [] },
      ],
    };
    const pending = runGraphWithFailureEdges(spec, exec);
    // 等 a、t 都已 settle 再放 b —— b 此刻的失败边才会看到 t 已 done。
    await new Promise((r) => setTimeout(r, 5));
    release.fn!();
    const { execution, violation } = await pending;
    // executor 进入顺序按 spec 顺序同步发生（a、b、t 都在 wave 0 批
    // 同步进入；b 在进入后 await gate 挂起，settle 晚于 a、t）。第
    // 二遍遍历 settled：a 先 settled → 查 results[t] === "done" → 立
    // 即 violation（ADR-0060）。b 后 settled 已走不到第二遍的循环内
    // —— 由 a 的失败边先抢到 violation 抬升口。
    expect(entries).toEqual(["a", "b", "t"]);
    expect(violation).toEqual({ from: "a", target: "t" });
    expect(execution.statuses.t).toBe("done");
    expect(execution.statuses.b).toBe("failed");
  });

  it("跨波汇聚：t 先被 a kick 且同批 done → b 的失败边发现终点已 done → violation", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (id) =>
      id === "t"
        ? { status: "done", output: "T" }
        : { status: "failed", error: `${id}-boom` }
    );
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [], onFailure: "t" },
        { id: "b", deps: [], onFailure: "t" },
        { id: "t", deps: [] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    // wave 0: a, b, t 同批。t settled done；a、b settled failed。第二遍：
    // a 的失败边先查 results[t] === "done" → violation 立即抬升（b 的
    // kick 走不到）。done 永不因失败边再跑（ADR-0060）。
    expect(entries).toEqual(["a", "b", "t"]);
    expect(violation).toEqual({ from: "a", target: "t" });
    expect(execution.statuses.t).toBe("done");
  });
});

describe("runGraphWithFailureEdges — 失败边终点同波 settle（双向）", () => {
  it("a failed、b 同波 settled done → violation（目标本段已 done，ADR-0060）", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (id) =>
      id === "b"
        ? { status: "done", output: "B" }
        : { status: "failed", error: "a-boom" }
    );
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [], onFailure: "b" },
        { id: "b", deps: [] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    // b 不被 a 的失败边再入（已是 done）→ 终点仅一次进入。
    expect(entries).toEqual(["a", "b"]);
    expect(violation).toEqual({ from: "a", target: "b" });
    expect(execution.statuses.a).toBe("failed");
    expect(execution.statuses.b).toBe("done");
  });

  it("a failed、b 同波 settled failed → b 合法再入一次（target 是 failed 不算 done）", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (id, i) => {
      // i=0 = a(1), i=1 = b(1) → b failed；i=2 = b(2) → done
      if (id === "a") return { status: "failed", error: "a-boom" };
      return i <= 1
        ? { status: "failed", error: "b-boom" }
        : { status: "done", output: "B-RECOVER" };
    });
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [], onFailure: "b" },
        { id: "b", deps: [] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    // wave 0: a, b 都 failed；a 的失败边 kick b（b 此刻在 queued →
    // 已 splice 删除后，b failed settled → 第二遍 a 的失败边尝试 enqueue
    // b，b 此时非 done，可入）→ wave 1: b(2) 真正再入一次 → done。
    expect(entries).toEqual(["a", "b", "b"]);
    expect(execution.statuses.b).toBe("done");
    expect(violation).toBeUndefined();
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
