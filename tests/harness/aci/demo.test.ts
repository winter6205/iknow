/**
 /**
 * ACI Layer 2：端到端测试。
 *
 * 经 run() + createAciExecutor 端到端验证：
 *   (a) read-only 场景 stopReason=completed；
 *   (b) 危险命令 deny 路径产生 is_error 的 tool_result；
 *   (c) edit_file 坏补丁被拒（文件内容未变）后正确补丁成功。
 *
 * #141 工具层重写：用 6 工具集（bash / read_file / glob / grep / edit_file /
 * write_file），与 demo.ts 装配同步。
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../../../src/harness/loop-engine.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";

import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../../src/harness/model-adapter/types.ts";

import { createAciRegistry } from "../../../src/harness/aci/aci-registry.ts";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createReadFileTool } from "../../../src/harness/aci/tools/read-file.ts";
import { createGlobTool } from "../../../src/harness/aci/tools/glob.ts";
import { createGrepTool } from "../../../src/harness/aci/tools/grep.ts";
import { createEditFileTool } from "../../../src/harness/aci/tools/edit-file.ts";
import { createWriteFileTool } from "../../../src/harness/aci/tools/write-file.ts";

/* ── helper: 构造 AssistantTurnResult（与 demo.ts 同一形状）── */

interface AssistantResultOpts {
  readonly texts: string[];
  readonly toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  readonly supplierStop?: "success" | "truncation" | "refusal" | "other";
}

function assistantResult(opts: AssistantResultOpts): AssistantTurnResult {
  const texts = opts.texts;
  const toolCalls = opts.toolCalls ?? [];
  const supplierStop = opts.supplierStop ?? "success";
  const blocks: AnthropicContentBlock[] = [];
  for (const t of texts) blocks.push({ type: "text", text: t });
  for (const c of toolCalls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  const native: AnthropicNativeMessage = { role: "assistant", content: blocks };
  return {
    nativeMessage: native,
    projection: { nativeMessage: native, texts, toolCalls },
    supplierStop,
    needsTools: toolCalls.length > 0,
    isEmptyFinalResponse:
      supplierStop === "success" &&
      texts.length === 0 &&
      toolCalls.length === 0,
  };
}

/* ── helper: 装配 registry + 装饰执行器 ── */

function assemble(scratchDir: string): {
  reg: ReturnType<typeof createAciRegistry>;
  exec: ReturnType<typeof createAciExecutor>;
} {
  const reg = createAciRegistry([
    createBashTool(scratchDir),
    createReadFileTool(scratchDir),
    createGlobTool(scratchDir),
    createGrepTool(scratchDir),
    createEditFileTool(scratchDir),
    createWriteFileTool(scratchDir),
  ]);
  const innerExec = createExecutor(reg.inner);
  const exec = createAciExecutor({ inner: innerExec, catalog: reg.catalog });
  return { reg, exec };
}

/* ── helper: 在 messages 中按 tool_use_id 查找 tool_result ── */

function findToolResult(opts: {
  messages: ReadonlyArray<AnthropicNativeMessage>;
  toolUseId: string;
}): Extract<AnthropicContentBlock, { type: "tool_result" }> | undefined {
  for (const m of opts.messages) {
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === opts.toolUseId) {
        return b;
      }
    }
  }
  return undefined;
}

/* ── helper: 提取 tool_result 的首个 text 块 ── */

function toolResultText(
  result: Extract<AnthropicContentBlock, { type: "tool_result" }>
): string {
  return (result.content as Array<{ text?: string }>)[0]?.text ?? "";
}

