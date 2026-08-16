import { describe, expect, it } from "vitest";
import type { AnthropicNativeMessage } from "../../../../src/harness/model-adapter/types.js";
import { checkEvidence } from "../../../../src/harness/verify/evidence-checker.js";
import { message, textBlock, toolResult, toolUse } from "./_fixtures.js";

/**
 * T4 fail-closed 收口 (spec SC7 / A8): 歧义 / 残缺 / 空输入样本集全部
 * 非 SUFFICIENT。属性式用例: 随机残缺 fixture 集 (缺 content / 空 runs /
 * 全 null exitCode) 任一永不 SUFFICIENT。
 */

describe("fail-closed 歧义 / 残缺 / 空输入 → 非 SUFFICIENT (A8)", () => {
  it("claimIndex = 0 → INSUFFICIENT", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message(
        "assistant",
        toolUse("t", "npx vitest run"),
        toolResult(
          "t",
          JSON.stringify({
            code: 0,
            stdout: " ✓ Tests  3 passed (3)\n",
            stderr: "",
          })
        )
      ),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 0 });
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("畸形 message (缺 content) → 不 crash → INSUFFICIENT", () => {
    const msgs = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: "user", content: null } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: "assistant" } as any,
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 1 });
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("畸形 content 块 (非对象) → 不 crash → INSUFFICIENT", () => {
    const msgs = [
      message("user", textBlock("task")),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: "assistant", content: ["not-a-block"] } as any,
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("空 runs (仅非测试 bash) → INSUFFICIENT", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message(
        "assistant",
        toolUse("l1", "ls -la"),
        toolResult(
          "l1",
          JSON.stringify({ code: 0, stdout: "files", stderr: "" })
        )
      ),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs).toHaveLength(0);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("全 null exitCode (无 code / is_error) → INSUFFICIENT", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message(
        "assistant",
        toolUse("e1", "npx vitest run"),
        toolResult(
          "e1",
          JSON.stringify({ stdout: "no code field", stderr: "" })
        )
      ),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].exitCode).toBeNull();
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("属性式: 随机残缺 fixture 集任一永不 SUFFICIENT", () => {
    const malformedFixtures: AnthropicNativeMessage[][] = [
      // 缺 content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [{ role: "user" } as any, { role: "assistant" } as any],
      // content 非数组
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [{ role: "user", content: {} } as any],
      // tool_use 缺 input
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [
        message("user", textBlock("task")),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "x", name: "bash" }],
        } as any,
        message("user", textBlock("done")),
      ],
      // tool_result 缺失 (tool_use 无配对 result)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [
        message("user", textBlock("task")),
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "y",
              name: "bash",
              input: { command: "npx vitest run" },
            },
          ],
        } as any,
        message("user", textBlock("done")),
      ],
    ];
    for (const msgs of malformedFixtures) {
      const report = checkEvidence({ messages: msgs, claimIndex: 1 });
      expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
    }
  });
});
