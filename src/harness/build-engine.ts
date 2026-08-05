/**
 * Source-of-truth harness assembly for the LLM + tool-call loop.
 *
 * `buildHarnessEngine({ env, askUser })` is the single assembly point for the
 * 8-tool ACI tool set (bash / read_file / grep / glob / edit_file /
 * write_file / web_fetch / web_search). Both the CLI (chat / ask) and the
 * session server (`iknow serve` → SessionHub.ensureDeps) import this
 * function so the tool set can never drift between the two entry points.
 *
 * Bundling rule: this module only depends on `env` (LLM/web config) and a
 * caller-supplied `askUser`. It does not import CLI-runtime bundles
 * (`store` / `session`) nor the session-server HTTP/session layer.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  createRealAnthropicAdapter,
  buildThinkingParams,
  createExecutor,
  createLoopEngine,
  type LoopEngineDeps,
} from "./index.js";
import {
  createAciRegistry,
  createAciExecutor,
  createPermissionPolicy,
} from "./aci/index.js";
import { createBashTool } from "./aci/tools/bash.js";
import { createReadFileTool } from "./aci/tools/read-file.js";
import { createGrepTool } from "./aci/tools/grep.js";
import { createGlobTool } from "./aci/tools/glob.js";
import { createEditFileTool } from "./aci/tools/edit-file.js";
import { createWriteFileTool } from "./aci/tools/write-file.js";
import { createWebFetchTool } from "./aci/tools/web-fetch.js";
import { createWebSearchTool } from "./aci/tools/web-search.js";
import type { AskUser } from "./permission/types.js";
import type { IknowEnv } from "../config/env.js";
import { ValidationError } from "../shared/errors.js";

export type BuildEngineOpts = {
  readonly env: IknowEnv;
  readonly askUser: AskUser;
  /** Process working directory used as the soft sandbox root for fs tools. */
  readonly sandboxRoot?: string;
};

export type BuiltEngine = {
  readonly deps: LoopEngineDeps;
  readonly engine: ReturnType<typeof createLoopEngine>;
};

/**
 * Build the harness engine deps + engine. `askUser` is required so the
 * permission middleware can prompt on `decision: "ask"` outcomes (#162).
 *
 * Throws when `env.llm.apiKey` is missing — the message contains the
 * `LLM mode needs` substring that CLI oneshot callers match on to emit the
 * `llm_mode_missing_api_key` envelope.
 */
export async function buildHarnessEngine(
  opts: BuildEngineOpts
): Promise<BuiltEngine> {
  const { env, askUser } = opts;
  if (!env.llm.apiKey) {
    // ValidationError keeps the HTTP layer's 400 mapping (http.ts sendError)
    // consistent for both CLI and serve; the message still carries the
    // `LLM mode needs` substring the CLI oneshot caller matches on.
    throw new ValidationError(
      `LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${env.llm.apiKeyEnv}); set the key.`
    );
  }
  if (!askUser) {
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
    // SSOT env→adapter params (#151/#156) and stream arm (#179/#147).
    thinking: buildThinkingParams(env.llm),
    stream: env.llm.stream === "on",
  });
  // ACI 8 件工具集 (#141-T11 + web_fetch/web_search Web 类扩展,对齐 ADR-0004)。
  // 沙箱根 = opts.sandboxRoot ?? process.cwd()。
  //
  // **sandboxRoot 假设 (code-review 2026-08-05):**
  //   - CLI: `process.cwd()` 是用户在工程根跑 `iknow chat` 的目录,等同于"项目根";
  //     fs 工具的软沙箱越界(超出 project root)即抛 ToolExecutionError,合理。
  //   - serve: `process.cwd()` 是 server 进程启动目录,长驻;**不等同于用户项目根**。
  //     serve 模式下 fs 工具的"项目根"语义需要由调用方(serve.ts)显式注入,否则
  //     agent 会把 server 启动目录当 workspace,从而读到 / 写错文件。
  //     当前实现走 fallback,产品决策(serve 是否接受 --sandbox-root flag)
  //     跟 Web 工具清单端点同 backlog。
  //
  // 软沙箱越界即抛 ToolExecutionError;bash 的 cwd 不是安全边界,真实边界在
  // allowlist-first + 黑名单 + (毕业后) OS 级沙箱(#123)。Web 类工具边界在
  // network-guard(SSRF 逐跳校验);category=read-only → 权限默认 allow。
  // append-only:不重排既有 6 工具(policy byName 键空间与 ADR-0006 稳定)。
  const sandboxRoot = opts.sandboxRoot ?? process.cwd();
  const aciTools = [
    createBashTool(sandboxRoot),
    createReadFileTool(sandboxRoot),
    createGrepTool(sandboxRoot),
    createGlobTool(sandboxRoot),
    createEditFileTool(sandboxRoot),
    createWriteFileTool(sandboxRoot),
    createWebFetchTool(),
    // web_search 端点覆写经 loadIknowEnv SSOT 解析(process.env > .env.local > .env),
    // 工具自身不直读 process.env。
    createWebSearchTool({ envSearchUrl: env.web.searchUrl }),
  ];
  const reg = createAciRegistry(aciTools);
  const baseExecutor = createExecutor(reg.inner);
  // 5-step permission middleware: 危险命令由硬墙无条件拦截(#122)。
  // `createAciExecutor` 内部已装配 permission-executor,不要再外包一层。
  const policy = createPermissionPolicy();
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser,
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
