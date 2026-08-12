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
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  createRealAnthropicAdapter,
  buildThinkingParams,
  createExecutor,
  createLoopEngine,
  type LoopEngineDeps,
} from "./index.js";
import { createAciExecutor } from "./aci/index.js";
import { createPermissionPolicy } from "./permission/policy.js";
import type { PermissionModeContext } from "./permission/modes.js";
import { createDefaultAciRegistry } from "./aci/tools/registry.js";
import type { AciCatalog } from "./aci/types.js";
import { createLspNotifier } from "./lsp/notifier.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import type { Registry } from "./tools/types.js";
import type { RegistryImpl } from "./tools/registry.js";
import type { ValidateFunction } from "ajv";
import { homedir } from "node:os";
import path from "node:path";
import type { AskUser, PostToolUseHook } from "./permission/types.js";
import {
  createSecretsGuardHook,
  type HookErrorEvent,
} from "./permission/index.js";
import { loadIknowSettings, type IknowSettings } from "../config/settings.js";
import type { IknowEnv } from "../config/env.js";
import { ValidationError } from "../shared/errors.js";
import {
  createIknowSystemResolver,
  initIknowWorkspaceSafe,
} from "./identity/index.js";
import { IKNOW_COORDINATOR_TEXT } from "./identity/assemble.js";
import {
  resolveProjectMemoryDir,
  createSystemResolver,
} from "./memory/index.js";
import { createSkillScanner } from "./skill/scanner.js";
import { createSkillCatalog } from "./skill/catalog.js";
import type { SkillCatalog } from "./skill/catalog.js";
import { loadMcpConfig } from "./mcp/config.js";
import { createMcpManager, type McpManager } from "./mcp/manager.js";
import {
  createSubAgentManager,
  type SubAgentManager,
} from "./subagent/manager.js";
import { defaultSubAgentSpawn } from "./subagent/spawn.js";

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
  /** Optional session-level policy source. When provided, served sessions can
   *  accumulate "always-allow" rules via the web SPA so the user does not have
   *  to re-confirm the same tool each turn. Memory-only (no disk persistence);
   *  cleared when the server restarts. */
  readonly session?: import("./permission/types.js").SessionGrantsPolicySource;
  /** W2: permission mode context (default / plan / full_auto). REPL slash
   *  command flips this in place without rebuilding the engine. */
  readonly permissionMode?: PermissionModeContext;
  /** #337 T8 测试缝:userHome / cwd 覆盖(默认 homedir() / process.cwd())。 */
  readonly userHome?: string;
  readonly cwd?: string;
  /** #337 T8 测试缝:MCP client 工厂覆盖(注入 stub,SC8 慢 connect 断言)。 */
  readonly createMcpClient?: (
    server: import("./mcp/config.js").McpServerConfig
  ) => import("./mcp/manager.js").McpClientHandle;
  /**
   * #378 测试缝:createMcpManager 工厂覆盖。与 deps.ts 对偶——测试经此
   * 捕获 createMcpManager 入参(如 timeoutMsOverride 透传)。
   */
  readonly createMcpManager?: typeof import("./mcp/manager.js").createMcpManager;
  /** #356 T6 测试缝:subagent manager 覆盖注入(生产默认不传则内部自建)。 */
  readonly subagentManager?: SubAgentManager;
  /** TUI 工具摘要观测缝:透传给 createAciExecutor hooks.postToolUse(chat/serve 不传 → 零变化)。 */
  readonly hooks?: PostToolUseHook;
  /** #126 T5 测试缝:settings 对象覆盖注入(生产默认不传则 loadIknowSettings({ cwd }))。
   *  secrets 段驱动 secrets-guard 装配;测试用 tmp fixture 注入隔离 settings。 */
  readonly settings?: IknowSettings;
  /** #126 T5 测试缝:secrets-guard 构造/运行期 hook 异常观测(production 不传 = 静默)。 */
  readonly onHookError?: (e: HookErrorEvent) => void;
};

