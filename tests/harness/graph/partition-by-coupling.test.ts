/**
 * PROTOTYPE — Self-written Graph 多任务编排：partition-by-coupling.test.ts。
 *
 * 覆盖：
 *   1. 空任务列表 → 空 GraphSpec。
 *   2. 单一任务 + 单一 module → 无 deps。
 *   3. 多个任务触碰同 module → 相邻加边（成链，不成团）。
 *   4. 多任务跨 module → 各自独立 wave 并行。
 *   5. 多 module 链：auth-ui 同时触碰 auth + ui，分发到两个 module 链。
 *   6. partitionByCoupling + topoWaves 组合：耦合的串行、解耦的并行。
 *   7. sameWave helper 正确判定同 / 不同 wave。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  partitionByCoupling,
  sameWave,
} from "../../../src/harness/graph/partition-by-coupling.ts";
import { topoWaves } from "../../../src/harness/graph/topo.ts";
import type { CouplingTask } from "../../../src/harness/graph/partition-by-coupling.ts";
import type { GraphSpec } from "../../../src/harness/graph/types.ts";

describe("partitionByCoupling", () => {
  it("empty tasks → empty spec", () => {
    const spec = partitionByCoupling([]);
    assert.deepEqual(spec, { nodes: [] });
  });

  it("single task no touches → no deps", () => {
    const tasks: CouplingTask[] = [{ id: "t1", touches: [] }];
    const spec = partitionByCoupling(tasks);
    assert.equal(spec.nodes.length, 1);
    assert.equal(spec.nodes[0]!.id, "t1");
    assert.deepEqual(spec.nodes[0]!.deps, []);
  });

  it("two tasks touching same module → adjacent edge only (chain)", () => {
    const tasks: CouplingTask[] = [
      { id: "t-a", touches: ["auth"] },
      { id: "t-b", touches: ["auth"] },
    ];
    const spec = partitionByCoupling(tasks);
    assert.equal(spec.nodes[0]!.deps.length, 0);
    assert.deepEqual(spec.nodes[1]!.deps, ["t-a"]);
  });

  it("three tasks same module → chain of 3, not clique", () => {
    const tasks: CouplingTask[] = [
      { id: "t1", touches: ["db"] },
      { id: "t2", touches: ["db"] },
      { id: "t3", touches: ["db"] },
    ];
    const spec = partitionByCoupling(tasks);
    assert.deepEqual(spec.nodes[0]!.deps, []);
    assert.deepEqual(spec.nodes[1]!.deps, ["t1"]);
    assert.deepEqual(spec.nodes[2]!.deps, ["t2"]);
  });

  it("disjoint modules → no edges, all parallel", () => {
    const tasks: CouplingTask[] = [
      { id: "t-auth", touches: ["auth"] },
      { id: "t-ui", touches: ["ui"] },
      { id: "t-db", touches: ["db"] },
    ];
    const spec = partitionByCoupling(tasks);
    for (const n of spec.nodes) {
      assert.equal(n.deps.length, 0, `${n.id} should have no deps`);
    }
    const waves = topoWaves(spec);
    assert.equal(waves.length, 1);
    assert.equal(waves[0]?.length, 3);
  });

  it("multi-module task fans out into multiple chains", () => {
    // t-auth-ui 触碰 auth + ui → 它与 t-auth 链（auth），与 t-ui 链（ui）。
    const tasks: CouplingTask[] = [
      { id: "t-auth", touches: ["auth"] },
      { id: "t-auth-ui", touches: ["auth", "ui"] },
      { id: "t-ui", touches: ["ui"] },
    ];
    const spec = partitionByCoupling(tasks);
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));
    // auth module 链：t-auth → t-auth-ui (按输入顺序)
    assert.deepEqual(byId.get("t-auth-ui")!.deps, ["t-auth"]);
    // ui module 链：t-auth-ui → t-ui（inputIndex 排序后 deps 含 t-auth-ui）
    // 因为 t-auth-ui 已经在 inputIndex 中排前，deps 含 t-auth-ui 合法。
    assert.ok(byId.get("t-ui")!.deps.includes("t-auth-ui"));
    // 验证 topoWaves：t-auth 与 t-ui 不在同一 wave（中间隔着 t-auth-ui）。
    const waves = topoWaves(spec);
    assert.equal(waves.length, 3);
    assert.deepEqual(waves[0], ["t-auth"]);
    assert.deepEqual(waves[1], ["t-auth-ui"]);
    assert.deepEqual(waves[2], ["t-ui"]);
  });

  it("complex 5-task mixed scenario from C1 (research report)", () => {
    // 复制 proto-c-coupling 的 C1_TASKS，但本测试只关注 partition 行为。
    const tasks: CouplingTask[] = [
      { id: "t-auth", touches: ["auth"] },
      { id: "t-auth-ui", touches: ["auth", "ui"] },
      { id: "t-ui", touches: ["ui"] },
      { id: "t-db", touches: ["db"] },
      { id: "t-db-test", touches: ["db"] },
    ];
    const spec = partitionByCoupling(tasks);
    const waves = topoWaves(spec);
    const wave0 = waves[0] ?? [];

    // auth-coupled separated: t-auth 与 t-auth-ui 不在同一 wave。
    assert.equal(sameWave("t-auth", "t-auth-ui", waves), false);
    // ui-coupled separated: t-auth-ui 与 t-ui 不在同一 wave。
    assert.equal(sameWave("t-auth-ui", "t-ui", waves), false);
    // db-coupled separated: t-db 与 t-db-test 不在同一 wave。
    assert.equal(sameWave("t-db", "t-db-test", waves), false);
    // wave0 含 t-db 与 auth 链起点（disjoint parallel）。
    assert.ok(wave0.includes("t-db"));
    assert.ok(wave0.some((id) => id.startsWith("t-auth")));
    // 总层数 < 5（解耦并行带来合并）。
    assert.ok(waves.length < 5, `expected <5 waves, got ${waves.length}`);
  });

  it("preserves input order in nodes array", () => {
    const tasks: CouplingTask[] = [
      { id: "z", touches: [] },
      { id: "a", touches: [] },
      { id: "m", touches: [] },
    ];
    const spec: GraphSpec = partitionByCoupling(tasks);
    assert.deepEqual(
      spec.nodes.map((n) => n.id),
      ["z", "a", "m"]
    );
  });
});
