/**
 * New permission module — session-grants.test.ts.
 *
 * add / list / remove / rules round-trip on in-memory session grants.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { createSessionGrants } from "../../../src/harness/permission/session-grants.js";
import type { NormalRuleSpec } from "../../../src/harness/permission/types.js";

function rule(
  id: string,
  decision: NormalRuleSpec["decision"]
): NormalRuleSpec {
  return {
    id,
    match: () => true,
    decision,
    reason: `r:${id}`,
  };
}

describe("createSessionGrants", () => {
  it("starts empty", () => {
    const g = createSessionGrants();
    assert.deepEqual(g.list(), []);
    assert.deepEqual(g.toRules(), []);
  });

  it("add + list: rules appear in insertion order", () => {
    const g = createSessionGrants();
    g.add(rule("a", "allow"));
    g.add(rule("b", "deny"));
    const r = g.list();
    assert.equal(r.length, 2);
    assert.equal(r[0]!.id, "a");
    assert.equal(r[1]!.id, "b");
  });

  it("add with duplicate id replaces the previous rule", () => {
    const g = createSessionGrants();
    g.add(rule("a", "allow"));
    g.add(rule("a", "deny"));
    const r = g.list();
    assert.equal(r.length, 1);
    assert.equal(r[0]!.decision, "deny");
  });

  it("remove by id returns true on hit, false on miss", () => {
    const g = createSessionGrants();
    g.add(rule("a", "allow"));
    assert.equal(g.remove("a"), true);
    assert.equal(g.remove("a"), false);
    assert.equal(g.list().length, 0);
  });

  it("returned object is frozen", () => {
    const g = createSessionGrants();
    assert.equal(Object.isFrozen(g), true);
  });

  it("rules() matches the policy-source surface", () => {
    const g = createSessionGrants();
    g.add(rule("x", "ask"));
    const r = g.rules();
    assert.equal(r.length, 1);
    assert.equal(r[0]!.id, "x");
    assert.equal(g.kind, "session");
  });
});
