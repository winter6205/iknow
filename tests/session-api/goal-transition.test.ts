/**
 * #458 T3: goal status transition pure functions.
 *
 * Covers:
 * - VALID_GOAL_TRANSITIONS whitelist length and contents (5 edges, no
 *   self-loops, no expansion of GoalStatus union).
 * - assertValidTransition: all 5 whitelisted edges accept; all 4 self-
 *   transitions reject with `kind: "invalid_transition"`; samples of
 *   non-whitelisted cross-status edges reject (achieved→active,
 *   aborted→active, achieved→aborted).
 * - applyTransition: pure, immutable, carries `status` + `updatedAt`
 *   forward while preserving other fields (text/source/createdAt/history).
 *
 * Boundary semantics:
 * - Self-transitions are explicitly rejected — a re-affirmation of an
 *   existing status requires no writeback (T5 routes `failed/unstable`
 *   outcomes through `recordGoal` only, NOT `applyTransition`, since
 *   `active→active` is not in the whitelist).
 * - Non-whitelisted edges reject — GoalStatus union stays at 4 values
 *   (T1 OQ3: no schema bump). White-list-as-source-of-truth discipline
 *   (postel-light: whitelist is closed, not enumerable-from-union).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { GoalState } from "../../src/session-api/store/schema.js";
import {
  applyTransition,
  assertValidTransition,
  VALID_GOAL_TRANSITIONS,
  type TransitionInput,
} from "../../src/session-api/goal/index.js";
import { ok } from "../../src/session-api/goal/errors.js";

const baseGoal: GoalState = {
  text: "Type-system-validate-LSP",
  source: "user_pin",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  history: [
    {
      text: "old-goal",
      source: "user_initial",
      status: "superseded",
      updatedAt: "2025-12-31T00:00:00.000Z",
    },
  ],
};

// Parameterised edge sets — the source-of-truth table is the constant;
// these tests are the executable spec for that table.
const VALID_EDGES: ReadonlyArray<TransitionInput> = [
  { from: "active", to: "achieved" },
  { from: "active", to: "aborted" },
  { from: "active", to: "superseded" },
  { from: "achieved", to: "superseded" },
  { from: "aborted", to: "superseded" },
];

const SELF_EDGES: ReadonlyArray<TransitionInput> = [
  { from: "active", to: "active" },
  { from: "achieved", to: "achieved" },
  { from: "aborted", to: "aborted" },
  { from: "superseded", to: "superseded" },
];

// Sample of non-whitelisted cross-status edges. The full Cartesian product
// of GoalStatus (4 values) has 12 directed pairs; 5 are whitelisted, 4 are
// self-loops (also rejected), leaving 3 non-whitelist cross-status edges.
const INVALID_CROSS_EDGES: ReadonlyArray<TransitionInput> = [
  { from: "achieved", to: "active" },
  { from: "aborted", to: "active" },
  { from: "achieved", to: "aborted" },
];

describe("VALID_GOAL_TRANSITIONS (#458 T3 whitelist shape)", () => {
  it("is a frozen list of exactly 5 edges", () => {
    assert.equal(VALID_GOAL_TRANSITIONS.length, 5);
    // Each entry is a 2-tuple of GoalStatus literals (compile-time typed);
    // runtime check: string literals only.
    for (const edge of VALID_GOAL_TRANSITIONS) {
      assert.equal(edge.length, 2);
      assert.equal(typeof edge[0], "string");
      assert.equal(typeof edge[1], "string");
    }
  });

  it("contains no self-loops", () => {
    for (const [from, to] of VALID_GOAL_TRANSITIONS) {
      assert.notEqual(
        from,
        to,
        `self-loop ${from}→${to} must not be in the whitelist`
      );
    }
  });

  it("contains exactly the expected edges (order-independent)", () => {
    const asStrings = VALID_GOAL_TRANSITIONS.map(
      ([from, to]) => `${from}->${to}`
    ).sort();
    assert.deepEqual(asStrings, [
      "aborted->superseded",
      "achieved->superseded",
      "active->aborted",
      "active->achieved",
      "active->superseded",
    ]);
  });
});

describe("assertValidTransition (#458 T3 / SC7)", () => {
  for (const edge of VALID_EDGES) {
    it(`accepts whitelisted ${edge.from} → ${edge.to}`, () => {
      assert.deepEqual(assertValidTransition(edge), ok(true));
    });
  }

  for (const edge of SELF_EDGES) {
    it(`rejects self-transition ${edge.from} → ${edge.to} as invalid_transition`, () => {
      const result = assertValidTransition(edge);
      assert.ok(!result.ok, "self-transition must be rejected");
      const error = result.error;
      assert.equal(error.kind, "invalid_transition");
      assert.match(error.reason, /self-transition/);
      assert.deepEqual(error.context, { from: edge.from, to: edge.to });
    });
  }

  for (const edge of INVALID_CROSS_EDGES) {
    it(`rejects non-whitelist cross-status ${edge.from} → ${edge.to}`, () => {
      const result = assertValidTransition(edge);
      assert.equal(result.ok, false);
      assert.ok(!result.ok);
      // context carries { from, to } for hub-side catch logging
      assert.deepEqual(result.ok ? null : result.error.context, {
        from: edge.from,
        to: edge.to,
      });
      assert.equal(result.ok ? null : result.error.kind, "invalid_transition");
    });
  }
});

describe("applyTransition (#458 T3 pure helper)", () => {
  it("returns a new GoalState with status and updatedAt replaced", () => {
    const next = applyTransition(
      baseGoal,
      "achieved",
      "2026-02-01T00:00:00.000Z"
    );
    assert.equal(next.status, "achieved");
    assert.equal(next.updatedAt, "2026-02-01T00:00:00.000Z");
    // preserved
    assert.equal(next.text, baseGoal.text);
    assert.equal(next.source, baseGoal.source);
    assert.equal(next.createdAt, baseGoal.createdAt);
    assert.deepEqual(next.history, baseGoal.history);
  });

  it("does not mutate the input goal", () => {
    const before = JSON.parse(JSON.stringify(baseGoal)) as GoalState;
    applyTransition(baseGoal, "aborted", "2026-02-01T00:00:00.000Z");
    assert.deepEqual(baseGoal, before);
  });

  it("does not validate the transition itself (caller's responsibility)", () => {
    // applyTransition is intentionally a pure setter; assertValidTransition
    // is the gating check. `achieved → active` is non-whitelisted but the
    // helper still produces the value (T3 boundary contract).
    const next = applyTransition(
      baseGoal,
      "active",
      "2026-02-01T00:00:00.000Z"
    );
    assert.equal(next.status, "active");
  });
});
