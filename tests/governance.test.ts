import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { kbGovernance } from "../src/kb-governance/governance.ts";
import { createSession } from "../src/agent-loop/session.ts";
import { GovernanceTimeoutError } from "../src/shared/errors.ts";

describe("kb_governance", () => {
  it("snapshot_id is always present", () => {
    const store = createSeededStore();
    const out = kbGovernance(
      store,
      { action: "snapshot_status", doc_id: "refund-v2026" },
      createSession(),
    );
    assert.ok(out.snapshot_id);
    assert.match(out.snapshot_id, /^snap_/);
    assert.ok(out.checked_at);
  });

  it("stale for revoked documents", () => {
    const store = createSeededStore();
    const out = kbGovernance(
      store,
      { action: "check_freshness", doc_id: "policy-revoked" },
      createSession(),
    );
    assert.equal(out.status, "stale");
    assert.ok(out.snapshot_id);

    const snap = kbGovernance(
      store,
      { action: "snapshot_status", doc_id: "policy-revoked" },
      createSession(),
    );
    assert.ok(
      snap.status === "stale" || snap.status === "conflict",
      snap.status,
    );
  });

  it("timeout throws GOVERNANCE_TIMEOUT when simulate flag set", () => {
    const store = createSeededStore();
    assert.throws(
      () =>
        kbGovernance(
          store,
          { action: "check_freshness", doc_id: "refund-v2026" },
          createSession("employee", { simulate_governance_timeout: true }),
        ),
      (e: unknown) =>
        e instanceof GovernanceTimeoutError &&
        e.code === "GOVERNANCE_TIMEOUT",
    );
  });

  it("detect_conflict marks dual refund policies", () => {
    const store = createSeededStore();
    const out = kbGovernance(
      store,
      { action: "detect_conflict", doc_id: "refund-v2026" },
      createSession(),
    );
    assert.equal(out.status, "conflict");
    assert.ok(out.snapshot_id);
  });

  it("snapshot_status also surfaces refund dual-policy conflict", () => {
    const store = createSeededStore();
    const out = kbGovernance(
      store,
      { action: "snapshot_status", doc_id: "refund-v2026" },
      createSession(),
    );
    assert.equal(out.status, "conflict");
  });
});
