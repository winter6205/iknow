/**
 * Shared agent-status test fixtures (#645 T1 / #647 T3).
 *
 * Not collected by vitest on purpose (no `.test.ts` suffix) — mirrors the
 * `tests/cli/_fixtures.ts` convention: the spy-adapter pattern that records
 * per-step `state.messages` is kept in ONE place so the bar suite and the
 * stream-event suite cannot fork.
 *
 * Used by:
 *   - tests/harness/agent-status-bar.test.ts (T1: bar append contract)
 *   - tests/harness/agent-status-stream.test.ts (T3: agent_status stream event)
 */
import { afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LoopAdapter } from "../../src/harness/loop-engine.ts";
import { PromptTooLongError } from "../../src/harness/errors.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../src/harness/model-adapter/types.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";

// -- tmp todoDir lifecycle -----------------------------------------------------

/**
 * 每个用例独立的 todoDir(tmpdir);initialContent 缺省 = 不写 todos.md。
 * 目录由本模块登记,afterAll 统一清理(hook 在各导入测试文件各自注册一次)。
 */
const tempDirs: string[] = [];

export async function makeTodoDir(initialContent?: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "iknow-agent-status-"));
  tempDirs.push(tmp);
  if (initialContent !== undefined) {
    await writeFile(join(tmp, "todos.md"), initialContent, "utf8");
  }
  return tmp;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// -- spy adapter ----------------------------------------------------------------

export type StepAction =
  | { readonly kind: "reply"; readonly result: AssistantTurnResult }
  | { readonly kind: "promptTooLong" };

/**
 * 扩展缝:每次(带 tools 的)模型调用入口回调(在 captured 记录之后、脚本
 * 消费之前)。返回值按调用序记入 `entrySamples`(T3 stream 套件用它采样
 * 「调用入口时已到达的 agent_status 事件数」;T1 bar 套件不传 → 恒空)。
 */
export interface SpyAdapterHooks<TSample = unknown> {
  readonly sampleAtEntry?: () => TSample;
}

/**
 * Spy adapter:捕获每次(带 tools 的)模型调用看到的 state.messages,
 * 按脚本回放 reply / PromptTooLongError。tools 缺席的调用(compact 摘要轮 /
 * 收尾摘要轮)返回空文本,不消耗脚本、不记 captured(栏 / 事件只挂主回路
 * 模型调用)。
 */
export function makeSpyAdapter<TSample = unknown>(
  actions: ReadonlyArray<StepAction>,
  hooks?: SpyAdapterHooks<TSample>
): {
  readonly adapter: LoopAdapter;
  /** 每次带 tools 的模型调用看到的 messages(按调用序)。 */
  readonly captured: ReadonlyArray<ReadonlyArray<AnthropicNativeMessage>>;
  /** 每次带 tools 的模型调用看到的 request.system(缺席 = undefined;守「注入不进 system」)。 */
  readonly systemsCaptured: ReadonlyArray<string | undefined>;
  /** hooks.sampleAtEntry 按调用序的返回值;未传 hooks → 恒空数组。 */
  readonly entrySamples: ReadonlyArray<TSample>;
} {
  const captured: ReadonlyArray<AnthropicNativeMessage>[] = [];
  const systemsCaptured: (string | undefined)[] = [];
  const entrySamples: TSample[] = [];
  let next = 0;
  const adapter: LoopAdapter = Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] =>
      results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolUseId,
        is_error: r.kind !== "ok",
        content: [
          {
            type: "text" as const,
            text:
              r.kind === "ok"
                ? JSON.stringify(r.payload ?? [])
                : `[${r.kind}] ${"message" in r ? r.message : ""}`,
          },
        ],
      })),
    step: async (
      state: { readonly messages: ReadonlyArray<AnthropicNativeMessage> },
      request: { readonly tools?: unknown; readonly system?: string }
    ): Promise<AssistantTurnResult> => {
      if (request.tools === undefined) {
        return assistantResult({
          texts: [],
          toolCalls: [],
          supplierStop: "success",
        });
      }
      captured.push(state.messages);
      systemsCaptured.push(request.system);
      if (hooks?.sampleAtEntry !== undefined) {
        entrySamples.push(hooks.sampleAtEntry());
      }
      const action = actions[next];
      next += 1;
      if (action === undefined) {
        throw new Error("spy adapter: action script exhausted");
      }
      if (action.kind === "promptTooLong") {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      return action.result;
    },
  });
  return { adapter, captured, systemsCaptured, entrySamples };
}

// -- tools ----------------------------------------------------------------------

export function okEchoTool(name = "echo"): ReturnType<typeof createStubTool> {
  return createStubTool({
    name,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    next: (input: unknown) => input,
  });
}

// -- bar 文本提取 / 解析 ----------------------------------------------------------

export function isBarBlock(
  b: AnthropicContentBlock
): b is { type: "text"; text: string } {
  return b.type === "text" && b.text.startsWith("<agent_status>");
}

/** 收集 messages 里全部栏文本(按出现序)。 */
export function barTexts(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (isBarBlock(b)) out.push(b.text);
    }
  }
  return out;
}

export interface ParsedBar {
  readonly lastTool: string;
  readonly todoLines: string[];
}

export function parseBar(text: string): ParsedBar {
  const lines = text.split("\n");
  assert.equal(lines[0], "<agent_status>");
  assert.equal(lines[lines.length - 1], "</agent_status>");
  const body = lines.slice(1, -1);
  const lastToolLine = body.find((l) => l.startsWith("last_tool: "));
  assert.ok(lastToolLine !== undefined, `bar missing last_tool line: ${text}`);
  const todoHeaderIndex = body.findIndex((l) => l === "todos:");
  const todoLines = todoHeaderIndex >= 0 ? body.slice(todoHeaderIndex + 1) : [];
  return { lastTool: lastToolLine.slice("last_tool: ".length), todoLines };
}
