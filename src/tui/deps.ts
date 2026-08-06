/**
 * src/tui/deps.ts
 *
 * #146 TUI 的 harness deps 装配：照抄 buildHarnessEngine（src/cli/runtime.ts）
 * 的 ACI 产品装配链——real Anthropic adapter + ACI 6 工具集 + permission
 * policy；差异两点：
 *  1. 不建 engine（SessionHub.postMessage 内部直接调 run()，deps 即所需全部）；
 *  2. createAciExecutor 注入 hooks.postToolUse → 工具摘要行事件（Q5b=B；
 *     permission/types.ts:117-128 官方观测挂点，每 call 事后触发）。
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  createRealAnthropicAdapter,
  createExecutor,
  buildThinkingParams,
  type LoopEngineDeps,
} from "../harness/index.js";
import {
  createAciRegistry,
  createAciExecutor,
  createPermissionPolicy,
} from "../harness/aci/index.js";
import { createBashTool } from "../harness/aci/tools/bash.js";
import { createReadFileTool } from "../harness/aci/tools/read-file.js";
import { createGrepTool } from "../harness/aci/tools/grep.js";
import { createGlobTool } from "../harness/aci/tools/glob.js";
import { createEditFileTool } from "../harness/aci/tools/edit-file.js";
import { createWriteFileTool } from "../harness/aci/tools/write-file.js";
import { createIknowSystemResolver } from "../harness/identity/index.js";
import type { AskUser } from "../harness/permission/types.js";
import type { RuntimeBundle } from "../cli/runtime.js";
import { homedir } from "node:os";

/** 工具摘要行事件（postToolUse 投影，observability-only）。 */
export interface TuiToolEvent {
  readonly conversationId: string;
  readonly toolName: string;
  /** ok | validation_failed | tool_not_found | execution_failed */
  readonly kind: string;
  readonly input: unknown;
  readonly message?: string;
}

export interface BuildTuiDepsOptions {
  readonly askUser: AskUser;
  /** 工具完成事件；归因规则见 hub-bridge.ts（单会话 in-flight 才归因）。 */
  readonly onToolEvent?: (event: TuiToolEvent) => void;
  /**
   * 归因查询：当前是否恰好一个会话 in-flight（是则返回其 id）。
   * 多会话并发时事件抑制（宁缺勿错归，见 hub-bridge.ts 已知边界）。
   */
  readonly soleInflightId?: () => string | undefined;
}

export function buildTuiDeps(
  bundle: RuntimeBundle,
  opts: BuildTuiDepsOptions
): LoopEngineDeps {
  const { env } = bundle;
  if (!env.llm.apiKey) {
    throw new Error(
      `CLI LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${env.llm.apiKeyEnv}); set the key.`
    );
  }
  const client = new Anthropic({
    apiKey: env.llm.apiKey,
    baseURL: env.llm.baseUrl,
  });
  const adapter = createRealAnthropicAdapter({
    client,
    model: env.llm.model,
    maxTokens: env.llm.maxOutputTokens,
    temperature: env.llm.temperature,
    thinking: buildThinkingParams(env.llm),
  });
  // 沙箱根 = process.cwd()（与 buildHarnessEngine 同款）。
  const sandboxRoot = process.cwd();
  const aciTools = [
    createBashTool(sandboxRoot),
    createReadFileTool(sandboxRoot),
    createGrepTool(sandboxRoot),
    createGlobTool(sandboxRoot),
    createEditFileTool(sandboxRoot),
    createWriteFileTool(sandboxRoot),
  ];
  const reg = createAciRegistry(aciTools);
  const baseExecutor = createExecutor(reg.inner);
  const policy = createPermissionPolicy();
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser: opts.askUser,
    hooks: {
      postToolUse: (result) => {
        if (!opts.onToolEvent) return;
        const conversationId = opts.soleInflightId?.();
        // 多会话并发 → 无法归因 → 抑制（v1 已知边界，见 hub-bridge.ts）。
        if (conversationId === undefined) return;
        opts.onToolEvent({
          conversationId,
          toolName: result.name,
          kind: result.kind,
          input: result.input,
          message: result.message,
        });
      },
    },
  });
  return {
    adapter,
    executor,
    registry: reg.inner,
    maxTurns: 6,
    timeoutMs: env.llm.timeoutMs,
    // #196 IKNOW T5:tui 入口走 system 注入缝(spec A12:chat/tui 激活
    // BOOTSTRAP,surface="tui" → bootstrapActive=true)。
    system: createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: homedir(),
      surface: "tui",
    }),
  };
}