/* ── scratch 生命周期 ── */

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-aci-demo-test-"));
  // 基础样例文件（足够覆盖三条断言所需）
  writeFileSync(join(scratch, "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(scratch, "beta.ts"), "export const beta = 2;\n");
  writeFileSync(join(scratch, "edit-me.ts"), "const x = 1;\nconsole.log(x);\n");
  const bigLines = Array.from(
    { length: 250 },
    (_, i) => `line ${String(i + 1)}`
  );
  writeFileSync(join(scratch, "big-file.txt"), bigLines.join("\n"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/* ── 测试 ── */

describe("demo 端到端 — 经 run() + createAciExecutor", () => {
  it("(a) read-only 场景 stopReason=completed", async () => {
    // 工作流对齐 ADR-0004：glob 发现 + read_file 精读（无状态、显式 offset）。
    const { reg, exec } = assemble(scratch);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "a-glob",
              name: "glob",
              input: { pattern: "*.ts" },
            },
            {
              id: "a-read-1",
              name: "read_file",
              // 续读必须显式 offset=50（契约 Y1 read_file 无状态）
              input: { path: "big-file.txt", offset: 0, limit: 50 },
            },
          ],
        }),
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "a-read-2",
              name: "read_file",
              input: { path: "big-file.txt", offset: 50, limit: 50 },
            },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("test-a", {
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 3);

    // glob 返回字母序相对路径，含 alpha.ts / beta.ts / edit-me.ts
    const globResult = findToolResult({
      messages: result.messages,
      toolUseId: "a-glob",
    });
    assert.ok(globResult);
    assert.equal(globResult.is_error, undefined);
    const globText = toolResultText(globResult);
    assert.ok(globText.includes("alpha.ts"));
    assert.ok(globText.includes("beta.ts"));

    // read_file 第 1 次：offset=0，返回行号格式 `<n>.padStart(6)\t<line>`
    const read1 = findToolResult({
      messages: result.messages,
      toolUseId: "a-read-1",
    });
    assert.ok(read1);
    const read1Text = toolResultText(read1);
    assert.ok(
      read1Text.startsWith("     1\t"),
      "expected 1-indexed line numbers"
    );
    assert.ok(read1Text.includes("line 1"));
    assert.ok(read1Text.includes("line 50"));

    // read_file 第 2 次：offset=50，承接上下文，line 51 开始
    const read2 = findToolResult({
      messages: result.messages,
      toolUseId: "a-read-2",
    });
    assert.ok(read2);
    const read2Text = toolResultText(read2);
    assert.ok(read2Text.startsWith("    51\t"));
    assert.ok(read2Text.includes("line 51"));
  });

  it("(b) 危险命令 deny -> is_error tool_result", async () => {
    const { reg, exec } = assemble(scratch);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "b-danger",
              name: "bash",
              input: { command: "rm -rf /" },
            },
          ],
        }),
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "b-safe",
              name: "bash",
              input: { command: "echo hello" },
            },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("test-b", {
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });

    // deny 路径产生 is_error tool_result
    // bash 工具内 throw ToolExecutionError，executor 用 [execution_failed] 信封。
    const dangerResult = findToolResult({
      messages: result.messages,
      toolUseId: "b-danger",
    });
    assert.ok(dangerResult, "expected tool_result for b-danger");
    assert.equal(dangerResult.is_error, true);
    const dangerText = toolResultText(dangerResult);
    // v0 graduated: hard-wall fires on the dangerous pattern; reason carries
    // [hard_wall] marker (the executor wrapper attaches [permission_denied]
    // and [execution_failed] prefixes).
    assert.ok(
      dangerText.includes("[hard_wall]") ||
        dangerText.includes("not in allowlist") ||
        dangerText.includes("dangerous command"),
      `expected hard-wall or allowlist denial, got: ${dangerText}`
    );

    // 安全命令成功（is_error 未设置）
    const safeResult = findToolResult({
      messages: result.messages,
      toolUseId: "b-safe",
    });
    assert.ok(safeResult);
    assert.equal(safeResult.is_error, undefined);
    const safeText = toolResultText(safeResult);
    // bash 输出结构化 {code, stdout, stderr}（Y1b 保结构化）
    assert.ok(
      safeText.includes("hello"),
      `expected safe command output, got: ${safeText}`
    );

    assert.equal(result.stopReason, "completed");
  });

  it("(c) edit_file 坏补丁被拒（文件不变）+ 正确补丁成功", async () => {
    const { reg, exec } = assemble(scratch);
    const filePath = join(scratch, "edit-me.ts");
    const before = readFileSync(filePath, "utf8");

    const model = createStubModel({
      responses: [
        // 坏补丁：括号不配对 -> lint rejected
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "c-bad",
              name: "edit_file",
              input: {
                path: "edit-me.ts",
                old_str: "const x = 1;",
                new_str: "const x = foo(1;",
              },
            },
          ],
        }),
        // 正确补丁
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "c-good",
              name: "edit_file",
              input: {
                path: "edit-me.ts",
                old_str: "const x = 1;",
                new_str: "const x = foo(1);",
              },
            },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("test-c", {
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });

    // 坏补丁被拒（is_error=true，message 含 lint rejected）
    const badResult = findToolResult({
      messages: result.messages,
      toolUseId: "c-bad",
    });
    assert.ok(badResult, "expected tool_result for c-bad");
    assert.equal(badResult.is_error, true);
    const badText = toolResultText(badResult);
    assert.ok(badText.includes("lint rejected"));

    // 坏补丁期间文件内容未变（good 还没执行）
    // 注意：此处 readFileSync 在 run() 完成后调用，good 已执行——
    // 所以我们在 good 执行前已无直接观察点。改用 messages 中 good 的
    // tool_result 验证成功，并在 (c) 末尾断言最终文件被改写。
    const goodResult = findToolResult({
      messages: result.messages,
      toolUseId: "c-good",
    });
    assert.ok(goodResult, "expected tool_result for c-good");
    assert.equal(goodResult.is_error, undefined);

    // T4 #298 集成回归:append-only messages 里 good 的 tool_result 文本
    // 只含 output 文案,不含 meta JSON(oldContent / newContent 决不漏进模型面)。
    const goodText = toolResultText(goodResult);
    assert.ok(goodText.includes("occurrence(s)"), "output text present");
    assert.ok(!goodText.includes("oldContent"), "meta must NOT leak");
    assert.ok(!goodText.includes("newContent"), "meta must NOT leak");
    assert.ok(
      !goodText.includes("const x = 1;"),
      "old full content NOT in model"
    );

    // 最终断言：文件已被正确补丁改写（说明坏补丁被拒后才执行 good）
    const after = readFileSync(filePath, "utf8");
    assert.notEqual(after, before, "file should be modified by good patch");
    assert.ok(after.includes("const x = foo(1);"));
    assert.ok(!after.includes("const x = 1;\n"));

    assert.equal(result.stopReason, "completed");
  });
});
