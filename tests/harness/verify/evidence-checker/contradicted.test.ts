import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../../src/harness/model-adapter/types.js";
import { checkEvidence } from "../../../../src/harness/verify/evidence-checker.js";
import {
  greenRun,
  message,
  textBlock,
  toolUse,
  writeFile,
} from "./_fixtures.js";

/**
 * CONTRADICTED: emptying/deleting test files after green → CONTRADICTED.
 * Numeric signals (fewer assertions) never CONTRADICTED — that counter-case
 * lives in gaming-soft.test.ts.
 */

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

  // Production ACI schema key is `path` (write-file.ts ALLOWED_KEYS); a
  // {path}-key blanking of a test file is the real tool-call form and must
  // reach the CONTRADICTED hard veto, not slip through on the legacy read.
  it("生产形态 {path} write_file 清空测试文件 → CONTRADICTED", () => {
    const write = {
      type: "tool_use",
      id: "w6",
      name: "write_file",
      input: { path: "src/foo.test.ts", content: "" },
    } as AnthropicContentBlock;
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", ...greenRun("g1")),
      message("assistant", write),
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

  it("rm -rf node_modules/vitest (含子串 test 但非测试文件) → 非 CONTRADICTED", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", ...greenRun("g1")),
      message("assistant", toolUse("r4", "rm -rf node_modules/vitest")),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).not.toBe("EVIDENCE_CONTRADICTED");
  });

  it("rm -f /tmp/test-cache/ (测试缓存非测试文件) → 非 CONTRADICTED", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message("assistant", ...greenRun("g1")),
      message("assistant", toolUse("r5", "rm -f /tmp/test-cache/")),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.verdict).not.toBe("EVIDENCE_CONTRADICTED");
  });
});
