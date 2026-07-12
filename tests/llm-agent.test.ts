import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeededStore } from "../src/fixtures/seed-kb.ts";
import { createSession } from "../src/agent-loop/session.ts";
import { LlmIknowAgent } from "../src/agent-loop/llm-agent.ts";
import type {
  LlmChatClient,
  LlmChatResult,
  LlmMessage,
  LlmToolDef,
} from "../src/agent-loop/llm-client.ts";
import { parseFinalContent } from "../src/agent-loop/llm-agent.ts";

/**
 * Scripted mock: no network.
 * 1) kb_retrieve tool_call
 * 2) kb_governance tool_call
 * 3) final text
 */
class ScriptedLlmClient implements LlmChatClient {
  private step = 0;
  readonly calls: LlmMessage[][] = [];

  async chat(
    messages: LlmMessage[],
    _tools: LlmToolDef[],
  ): Promise<LlmChatResult> {
    this.calls.push(messages.map((m) => ({ ...m })));
    this.step += 1;
    if (this.step === 1) {
      return {
        tool_calls: [
          {
            id: "call_retrieve_1",
            type: "function",
            function: {
              name: "kb_retrieve",
              arguments: JSON.stringify({ query: "公司的退款政策是什么？" }),
            },
          },
        ],
      };
    }
    if (this.step === 2) {
      return {
        tool_calls: [
          {
            id: "call_gov_1",
            type: "function",
            function: {
              name: "kb_governance",
              arguments: JSON.stringify({
                action: "snapshot_status",
                doc_id: "refund-v2026",
              }),
            },
          },
        ],
      };
    }
    return {
      content:
        "根据知识库，退款需在规定期限内按流程申请。",
    };
  }
}

/**
 * Model forgets governance: agent must force G2 snapshot itself.
 */
class RetrieveThenFinalClient implements LlmChatClient {
  private step = 0;

  async chat(
    _messages: LlmMessage[],
    _tools: LlmToolDef[],
  ): Promise<LlmChatResult> {
    this.step += 1;
    if (this.step === 1) {
      return {
        tool_calls: [
          {
            id: "call_r",
            type: "function",
            function: {
              name: "kb_retrieve",
              arguments: JSON.stringify({ query: "退款政策" }),
            },
          },
        ],
      };
    }
    return { content: "退款政策说明（模型未调治理）。" };
  }
}

describe("LlmIknowAgent (mock LLM, offline)", () => {
  it("G2 snapshot_id present and tool_calls length >= 2", async () => {
    const store = createSeededStore();
    const llm = new ScriptedLlmClient();
    const agent = new LlmIknowAgent({
      store,
      session: createSession("employee"),
      llm,
    });
    const ans = await agent.answer("公司的退款政策是什么？");

    assert.ok(ans.snapshot_id, "snapshot_id required (G2)");
    assert.match(ans.snapshot_id, /^snap_/);
    assert.ok(
      ans.tool_calls.length >= 2,
      `tool_calls.length=${ans.tool_calls.length}`,
    );
    assert.ok(ans.tool_trace.includes("kb_retrieve"));
    assert.ok(ans.tool_trace.includes("kb_governance"));
    assert.ok(ans.hops_used >= 1);
    assert.ok(ans.text.length > 0);
    assert.equal(ans.tool_calls[0]!.ordinal, 1);
  });

  it("forces kb_governance when model skips it", async () => {
    const store = createSeededStore();
    const agent = new LlmIknowAgent({
      store,
      session: createSession("employee"),
      llm: new RetrieveThenFinalClient(),
    });
    const ans = await agent.answer("退款政策");
    assert.ok(ans.snapshot_id.startsWith("snap_"));
    assert.ok(ans.tool_trace.includes("kb_retrieve"));
    assert.ok(ans.tool_trace.includes("kb_governance"));
    assert.ok(ans.tool_calls.length >= 2);
  });

  it("parseFinalContent accepts plain text and JSON", () => {
    const plain = parseFinalContent("hello", [{ chunk_id: "c1" }]);
    assert.equal(plain.text, "hello");
    assert.equal(plain.source_spans[0]?.chunk_id, "c1");

    const json = parseFinalContent(
      JSON.stringify({
        text: "structured",
        source_spans: [{ chunk_id: "c2", quote: "q" }],
      }),
      [],
    );
    assert.equal(json.text, "structured");
    assert.equal(json.source_spans[0]?.chunk_id, "c2");
  });
});
