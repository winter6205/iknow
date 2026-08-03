/**
 * PROTOTYPE（throwaway）— ACI 原型 Layer 2：一条命令跑通全生命周期演示。
 *
 * 验证问题：Layer 0（契约/权限/装饰执行器）+ Layer 1（6 工具集，
 * ADR-0004）能否组装成一条命令跑通、每步打印完整状态的端到端演示，
 * 证明 ACI 装饰层可在不改 4-tool 协议前提下注入权限检查、安全标记
 * （Linter poka-yoke）。
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
import { createBashTool } from "./tools/bash.js";
import { createReadFileTool } from "./tools/read-file.js";
import { createGlobTool } from "./tools/glob.js";
import { createGrepTool } from "./tools/grep.js";
import { createEditFileTool } from "./tools/edit-file.js";
import { createWriteFileTool } from "./tools/write-file.js";

/* ── helper: 构造 AssistantTurnResult（仿 loop-engine.test.ts，demo 自带一份）── */

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

/* ── helper: 打印 messages 中全部 tool_result（is_error / payload 摘要）── */

function printToolResults(
  messages: ReadonlyArray<AnthropicNativeMessage>
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
      const summary = text.length > 300 ? `${text.slice(0, 300)}…` : text;
      console.log(
        `  tool_result [${block.tool_use_id}] is_error=${String(block.is_error ?? false)}: ${summary}`
      );
    }
  }
}

/* ── helper: 打印 run() 返回摘要 + trace.totals ── */

