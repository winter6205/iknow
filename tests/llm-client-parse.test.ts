import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLlmResponseJson } from "../src/agent-loop/llm-client.ts";

describe("parseLlmResponseJson", () => {
  it("parses plain completion JSON", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "hi", tool_calls: [] } }],
    });
    const j = parseLlmResponseJson(body) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(j.choices[0]?.message.content, "hi");
  });

  it("strips SSE data:[DONE] trailer after JSON object", () => {
    const obj = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "kb_retrieve", arguments: "{}" },
              },
            ],
          },
        },
      ],
    };
    const raw = `${JSON.stringify(obj)}\n\ndata: [DONE]\n\n`;
    const j = parseLlmResponseJson(raw) as {
      choices: Array<{ message: { tool_calls: unknown[] } }>;
    };
    assert.equal(j.choices[0]?.message.tool_calls?.length, 1);
  });

  it("parses data: line SSE payload", () => {
    const obj = { choices: [{ message: { content: "sse" } }] };
    const raw = `data: ${JSON.stringify(obj)}\n\ndata: [DONE]\n`;
    const j = parseLlmResponseJson(raw) as {
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(j.choices[0]?.message.content, "sse");
  });

  it("throws on empty body", () => {
    assert.throws(() => parseLlmResponseJson("   "), /empty/);
  });
});
