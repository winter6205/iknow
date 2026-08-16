import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../../src/harness/model-adapter/types.js";
import { checkEvidence } from "../../../../src/harness/verify/evidence-checker.js";
import {
  greenTranscript,
  message,
  textBlock,
  toolResult,
  toolUse,
  VITEST_GREEN,
} from "./_fixtures.js";

/**
 * T4 gamingSignals 软信号 (spec SC9 / A7): 断言数减少 / 新增 skip / --no-verify
 * → gamingSignals 非空且 verdict 不变 (count-based 永不指控)。数字类信号
 * (断言减少) 永不 CONTRADICTED (SC6 反向)。
 */

function greenWithTail(
  tail: AnthropicContentBlock[]
): AnthropicNativeMessage[] {
  return [
    message("user", textBlock("task")),
    message(
      "assistant",
      toolUse("g1", "npx vitest run"),
      toolResult(
        "g1",
        JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
      )
    ),
    ...(tail.length ? [message("assistant", ...tail)] : []),
    message("user", textBlock("done")),
  ];
}

describe("gamingSignals 软信号只记录, verdict 不变 (SC9)", () => {
  it("git commit --no-verify → gamingSignals 非空, verdict 仍 SUFFICIENT", () => {
    const msgs = greenWithTail([
      toolUse("c1", "git commit --no-verify -m 'skip checks'"),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.gamingSignals.length).toBeGreaterThan(0);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("git commit -n → gamingSignals 非空, verdict 仍 SUFFICIENT", () => {
    const msgs = greenWithTail([toolUse("c2", "git commit -n -m 'x'")]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.gamingSignals.length).toBeGreaterThan(0);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("断言数减少的 bash (sed 删断言) → 非 CONTRADICTED, 且 verdict 不变", () => {
    const msgs = greenWithTail([
      toolUse("s1", "sed -i '/expect(/d' src/foo.test.ts"),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).not.toBe("EVIDENCE_CONTRADICTED");
    // 断言减少是软信号 (count-based), 记录但不定罪。
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("新增 skip 装饰器到测试文件 → gamingSignals 非空, verdict 不变", () => {
    // 编辑发生在绿证据前 (claimIndex 之前, 非绿后窗口) → 不触发 stale,
    // 只验证 skip 软信号记录且 verdict 仍 SUFFICIENT。
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", {
        type: "tool_use",
        id: "w1",
        name: "edit_file",
        input: { filePath: "src/foo.test.ts", content: "it.skip('x', ...)" },
      } as AnthropicContentBlock),
      message(
        "assistant",
        toolUse("g1", "npx vitest run"),
        toolResult(
          "g1",
          JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
        )
      ),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.gamingSignals.length).toBeGreaterThan(0);
    expect(report.stale).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("新增 pytest.mark.skip → gamingSignals 非空, verdict 不变", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", {
        type: "tool_use",
        id: "w2",
        name: "write_file",
        input: {
          filePath: "tests/test_foo.py",
          content: "@pytest.mark.skip\n",
        },
      } as AnthropicContentBlock),
      message(
        "assistant",
        toolUse("g1", "npx vitest run"),
        toolResult(
          "g1",
          JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
        )
      ),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.gamingSignals.length).toBeGreaterThan(0);
    expect(report.stale).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("无软信号时 gamingSignals 为空", () => {
    const msgs = greenWithTail([]);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.gamingSignals).toEqual([]);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });
});
