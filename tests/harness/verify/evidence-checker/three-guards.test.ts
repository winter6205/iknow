import { describe, expect, it } from "vitest";
import type { AnthropicNativeMessage } from "../../../../src/harness/model-adapter/types.js";
import { checkEvidence } from "../../../../src/harness/verify/evidence-checker.js";
import {
  editFile,
  greenTranscript,
  message,
  VITEST_GREEN,
  writeFile,
} from "./_fixtures.js";

/**
 * T3 三防 (spec SC5): 弱绿四形态 / 吞失败四 pattern / 时效 + doc-only 豁免。
 * 弱绿与吞失败 → 证据作废 → INSUFFICIENT; 时效窗口内代码编辑 → stale →
 * INSUFFICIENT; doc-only 编辑豁免 → 仍 SUFFICIENT。
 */

describe("弱绿四形态 → 非 SUFFICIENT (A6)", () => {
  it("0 tests run → INSUFFICIENT", () => {
    const msgs = greenTranscript("npx vitest run", "0 tests run\n");
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].weakGreen).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("collected 0 items → INSUFFICIENT", () => {
    const msgs = greenTranscript("pytest", "collected 0 items\n");
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].weakGreen).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("no tests found → INSUFFICIENT", () => {
    const msgs = greenTranscript("npx vitest run", "No test files found\n");
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].weakGreen).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("-k / -t 窄跑 → INSUFFICIENT", () => {
    const msgs = greenTranscript("npx vitest run -t login", VITEST_GREEN);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].weakGreen).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it(":: 精确路径窄跑 → INSUFFICIENT", () => {
    const msgs = greenTranscript(
      "npx vitest run tests/a.test.ts::case1",
      VITEST_GREEN
    );
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].weakGreen).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });
});

describe("吞失败四 pattern → 证据作废 → INSUFFICIENT (A7 硬信号)", () => {
  it("|| true", () => {
    const msgs = greenTranscript("npm test || true", VITEST_GREEN);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].swallowed).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("|| exit 0", () => {
    const msgs = greenTranscript("npm test || exit 0", VITEST_GREEN);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].swallowed).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("; exit 0", () => {
    const msgs = greenTranscript("npm test; exit 0", VITEST_GREEN);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].swallowed).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("--passWithNoTests", () => {
    const msgs = greenTranscript(
      "npx jest --passWithNoTests",
      "Tests:       0 passed, 0 total\n"
    );
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].swallowed).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });
});

describe("时效 (A6) — 绿后代码编辑 → stale → INSUFFICIENT; doc-only 豁免", () => {
  it("绿测试后 edit_file 代码文件 → stale → INSUFFICIENT", () => {
    const msgs = greenTranscript("npx vitest run", VITEST_GREEN, [
      message("assistant", editFile("e1", "src/foo.ts")),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.runs[0].greenSummary).toBe(true);
    expect(report.stale).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("绿测试后 write_file 代码文件 → stale → INSUFFICIENT", () => {
    const msgs = greenTranscript("npx vitest run", VITEST_GREEN, [
      message("assistant", writeFile("w1", "src/bar.ts", "code")),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.stale).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("doc-only 编辑 (.md) 豁免 → 仍 SUFFICIENT", () => {
    const msgs = greenTranscript("npx vitest run", VITEST_GREEN, [
      message("assistant", editFile("e2", "docs/readme.md")),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.stale).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("doc-only 编辑 (.txt) 豁免 → 仍 SUFFICIENT", () => {
    const msgs = greenTranscript("npx vitest run", VITEST_GREEN, [
      message("assistant", writeFile("w2", "notes.txt", "notes")),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.stale).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("绿后无编辑 → stale false → SUFFICIENT", () => {
    const msgs = greenTranscript("npx vitest run", VITEST_GREEN);
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.stale).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });
});
