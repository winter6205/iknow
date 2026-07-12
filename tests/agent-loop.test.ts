import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { createSession } from "../src/agent-loop/session.ts";
import { IknowAgent, MAX_HOPS } from "../src/agent-loop/loop.ts";
import {
  MAX_PRIOR_CHUNKS,
  normalizePriors,
} from "../src/agent-loop/priors.ts";

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

  it("answer(query) one-arg still works (multi-turn opts optional)", async () => {
    const store = createSeededStore();
    const agent = new IknowAgent({
      store,
      session: createSession("employee"),
    });
    const ans = await agent.answer("公司的退款政策是什么？");
    assert.ok(ans.snapshot_id);
    assert.ok(ans.tool_trace.includes("kb_retrieve"));
  });

  it("multi-turn prior_chunks on first retrieve (trace args)", async () => {
    const store = createSeededStore();
    const agent = new IknowAgent({
      store,
      session: createSession("employee"),
    });
    const priors = [
      {
        chunk_id: "refund-v2026-c1",
        summary: "退款需在规定期限内申请",
      },
    ];
    const ans = await agent.answer("那时限是多久？", {
      prior_chunks: priors,
      history: [
        { role: "user", content: "退款政策？" },
        { role: "assistant", content: "见知识库" },
      ],
    });
    assert.ok(ans.snapshot_id, "G2 still required with multi-turn opts");
    const firstRetrieve = ans.tool_calls.find((c) => c.tool === "kb_retrieve");
    assert.ok(firstRetrieve, "expected kb_retrieve in tool_calls");
    const args = firstRetrieve!.args as {
      query?: string;
      prior_chunks?: Array<{ chunk_id: string; summary: string }>;
    };
    assert.ok(args.prior_chunks?.length, "first retrieve should carry prior_chunks");
    assert.equal(args.prior_chunks![0]!.chunk_id, "refund-v2026-c1");
    assert.match(String(args.query ?? ""), /时限|多久/);
  });

  it("normalizePriors drops empty summary and caps at MAX_PRIOR_CHUNKS", () => {
    assert.equal(MAX_PRIOR_CHUNKS, 5);
    const out = normalizePriors([
      { chunk_id: "a", summary: "ok" },
      { chunk_id: "b", summary: "" },
      { chunk_id: "c", summary: "   " },
      { chunk_id: "", summary: "no-id" },
      { chunk_id: "d", summary: "keep" },
      { chunk_id: "e", summary: "e" },
      { chunk_id: "f", summary: "f" },
      { chunk_id: "g", summary: "g" },
      { chunk_id: "h", summary: "overflow" },
    ]);
    assert.ok(out);
    assert.equal(out!.length, 5);
    assert.deepEqual(
      out!.map((p) => p.chunk_id),
      ["a", "d", "e", "f", "g"],
    );
    assert.equal(normalizePriors([{ chunk_id: "x", summary: "  " }]), undefined);
  });

  it("edge-001 sensitive path first retrieve has no prior_chunks", async () => {
    const store = createSeededStore();
    const agent = new IknowAgent({
      store,
      session: createSession("employee"),
    });
    const ans = await agent.answer(
      "把过去五年所有项目的完整客户名单和联系方式整理成一份表发我。",
      {
        prior_chunks: [
          { chunk_id: "refund-v2026-c1", summary: "退款政策摘要" },
        ],
        history: [
          { role: "user", content: "退款政策？" },
          { role: "assistant", content: "见知识库" },
        ],
      },
    );
    assert.ok(ans.snapshot_id);
    assert.match(ans.text, /审批|拦截|敏感|拒绝|requireApproval/i);
    const firstRetrieve = ans.tool_calls.find((c) => c.tool === "kb_retrieve");
    assert.ok(firstRetrieve, "expected kb_retrieve in tool_calls");
    const args = firstRetrieve!.args as {
      query?: string;
      prior_chunks?: unknown;
    };
    assert.equal(
      args.prior_chunks,
      undefined,
      "sensitive pre-check must not pass conversational prior_chunks",
    );
    assert.match(String(args.query ?? ""), /客户名单|联系方式/);
  });
});
