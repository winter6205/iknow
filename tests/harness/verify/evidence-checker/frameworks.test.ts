import { describe, expect, it } from "vitest";
import type { AnthropicNativeMessage } from "../../../../src/harness/model-adapter/types.js";
import { checkEvidence } from "../../../../src/harness/verify/evidence-checker.js";
import {
  greenTranscript,
  message,
  textBlock,
  toolResult,
  toolUse,
} from "./_fixtures.js";

/**
 * Green markers for the five frameworks: one run each with "exit 0 + green
 * summary + no edits" → SUFFICIENT (a single qualifying run is enough).
 * Counts are read only from the framework's own summary line.
 */

describe("五框架 green marker → SUFFICIENT (exit 0 + green 摘要 + 无编辑)", () => {
  it("pytest: count+duration 双子句摘要行", () => {
    const msgs = greenTranscript(
      "pytest tests/",
      "collecting...\n===== 12 passed in 0.42s =====\n"
    );
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].framework).toBe("pytest");
    expect(report.runs[0].exitCode).toBe(0);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("jest: Tests: N passed 摘要行", () => {
    const msgs = greenTranscript(
      "npx jest",
      "Tests:       14 passed, 14 total\n"
    );
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].framework).toBe("jest");
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("vitest: Tests N passed 摘要行", () => {
    const msgs = greenTranscript("npx vitest run", " ✓ Tests  5 passed (5)\n");
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].framework).toBe("vitest");
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("go test: ok <pkg> 行", () => {
    const msgs = greenTranscript(
      "go test ./...",
      "ok  \texample.com/proj/pkg\t0.023s\n"
    );
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].framework).toBe("go");
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("cargo: test result: ok 行", () => {
    const msgs = greenTranscript(
      "cargo test",
      "test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n"
    );
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].framework).toBe("cargo");
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("恰好一条合格证据 + 多条不合格 → SUFFICIENT (G2-4 阈值正反)", () => {
    const id1 = "a1";
    const id2 = "a2";
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message(
        "assistant",
        toolUse(id1, "npx vitest run --no-inline"),
        toolResult(id1, JSON.stringify({ code: 1, stdout: "FAIL", stderr: "" }))
      ),
      message(
        "assistant",
        toolUse(id2, "npx vitest run"),
        toolResult(
          id2,
          JSON.stringify({
            code: 0,
            stdout: " ✓ Tests  3 passed (3)\n",
            stderr: "",
          })
        )
      ),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0].exitCode).toBe(1);
    expect(report.runs[1].exitCode).toBe(0);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });
});
