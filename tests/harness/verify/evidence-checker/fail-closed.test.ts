import { describe, expect, it } from "vitest";
import type { AnthropicNativeMessage } from "../../../../src/harness/model-adapter/types.js";
import {
  checkEvidence,
  shouldTriggerVerify,
} from "../../../../src/harness/verify/evidence-checker.js";
import { message, textBlock, toolResult, toolUse } from "./_fixtures.js";

/**
 * fail-closed convergence: every ambiguous / truncated / empty input sample
 * must be non-SUFFICIENT. Property-style case: no fixture in the randomly
 * malformed set (missing content / empty runs / all-null exitCode) is ever SUFFICIENT.
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
      // missing content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [{ role: "user" } as any, { role: "assistant" } as any],
      // content is not an array
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [{ role: "user", content: {} } as any],
      // tool_use without input
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [
        message("user", textBlock("task")),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "x", name: "bash" }],
        } as any,
        message("user", textBlock("done")),
      ],
      // tool_result missing (tool_use has no paired result)
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

describe("gate 畸形 message → 无可用信号 → 不开门，不抛 (SC7)", () => {
  // Every malformed shape below carries a block that WOULD trigger if the
  // malformed field were readable (a test command text in a non-string
  // command, a src path in a non-string filePath): the predicate must
  // resolve each to "no usable signal", never to a positive trigger.
  const malformedShapes: ReadonlyArray<[string, unknown[]]> = [
    ["非对象 message (null / string / number)", [null, "not-a-message", 42]],
    [
      "非数组 content",
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: "assistant", content: "npm test" } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: "assistant", content: { filePath: "src/a.ts" } } as any,
      ],
    ],
    [
      "edit_file filePath=null",
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "e1",
              name: "edit_file",
              input: { filePath: null },
            },
          ],
        } as any,
      ],
    ],
    [
      "write_file filePath 非字符串 (数字)",
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "w1",
              name: "write_file",
              input: { filePath: 123 },
            },
          ],
        } as any,
      ],
    ],
    [
      "edit_file path=null (生产键)",
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "e3",
              name: "edit_file",
              input: { path: null },
            },
          ],
        } as any,
      ],
    ],
    [
      "write_file path 非字符串 (生产键, 数字)",
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "w3",
              name: "write_file",
              input: { path: 123 },
            },
          ],
        } as any,
      ],
    ],
    [
      "edit_file input 缺失",
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "e2", name: "edit_file" }],
        } as any,
      ],
    ],
    [
      "bash input.command 缺失",
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "b1", name: "bash", input: {} }],
        } as any,
      ],
    ],
    [
      "bash input.command 非字符串 (数组里藏测试命令)",
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "b2",
              name: "bash",
              input: { command: ["npm test"] },
            },
          ],
        } as any,
      ],
    ],
    [
      "content 块非对象",
      [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { role: "assistant", content: ["npm test", null, 7] } as any,
      ],
    ],
  ];

  for (const [name, msgs] of malformedShapes) {
    it(`${name} → false 且不抛`, () => {
      let result: boolean | undefined;
      expect(() => {
        result = shouldTriggerVerify({
          messages: msgs as AnthropicNativeMessage[],
        });
      }).not.toThrow();
      expect(result).toBe(false);
    });
  }

  it("非数组 messages → false 且不抛", () => {
    let result: boolean | undefined;
    expect(() => {
      result = shouldTriggerVerify({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: "npm test" as any,
      });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it("畸形样本混一条完好信号 → 完好信号照常开门", () => {
    const msgs = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any,
      message(
        "assistant",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {
          type: "tool_use",
          id: "b1",
          name: "bash",
          input: { command: 99 },
        } as any
      ),
      message("assistant", toolUse("b2", "npm test")),
    ];
    expect(shouldTriggerVerify({ messages: msgs })).toBe(true);
  });
});
