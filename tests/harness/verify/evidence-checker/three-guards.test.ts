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

  // `::` is a selector only when glued to an argument token (the pytest
  // `file.py::Class::test` shape); a spaced `::` sits in prose / a trailing
  // comment and selects nothing, so it must not read as a narrow run.
  it("注释里空格包围的 :: 不在参数位 → 不算窄跑 → SUFFICIENT", () => {
    const msgs = greenTranscript(
      "npx vitest run --silent  # full suite, see docs :: all",
      VITEST_GREEN
    );
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].weakGreen).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
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

  it("遗留键 {filePath} 仍被读取: 代码编辑 绿后 → stale; doc-only → 豁免", () => {
    const legacyCodeEdit = {
      type: "tool_use",
      id: "e14",
      name: "edit_file",
      input: { filePath: "src/legacy.ts" },
    } as AnthropicContentBlock;
    const codeReport = checkEvidence({
      messages: greenTranscript("npx vitest run", VITEST_GREEN, [
        message("assistant", legacyCodeEdit),
      ]),
      claimIndex: 3,
    });
    expect(codeReport.stale).toBe(true);
    expect(codeReport.verdict).toBe("EVIDENCE_INSUFFICIENT");

    const legacyDocEdit = {
      type: "tool_use",
      id: "w12",
      name: "write_file",
      input: { filePath: "docs/legacy.md", content: "text" },
    } as AnthropicContentBlock;
    const docReport = checkEvidence({
      messages: greenTranscript("npx vitest run", VITEST_GREEN, [
        message("assistant", legacyDocEdit),
      ]),
      claimIndex: 3,
    });
    expect(docReport.stale).toBe(false);
    expect(docReport.verdict).toBe("EVIDENCE_SUFFICIENT");
  });
});

/**
 * Staleness is ordered by (message, content-block) pairs — the session's own
 * tool-call order — because a single assistant message can carry the green
 * bash and the edit as siblings, or a claim text block and an edit together.
 * Message-granular edges made both invisible.
 */
describe("时效按 tool_use BLOCK 粒度 (兄弟块 / claim 消息内编辑)", () => {
  /** Green bash pair + sibling edit_file in ONE assistant message. */
  function greenWithSiblingEdit(
    edit: AnthropicContentBlock
  ): AnthropicNativeMessage[] {
    const id = "b01";
    return [
      message("user", textBlock("task")),
      message(
        "assistant",
        toolUse(id, "npx vitest run"),
        toolResult(
          id,
          JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
        ),
        edit
      ),
      message("user", textBlock("done")),
    ];
  }

  it("绿 bash 的同消息兄弟 edit_file (代码) → stale → INSUFFICIENT", () => {
    const msgs = greenWithSiblingEdit(editFile("e20", "src/foo.ts"));
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].greenSummary).toBe(true);
    expect(report.runs[0].contentBlockIndex).toBe(0);
    expect(report.stale).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("绿 bash 的同消息兄弟 write_file (代码) → stale → INSUFFICIENT", () => {
    const msgs = greenWithSiblingEdit(writeFile("w20", "src/bar.ts", "code"));
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.stale).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("绿 bash 的同消息兄弟 .md 编辑 → doc 豁免仍成立 → SUFFICIENT", () => {
    const msgs = greenWithSiblingEdit(editFile("e21", "docs/readme.md"));
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.stale).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("claim 消息内、claim 文本块之后的 edit_file → stale → INSUFFICIENT", () => {
    const id = "b02";
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message(
        "assistant",
        toolUse(id, "npx vitest run"),
        toolResult(
          id,
          JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
        )
      ),
      message(
        "assistant",
        textBlock("全部测试通过"),
        editFile("e22", "src/foo.ts")
      ),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].greenSummary).toBe(true);
    expect(report.stale).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("claim 消息内、claim 文本块之前的 edit_file → 同样作废 → stale → INSUFFICIENT", () => {
    const id = "b03";
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message(
        "assistant",
        toolUse(id, "npx vitest run"),
        toolResult(
          id,
          JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
        )
      ),
      message(
        "assistant",
        editFile("e23", "src/foo.ts"),
        textBlock("全部测试通过")
      ),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.stale).toBe(true);
    expect(report.verdict).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("绿 bash 之前的同消息 edit_file (块序在前) → 不是绿后编辑 → SUFFICIENT", () => {
    const id = "b04";
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message(
        "assistant",
        editFile("e24", "src/foo.ts"),
        toolUse(id, "npx vitest run"),
        toolResult(
          id,
          JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
        )
      ),
      message("user", textBlock("done")),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 2 });
    expect(report.runs[0].contentBlockIndex).toBe(1);
    expect(report.stale).toBe(false);
    expect(report.verdict).toBe("EVIDENCE_SUFFICIENT");
  });

  it("绿 bash 与 claim 文本同处一条消息 (bash 块在 claim 块之前) → 计入证据 → SUFFICIENT", () => {
    const id = "b05";
    const msgs: AnthropicNativeMessage[] = [
      message("user", textBlock("task")),
      message(
        "assistant",
        toolUse(id, "npx vitest run"),
        textBlock("全部测试通过"),
        toolResult(
          id,
          JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" })
        )
      ),
    ];
    const report = checkEvidence({ messages: msgs, claimIndex: 1 });
    expect(report.runs.length).toBe(1);
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
