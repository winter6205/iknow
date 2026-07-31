/**
 * PROTOTYPE（throwaway）— ACI 原型 Layer 2：一条命令跑通全生命周期演示。
 *
 * 验证问题：Layer 0（契约/权限/装饰执行器/延迟加载 registry）+ Layer 1（5 工具）
 * 能否组装成一条命令跑通、每步打印完整状态的端到端演示，证明 ACI 装饰层
 * 可在不改 4-tool 协议前提下注入权限检查、安全标记（Linter poka-yoke）、延迟加载。
 *
 * 运行：npm run aci:demo（= tsx src/harness/aci/demo.ts）
 * 无持久化：scratch 目录在 os.tmpdir() 下创建，结束 rmSync 清理。
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../loop-engine.js";
import { createExecutor } from "../tools/executor.js";
import { createStubModel } from "../stubs/stub-model.js";

import type { LoopEngineDeps } from "../loop-engine.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  RunResult,
} from "../model-adapter/types.js";
import type { LoopTrace } from "../loop-trace.js";

import { createAciRegistry, createAciExecutor } from "./index.js";
import { createFsSearchTool } from "./tools/fs-search.js";
import { createFsViewTool } from "./tools/fs-view.js";
import { createFsEditTool } from "./tools/fs-edit.js";
import { createShellExecTool } from "./tools/shell-exec.js";
import { createContextManagerTool } from "./tools/context-manager.js";

/* ── helper: 构造 AssistantTurnResult（仿 loop-engine.test.ts，demo 自带一份）── */

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

/* ── helper: 打印 messages 中全部 tool_result（is_error / payload 摘要）── */

function printToolResults(
  messages: ReadonlyArray<AnthropicNativeMessage>,
): void {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      let text: string;
      if (Array.isArray(block.content)) {
        const first = block.content[0] as { text?: string } | undefined;
        text = first?.text ?? JSON.stringify(block.content);
      } else {
        text = String(block.content);
      }
      const summary =
        text.length > 300 ? `${text.slice(0, 300)}…` : text;
      console.log(
        `  tool_result [${block.tool_use_id}] is_error=${String(block.is_error ?? false)}: ${summary}`,
      );
    }
  }
}

/* ── helper: 打印 run() 返回摘要 + trace.totals ── */

function printRunSummary(result: RunResult, trace: LoopTrace): void {
  console.log(
    `  run() → stopReason=${result.stopReason} turnCount=${String(result.turnCount)} finalText=${JSON.stringify(result.finalText)}`,
  );
  console.log(`  trace.totals → ${JSON.stringify(trace.totals)}`);
}

/* ── helper: 场景分隔线 ── */

function banner(title: string): void {
  console.log("");
  console.log("=".repeat(64));
  console.log(title);
  console.log("=".repeat(64));
}

/* ── main ── */