function printRunSummary(opts: { result: RunResult; trace: LoopTrace }): void {
  const { result, trace } = opts;
  console.log(
    `  run() → stopReason=${result.stopReason} turnCount=${String(result.turnCount)} finalText=${JSON.stringify(result.finalText)}`
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

  // 60 个 .txt（验证 glob 真匹配 + 字母序）
  for (let i = 0; i < 60; i++) {
    writeFileSync(
      join(scratch, `note-${String(i).padStart(3, "0")}.txt`),
      `needle content ${String(i)}`
    );
  }
  writeFileSync(join(scratch, "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(scratch, "beta.ts"), "export const beta = 2;\n");
  // 250 行大文件（验证 read_file 显式 offset 分页 — 无状态）
  const bigLines = Array.from(
    { length: 250 },
    (_, i) => `line ${String(i + 1)}: placeholder content for paging`
  );
  writeFileSync(join(scratch, "big-file.txt"), bigLines.join("\n"));
  // 待编辑文件（验证 edit_file poka-yoke）
  writeFileSync(join(scratch, "edit-me.ts"), "const x = 1;\nconsole.log(x);\n");

  let allGreen = true;

  try {
    // 2. 装配：registry + 装饰执行器（#141-T11 6 工具集，ADR-0004）
    const bash = createBashTool(scratch);
    const readFile = createReadFileTool(scratch);
    const glob = createGlobTool(scratch);
    const grep = createGrepTool(scratch);
    const editFile = createEditFileTool(scratch);
    const writeFile = createWriteFileTool(scratch);

    const reg = createAciRegistry([
      bash,
      readFile,
      glob,
      grep,
      editFile,
      writeFile,
    ]);
    const innerExec = createExecutor(reg.inner);
    const exec = createAciExecutor({
      inner: innerExec,
      catalog: reg.catalog,
      onDecision: (call, outcome) => {
        console.log(
          `  [permission] ${call.name} -> ${outcome.decision} (${outcome.reason})`
        );
      },
    });

    const makeDeps = (
      model: ReturnType<typeof createStubModel>
    ): LoopEngineDeps => ({
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });

    /* ── 场景 1：read-only 并发免确认 ── */
    banner(
      "场景 1：read-only 并发免确认（glob 真匹配 + read_file 无状态分页）"
    );
    console.log(
      "  脚本：turn1 glob(*.ts)+read_file(offset=0,limit=50) | turn2 read_file(offset=50,limit=50) | turn3 文本完成"
    );
    {
      const model = createStubModel({
        responses: [
          assistantResult({
            texts: [],
            toolCalls: [
              {
                id: "s1-glob",
                name: "glob",
                input: { pattern: "*.ts" },
              },
              {
                id: "s1-read-1",
                name: "read_file",
                input: { path: "big-file.txt", offset: 0, limit: 50 },
              },
            ],
          }),
          assistantResult({
            texts: [],
            toolCalls: [
              {
                id: "s1-read-2",
                name: "read_file",
                // 续读必须显式 offset=50（契约 Y1 read_file 无状态）
                input: { path: "big-file.txt", offset: 50, limit: 50 },
              },
            ],
          }),
          assistantResult({
            texts: ["read-only 场景完成"],
            toolCalls: [],
            supplierStop: "success",
          }),
        ],
      });
      const { result, trace } = await run("scenario 1", makeDeps(model));
      printToolResults(result.messages);
      printRunSummary({ result, trace });
      if (result.stopReason !== "completed") allGreen = false;
    }

    /* ── 场景 2：write 需确认 + Linter poka-yoke ── */
    banner("场景 2：write + Linter poka-yoke（先坏补丁被拒，再正确补丁成功）");
    {
      const before = readFileSync(join(scratch, "edit-me.ts"), "utf8");
      console.log(`  编辑前文件内容: ${JSON.stringify(before)}`);
      console.log(
        '  脚本：turn1 edit_file(new_str="const x = foo(1;" 括号不配对) | turn2 edit_file(正确) | turn3 文本完成'
      );
      const model = createStubModel({
        responses: [
          assistantResult({
            texts: [],
            toolCalls: [
              {
                id: "s2-bad",
                name: "edit_file",
                input: {
                  path: "edit-me.ts",
                  old_str: "const x = 1;",
                  new_str: "const x = foo(1;",
                },
              },
            ],
          }),
          assistantResult({
            texts: [],
            toolCalls: [
              {
                id: "s2-good",
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
            texts: ["write 场景完成"],
            toolCalls: [],
            supplierStop: "success",
          }),
        ],
      });
      const { result, trace } = await run("scenario 2", makeDeps(model));
      printToolResults(result.messages);
      const after = readFileSync(join(scratch, "edit-me.ts"), "utf8");
      console.log(`  编辑后文件内容: ${JSON.stringify(after)}`);
      printRunSummary({ result, trace });
      if (result.stopReason !== "completed") allGreen = false;
    }

    /* ── 场景 3：execute 危险命令 deny ── */
    banner(
      "场景 3：execute 危险命令 deny（allowlist-first: rm -rf / -> not in allowlist）+ 安全命令放行"
    );
    console.log(
      '  脚本：turn1 bash("rm -rf /") | turn2 bash("echo hello") | turn3 文本完成'
    );
    {
      const model = createStubModel({
        responses: [
          assistantResult({
            texts: [],
            toolCalls: [
              {
                id: "s3-danger",
                name: "bash",
                input: { command: "rm -rf /" },
              },
            ],
          }),
          assistantResult({
            texts: [],
            toolCalls: [
              {
                id: "s3-safe",
                name: "bash",
                input: { command: "echo hello" },
              },
            ],
          }),
          assistantResult({
            texts: ["execute 场景完成"],
            toolCalls: [],
            supplierStop: "success",
          }),
        ],
      });
      const { result, trace } = await run("scenario 3", makeDeps(model));
      printToolResults(result.messages);
      printRunSummary({ result, trace });
      if (result.stopReason !== "completed") allGreen = false;
    }

    /* ── 总结 ── */
    banner("被验证的决策");
    console.log("ACI 装饰层可在不改 4-tool 协议前提下注入：");
    console.log(
      "  1. 权限检查（read-only 免确认 / execute allowlist-first 危险命令 deny 零副作用）"
    );
    console.log(
      "  2. 安全标记（edit_file Linter poka-yoke 拒绝坏补丁，文件不动）"
    );
    console.log(
      "  3. 工具集（6 工具协作覆盖发现/精读/写/执行/编辑，grep/glob 语义分离）"
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
