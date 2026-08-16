import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../../src/harness/model-adapter/types.js";
import { checkEvidence } from "../../../../src/harness/verify/evidence-checker.js";

/**
 * T4 gamingSignals 软信号 (spec SC9 / A7): 断言数减少 / 新增 skip / --no-verify
 * → gamingSignals 非空且 verdict 不变 (count-based 永不指控)。数字类信号
 * (断言减少) 永不 CONTRADICTED (SC6 反向)。
 */

function toolUse(id: string, command: string): AnthropicContentBlock {
  return { type: "tool_use", id, name: "bash", input: { command } };
}

function toolResult(id: string, content: unknown): AnthropicContentBlock {
  return { type: "tool_result", tool_use_id: id, content };
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

function greenTranscript(
  tail: AnthropicContentBlock[] = []
): AnthropicNativeMessage[] {
  const id = "g1";
  return [
    message("user", textBlock("task")),
    message(
      "assistant",
      toolUse(id, "npx vitest run"),
      toolResult(
        id,
        JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
      )
    ),
    ...(tail.length ? [message("assistant", ...tail)] : []),
    message("user", textBlock("done")),
  ];
}

describe("gamingSignals 软信号只记录, verdict 不变 (SC9)", () => {
  it("git commit --no-verify → gamingSignals 非空, verdict 仍 SUFFICIENT", () => {
    const msgs = greenTranscript([
      toolUse("c1", "git commit --no-verify -m 'skip checks'"),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.gamingSignals.length).toBeGreaterThan(0);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("git commit -n → gamingSignals 非空, verdict 仍 SUFFICIENT", () => {
    const msgs = greenTranscript([toolUse("c2", "git commit -n -m 'x'")]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.gamingSignals.length).toBeGreaterThan(0);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("断言数减少的 bash (sed 删断言) → 非 CONTRADICTED, 且 verdict 不变", () => {
    const msgs = greenTranscript([
      toolUse("s1", "sed -i '/expect(/d' src/foo.test.ts"),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).not.toBe("EVIDENCE_CONTRADICTED");
    // 断言减少是软信号 (count-based), 记录但不定罪。
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("无软信号时 gamingSignals 为空", () => {
    const msgs = greenTranscript();
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.gamingSignals).toEqual([]);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });
});
