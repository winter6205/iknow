/**
 * archived: per-call network:true 轴退役（ADR-0097 accepted）——原断言钉住的旧语义已由 tests/harness/aci/bash-egress-typed-failure.test.ts / egress-domain-matcher.test.ts 承接
 *
 * ── original header ──────────────────────────────────────────────────────
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  NetworkViolationError,
  STATIC_NETWORK_WHITELIST,
  createNetworkPolicy,
} from "../../../src/harness/sandbox/network-policy.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

describe("createNetworkPolicy", () => {
  it("allows static whitelist domains", () => {
    const policy = createNetworkPolicy();
    assert.doesNotThrow(() => policy.assertDomain("github.com"));
    assert.ok(Object.isFrozen(STATIC_NETWORK_WHITELIST));
  });

  it("rejects non-whitelisted domains with a typed error", () => {
    assert.throws(
      () => createNetworkPolicy().assertDomain("evil.example.com"),
      (error: unknown) =>
        error instanceof NetworkViolationError &&
        error instanceof ToolExecutionError &&
        error.message ===
          "[network_denied] domain not in whitelist: evil.example.com"
    );
  });
});
