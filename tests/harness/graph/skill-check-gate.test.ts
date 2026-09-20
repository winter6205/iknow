/**
 * PROTOTYPE — self-authored Graph multi-task orchestration: skill-check-gate.test.ts.
 *
 * Coverage:
 *   1. Node matching a skill → route, annotated with the skill name.
 *   2. High-risk node (deploy-prod) → block with reason.
 *   3. Unknown node → route with skill = "" (passed through, no contract).
 *   4. skillCatalog contains at least the built-in code-review and tdd skills.
 *   5. block + runGraph wiring: blocked nodes take the skipped branch
 *      (the underlying executor is never called).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  skillCatalog,
  skillCheckGate,
} from "../../../src/harness/graph/skill-check-gate.ts";
import { runGraph } from "../../../src/harness/graph/scheduler.ts";
import type { NodeExecutor } from "../../../src/harness/graph/types.ts";

describe("skillCheckGate (pure function)", () => {
  it("review-code → route with code-review skill", () => {
    const d = skillCheckGate("review-code");
    assert.equal(d.decision, "route");
    if (d.decision === "route") {
      assert.equal(d.skill, "code-review");
    }
  });

  it("write-test → route with tdd skill", () => {
    const d = skillCheckGate("write-test");
    assert.equal(d.decision, "route");
    if (d.decision === "route") {
      assert.equal(d.skill, "tdd");
    }
  });

  it("deploy-prod → block with reason", () => {
    const d = skillCheckGate("deploy-prod");
    assert.equal(d.decision, "block");
    if (d.decision === "block") {
      assert.match(d.reason, /禁止|生产|deploy/i);
    }
  });

  it("unknown node → route with empty skill (放行)", () => {
    const d = skillCheckGate("totally-unknown");
    assert.equal(d.decision, "route");
    if (d.decision === "route") {
      assert.equal(d.skill, "");
    }
  });

  it("skillCatalog contains code-review and tdd", () => {
    assert.ok(skillCatalog["code-review"]);
    assert.ok(skillCatalog["tdd"]);
    assert.equal(skillCatalog["code-review"]?.name, "code-review");
    assert.equal(skillCatalog["tdd"]?.name, "tdd");
  });

  it("opts.nodeSkillMap override default route table (per-call injection)", () => {
    // Default table maps 'review-code' → code-review; the override points it at a custom skill.
    const d = skillCheckGate("review-code", {
      nodeSkillMap: { "review-code": "custom-skill" },
    });
    assert.equal(d.decision, "route");
    if (d.decision === "route") {
      assert.equal(d.skill, "custom-skill");
    }
  });

  it("opts.blockedNodes override default block table (per-call injection)", () => {
    // Default table does not block 'unknown'; the override blocks it.
    const d = skillCheckGate("unknown", {
      blockedNodes: { unknown: "test override: 强制拦截" },
    });
    assert.equal(d.decision, "block");
    if (d.decision === "block") {
      assert.match(d.reason, /test override/);
    }
  });
});

describe("skillCheckGate wired into runGraph", () => {
  it("blocked 节点 → status=skipped 不调底层 executor", async () => {
    const called: string[] = [];
    // Inner executor records any call; blocked nodes must not reach it.
    const inner: NodeExecutor = async (id) => {
      called.push(id);
      return { status: "done", output: id };
    };
    // Wrap inner with skillCheckGate: block → skipped, no delegation.
    const gated: NodeExecutor = async (id, ctx) => {
      const gate = skillCheckGate(id);
      if (gate.decision === "block") {
        return { status: "skipped", reason: gate.reason };
      }
      return inner(id, ctx);
    };
    const out = await runGraph(
      {
        nodes: [
          { id: "review-code", deps: [] },
          { id: "write-test", deps: [] },
          { id: "deploy-prod", deps: [] },
        ],
      },
      gated
    );
    assert.equal(out.statuses["review-code"], "done");
    assert.equal(out.statuses["write-test"], "done");
    assert.equal(out.statuses["deploy-prod"], "skipped");
    // The blocked node never reached the underlying executor.
    assert.deepEqual(called, ["review-code", "write-test"]);
    // The skip reason carries the prohibition ("禁止").
    const r = out.results["deploy-prod"];
    assert.ok(r?.status === "skipped");
    if (r?.status === "skipped") {
      assert.match(r.reason, /禁止/);
    }
  });
});
