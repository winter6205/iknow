import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../../src/harness/model-adapter/types.js";
import {
  checkEvidence,
  shouldTriggerVerify,
} from "../../../../src/harness/verify/evidence-checker.js";
import {
  editFile,
  greenTranscript,
  message,
  textBlock,
  toolResult,
  toolUse,
  VITEST_GREEN,
  writeFile,
} from "./_fixtures.js";

/**
 * Three guards: weak-green shapes / failure-swallowing patterns / staleness
 * + doc-only exemption. Weak green and swallowed failures void the evidence →
 * INSUFFICIENT; a code edit inside the post-green window → stale →
 * INSUFFICIENT; doc-only edits are exempt → still SUFFICIENT.
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

  // Production-shaped {input:{path}} blocks (real ACI key): a code edit must
  // open the staleness window, and a doc-only edit must stay exempt — under
  // the old filePath-only read both shapes collapsed to "non-doc edit".
  it("生产形态 {path} 代码编辑 绿后 → stale → INSUFFICIENT", () => {
    const edit = {
      type: "tool_use",
      id: "e13",
      name: "edit_file",
      input: { path: "src/app.ts", old_str: "a", new_str: "b" },
    } as AnthropicContentBlock;
    const msgs = greenTranscript("npx vitest run", VITEST_GREEN, [
      message("assistant", edit),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.stale).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("生产形态 {path} doc-only 编辑 绿后 → 豁免 → SUFFICIENT", () => {
    const write = {
      type: "tool_use",
      id: "w11",
      name: "write_file",
      input: { path: "docs/notes.md", content: "text" },
    } as AnthropicContentBlock;
    const msgs = greenTranscript("npx vitest run", VITEST_GREEN, [
      message("assistant", write),
    ]);
    const report = checkEvidence({ messages: msgs, claimIndex: 3 });
    expect(report.stale).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });
});

describe("gate 内容信号: 测试命令 / 代码编辑开门; doc-only 三件套 = 闲聊 (SC10)", () => {
  it("bash 测试命令 (带结果) → 开门", () => {
    const msgs = greenTranscript("npm test", VITEST_GREEN);
    expect(shouldTriggerVerify({ messages: msgs })).toBe(true);
  });

  it("非 doc 源码 edit_file / write_file → 开门", () => {
    const edit = [message("assistant", editFile("e9", "src/foo.ts"))];
    const write = [message("assistant", writeFile("w9", "src/bar.ts", "x"))];
    expect(shouldTriggerVerify({ messages: edit })).toBe(true);
    expect(shouldTriggerVerify({ messages: write })).toBe(true);
  });

  // Production ACI schema key is `path` (edit-file.ts / write-file.ts
  // ALLOWED_KEYS); `filePath` is legacy-fixture only. Both must open the gate.
  it("生产形态 {path} edit_file / write_file 非 doc → 开门", () => {
    const edit = {
      type: "tool_use",
      id: "e10",
      name: "edit_file",
      input: { path: "src/foo.ts", old_str: "a", new_str: "b" },
    } as AnthropicContentBlock;
    const write = {
      type: "tool_use",
      id: "w10",
      name: "write_file",
      input: { path: "src/bar.ts", content: "x" },
    } as AnthropicContentBlock;
    expect(
      shouldTriggerVerify({ messages: [message("assistant", edit)] })
    ).toBe(true);
    expect(
      shouldTriggerVerify({ messages: [message("assistant", write)] })
    ).toBe(true);
  });

  it("生产形态 {path} doc-only → 不开门; 双键并存以 path 为准", () => {
    const doc = {
      type: "tool_use",
      id: "e11",
      name: "edit_file",
      input: { path: "README.md", old_str: "a", new_str: "b" },
    } as AnthropicContentBlock;
    expect(shouldTriggerVerify({ messages: [message("assistant", doc)] })).toBe(
      false
    );
    const both = {
      type: "tool_use",
      id: "e12",
      name: "edit_file",
      input: { path: "src/a.ts", filePath: "notes.txt" },
    } as AnthropicContentBlock;
    expect(
      shouldTriggerVerify({ messages: [message("assistant", both)] })
    ).toBe(true);
  });

  it("纯闲聊 (只有文本块) → 不开门", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("你好")),
      message("assistant", textBlock("你好，有什么可以帮你？")),
    ];
    expect(shouldTriggerVerify({ messages: msgs })).toBe(false);
  });

  // isDocOnlyPath is the SSOT: .md / .txt / docs/ — the doc-only trio is
  // treated exactly like chit-chat by the gate (criterion 10).
  for (const docPath of ["README.md", "notes.txt", "docs/x.md"]) {
    it(`doc-only ${docPath} write_file → 不开门 (= 闲聊)`, () => {
      const msgs = [message("assistant", writeFile("d1", docPath, "text"))];
      expect(shouldTriggerVerify({ messages: msgs })).toBe(false);
    });
    it(`doc-only ${docPath} edit_file → 不开门 (= 闲聊)`, () => {
      const msgs = [message("assistant", editFile("d2", docPath))];
      expect(shouldTriggerVerify({ messages: msgs })).toBe(false);
    });
  }

  it("非测试 bash (ls / git add) → 不开门", () => {
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message(
        "assistant",
        toolUse("l1", "ls -la"),
        toolResult("l1", JSON.stringify({ code: 0, stdout: "", stderr: "" }))
      ),
      message("assistant", textBlock("done")),
    ];
    expect(shouldTriggerVerify({ messages: msgs })).toBe(false);
  });
});