export type BuiltEngine = {
  readonly deps: LoopEngineDeps;
  readonly engine: ReturnType<typeof createLoopEngine>;
  /** #356 T6:subagent manager 句柄(ask surface 不创建时缺席;T7 host-drain 消费)。 */
  readonly subagentManager?: SubAgentManager;
  /** #337 T8 / #356 T6:MCP + subagent 组合 shutdown 句柄(ask surface 两者皆缺席时
   * 无句柄)。顺序:mcpManager first → subagentManager second(两者无共享可变状态,
   * Promise.all 并发;顺序仅语义标注)。 */
  readonly shutdown?: () => Promise<void>;
  /**
   * #337 T8:skill catalog(全 surface 装配;ask 也装配——SC12 skill 两件在场)。
   * TUI deps 消费其 available()/get() 派生 slash 候选 + 加载正文(deps.ts
   * TuiExtensions.skillCatalog)。chat/serve 缺省不读。
   */
  readonly skillCatalog?: SkillCatalog;
  /**
   * #337 T8 / #361 Phase D:MCP manager 句柄(surface === "ask" 时缺席)。
   * TUI deps 消费 status()/reload() 构建 /mcp 看板扩展面;ask 零 mcp__*。
   */
  readonly mcpManager?: McpManager;
  /**
   * #361 Phase D:动态 MCP 工具全量源(reg.catalog.all() 含 registerExternal
   * 追加的 mcp__* 工具;inner 冻结快照不含)。TUI deps 据此平铺
   * `{ server, tool }[]`(listMcpTools);server 名反解在 deps.ts。
   */
  readonly catalog?: AciCatalog;
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
    // settings-model-extension：key 来源 = settings.llm.apiKey（字面或 ${VAR}）。
    throw new ValidationError(LLM_API_KEY_MISSING_MESSAGE);
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
  // #337 T8:userHome / cwd 测试缝(默认 = 真实 homedir() / process.cwd())。
  // 装配期 skill scanner + mcp config 都从这里取 userHome / cwd。
  // 单测用 tmp fixture 注入空 home 隔离真实用户目录,不污染 ~/.iknow。
  const userHome = opts.userHome ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const memoryDir = resolveProjectMemoryDir(cwd);
  const sandboxRoot = opts.sandboxRoot ?? cwd;
  // 10 件工具集 SSOT 工厂(append-only 顺序;env.web 透传 IKNOW_WEB_PROXY /
  // IKNOW_WEB_SEARCH_URL)。proxyUrl 非法 → 装配期同步抛(见 registry.ts)。
  // #194 T6:reg 按 memoryEnabled 条件化构造 — enabled 时传 memoryDir(reg.inner 10
  // 件,含 memory_recall + memory_save);disabled(ask)时不传 memoryDir(reg.inner 8
  // 件)。registry / executor / catalog 因此三方一致,不再手工过滤(SC9 保留
  // `memoryEnabled ? ... : undefined` 形态)。
  // #337 T8:skill catalog 装配 — scanSkillDirs 读三级目录
  // (~/.iknow/skills → <cwd>/.iknow/skills → IKNOW_SKILL_DIRS),createSkillCatalog
  // 装好后注入 reg 的 skillCatalog opt → registry 含 skill / skill_search 两件
  // (全 surface,ask 也装配 — SC12 守门)。
  // **降级契约**:scanner 自身 try/catch + warn(目录缺失跳过),scan 抛错被
  // createSkillScanner 的 warn 吞掉,build 不阻塞装配。
  // #251 LSP 联动缝:edit_file 写盘成功后由装配层注入 lspNotifier.invalidate
  // 作为 registry 的 onEdit 回调(notifier 内部 fire-and-forget + 失败降级,
  // 详见 src/harness/lsp/notifier.ts)。SSOT:LspCtx.directory 必须等于
  // sandboxRoot(LS 工具的 NearestRoot 上界 stop 与 fs 软沙箱同根语义),
  // 否则两者分叉会让同一边界出现两个值。
  const lspCtx = { directory: sandboxRoot };
  const lspNotifier = createLspNotifier(lspCtx);
  const skillCatalog: SkillCatalog = createSkillCatalog(
    await createSkillScanner({
      userHome,
      cwd,
      env: process.env,
    }).scan()
  );
  // #356 T6:subagent manager 条件装配 — 与 MCP 同门(surface !== "ask"):
  //   - chat/tui/serve 自建 createSubAgentManager({ spawn: defaultSubAgentSpawn });
  //     opts.subagentManager 测试缝覆盖注入。
  //   - ask 不创建(SC8 守门,oneshot 即用即抛,registry 缺 spawn_subagent /
  //     subagent_result 两件 = 23 件,三方视图一致)。
  // 注:TUI 产品入口 buildTuiDeps(#365 T2)现委托 build-engine({surface:"tui"})
  // 装配,自动继承 subagentManager / IKNOW_COORDINATOR_TEXT / shutdown 句柄
  // — chat / tui / serve / ask 四入口共用 SSOT,工具面 25 件永不漂移。
  // 位置在 registry 装配之前:registry 的 subagentManager opt 在此消费,故放
  // MCP 条件装配段之前(同 surface 条件,语义同形)。
  const subagentManager: SubAgentManager | undefined =
    surface !== "ask"
      ? (opts.subagentManager ??
        createSubAgentManager({ spawn: defaultSubAgentSpawn }))
      : undefined;
  const reg = createDefaultAciRegistry({
    env,
    sandboxRoot,
    ...(memoryEnabled ? { memoryDir } : undefined),
    skillCatalog,
    ...(subagentManager ? { subagentManager } : undefined),
    onEdit: (file) => lspNotifier.invalidate(file),
  });
  // #337:动态 registry 包装 —— 让 inner executor 能解析 registerExternal
  // 动态注册的 mcp__ 工具。`reg.inner` 是构造期快照（aci-registry.ts:71），
  // 本身的 `get/getValidator/list` 契约不变（T1 已锁 inner.list() 快照）。
  // 这里我们新建一个 RegistryImpl 视图，list() 仍返回 reg.inner.list()，
  // get()/getValidator() 优先 reg.inner，miss 时查 reg.catalog（动态源）。
  // 动态 def 的 validator 用与 registry.makeAjv 同配置的 ajv 实例现场编译
  // 一次并缓存（Map），避免每次调用重复编译。
  const dynamicExecutorRegistry = createDynamicExecutorRegistry(reg);
  const baseExecutor = createExecutor(dynamicExecutorRegistry);
  // 5-step permission middleware: 危险命令由硬墙无条件拦截(#122)。
  // `createAciExecutor` 内部已装配 permission-executor,不要再外包一层。
  const policy = createPermissionPolicy({
    ...(opts.session ? { session: opts.session } : {}),
    // W2: mode context — REPL toggles this via /permissions; absent → default.
    ...(opts.permissionMode ? { mode: opts.permissionMode } : {}),
  });
  // #126 T5:secrets guard 产品装配 —— settings.secrets 段驱动。
  //   - 缺省 settings 测试缝 → loadIknowSettings({ cwd })(与 userHome/cwd 缝同源)。
  //   - guard 挂 preToolUse(Step 1 最早短路):密钥形态在权限层之前拦截,
  //     与既有 opts.hooks(postToolUse,Step 5 观测)互补不重叠。
  //   - secrets.enabled 缺失 → 默认 true(内置集生效);enabled:false → guard 透明。
  //   - secrets.patterns 缺失/空 → 内置默认集;追加的自定义 pattern 构造期编译,
  //     非法正则剔除 + onHookError 告警,不毒化 guard(spec Constraints (a))。
  const settings = opts.settings ?? loadIknowSettings({ cwd });
  const secretsGuard = createSecretsGuardHook({
    ...(settings.secrets ? { ...settings.secrets } : {}),
    ...(opts.onHookError ? { onHookError: opts.onHookError } : {}),
  });
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser,
    hooks: {
      preToolUse: secretsGuard,
      ...(opts.hooks ? { postToolUse: opts.hooks } : {}),
    },
  });

  // registry 单源:reg.inner 已是按 memoryEnabled 条件化的最终视图(8 或 10 件)。
  // deps.registry / executor / catalog 三方一致 — ask 入口自然不含 memory 工具。
  const registryTools: Registry = reg.inner;

  // #196 IKNOW T4:启动时 eager + idempotent 初始化 ~/.iknow/(initIknowWorkspaceSafe
  // 内部 try/catch + warn,失败不阻塞装配 — 守 spec Boundaries Always 降级契约)。
  // rev 2026-08-11:透传 userHome 缝 — 否则 seed 落到 os.homedir()/真实 home,
  // 而装配 readBootstrapIfNeeded 读 opts.userHome,二者分叉(隔离 HOME 测试
  // 必红 + 污染真实 home)。缺省(CLI 未传 userHome)→ 与 iknowWorkspaceRoot()
  // 同值,行为不变。
  await initIknowWorkspaceSafe(
    userHome === homedir()
      ? undefined
      : { workspace: path.join(userHome, ".iknow") }
  );
  // #337 T8:MCP 条件化装配。四入口判定:
  //   - surface === "ask" → 不创建 manager(SC12 守门,ask 三方视图零 mcp__*)。
  //     ask oneshot 进程即用即抛,无长连接,无需关闭句柄。
  //   - surface ∈ {chat, tui, serve} → loadMcpConfig 两级合并 + createMcpManager
  //     + start() **不 await**(SC8 守门:慢 connect 不阻塞 buildHarnessEngine
  //     返回)。manager.start() 内部 void Promise.allSettled,fire-and-forget;
  //     我们 capture 但不 await,确保返回时间只取决于 registry 装配期(快)。
  //   shutdown 句柄透出 BuiltEngine.shutdown,RuntimeBundle 生命周期钩子
  //   (cli.ts SIGINT/SIGTERM 接线)在进程退出前调它,manager 关闭所有 client +
  //   取消 in-flight + SIGTERM stdio 子孙(SC11)。
  let mcpManager: McpManager | undefined;
  if (surface !== "ask") {
    const config = await loadMcpConfig({ home: userHome, cwd });
    mcpManager = (opts.createMcpManager ?? createMcpManager)({
      config: config.servers,
      registerExternal: reg.registerExternal,
      // #337 reload 缝:manager.reload 先按名撤回旧 server 已注册的 mcp__* 工具,
      // 再重建——不注入则 reload 后 stale 名残留 externalByExt,重名 register
      // 触发 Gate2 duplicate,新 server 工具静默注册失败(与 TUI deps 同款装配)。
      unregisterExternal: reg.unregisterExternal,
      // #378 根因 B: env 注入连接超时(默认 60_000, 缓解 npx -y cold start)。
      timeoutMsOverride: env.mcp.connectTimeoutMs,
      ...(opts.createMcpClient ? { createClient: opts.createMcpClient } : {}),
    });
    // start() 返回的 promise 仅作错误兜底(start 内部 void allSettled,
    // 但保留 promise 引用便于未来加 await + timeout 收尾)。
    void mcpManager.start().catch((err) => {
      console.warn(
        `[build-engine] MCP manager start failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  }
  const deps: LoopEngineDeps = {
    adapter,
    executor,
    registry: registryTools,
    // plan T5-engine / ADR-0012:env 优先(CLI --max-turns 由 surface 注入);
    // undefined = 无限(默认),长程探索不被 turn 计数误杀。
    maxTurns: env.llm.maxTurns,
    timeoutMs: env.llm.timeoutMs,
    // #224 注入装配 — 把 reg.visibleSchemas（含 discovered lazy 工具）注入到
    // promptTools；fallback 路径（缺省回退 deps.registry.list()）由 loop-engine
    // 处理；本期 visibleSchemas ≡ 全量（无 lazy 工具），字节级零变化。
    promptTools: reg.visibleSchemas,
    // #196 IKNOW T4:每 turn 装配 identity/soul/user_profile/bootstrap + memory_layer。
    // deps.system 注入缝装配点(loop-engine 每 turn 调 deps.system?.() 透传
    // adapter.step request.system)。#194 T6:双层系统缝 — deps.system 始终挂
    // createIknowSystemResolver;memoryEnabled=true 时注入 memoryResolver 装配
    // memory_layer 段,false 时 memory_layer 段静默(ask 仍走 identity 4 段)。
    // #337 T6:skills 注入缝(catalog.available() → SkillSummary 投影)。
    // 全 surface 注入(ask 也注入,SC12 守门:skill 工具在场就该让模型知道
    // available skills)。deps.system 内部 disabled 过滤后渲染 <available_skills>
    // 段。
    system: createIknowSystemResolver({
      cwd,
      userHome,
      surface,
      memoryEnabled,
      ...(memoryEnabled
        ? {
            memoryResolver: createSystemResolver({
              cwd,
              userHome,
              memoryDir,
            }),
          }
        : {}),
      skills: () =>
        skillCatalog.available().map((entry) => ({
          name: entry.name,
          description: entry.description ?? "",
          ...(entry.disabled ? { disabled: true } : {}),
        })),
      // #361 T8 subagent coordinator 引导层 — 条件与 registry 同源:
      // subagentManager 装配 (surface !== "ask") 时注入 IKNOW_COORDINATOR_TEXT,
      // ask (无 manager) 不注入 → 装配层段缺席 (字节级零变化)。文案含验收6
      // 关键词 proactive / parallelizable / blocks until finished。
      ...(subagentManager ? { coordinatorText: IKNOW_COORDINATOR_TEXT } : {}),
    }),
    // #119 T7:env.compress 透传 → deps.compress(LoopEngineDeps.compress 可选缝)。
    // IknowCompressEnv 必填(contextWindow / thresholdTokens),缺失即压缩关闭由
    // loop-engine 字段缺席兜底;此处无条件透传,类型安全(window 默认 200000 由 env 层兜底)。
    compress: {
      contextWindow: env.compress.contextWindow,
      thresholdTokens: env.compress.thresholdTokens,
    },
  };
  const engine = createLoopEngine(deps);
  return {
    deps,
    engine,
    ...(subagentManager ? { subagentManager } : {}),
    // #337 T8 / #361 Phase D:透出 skillCatalog + mcpManager + catalog,供
    // TUI deps 构建扩展面(TuiExtensions.skillCatalog / mcp.status / mcp.reload /
    // listMcpTools)。全 surface 通用装配件,非 TUI 专用 — 不改变既有消费方。
    skillCatalog,
    ...(mcpManager ? { mcpManager } : {}),
    catalog: reg.catalog,
    // #356 T6:shutdown 组合 MCP + subagent 两清理。SC12 顺序:mcpManager first →
    // subagentManager second(两者无共享可变状态,Promise.all 并发触发;顺序仅
    // 语义标注,非严格串行 — ask 入口两者都缺席时 shutdown 也缺席)。
    ...(mcpManager || subagentManager
      ? {
          shutdown: async (): Promise<void> => {
            await Promise.all([
              mcpManager?.shutdown(),
              subagentManager?.shutdown(),
            ]);
          },
        }
      : {}),
  };
}

/**
 * #337:动态 registry 包装 —— 给 createExecutor 喂一个能解析 registerExternal
 * 动态注册的 mcp__ 工具的 RegistryImpl 视图。
 *
 * 约束:
 *   - 构造后 reg.inner 冻结（T1 契约，aci-registry-external.test.ts 断言
 *     registerExternal 后 inner.list() 不变）。本包装不修改 inner，仅在
 *     内层 miss 时向上查 reg.catalog（动态源）。
 *   - list() 仍返回 reg.inner.list() 快照（与 T1 一致；createExecutor
 *     内部不依赖 list() 的动态性，验证见 executor.ts 只用 get/getValidator）。
 *   - get()/getValidator() 优先 reg.inner（构造期冻结、零开销），miss 时
 *     走 reg.catalog.get(name)（动态源）；动态 def 的 validator 用与
 *     registry.makeAjv 同配置（strict + allErrors + formats）的 ajv 实例
 *     现场编译一次并缓存。
 *
 * 仅在 build-engine 这一处装配；aci-registry.ts 与 permission-executor.ts
 * 都不动。
 */
function createDynamicExecutorRegistry(
  reg: import("./aci/aci-registry.js").AciRegistry
): RegistryImpl {
  // ajv **惰性**初始化：Ajv.default + addFormats 实例化在构造期很重
  // （实测 ~300ms+），而 SC8 要求 buildHarnessEngine 装配不因 MCP 变慢
  // （慢 connect 不阻塞，单测容差 <200ms）。首次命中动态源才创建。
  let externalAjv: Ajv.default | undefined;
  const dynamicValidatorCache = new Map<string, ValidateFunction>();

  function ensureAjv(): Ajv.default {
    if (externalAjv === undefined) {
      externalAjv = new Ajv.default({ strict: true, allErrors: true });
      addFormats.default(externalAjv);
    }
    return externalAjv;
  }

  return Object.freeze({
    list: () => reg.inner.list(),
    get: (name: string) => reg.inner.get(name) ?? reg.catalog.get(name),
    getValidator: (name: string) => {
      const inner = reg.inner.getValidator(name);
      if (inner !== undefined) return inner;
      // 动态源：仅当 reg.catalog 真有这名字（且 reg.inner 没注册）才编译。
      // reg.catalog.get 已做 byName ∪ externalByExt fallback。
      if (reg.inner.get(name) !== undefined) return undefined;
      const dyn = reg.catalog.get(name);
      if (dyn === undefined) return undefined;
      let v = dynamicValidatorCache.get(name);
      if (v === undefined) {
        v = ensureAjv().compile(dyn.inputSchema);
        dynamicValidatorCache.set(name, v);
      }
      return v;
    },
  });
}
