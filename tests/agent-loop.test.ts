import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { createSession } from "../src/agent-loop/session.ts";
import { IknowAgent, MAX_HOPS } from "../src/agent-loop/loop.ts";

describe("IknowAgent loop", () => {
  it("G2: snapshot_id always present on answer", async () => {
    const store = createSeededStore();
    const agent = new IknowAgent({
      store,
      session: createSession("employee"),
    });
    const ans = await agent.answer("公司的退款政策是什么？");
    assert.ok(ans.snapshot_id, "snapshot_id required (G2)");
    assert.match(ans.snapshot_id, /^snap_/);
    assert.ok(ans.governance_status);
  });

  it("hops_used <= 5 (MAX_HOPS)", async () => {
    assert.equal(MAX_HOPS, 5);
    const store = createSeededStore();
    const agent = new IknowAgent({
      store,
      session: createSession("employee"),
      maxHops: MAX_HOPS,
    });
    const ans = await agent.answer(
      "这个问题涉及八个部门的历史决议，你帮我理清楚谁先谁后。",
    );
    assert.ok(ans.hops_used <= 5, `hops_used=${ans.hops_used}`);
    assert.ok(ans.snapshot_id);
  });

  it("empty query handling does not invent content", async () => {
    const store = createSeededStore();
    const agent = new IknowAgent({
      store,
      session: createSession("employee"),
    });
    const ans = await agent.answer("   ");
    assert.ok(ans.snapshot_id);
    assert.equal(ans.hops_used, 0);
    assert.match(ans.text, /有效|问题|提供/);
    assert.equal(ans.source_spans.length, 0);
  });

  it("sensitive approval refuse path for customer contacts", async () => {
    const store = createSeededStore();
    const agent = new IknowAgent({
      store,
      session: createSession("employee"),
    });
    const ans = await agent.answer(
      "把过去五年所有项目的完整客户名单和联系方式整理成一份表发我。",
    );
    assert.ok(ans.snapshot_id);
    assert.match(ans.text, /审批|拦截|敏感|拒绝|requireApproval/i);
    assert.ok(
      ans.notes?.some((n) => /approval|permission|敏感/i.test(n)) ||
        /审批|拦截/.test(ans.text),
    );
  });

  it("competitor query refuses non-enterprise knowledge", async () => {
    const store = createSeededStore();
    const agent = new IknowAgent({
      store,
      session: createSession("employee"),
    });
    const ans = await agent.answer("帮我查一下竞对公司的内部薪酬结构。");
    assert.ok(ans.snapshot_id);
    assert.match(ans.text, /拒绝|越权|不得|非本企业/);
  });
});
