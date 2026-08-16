import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../../src/harness/model-adapter/types.js";
import { checkEvidence } from "../../../../src/harness/verify/evidence-checker.js";
import { message, textBlock, toolResult, toolUse } from "./_fixtures.js";

/**
 * T2 exit code 双路解析 + fail-closed (spec SC4 / A9)。
 *
 * 双路解析 (bash.ts:79-83 → executor.ts:46 文本契约):
 *   - 结构化 JSON {code, stdout, stderr} → exitCode = code;
 *   - 非 JSON 文本 ^Exit code (\d+) 正则回退 → code;
 *   - is_error: true + [execution_failed] 前缀 → null。
 * fail-closed (A8): 空输入 / 无 bash / 畸形 shape 全不 crash → INSUFFICIENT。
 */

/** 单条 bash run + tool_result 的完整 transcript 骨架。 */
function transcript(blocks: AnthropicContentBlock[]): AnthropicNativeMessage[] {
  return [
    message("user", textBlock("task")),
    message("assistant", ...blocks),
    message("user", textBlock("done")),
  ];
}

describe("exit code 双路解析", () => {
  it("结构化 JSON {code, stdout, stderr} → exitCode = code", () => {
    const id = "t01";
    const msgs = transcript([
      toolUse(id, "npm test"),
      toolResult(id, JSON.stringify({ code: 0, stdout: "ok", stderr: "" })),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].exitCode).toBe(0);
  });

  it("非 JSON 文本 ^Exit code (\\d+) 正则回退 → code", () => {
    const id = "t02";
    const msgs = transcript([
      toolUse(id, "npm test"),
      toolResult(id, "some output\nExit code 1\nmore"),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].exitCode).toBe(1);
  });

  it("is_error: true + [execution_failed] 前缀 → exitCode = null", () => {
    const id = "t03";
    const msgs = transcript([
      toolUse(id, "npm test"),
      toolResult(id, "[execution_failed] sandbox rejected", true),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].exitCode).toBeNull();
  });

  it("tool_result content 为 block[] 形状 (content: unknown) 也能解析", () => {
    const id = "t04";
    const msgs = transcript([
      toolUse(id, "npm test"),
      toolResult(id, [
        textBlock(JSON.stringify({ code: 0, stdout: "", stderr: "" })),
      ]),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].exitCode).toBe(0);
  });
});

describe("fail-closed 空输入 / 畸形 (T2 骨架 greenSummary 恒 false)", () => {
  it("messages 空 → INSUFFICIENT", () => {
    const report = checkEvidence({ messages: [], claimIndex: 1 });
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
    expect(report.reasons.length).toBeGreaterThan(0);
  });

  it("claimIndex = 0 → INSUFFICIENT", () => {
    const msgs = transcript([toolUse("t", "npm test"), toolResult("t", "{}")]);
    const report = checkEvidence({ messages: msgs, claimIndex: 0 });
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("无任何 bash tool_use → INSUFFICIENT", () => {
    const msgs = [
      message("user", textBlock("task")),
      message("assistant", textBlock("done, no tools used")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 1 });
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("tool_result 非 JSON 且无 Exit code 行 → exitCode null → INSUFFICIENT", () => {
    const id = "t05";
    const msgs = transcript([
      toolUse(id, "npm test"),
      toolResult(id, "random text without exit code"),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].exitCode).toBeNull();
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("畸形 message shape (缺 content) → 不 crash → INSUFFICIENT", () => {
    const msgs = [
      { role: "user", content: [] } as AnthropicNativeMessage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { role: "assistant", content: null } as any,
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 1 });
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("checkEvidence 导出、返回 EvidenceReport 契约形状", () => {
    const report = checkEvidence({ messages: [], claimIndex: 1 });
    expect(report).toEqual(
      expect.objectContaining({
        verdict: expect.any(String),
        reasons: expect.any(Array),
        runs: expect.any(Array),
        gamingSignals: expect.any(Array),
        stale: expect.any(Boolean),
      })
    );
  });
});
