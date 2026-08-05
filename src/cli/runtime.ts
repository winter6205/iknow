/**
 * Runtime bootstrap for CLI: env, store, harness engine.
 *
 * 020 决议收口后只剩 `buildHarnessEngine(bundle)` 一条 build 路径:
 * CLI ask/chat 产品路径,走 harness foundation(real Anthropic adapter +
 * LoopEngine)。#141-T11 把 ACI 装饰层工具集从 5 件 PROTOTYPE 切到 6 件业界通用名
 * (bash / read_file / grep / glob / edit_file / write_file)，与 permission
 * policy byName 键 `bash` 对齐（ADR-0004 / ADR-0006）；后续追加 Web 类
 * web_fetch / web_search（harness-report p04 ACI 映射），合计 8 件。
 *
 * 旧 agent builder 服务于 Session API serve 路径,在 #51 把 serve 切到
 * harness 后于 022 归档(见 `docs/archive/022-retire-agent-loop/README.md`)。
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  createRealAnthropicAdapter,
  createExecutor,
  createLoopEngine,
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
import { createWebFetchTool } from "../harness/aci/tools/web-fetch.js";
import { createWebSearchTool } from "../harness/aci/tools/web-search.js";
import type { AskUser } from "../harness/permission/types.js";
import { loadIknowEnv, type IknowEnv } from "../config/env.js";
import type { SessionContext } from "../shared/schema.js";
import { createIknowRuntime } from "../runtime/create-runtime.js";
import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";

export type RuntimeBundle = {
  store: InMemoryKnowledgeStore;
  env: IknowEnv;
  session: SessionContext;
};

export async function prepareRuntime(): Promise<RuntimeBundle> {
  const env = loadIknowEnv();
  const { store, env: runtimeEnv } = await createIknowRuntime({ env });

  const session: SessionContext = {};

  return { store, env: runtimeEnv, session };
}

export type BuiltEngine = {
  deps: LoopEngineDeps;
  engine: ReturnType<typeof createLoopEngine>;
};

/**
 * CLI ask/chat 产品路径的 harness 装配(020 新主路径)。
 *
 * 只构造 deps + engine,不在此调 run();调用方(cli.ts / chat-session.ts)决定
 * 何时跑、是否续传 priorMessages。maxTurns 硬编码 6(loadIknowEnv 无 maxTurns
 * 字段,对齐 019 i9 smoke 惯例)。缺 apiKey 抛错,message 含 "LLM mode needs"
 * 子串(cli.ts runOneShot 按此匹配发 llm_mode_missing_api_key 信封)。
 *
 * #162 三入口装配 askUser：`askUser: AskUser` 是必传参数；缺则启动 throw
 * `ask_inlet_missing`。
 */
export async function buildHarnessEngine(
  bundle: RuntimeBundle,
  opts: { askUser: AskUser }
): Promise<BuiltEngine> {
  const { env } = bundle;
  if (!env.llm.apiKey) {
    throw new Error(
      `CLI LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${env.llm.apiKeyEnv}); set the key.`
    );
  }
  if (!opts.askUser) {
    throw new Error(
      "ask_inlet_missing: buildHarnessEngine requires an AskUser implementation (chat/ask/serve must inject one)"
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
    // #151 T4 / #156 Low:env → adapter params(去重 single source)。
    thinking: buildThinkingParams(env.llm),
    // #179 T6 (#147 D0):流式臂开关,env SSOT,默认 on(D0)。
    stream: env.llm.stream === "on",
  });
  // ACI 工具集（#141-T11 6 工具集 + web_fetch/web_search Web 类扩展，
  // 对齐 ADR-0004 业界通用名）。沙箱根 = process.cwd()（CLI 在工程根跑时,
  // agent 工作区与项目一致）。所有工具的 root 软沙箱越界即报 ToolExecutionError；
  // bash 的 cwd 不是安全边界，真实边界是 allowlist-first + 黑名单双保险 +
  // (毕业后) OS 级沙箱(#123)。Web 类工具不触文件系统，边界在
  // network-guard（SSRF 逐跳校验）；category=read-only → 权限默认 allow。
  // append-only：不重排既有 6 工具（policy byName 键空间与 ADR-0006 稳定）。
  const sandboxRoot = process.cwd();
  const aciTools = [
    createBashTool(sandboxRoot),
    createReadFileTool(sandboxRoot),
    createGrepTool(sandboxRoot),
    createGlobTool(sandboxRoot),
    createEditFileTool(sandboxRoot),
    createWriteFileTool(sandboxRoot),
    createWebFetchTool(),
    // web_search 端点覆写经 loadIknowEnv SSOT 解析（process.env > .env.local > .env），
    // 工具自身不直读 process.env。
    createWebSearchTool({ envSearchUrl: env.web.searchUrl }),
  ];
  const reg = createAciRegistry(aciTools);
  const baseExecutor = createExecutor(reg.inner);
  // 5-step permission middleware: 危险命令由硬墙无条件拦截（#122 Q2b），
  // 无需策略开关。`createAciExecutor` 内部已装配 permission-executor（接受
  // askUser via `AciExecutorOptions.askUser`），不要再外包一层。
  const policy = createPermissionPolicy();
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser: opts.askUser,
  });
  const deps: LoopEngineDeps = {
    adapter,
    executor,
    registry: reg.inner,
    maxTurns: 6,
    timeoutMs: env.llm.timeoutMs,
  };
  return { deps, engine: createLoopEngine(deps) };
}
