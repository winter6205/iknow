/**
 * PROTOTYPE — Self-written Graph 多任务编排：skill-check-gate.test.ts。
 *
 * 覆盖：
 *   1. 匹配 skill 的节点 → route + 标注 skill 名。
 *   2. 高危节点（deploy-prod） → block + reason。
 *   3. 未知节点 → route 但 skill = ""（放行不套契约）。
 *   4. skillCatalog 至少含 code-review 与 tdd 两个内置 skill。
 *   5. block 决策与 runGraph 串联：blocked 节点走 skipped 分支（不调底层）。
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
    // 默认表里 'review-code' → code-review；这里 override 让它指向 custom skill。
    const d = skillCheckGate("review-code", {
      nodeSkillMap: { "review-code": "custom-skill" },
    });
    assert.equal(d.decision, "route");
    if (d.decision === "route") {
      assert.equal(d.skill, "custom-skill");
    }
  });

  it("opts.blockedNodes override default block table (per-call injection)", () => {
    // 默认表里 'unknown' 不被 block；这里 override 让它被 block。
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
    // 底层 executor：若被调用则记录。blocked 节点不应触发。
    const inner: NodeExecutor = async (id) => {
      called.push(id);
      return { status: "done", output: id };
    };
    // 在 inner 外面包 skillCheckGate；block → skipped 不委派。
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
    // blocked 节点未被调到底层 executor。
    assert.deepEqual(called, ["review-code", "write-test"]);
    // reason 含禁止语义。
    const r = out.results["deploy-prod"];
    assert.ok(r?.status === "skipped");
    if (r?.status === "skipped") {
      assert.match(r.reason, /禁止/);
    }
  });
});
