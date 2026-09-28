import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../../src/harness/model-adapter/types.js";
import { checkEvidence } from "../../../../src/harness/verify/evidence-checker.js";
import {
  message,
  textBlock,
  toolResult,
  toolUse,
  VITEST_GREEN,
} from "./_fixtures.js";

/**
 * Exit-code dual-path parsing + fail-closed.
 *
 * Dual-path parsing (the text contract produced by the bash executor):
 *   - structured JSON {code, stdout, stderr} → exitCode = code;
 *   - non-JSON text: ^Exit code (\d+) regex fallback → code;
 *   - is_error: true with the `[execution_failed]` prefix → null.
 * fail-closed: empty input / no bash / malformed shapes never crash → INSUFFICIENT.
 */

/** Skeleton transcript: one bash run (tool_use + tool_result) between task and done. */
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

describe("pipeline-tail 掩码 → swallowed → INSUFFICIENT, 永不为 SUFFICIENT (SC11)", () => {
  // `| tail` / `| head`: the sandbox runs bare `bash -c` with no
  // `set -o pipefail`, so {code: 0} is the tail's exit code, not the runner's.
  // Evidence condition 4 (not swallowed) widens to void the masked run. The
  // vitest-runner form below is the shape that used to read SUFFICIENT
  // (exit 0 + green line + not weak), so the voiding is what fails the case.
  for (const tail of ["tail -5", "head -5"]) {
    it(`npx vitest run 2>&1 | ${tail} + code 0 + 绿行 → swallowed → INSUFFICIENT`, () => {
      const id = `p-${tail.replace(/[^a-z]/g, "")}`;
      const msgs = transcript([
        toolUse(id, `npx vitest run 2>&1 | ${tail}`),
        toolResult(
          id,
          JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
        ),
      ]);
      const report = checkEvidence({ messages: msgs, claimIndex: 2 });
      expect(report.runs).toHaveLength(1);
      expect(report.runs[0].greenSummary).toBe(true);
      expect(report.runs[0].exitCode).toBe(0);
      expect(report.runs[0].swallowed).toBe(true);
      expect(report.verdict).not.toBe("EVIDENCE_SUFFICIENT");
      expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
    });
  }

  it("spec 原样命令 npm test 2>&1 | tail -5 → swallowed = true", () => {
    const msgs = transcript([
      toolUse("p-npm", "npm test 2>&1 | tail -5"),
      toolResult(
        "p-npm",
        JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
      ),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].swallowed).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("管道尾部空格变体 (npx vitest run |tail -1) 同样作废", () => {
    const msgs = transcript([
      toolUse("p-sp", "npx vitest run |tail -1"),
      toolResult(
        "p-sp",
        JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
      ),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].swallowed).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("非掩码管道 (| cat) 不吞 — 其余证据条件不变 → SUFFICIENT", () => {
    const msgs = transcript([
      toolUse("p-cat", "npx vitest run 2>&1 | cat"),
      toolResult(
        "p-cat",
        JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
      ),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].swallowed).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });
});
