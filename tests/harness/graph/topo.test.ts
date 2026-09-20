/**
 * PROTOTYPE — self-authored Graph multi-task orchestration: topo.test.ts.
 *
 * Coverage:
 *   1. validateGraph accepts nodes without deps.
 *   2. validateGraph accepts a linear chain (valid DAG).
 *   3. validateGraph rejects self-deps.
 *   4. validateGraph rejects unknown deps.
 *   5. validateGraph rejects duplicate ids.
 *   6. validateGraph detects cycles (best effort).
 *   7. topoWaves layers a DAG; nodes within a layer keep spec order.
 *   8. topoWaves splits a diamond dependency into 3 layers.
 *   9. topoWaves throws Error on invalid graphs.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { topoWaves, validateGraph } from "../../../src/harness/graph/topo.ts";
import type { GraphSpec } from "../../../src/harness/graph/types.ts";

describe("validateGraph", () => {
  it("empty spec is valid", () => {
    assert.deepEqual(validateGraph({ nodes: [] }), []);
  });

  it("zero-dep nodes are valid", () => {
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "b", deps: [] },
      ],
    };
    assert.deepEqual(validateGraph(spec), []);
  });

  it("linear chain is valid", () => {
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "b", deps: ["a"] },
        { id: "c", deps: ["b"] },
      ],
    };
    assert.deepEqual(validateGraph(spec), []);
  });

  it("rejects self-dep", () => {
    const spec: GraphSpec = {
      nodes: [{ id: "a", deps: ["a"] }],
    };
    const errors = validateGraph(spec);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.kind, "self-dep");
  });

  it("rejects unknown-dep", () => {
    const spec: GraphSpec = {
      nodes: [{ id: "a", deps: ["missing"] }],
    };
    const errors = validateGraph(spec);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.kind, "unknown-dep");
  });

  it("rejects duplicate-id", () => {
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "a", deps: [] },
      ],
    };
    const errors = validateGraph(spec);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.kind, "duplicate-id");
  });

  it("detects cycle (a -> b -> a)", () => {
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: ["b"] },
        { id: "b", deps: ["a"] },
      ],
    };
    const errors = validateGraph(spec);
    assert.ok(
      errors.some((e) => e.kind === "cycle"),
      `expected cycle error, got ${JSON.stringify(errors)}`
    );
  });
});

describe("topoWaves", () => {
  it("returns one wave for zero-dep nodes, ordered by spec input order", () => {
    const spec: GraphSpec = {
      nodes: [
        { id: "z", deps: [] },
        { id: "a", deps: [] },
        { id: "m", deps: [] },
      ],
    };
    assert.deepEqual(topoWaves(spec), [["z", "a", "m"]]);
  });

  it("linear chain => N waves each with one node", () => {
    const spec: GraphSpec = {
      nodes: [
        { id: "a", deps: [] },
        { id: "b", deps: ["a"] },
        { id: "c", deps: ["b"] },
      ],
    };
    assert.deepEqual(topoWaves(spec), [["a"], ["b"], ["c"]]);
  });

  it("diamond deps => 3 waves (root, mid parallel, sink)", () => {
    const spec: GraphSpec = {
      nodes: [
        { id: "root", deps: [] },
        { id: "left", deps: ["root"] },
        { id: "right", deps: ["root"] },
        { id: "sink", deps: ["left", "right"] },
      ],
    };
    const waves = topoWaves(spec);
    assert.equal(waves.length, 3);
    assert.deepEqual(waves[0], ["root"]);
    assert.deepEqual(waves[1], ["left", "right"]);
    assert.deepEqual(waves[2], ["sink"]);
  });

  it("throws on invalid graph", () => {
    const spec: GraphSpec = {
      nodes: [{ id: "a", deps: ["missing"] }],
    };
    assert.throws(() => topoWaves(spec), /invalid graph/);
  });
});
