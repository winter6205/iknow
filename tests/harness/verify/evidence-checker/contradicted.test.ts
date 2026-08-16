import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../../src/harness/model-adapter/types.js";
import { checkEvidence } from "../../../../src/harness/verify/evidence-checker.js";

/**
 * T4 CONTRADICTED (spec SC6): 清空/删除测试文件 → CONTRADICTED; 数字类信号
 * (断言减少) 永不 CONTRADICTED (反向断言, 落 gaming-soft.test.ts)。
 */

function toolUse(id: string, command: string): AnthropicContentBlock {
  return { type: "tool_use", id, name: "bash", input: { command } };
}

function toolResult(id: string, content: unknown): AnthropicContentBlock {
  return { type: "tool_result", tool_use_id: id, content };
}

function writeFile(
  id: string,
  filePath: string,
  content: unknown
): AnthropicContentBlock {
  return {
    type: "tool_use",
    id,
    name: "write_file",
    input: { filePath, content },
  };
}

function textBlock(text: string): AnthropicContentBlock {
  return { type: "text", text };
}

function message(
  role: "user" | "assistant",
  ...blocks: AnthropicContentBlock[]
): AnthropicNativeMessage {
  return { role, content: blocks };
}

const VITEST_GREEN = " ✓ Tests  3 passed (3)\n";

function greenRun(id: string): AnthropicContentBlock[] {
  return [
    toolUse(id, "npx vitest run"),
    toolResult(
      id,
      JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
    ),
  ];
}

describe("CONTRADICTED — write_file 清空测试文件 / bash rm 测试文件", () => {
  it("write_file 清空测试文件 (内容空串) → CONTRADICTED", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", ...greenRun("g1")),
      message("assistant", writeFile("w1", "src/foo.test.ts", "")),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).toBe("EVIDENCE_CONTRADICTED");
    expect(report.reasons.length).toBeGreaterThan(0);
  });

  it("write_file 清空测试文件 (空数组内容) → CONTRADICTED", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", ...greenRun("g1")),
      message("assistant", writeFile("w2", "tests/api.test.ts", [])),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).toBe("EVIDENCE_CONTRADICTED");
  });

  it("bash rm 测试文件 → CONTRADICTED", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", ...greenRun("g1")),
      message("assistant", toolUse("r1", "rm -f src/foo.test.ts")),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).toBe("EVIDENCE_CONTRADICTED");
  });

  it("bash rm 测试目录 → CONTRADICTED", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", ...greenRun("g1")),
      message("assistant", toolUse("r2", "rm -rf tests/")),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).toBe("EVIDENCE_CONTRADICTED");
  });

  it("非空 write_file (正常补测试) → 非 CONTRADICTED", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", ...greenRun("g1")),
      message(
        "assistant",
        writeFile("w3", "src/foo.test.ts", "import { expect } from 'vitest';\n")
      ),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).not.toBe("EVIDENCE_CONTRADICTED");
  });

  it("rm 非测试文件 (rm build artifact) → 非 CONTRADICTED", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", ...greenRun("g1")),
      message("assistant", toolUse("r3", "rm -f dist/bundle.js")),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).not.toBe("EVIDENCE_CONTRADICTED");
  });
});
