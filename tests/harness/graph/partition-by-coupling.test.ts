/**
 * PROTOTYPE — multi-task graph orchestration: partition-by-coupling.test.ts.
 *
 * Covers:
 *   1. Empty task list → empty GraphSpec.
 *   2. Single task + single module → no deps.
 *   3. Multiple tasks touching the same module → edges only between adjacent ones (chain, not clique).
 *   4. Tasks across modules → independent parallel waves.
 *   5. Multi-module chain: auth-ui touches auth + ui → fans out into both module chains.
 *   6. partitionByCoupling + topoWaves composition: coupled tasks serialize, decou ones parallelize.
 *   7. sameWave helper correctly decides same / different wave.
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
    // t-auth-ui touches auth + ui → it joins the auth chain (auth) and the ui chain (ui).
    const tasks: CouplingTask[] = [
      { id: "t-auth", touches: ["auth"] },
      { id: "t-auth-ui", touches: ["auth", "ui"] },
      { id: "t-ui", touches: ["ui"] },
    ];
    const spec = partitionByCoupling(tasks);
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));
    // auth-module chain: t-auth → t-auth-ui (input order)
    assert.deepEqual(byId.get("t-auth-ui")!.deps, ["t-auth"]);
    // ui-module chain: t-auth-ui → t-ui (after inputIndex sort, deps include t-auth-ui).
    // t-auth-ui sorts earlier in inputIndex, so the dep is legitimate.
    assert.ok(byId.get("t-ui")!.deps.includes("t-auth-ui"));
    // topoWaves check: t-auth and t-ui are not in the same wave (t-auth-ui sits between them).
    const waves = topoWaves(spec);
    assert.equal(waves.length, 3);
    assert.deepEqual(waves[0], ["t-auth"]);
    assert.deepEqual(waves[1], ["t-auth-ui"]);
    assert.deepEqual(waves[2], ["t-ui"]);
  });

  it("complex 5-task mixed scenario from C1 (research report)", () => {
    // Ported from proto-c-coupling's C1_TASKS; this test only checks partition behavior.
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

    // auth-coupled separated: t-auth and t-auth-ui are not in the same wave.
    assert.equal(sameWave("t-auth", "t-auth-ui", waves), false);
    // ui-coupled separated: t-auth-ui and t-ui are not in the same wave.
    assert.equal(sameWave("t-auth-ui", "t-ui", waves), false);
    // db-coupled separated: t-db and t-db-test are not in the same wave.
    assert.equal(sameWave("t-db", "t-db-test", waves), false);
    // wave0 contains t-db and the auth-chain head (disjoint parallel).
    assert.ok(wave0.includes("t-db"));
    assert.ok(wave0.some((id) => id.startsWith("t-auth")));
    // total wave count < 5 thanks to decoupled parallelism.
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