async function main(): Promise<void> {
  // 1. scratch 目录 + 样例文件（无持久化，结束即清理）
  const scratch = mkdtempSync(join(tmpdir(), "iknow-aci-prototype-"));
  console.log(`scratch: ${scratch}`);

  // 60 个 .txt（验证 fs_search 硬截断 50 条）
  for (let i = 0; i < 60; i++) {
    writeFileSync(
      join(scratch, `note-${String(i).padStart(3, "0")}.txt`),
      `needle content ${String(i)}`,
    );
  }
  writeFileSync(join(scratch, "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(scratch, "beta.ts"), "export const beta = 2;\n");
  // 250 行大文件（验证 fs_view 有状态翻页：第一页 0-99，第二页 100-199）
  const bigLines = Array.from(
    { length: 250 },
    (_, i) => `line ${String(i + 1)}: placeholder content for paging`,
  );
  writeFileSync(join(scratch, "big-file.txt"), bigLines.join("\n"));
  // 待编辑文件（验证 fs_edit Linter poka-yoke）
  writeFileSync(join(scratch, "edit-me.ts"), "const x = 1;\nconsole.log(x);\n");

  let allGreen = true;

  try {
    // 2. 装配：registry + 装饰执行器
    const fsSearch = createFsSearchTool(scratch);
    const fsView = createFsViewTool(scratch);
    const fsEdit = createFsEditTool(scratch);
    const shellExec = createShellExecTool(scratch);
    const ctxMgr = createContextManagerTool();

    const reg = createAciRegistry([
      fsSearch,
      fsView,
      fsEdit,
      shellExec,
      ctxMgr,
    ]);
    const innerExec = createExecutor(reg.inner);
    const exec = createAciExecutor(innerExec, reg.catalog, {
      onDecision: (call, outcome) => {
        console.log(
          `  [permission] ${call.name} -> ${outcome.decision} (${outcome.reason})`,
        );
      },
    });

    const makeDeps = (
      model: ReturnType<typeof createStubModel>,
    ): LoopEngineDeps => ({
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });

    /* ── 场景 1：read-only 并发免确认 ── */
    banner(
      "场景 1：read-only 并发免确认（fs_search 限 50 + fs_view 有状态翻页）",
    );
    console.log(
      "  脚本：turn1 fs_search(.ts)+fs_view(offset=0) | turn2 fs_view(无offset,续读) | turn3 文本完成",
    );
    {
      const model = createStubModel([
        assistantResult(
          [],
          [
            { id: "s1-search", name: "fs_search", input: { pattern: ".ts" } },
            {
              id: "s1-view-1",
              name: "fs_view",
              input: { path: "big-file.txt", offset: 0 },
            },
          ],
        ),
        assistantResult(
          [],
          [
            {
              id: "s1-view-2",
              name: "fs_view",
              input: { path: "big-file.txt" },
            },
          ],
        ),
        assistantResult(["read-only 场景完成"], [], "success"),
      ]);
      const { result, trace } = await run("scenario 1", makeDeps(model));
      printToolResults(result.messages);
      printRunSummary(result, trace);
      if (result.stopReason !== "completed") allGreen = false;
    }

    /* ── 场景 2：write 需确认 + Linter poka-yoke ── */
    banner(
      "场景 2：write + Linter poka-yoke（先坏补丁被拒，再正确补丁成功）",
    );
    {
      const before = readFileSync(join(scratch, "edit-me.ts"), "utf8");
      console.log(`  编辑前文件内容: ${JSON.stringify(before)}`);
      console.log(
        '  脚本：turn1 fs_edit(new_str="const x = foo(1;" 括号不配对) | turn2 fs_edit(正确) | turn3 文本完成',
      );
      const model = createStubModel([
        assistantResult(
          [],
          [
            {
              id: "s2-bad",
              name: "fs_edit",
              input: {
                path: "edit-me.ts",
                old_str: "const x = 1;",
                new_str: "const x = foo(1;",
              },
            },
          ],
        ),
        assistantResult(
          [],
          [
            {
              id: "s2-good",
              name: "fs_edit",
              input: {
                path: "edit-me.ts",
                old_str: "const x = 1;",
                new_str: "const x = foo(1);",
              },
            },
          ],
        ),
        assistantResult(["write 场景完成"], [], "success"),
      ]);
      const { result, trace } = await run("scenario 2", makeDeps(model));
      printToolResults(result.messages);
      const after = readFileSync(join(scratch, "edit-me.ts"), "utf8");
      console.log(`  编辑后文件内容: ${JSON.stringify(after)}`);
      printRunSummary(result, trace);
      if (result.stopReason !== "completed") allGreen = false;
    }

    /* ── 场景 3：execute 危险命令 deny ── */
    banner(
      "场景 3：execute 危险命令 deny（allowlist-first: rm -rf / -> command not in allowlist）+ 安全命令放行",
    );
    console.log(
      '  脚本：turn1 shell_exec("rm -rf /") | turn2 shell_exec("echo hello") | turn3 文本完成',
    );
    {
      const model = createStubModel([
        assistantResult(
          [],
          [
            {
              id: "s3-danger",
              name: "shell_exec",
              input: { command: "rm -rf /" },
            },
          ],
        ),
        assistantResult(
          [],
          [
            {
              id: "s3-safe",
              name: "shell_exec",
              input: { command: "echo hello" },
            },
          ],
        ),
        assistantResult(["execute 场景完成"], [], "success"),
      ]);
      const { result, trace } = await run("scenario 3", makeDeps(model));
      printToolResults(result.messages);
      printRunSummary(result, trace);
      if (result.stopReason !== "completed") allGreen = false;
    }

    /* ── 场景 4：延迟加载 ── */
    banner(
      "场景 4：延迟加载（context_manager lazy -> discover() 注入后可用）",
    );
    {
      const visible = reg.visibleSchemas().map((t) => t.name);
      console.log(`  visibleSchemas(): [${visible.join(", ")}]`);
      console.log(
        `  含 context_manager? ${String(visible.includes("context_manager"))}`,
      );
      const discovered = reg.discover("context_manager");
      console.log(
        `  discover("context_manager") -> ${
          discovered ? `命中 (name=${discovered.name})` : "undefined"
        }`,
      );
      console.log(
        "  脚本：turn1 context_manager(5 条观测, keepRecent=2) | turn2 文本完成",
      );
      const model = createStubModel([
        assistantResult(
          [],
          [
            {
              id: "s4-ctx",
              name: "context_manager",
              input: {
                observations: [
                  "obs-1: early finding about the codebase structure",
                  "obs-2: another early observation with some detail",
                  "obs-3: mid-session note about a pattern",
                  "obs-4: recent finding about the API layer",
                  "obs-5: latest observation about test coverage",
                ],
                keepRecent: 2,
              },
            },
          ],
        ),
        assistantResult(["延迟加载场景完成"], [], "success"),
      ]);
      const { result, trace } = await run("scenario 4", makeDeps(model));
      printToolResults(result.messages);
      printRunSummary(result, trace);
      if (result.stopReason !== "completed") allGreen = false;
    }

    /* ── 总结 ── */
    banner("被验证的决策");
    console.log(
      "ACI 装饰层可在不改 4-tool 协议前提下注入：",
    );
    console.log(
      "  1. 权限检查（read-only 免确认 / execute allowlist-first 危险命令 deny 零副作用）",
    );
    console.log(
      "  2. 安全标记（fs_edit Linter poka-yoke 拒绝坏补丁，文件不动）",
    );
    console.log(
      "  3. 延迟加载（lazy 工具不进 prompt schema，discover() 按需注入）",
    );
    console.log("");
    console.log(allGreen ? "ALL GREEN" : "SOME SCENARIO FAILED");

    if (!allGreen) {
      process.exitCode = 1;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    console.log(`scratch 已清理: ${scratch}`);
  }
}

main().catch((err: unknown) => {
  console.error("demo 异常退出:", err);
  process.exitCode = 1;
});
