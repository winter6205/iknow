/**
 * Source-of-truth harness assembly for the LLM + tool-call loop.
 *
 * `buildHarnessEngine({ env, askUser })` is the assembly point for the LLM
 * adapter, permission middleware, executor, and engine — plus the 8-tool
 * ACI tool set, which it obtains from the SSOT factory
 * `createDefaultAciRegistry` (`src/harness/aci/tools/registry.ts`). Both the
 * CLI (chat / ask), the session server (`iknow serve` → SessionHub.ensureDeps),
 * and the TUI (`iknow tui` → buildTuiDeps) share that factory so the tool set
 * can never drift between entry points.
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
import { createAciExecutor, createPermissionPolicy } from "./aci/index.js";
import { createDefaultAciRegistry } from "./aci/tools/registry.js";
import type { Registry } from "./tools/types.js";
import { homedir } from "node:os";
import type { AskUser } from "./permission/types.js";
import type { IknowEnv } from "../config/env.js";
import { ValidationError } from "../shared/errors.js";
import {
  createIknowSystemResolver,
  initIknowWorkspaceSafe,
} from "./identity/index.js";
import {
  resolveProjectMemoryDir,
  createSystemResolver,
} from "./memory/index.js";

export type BuildEngineOpts = {
  readonly env: IknowEnv;
  readonly askUser: AskUser;
  /** Process working directory used as the soft sandbox root for fs tools. */
  readonly sandboxRoot?: string;
  /** #196 IKNOW T4:入口 surface(默认 "chat" 守 CLI 主路径;仅 chat/tui 激活 BOOTSTRAP)。 */
  readonly surface?: "chat" | "tui" | "ask" | "serve";
  /** #194 T6:memory 层开关(默认 true)。ask 入口显式 memory:{enabled:false}
   *  剥离 memory 工具(registry 8 件)+ memory_layer 段不装配。 */
  readonly memory?: { readonly enabled: boolean };
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
  const surface = opts.surface ?? "chat";
  // #194 T6:memory 开关(ask 显式关)。memoryDir = 项目命名空间记忆库根。
  const memoryEnabled = opts.memory?.enabled !== false;
  const memoryDir = resolveProjectMemoryDir(process.cwd());
  const sandboxRoot = opts.sandboxRoot ?? process.cwd();
  // 10 件工具集 SSOT 工厂(append-only 顺序;env.web 透传 IKNOW_WEB_PROXY /
  // IKNOW_WEB_SEARCH_URL)。proxyUrl 非法 → 装配期同步抛(见 registry.ts)。
  // #194 T6:reg 按 memoryEnabled 条件化构造 — enabled 时传 memoryDir(reg.inner 10
  // 件,含 memory_recall + memory_save);disabled(ask)时不传 memoryDir(reg.inner 8
  // 件)。registry / executor / catalog 因此三方一致,不再手工过滤(SC9 保留
  // `memoryEnabled ? ... : undefined` 形态)。
  const reg = createDefaultAciRegistry({
    env,
    sandboxRoot,
    ...(memoryEnabled ? { memoryDir } : undefined),
  });
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

  // registry 单源:reg.inner 已是按 memoryEnabled 条件化的最终视图(8 或 10 件)。
  // deps.registry / executor / catalog 三方一致 — ask 入口自然不含 memory 工具。
  const registryTools: Registry = reg.inner;

  // #196 IKNOW T4:启动时 eager + idempotent 初始化 ~/.iknow/(initIknowWorkspaceSafe
  // 内部 try/catch + warn,失败不阻塞装配 — 守 spec Boundaries Always 降级契约)。
  await initIknowWorkspaceSafe();
  const deps: LoopEngineDeps = {
    adapter,
    executor,
    registry: registryTools,
    maxTurns: 6,
    timeoutMs: env.llm.timeoutMs,
    // #196 IKNOW T4:每 turn 装配 identity/soul/user_profile/bootstrap + memory_layer。
    // deps.system 注入缝装配点(loop-engine 每 turn 调 deps.system?.() 透传
    // adapter.step request.system)。#194 T6:双层系统缝 — deps.system 始终挂
    // createIknowSystemResolver;memoryEnabled=true 时注入 memoryResolver 装配
    // memory_layer 段,false 时 memory_layer 段静默(ask 仍走 identity 4 段)。
    system: createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: homedir(),
      surface,
      memoryEnabled,
      ...(memoryEnabled
        ? {
            memoryResolver: createSystemResolver({
              cwd: process.cwd(),
              userHome: homedir(),
              memoryDir,
            }),
          }
        : {}),
    }),
  };
  return { deps, engine: createLoopEngine(deps) };
}
