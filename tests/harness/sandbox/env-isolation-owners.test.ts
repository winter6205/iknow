/**
 * env-isolation active-extras ownership.
 *
 * The extras contribution is keyed by owner (an engine build root, a model
 * route, or the default owner direct callers use), and `currentSecretValues()`
 * masks the **union** of all live owners. Clearing removes one owner's
 * contribution only, so a second build can never drop the first build's secret
 * values out of the output mask.
 *
 * Synthetic secret values only; nothing here is real key material.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  clearActiveExtraSecrets,
  currentSecretValues,
  setActiveExtraSecrets,
  DEFAULT_OWNER,
} from "../../../src/harness/sandbox/env-isolation.js";

// Owner keys mirror the shapes real callers use: an engine build root under
// the `root:` namespace, a second root in the same process, and a hub route
// key under the `route:` namespace.
const OWNER_A = "root:/synthetic/root-a";
const OWNER_B = "root:/synthetic/root-b";
const OWNER_ROUTE = "route:synthetic-route";
// Same tail, different namespace — the two production shapes must not collide.
const OWNER_NS_BUILD = "root:shared-tail";
const OWNER_NS_ROUTE = "route:shared-tail";

const K1 = "synthetic-owner-secret-k1";
const K2 = "synthetic-owner-secret-k2";
const K3 = "synthetic-owner-secret-k3";
const K4 = "synthetic-owner-secret-k4";

const OWNERS = [
  OWNER_A,
  OWNER_B,
  OWNER_ROUTE,
  OWNER_NS_BUILD,
  OWNER_NS_ROUTE,
  DEFAULT_OWNER,
];
const VALUES = [K1, K2, K3, K4];

function clearEveryOwner(): void {
  for (const owner of OWNERS) clearActiveExtraSecrets(owner);
}

beforeEach(clearEveryOwner);
afterEach(() => {
  clearEveryOwner();
  // A contribution that outlived its case (an owner key nobody cleared) would
  // still sit in the union here.
  const leaked = VALUES.filter((v) => currentSecretValues({}).includes(v));
  assert.deepEqual(leaked, [], "an owner contribution outlived its test case");
});

describe("active extras — union of live owners", () => {
  it("every live owner's values are masked (one build must not replace another)", () => {
    setActiveExtraSecrets(OWNER_A, [K1]);
    setActiveExtraSecrets(OWNER_B, [K2]);
    setActiveExtraSecrets(OWNER_ROUTE, [K3]);
    const masked = currentSecretValues({});
    for (const value of [K1, K2, K3]) {
      assert.ok(
        masked.includes(value),
        `union must keep owner value (actual=${masked.length} entries)`
      );
    }
  });

  it("a value contributed by two owners enters the mask set once", () => {
    setActiveExtraSecrets(OWNER_A, [K1, K1]);
    setActiveExtraSecrets(OWNER_B, [K1, K2]);
    const masked = currentSecretValues({});
    assert.equal(
      masked.filter((v) => v === K1).length,
      1,
      "cross-owner duplicates collapse"
    );
    assert.ok(masked.includes(K2));
  });

  it("clearing one owner leaves every other owner masked", () => {
    setActiveExtraSecrets(OWNER_A, [K1]);
    setActiveExtraSecrets(OWNER_B, [K2]);
    setActiveExtraSecrets(OWNER_ROUTE, [K3]);
    clearActiveExtraSecrets(OWNER_B);
    const masked = currentSecretValues({});
    assert.ok(!masked.includes(K2), "the cleared owner drops out");
    assert.ok(masked.includes(K1), "other owners stay masked");
    assert.ok(masked.includes(K3), "other owners stay masked");
  });
});

describe("active extras — per-owner replacement", () => {
  it("re-setting an owner replaces only its own contribution", () => {
    setActiveExtraSecrets(OWNER_A, [K1]);
    setActiveExtraSecrets(OWNER_B, [K2]);
    setActiveExtraSecrets(OWNER_A, [K1, K3]);
    const masked = currentSecretValues({});
    assert.ok(masked.includes(K1) && masked.includes(K3));
    assert.ok(masked.includes(K2), "the other owner's contribution survives");
  });

  it("an owner's rebuild drops its stale value instead of growing the set", () => {
    setActiveExtraSecrets(OWNER_A, [K1]);
    setActiveExtraSecrets(OWNER_A, [K2]);
    const masked = currentSecretValues({});
    assert.ok(
      !masked.includes(K1),
      "stale value of the same owner is replaced"
    );
    assert.ok(masked.includes(K2));
  });
});

describe("active extras — owner key namespaces", () => {
  it("a build owner and a route owner with the same tail are distinct owners", () => {
    setActiveExtraSecrets(OWNER_NS_BUILD, [K1]);
    setActiveExtraSecrets(OWNER_NS_ROUTE, [K2]);
    const masked = currentSecretValues({});
    assert.ok(masked.includes(K1), "the build owner's value is masked");
    assert.ok(masked.includes(K2), "the route owner's value is masked");
    clearActiveExtraSecrets(OWNER_NS_ROUTE);
    const afterClear = currentSecretValues({});
    assert.ok(!afterClear.includes(K2), "the route owner drops out");
    assert.ok(afterClear.includes(K1), "the build owner stays masked");
  });
});

describe("active extras — default owner and explicit-argument precedence", () => {
  it("the default owner sets and clears one default contribution", () => {
    setActiveExtraSecrets(DEFAULT_OWNER, [K1]);
    assert.ok(currentSecretValues({}).includes(K1));
    clearActiveExtraSecrets(DEFAULT_OWNER);
    assert.ok(!currentSecretValues({}).includes(K1));
  });

  it("clearing the default owner does not remove a rooted owner's contribution", () => {
    setActiveExtraSecrets(OWNER_A, [K1]);
    setActiveExtraSecrets(DEFAULT_OWNER, [K2]);
    clearActiveExtraSecrets(DEFAULT_OWNER);
    const masked = currentSecretValues({});
    assert.ok(!masked.includes(K2), "the default contribution is gone");
    assert.ok(masked.includes(K1), "the rooted owner stays masked");
  });

  it("an explicit extraSecrets argument still overrides the whole union", () => {
    setActiveExtraSecrets(OWNER_A, [K1]);
    setActiveExtraSecrets(OWNER_B, [K2]);
    const masked = currentSecretValues({}, [K3]);
    assert.ok(masked.includes(K3), "explicit extras take effect");
    assert.ok(!masked.includes(K1), "explicit extras win over the union");
    assert.ok(!masked.includes(K2), "explicit extras win over the union");
  });
});
