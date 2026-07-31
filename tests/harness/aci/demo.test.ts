/**
 * PROTOTYPE（throwaway）— ACI 原型 Layer 2：端到端测试。
 *
 * 经 run() + createAciExecutor 端到端验证：
 *   (a) read-only 场景 stopReason=completed；
 *   (b) 危险命令 deny 路径产生 is_error 的 tool_result；
 *   (c) fs_edit 坏补丁被拒（文件内容未变）后正确补丁成功。
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
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
import { createFsSearchTool } from "../../../src/harness/aci/tools/fs-search.ts";
import { createFsViewTool } from "../../../src/harness/aci/tools/fs-view.ts";
import { createFsEditTool } from "../../../src/harness/aci/tools/fs-edit.ts";
import { createShellExecTool } from "../../../src/harness/aci/tools/shell-exec.ts";
import { createContextManagerTool } from "../../../src/harness/aci/tools/context-manager.ts";

/* ── helper: 构造 AssistantTurnResult（与 demo.ts 同一形状）── */

function assistantResult(
  texts: string[],
  toolCalls: Array<{ id: string; name: string; input: unknown }> = [],
  supplierStop: "success" | "truncation" | "refusal" | "other" = "success",
): AssistantTurnResult {
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
    createFsSearchTool(scratchDir),
    createFsViewTool(scratchDir),
    createFsEditTool(scratchDir),
    createShellExecTool(scratchDir),
    createContextManagerTool(),
  ]);
  const innerExec = createExecutor(reg.inner);
  const exec = createAciExecutor(innerExec, reg.catalog);
  return { reg, exec };
}

/* ── helper: 在 messages 中按 tool_use_id 查找 tool_result ── */

function findToolResult(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  toolUseId: string,
): Extract<AnthropicContentBlock, { type: "tool_result" }> | undefined {
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === toolUseId) {
        return b;
      }
    }
  }
  return undefined;
}

/* ── scratch 生命周期 ── */

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-aci-demo-test-"));
  // 基础样例文件（足够覆盖三条断言所需）
  writeFileSync(join(scratch, "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(scratch, "edit-me.ts"), "const x = 1;\nconsole.log(x);\n");
  const bigLines = Array.from(
    { length: 250 },
    (_, i) => `line ${String(i + 1)}`,
  );
  writeFileSync(join(scratch, "big-file.txt"), bigLines.join("\n"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/* ── 测试 ── */

describe("demo 端到端 — 经 run() + createAciExecutor", () => {
  it("(a) read-only 场景 stopReason=completed", async () => {
    const { reg, exec } = assemble(scratch);
    const model = createStubModel([
      assistantResult(
        [],
        [
          { id: "a-search", name: "fs_search", input: { pattern: ".ts" } },
          {
            id: "a-view-1",
            name: "fs_view",
            input: { path: "big-file.txt", offset: 0 },
          },
        ],
      ),
      assistantResult(
        [],
        [{ id: "a-view-2", name: "fs_view", input: { path: "big-file.txt" } }],
      ),
      assistantResult(["done"], [], "success"),
    ]);
    const { result } = await run("test-a", {
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 3);
    // fs_search 返回绝对路径且含 alpha.ts / beta.ts
    const searchResult = findToolResult(result.messages, "a-search");
    assert.ok(searchResult);
    assert.equal(searchResult.is_error, undefined);
    // fs_view 第一次翻页 offset=0，from=0，to=100
    const view1 = findToolResult(result.messages, "a-view-1");
    assert.ok(view1);
    const view1Text = (view1.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.ok(view1Text.includes('"from":0'));
    assert.ok(view1Text.includes('"to":100'));
    // fs_view 第二次无 offset，stateful 续读，from=100，to=200
    const view2 = findToolResult(result.messages, "a-view-2");
    assert.ok(view2);
    const view2Text = (view2.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.ok(view2Text.includes('"from":100'));
    assert.ok(view2Text.includes('"to":200'));
  });

  it("(b) 危险命令 deny -> is_error tool_result", async () => {
    const { reg, exec } = assemble(scratch);
    const model = createStubModel([
      assistantResult(
        [],
        [
          {
            id: "b-danger",
            name: "shell_exec",
            input: { command: "rm -rf /" },
          },
        ],
      ),
      assistantResult(
        [],
        [
          {
            id: "b-safe",
            name: "shell_exec",
            input: { command: "echo hello" },
          },
        ],
      ),
      assistantResult(["done"], [], "success"),
    ]);
    const { result } = await run("test-b", {
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });

    // deny 路径产生 is_error tool_result，message 以 [permission_denied] 开头
    const dangerResult = findToolResult(result.messages, "b-danger");
    assert.ok(dangerResult, "expected tool_result for b-danger");
    assert.equal(dangerResult.is_error, true);
    const dangerText =
      (dangerResult.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.ok(dangerText.includes("[permission_denied]"));
    // allowlist-first：rm 不在白名单,reason 含 "command not in allowlist"。
    assert.ok(
      dangerText.includes("command not in allowlist"),
      `expected allowlist denial, got: ${dangerText}`,
    );

    // 安全命令成功（is_error 未设置）
    const safeResult = findToolResult(result.messages, "b-safe");
    assert.ok(safeResult);
    assert.equal(safeResult.is_error, undefined);
    const safeText =
      (safeResult.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.ok(safeText.includes("hello"));

    assert.equal(result.stopReason, "completed");
  });

  it("(c) fs_edit 坏补丁被拒（文件不变）+ 正确补丁成功", async () => {
    const { reg, exec } = assemble(scratch);
    const filePath = join(scratch, "edit-me.ts");
    const before = readFileSync(filePath, "utf8");

    const model = createStubModel([
      // 坏补丁：括号不配对 -> lint rejected
      assistantResult(
        [],
        [
          {
            id: "c-bad",
            name: "fs_edit",
            input: {
              path: "edit-me.ts",
              old_str: "const x = 1;",
              new_str: "const x = foo(1;",
            },
          },
        ],
      ),
      // 正确补丁
      assistantResult(
        [],
        [
          {
            id: "c-good",
            name: "fs_edit",
            input: {
              path: "edit-me.ts",
              old_str: "const x = 1;",
              new_str: "const x = foo(1);",
            },
          },
        ],
      ),
      assistantResult(["done"], [], "success"),
    ]);
    const { result } = await run("test-c", {
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });

    // 坏补丁被拒（is_error=true，message 含 lint rejected）
    const badResult = findToolResult(result.messages, "c-bad");
    assert.ok(badResult, "expected tool_result for c-bad");
    assert.equal(badResult.is_error, true);
    const badText =
      (badResult.content as Array<{ text?: string }>)[0]?.text ?? "";
    assert.ok(badText.includes("lint rejected"));

    // 坏补丁期间文件内容未变（good 还没执行）
    // 注意：此处 readFileSync 在 run() 完成后调用，good 已执行——
    // 所以我们在 good 执行前已无直接观察点。改用 messages 中 good 的
    // tool_result 验证成功，并在 (c) 末尾断言最终文件被改写。
    const goodResult = findToolResult(result.messages, "c-good");
    assert.ok(goodResult, "expected tool_result for c-good");
    assert.equal(goodResult.is_error, undefined);

    // 最终断言：文件已被正确补丁改写（说明坏补丁被拒后才执行 good）
    const after = readFileSync(filePath, "utf8");
    assert.notEqual(after, before, "file should be modified by good patch");
    assert.ok(after.includes("const x = foo(1);"));
    assert.ok(!after.includes("const x = 1;\n"));

    assert.equal(result.stopReason, "completed");
  });
});