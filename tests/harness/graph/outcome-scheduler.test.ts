/**
 * Outcome-driven failure-edge scheduler tests (ADR-0054 / ADR-0055).
 *
 * Pinned invariants:
 *   - **Only failed triggers a failure edge**: a start settling done /
 *     skipped never kicks its `onFailure` (ADR-0055); each failed outcome
 *     kicks the target exactly once.
 *   - **Re-entry under the same id**: a failure edge back to an unfrozen old
 *     id (including self) re-enters the executor under the same id, never a
 *     new one — the entry log asserts two entries with the same id.
 *   - **Target already done this run → violation**: no spawn, scheduling
 *     stops, the violation is surfaced to the handler as a typed rejection
 *     (distinct from submit-time schema rejection; partial results stay in
 *     execution). A done node is never re-run via a failure edge.
 *   - **skipped does not trigger failure edges**: markSkipped produces no kick.
 *   - **Failure-edge targets remain ordinary nodes**: normal deps rules still
 *     apply (the two wave-0 behaviors pinned earlier must not regress); to
 *     express "first run only on failure", point the target's deps at the failed start.
 *   - **After abort, no new entries start**: in-flight work drains then converges, no spinning.
 *
 * This file asserts the entry sequence (id level) with a stub executor;
 * wire level (real manager spawn) lives in run-graph-failure-edges.test.ts.
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

/** Entry-id sequence log from the executor — ground truth for "same id re-runs". */
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
    // Same id entered twice (re-entry), finally done
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
    // Only b actually runs; c fail-fast skips via deps and its failure edge stays
    // untriggered; d skips together with c.
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
        // a's first entry fails; re-entered by b's failure edge it then succeeds
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
    // The target enters only once (a done node is never re-run via a failure edge)
    expect(entries).toEqual(["b", "a"]);
    // Partial results stay in execution; the handler uses them for freeze + typed rejection
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
        // c's first entry fails (wave 1, same batch as b(2)); the second entry
        // kicked by b(2)'s failure edge succeeds and converges — if c succeeded
        // on its first entry, b(2) in the same wave would find the target
        // already done and raise a violation, breaking the chain there.
        return cEntry === 1
          ? { status: "failed", error: "c-boom" }
          : { status: "done", output: "C-RECOVER" };
      }
      return { status: "failed", error: `${id}-boom` };
    };
    // c deps[b]: b always fails → c's deps gate is never satisfied, so c can
    // only enter via a failure-edge kick. Chain: wave 0 a and b both fail →
    // a kicks b(2), b kicks c(1) → wave 1 b(2) and c(1) both fail → b(2)
    // kicks c(2) → wave 2 c(2) succeeds and converges.
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [], onFailure: "b" },
        { id: "b", deps: [], onFailure: "c" },
        { id: "c", deps: ["b"] },
      ],
    };
    const { execution, violation } = await runGraphWithFailureEdges(spec, exec);
    // Both of c's entries happen after some b settles failed (wave 1 after
    // b(1), wave 2 after b(2)) — chained failure edges serialize wave by wave.
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
    // t deps[a]: a always fails → t's deps gate is never satisfied, so t can
    // only enter via a failure-edge kick. a and b fail in the same wave and
    // both target t: the first kick queues it, the second is short-circuited
    // by queued — t enters exactly once.
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
    // A cross-wave convergence form that is honestly reachable without a fuse
    // or abort is awkward: with plain deps the later start never enters, and
    // with self-edges the scheduler spins. So this test gates b — b's failure
    // edge must settle strictly after a and t — making the second edge observe
    // results[t] === "done" and raise the violation.
    const release: { fn?: () => void } = {};
    const gate = new Promise<void>((resolve) => {
      release.fn = resolve;
    });
    const exec: NodeExecutor = async (id) => {
      entries.push(id);
      if (id === "b") await gate; // hold b until a and t have fully settled
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
    // Release b only after a and t have settled — only then can b's failure
    // edge observe t as already done.
    await new Promise((r) => setTimeout(r, 5));
    release.fn!();
    const { execution, violation } = await pending;
    // Entries happen synchronously in spec order (a, b, t all enter in the
    // wave-0 batch; b suspends on the gate after entering, settling later
    // than a and t). In the second pass over settled nodes, a is seen first
    // → results[t] === "done" → immediate violation. b settles
    // later and never reaches the loop again — a's edge wins the raise.
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
    // wave 0: a, b, t in one batch. t settles done; a and b settle failed.
    // Second pass: a's edge checks results[t] === "done" first → violation
    // raised immediately (b's kick never runs). A done node is never re-run
    // via a failure edge.
    expect(entries).toEqual(["a", "b", "t"]);
    expect(violation).toEqual({ from: "a", target: "t" });
    expect(execution.statuses.t).toBe("done");
  });
});

describe("runGraphWithFailureEdges — 失败边终点同波 settle（双向）", () => {
  it("a failed、b 同波 settled done → violation（目标本段已 done）", async () => {
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
    // b is not re-entered via a's edge (already done) → the target enters once.
    expect(entries).toEqual(["a", "b"]);
    expect(violation).toEqual({ from: "a", target: "b" });
    expect(execution.statuses.a).toBe("failed");
    expect(execution.statuses.b).toBe("done");
  });

  it("a failed、b 同波 settled failed → b 合法再入一次（target 是 failed 不算 done）", async () => {
    const entries: string[] = [];
    const exec = recordingExec(entries, (id, i) => {
      // i=0 = a(1), i=1 = b(1) → b failed; i=2 = b(2) → done
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
    // wave 0: both a and b fail; a's edge kicks b (b was already removed from
    // queued on splice → after b settles failed, the second pass lets a's edge
    // enqueue b since b is not done) → wave 1: b(2) really re-enters once → done.
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
    // The first entry was already dispatched synchronously, parked on the gate
    expect(entries).toEqual(["a"]);
    controller.abort();
    release({ status: "failed", error: "cancelled by caller abort" });
    const { execution, violation } = await pending;
    // A failed outcome would kick self again, but scheduling stops after abort (no spinning)
    expect(entries).toEqual(["a"]);
    expect(execution.statuses.a).toBe("failed");
    expect(violation).toBeUndefined();
  });
});
