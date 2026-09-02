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
  withTransportRetry,
  translateAnthropicTransportFault,
  type LoopEngineDeps,
} from "./index.js";
import { createAciExecutor } from "./aci/index.js";
import {
  setActiveExtraSecrets,
  clearActiveExtraSecrets,
} from "./sandbox/env-isolation.js";
import { createPermissionPolicy } from "./permission/policy.js";
import type { PermissionModeContext } from "./permission/modes.js";
import type { GraphModeContext } from "./graph/mode.js";
import { createGraphAssembly, type GraphAssembly } from "./graph/assembly.js";
import { createDefaultAciRegistry } from "./aci/tools/registry.js";
import type { AciRegistry } from "./aci/aci-registry.js";
import { errorMessage } from "./errors.js";
import type { AciCatalog, AciToolDef } from "./aci/types.js";
import { createLspNotifier } from "./lsp/notifier.js";
import { startLspWarmup } from "./lsp/warmup.js";
import { DEFAULT_LSP_IDLE_TIMEOUT_MS } from "./lsp/client.js";
import type { LspCtx } from "./lsp/types.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import type { Registry, ToolCall } from "./tools/types.js";
import type { RegistryImpl } from "./tools/registry.js";
import type { ValidateFunction } from "ajv";
import { homedir } from "node:os";
import path from "node:path";
import type { AskUser, PostToolUseHook } from "./permission/types.js";
import {
  createSecretsGuardHook,
  type HookErrorEvent,
} from "./permission/index.js";
import {
  loadIknowSettings,
  resolveWorktreeOnMutate,
  type IknowSettings,
} from "../config/settings.js";
import {
  createWorktreeIsolationExecutor,
  classifyCall,
  mainCheckoutOf,
  taskWorktreeOwnerOf,
  type MutateClass,
  type WorktreeIsolationHostOpts,
} from "./isolation/worktree-gate.js";
import type { IknowEnv } from "../config/env.js";
import {
  createSecretRegistry,
  type SecretRegistry,
} from "./secret-roundtrip/index.js";
import { ValidationError } from "../shared/errors.js";
import {
  createIknowSystemResolver,
  initIknowWorkspaceSafe,
  type McpServiceSummary,
  type McpToolSummary,
} from "./identity/index.js";
import {
  resolveProjectMemoryDir,
  createSystemResolver,
  createAutoMemoryHook,
  assembleStaticSystemPrompt,
  buildMemoryPrefetchOverlay,
  type AutoMemoryHook,
  type MemoryLiveFlags,
  type OverlayPrefetchFn,
  type PrefetchQueryOpts,
} from "./memory/index.js";
import { createAdapterExtractLlm } from "./auto-memory-wire.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import { createSkillScanner } from "./skill/scanner.js";
import { createSkillCatalog } from "./skill/catalog.js";
import type { SkillCatalog } from "./skill/catalog.js";
import { loadMcpConfig } from "./mcp/config.js";
import { createMcpManager, type McpManager } from "./mcp/manager.js";
import { resolveMcpRoots, type McpRoots } from "./mcp/roots.js";
import {
  resolveInstallRoot,
  resolveSessionRoots,
  type SessionRoots,
} from "./session-roots.js";
import {
  createSubAgentManager,
  type SubAgentManager,
} from "./subagent/manager.js";
import { assessSubagentIsolation } from "./subagent/capability.js";
import { buildWorkerToolSurface } from "./subagent/role.js";
import {
  createDefaultSubAgentSpawn,
  resolveSubagentTraceDir,
} from "./subagent/spawn.js";
import { createNoopTraceService } from "./trace/noop.js";
import type { TraceService } from "./trace/types.js";
import {
  createBackgroundTaskManager,
  defaultBackgroundSpawn,
  type BackgroundTaskManager,
} from "./background/manager.js";
import { resolveTasksDir } from "./background/paths.js";
import { reapStaleTasks } from "./background/stale-reap.js";

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
  /** D-α T3 / ADR-0030: graph 编排 overlay 的会话 holder（Shift+Tab 三态轮
   *  与 `/graph` 翻的是同一个）。在场 = 本入口接了 overlay：`run_graph`
   *  进注册表，可见性与编排段按 `BuiltEngine.graphAssembly` 的 per-round
   *  快照 gate。缺席 = 未接 overlay（ask / 老调用方）→ 工具与段都不存在，
   *  字节级零变化。 */
  readonly graphMode?: GraphModeContext;
  /** #337 T8 测试缝:userHome / cwd 覆盖(默认 homedir() / process.cwd())。 */
  readonly userHome?: string;
  readonly cwd?: string;
  /**
   * ADR-0019 (T2, D1.1/D1.4): per-root state anchor — CLI `--workspace-root`
   * flag / env `IKNOW_WORKSPACE_ROOT`。
   *
   * T4 (plans/worktree-session-roots.md / ADR-0037 §4 amended 2026-08-31):
   * 改绑后宿主把它切到 task worktree，所以它**只在自身不是 task worktree 时**
   * 充当状态锚（记忆库 / tasks 登记）；是树时退到 `sessionRoots.productRoot`
   * —— 这样 `--workspace-root` 重定向仍生效而状态不落进树。本字段留在
   * **写与围栏**一侧：fs-policy 的保护路径与 bwrap bind root（task worktree
   * 位于 `<productRoot>/.iknow/worktrees/…` 之下，若把状态锚设成 productRoot，
   * 树内所有写都会被自己的状态围栏拦死）。
   * `workspaceRoot` **不**加入 `LoopEngineDeps`(ACR minimal-change-verifier)。
   * 缺省 → `resolveWorkspaceRoot({ env: process.env })`(priority chain
   * `[explicit, env, cwd]`;T1 resolver SSOT)。opts.workspaceRoot(CLI 显式)
   * > env > cwd 的优先顺序由 resolver 层保证。
   */
  readonly workspaceRoot?: string;
  /**
   * T5 / worktree-mcp-rebind-lifecycle:稳定主 checkout root。`resolveMcpRoots`
   * 由此派生 `mcpConfigRoot`；跨 rebind 不变。缺省 → 与 `workspaceRoot` 同值
   *（T6 前 hosts 可显式传 `productRoot === workspaceRoot`；本桥保持编译与
   * 既有单根调用可跑）。
   */
  readonly productRoot?: string;
  /**
   * Review (round 2/3): **项目身份根** —— 用户此刻在做的那个项目，跨改绑稳定。
   * 一处钉住，四个消费者共用：项目 `AGENTS.md` / `.iknow/rules` / 项目 skills
   * 的发现根、记忆库命名空间名（`<basename>-<sha1>`）、`read_file` 的主仓只读
   * 放行、以及子代理继承的身份根。
   *
   * 为什么它**不是** `productRoot`：`productRoot` 同时承担 `mcpConfigRoot` 与
   * 状态锚，宿主按 ADR-0019 把它取自 `workspaceRoot`；而 `--workspace-root <dir>`
   * 重定向档下 `<dir>` 不是项目（`dir ≠ cwd`），拿它查身份会让项目自己的
   * `AGENTS.md` / rules / skills 静默消失（今日走的是 `cwd`）。
   *
   * 为什么**不能每次装配现算**：改绑后宿主把 `cwd` 切成 task worktree，现算就只
   * 能退到主 checkout —— 启动 cwd 是仓内子目录时记忆库命名空间会从 `app-<sha1>`
   * 跳到 `<repo>-<sha1>`。宿主在启动装配 opts 里钉一次（rebind 只覆盖 `cwd` /
   * `workspaceRoot`），因此跨改绑不动。
   *
   * 缺省 → `mainCheckoutOf(cwd)`：未改绑时逐字节等于今日的 `cwd`，改绑后退到主
   * checkout 而不是落进树。
   */
  readonly projectIdentityRoot?: string;
  /**
   * T2 (plans/worktree-session-roots.md) 测试缝:iknow 自身安装根。生产缺省
   * → `resolveInstallRoot()`（锚 `import.meta.url`，与会话根、`process.cwd()`
   * 都无关）。单测注入 tmp fixture 以断言 worker bootstrap 不问会话根。
   */
  readonly installRoot?: string;
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
  /**
   * #358 T4 测试缝:subagent manager 配套 TraceService 覆盖注入。生产默认
   * createNoopTraceService() (manager 透传 trace 字段来自各 caller,本缝保持
   * 既有 byte-stable;集成路径在 cli.ts / hub.ts / #371 路由层把 per-conversation
   * JsonlTraceService 注入 manager)。
   */
  readonly subagentTrace?: TraceService;
  /** Crash diagnostics / worker trace root for subagent lifecycle evidence. */
  readonly subagentDiagnosticsDir?: string;
  /** TUI 工具摘要观测缝:透传给 createAciExecutor hooks.postToolUse(chat/serve 不传 → 零变化)。 */
  readonly hooks?: PostToolUseHook;
  /** #126 T5 测试缝:settings 对象覆盖注入(生产默认不传则 loadIknowSettings({ cwd }))。
   *  secrets 段驱动 secrets-guard 装配;测试用 tmp fixture 注入隔离 settings。 */
  readonly settings?: IknowSettings;
  /** #126 T5 测试缝:secrets-guard 构造/运行期 hook 异常观测(production 不传 = 静默)。 */
  readonly onHookError?: (e: HookErrorEvent) => void;
  /**
   * ADR-0037 T3:worktree isolation host 缝（session-api hub 注入）。开关
   * 本体在启动加载点读取（`resolveWorktreeOnMutate(settings)`，硬要求 9）：
   * 仅当 host 提供了 provision 缝 **且** 开关为 true 时才包一层 mutate 门禁
   * executor；否则字节级零变化（默认 OFF）。provision 负责「建 task worktree
   * + 改绑当前会话根」，并按会话锚定 passthrough（T4：已在本会话自己的 task
   * worktree → 同根 no-op 放行；外来 worktree → typed `foreign_worktree`
   * fail-closed），门禁本体见 `harness/isolation/worktree-gate.ts`。
   */
  readonly worktreeIsolation?: WorktreeIsolationHostOpts;
  /** #440 D2 seam:session 作用域 todos.md 目录。host 注入：调用方
   *  (chat-session / session-hub / TUI deps) 根据 conversationId 解析得到
   *  唯一的 per-session 目录；测试可传 mkdtemp 路径隔离。surface === "ask"
   *  路径不传(SC8 oneshot 剥离,与 memory / subagent / skill 编排同形态)。 */
  readonly todoDir?: string;
};

/**
 * settings-hot-reload（T3）：从 env 纯函数构造 Anthropic adapter —— 无 I/O、
 * 无装配副作用。build-engine 整条装配链内部调用它（保持既有行为不变）；
 * hub 的 `reloadFromEnv` 也调用它做 adapter 最小面热重建（不重跑
 * buildHarnessEngine / MCP / subagent / skill）。
 *
 * 返回 `{ client, adapter }`：client 保留给调用方统一关闭句柄
 * （SDK 0.115 无 close API，仅作 APIKey/BaseURL 装载）。
 */
export function createAdapterFromEnv(env: IknowEnv): {
  readonly client: Anthropic;
  readonly adapter: LoopEngineDeps["adapter"];
} {
  const client = new Anthropic({
    apiKey: env.llm.apiKey,
    baseURL: env.llm.baseUrl,
  });
  const adapter = withTransportRetry(
    createRealAnthropicAdapter({
      client,
      model: env.llm.model,
      maxTokens: env.llm.maxOutputTokens,
      temperature: env.llm.temperature,
      // SSOT env→adapter params (#151/#156) and stream arm (#179/#147).
      thinking: buildThinkingParams(env.llm),
      stream: env.llm.stream === "on",
    }),
    { translate: translateAnthropicTransportFault }
  );
  return { client, adapter };
}

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
   * T5:本次装配解析出的双根(`workspaceRoot` + `mcpConfigRoot`)。
   * surface === "ask" 或缺席 MCP 装配时不透出。Hub reload(T7)消费此句柄，
   * 不得再发明 cwd/config 策略。
   */
  readonly mcpRoots?: McpRoots;
  /**
   * T2 (plans/worktree-session-roots.md):本次装配的会话三根 SSOT
   * (`productRoot` / `taskRoot` / `installRoot`，ADR-0037 §4)。所有 surface
   * 都透出——项目身份、per-root 状态与 worker bootstrap 的消费者只问这里，
   * 不再自行拼 `join(cwd, '.iknow', …)` 或读 `process.cwd()`。
   */
  readonly sessionRoots: SessionRoots;
  /**
   * #361 Phase D:动态 MCP 工具全量源(reg.catalog.all() 含 registerExternal
   * 追加的 mcp__* 工具;inner 冻结快照不含)。TUI deps 据此平铺
   * `{ server, tool }[]`(listMcpTools);server 名反解在 deps.ts。
   */
  readonly catalog?: AciCatalog;
  /**
   * D-α T3 / ADR-0030:graph 装配快照句柄（仅 `opts.graphMode` 在场时透出）。
   * host 在每次 `run()` 之前调 `beginRound()` —— 这是「下一次 run() 才生效」
   * 落地的那一下：翻键立刻改 holder，装配面等下一 round。
   */
  readonly graphAssembly?: GraphAssembly;
  /**
   * auto-memory T4 / ADR-0031 D1+D5:自动记忆 host 钩子。**默认缺席** ——
   * 只有 `settings.memory.autoExtract === true || dream === true`、memory 层
   * 在场、且 surface 不是 `ask`(ADR-0010 D3 opt-out)三者同时成立才装配。
   * 缺席时宿主什么都不调,行为与现网逐字节一致。
   */
  readonly autoMemory?: AutoMemoryHook;
  /**
   * auto-memory low-trust read: per-turn prefetch overlay builder. Gated on
   * `autoExtract === true` (not dream-only). Hosts prepend the string onto
   * the user payload; it must never be written to `deps.system`. T1: hosts
   * pass `excludeIds` (session-level dedup) through the second argument.
   */
  readonly overlayMemoryPrefetch?: OverlayPrefetchFn;
  /**
   * TUI live flags for /memory. Present when surface is `tui` and the memory
   * layer is on. The TUI mutates this box on Esc; the hook reads it per turn.
   */
  readonly memoryFlags?: MemoryLiveFlags;
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
  // settings-hot-reload（T3）：adapter 构造收敛到 createAdapterFromEnv 纯函数
  // （build-engine 与 hub.reloadFromEnv 共用，避免漂移）。apiKey 守卫在
  // createAdapterFromEnv 之前（apiKey 缺失时 fail-fast 文案不变）。
  const { adapter } = createAdapterFromEnv(env);
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
  const memoryToolsEnabled = surface !== "ask" && memoryEnabled;
  // #337 T8:userHome / cwd 测试缝(默认 = 真实 homedir() / process.cwd())。
  // 装配期 skill scanner + mcp config 都从这里取 userHome / cwd。
  // 单测用 tmp fixture 注入空 home 隔离真实用户目录,不污染 ~/.iknow。
  const userHome = opts.userHome ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  // ADR-0019 (T2, D1.1):per-root state anchor,priority chain
  // `[opts.workspaceRoot(CLI 显式), env IKNOW_WORKSPACE_ROOT, cwd]`。
  // resolver 是纯函数(existsSync 唯一 IO),typed `WorkspaceRootError`
  // 在 CLI flag 非法时 fail-fast。缺省 = cwd(D1.1 default process.cwd())。
  const workspaceRoot =
    opts.workspaceRoot ??
    resolveWorkspaceRoot({
      cwd,
      env: { [WORKSPACE_ROOT_ENV_KEY]: env.workspaceRoot },
    });
  // T5:非 ask 表面一次 resolveMcpRoots — 同一组 roots 驱动 config /
  // manager cwd / ACI FS root / BuiltEngine.mcpRoots。显式 sandboxRoot
  // 不一致 → root_mismatch（fail-closed，不 spawn）。ask 跳过 resolver，
  // 保留既有 sandboxRoot = opts.sandboxRoot ?? cwd。
  // productRoot 缺省经 `mainCheckoutOf` 推导而不是裸取 workspaceRoot：改绑后
  // 宿主把 workspaceRoot 也切到树上，裸回退会让漏接 productRoot 的宿主从
  // gitignored 的空树读身份 / 落状态（review Medium）。未改绑时两者同值。
  let mcpRoots: McpRoots | undefined;
  let sandboxRoot: string;
  if (surface !== "ask") {
    mcpRoots = resolveMcpRoots({
      workspaceRoot,
      productRoot: opts.productRoot ?? mainCheckoutOf(workspaceRoot),
      ...(opts.sandboxRoot !== undefined
        ? { expectedWorkspaceRoot: opts.sandboxRoot }
        : {}),
    });
    sandboxRoot = mcpRoots.workspaceRoot;
  } else {
    sandboxRoot = opts.sandboxRoot ?? cwd;
  }
  // T2 (plans/worktree-session-roots.md / ADR-0037 §4):会话三根 SSOT。
  // 非 ask 面的根校验仍由上方 `resolveMcpRoots` 承担（`McpLifecycleError`
  // kind 分工对既有调用方不变），这里只把已校验的值按角色归位并补
  // `installRoot`；ask 面没有 MCP resolver，三根解析就是它的校验点。
  //   productRoot → 项目身份 + per-root 状态（跨 rebind 不动）
  //   taskRoot    → 写与工具 cwd（= sandboxRoot，rebind 后是 task worktree）
  //   installRoot → worker bootstrap（锚 import.meta.url，不问会话根）
  const sessionRoots = resolveSessionRoots({
    productRoot:
      mcpRoots?.mcpConfigRoot ??
      opts.productRoot ??
      mainCheckoutOf(workspaceRoot),
    taskRoot: sandboxRoot,
    installRoot: opts.installRoot ?? resolveInstallRoot(),
    // 取值在装配层（宿主钉的值优先，缺席退 cwd），校验在 SSOT —— 显式传空串 /
    // 相对值一律 typed fail-closed，与另外三根同规则。
    //
    // `mainCheckoutOf` 对**两条路径都**生效：身份根不可以是 task worktree。
    // 宿主钉的是启动 cwd，而 exit 后树是保留不删的（ADR-0037 §4），所以操作员
    // 完全可能在一棵遗留树里起 `iknow chat` —— 只归一化 fallback 会让「钉了」
    // 比「没钉」更差：钉住空树 → 项目说明书 / rules / skills 全部消失，而没钉
    // 时反而能回到主仓（review round 4 实测）。
    projectIdentityRoot: mainCheckoutOf(opts.projectIdentityRoot ?? cwd),
  });
  // Review (round 2/3): 项目身份根 —— 身份发现（AGENTS.md / rules / 项目
  // skills / 子代理继承）与记忆库命名空间共用它，**不**用 `productRoot`：后者
  // 取自 `workspaceRoot`，在 `--workspace-root <dir>` 重定向档下不是项目本身。
  const projectIdentityRoot = sessionRoots.projectIdentityRoot;
  // ADR-0019 (T2): memory root 落 `<anchor>/.iknow/memory/<namespace>`。
  // T4 review High-1: 「落哪个根」(anchor) 与「叫什么名」(namespace) 是两个
  // 决策，必须分开推。
  //   anchor    = workspaceRoot，除非它已经是 task worktree（改绑后宿主把
  //               workspaceRoot 也切到树上）—— 那时退回 productRoot。这样
  //               ADR-0019 D1.3 的 `--workspace-root <dir>` 重定向仍然生效，
  //               同时状态永不落进 gitignored 的树。
  //   namespace = `projectIdentityRoot`（宿主启动时钉下的项目身份），未改绑时
  //               逐字节等于今日的 `resolveProjectMemoryDir(cwd, workspaceRoot)`。
  // 反例（回归来源）：两者都取 productRoot 时，`--workspace-root $HOME` 档下
  // productRoot 缺省 = $HOME，同锚下多个项目会塌进同一个命名空间。
  const stateAnchor =
    taskWorktreeOwnerOf(workspaceRoot) === undefined
      ? workspaceRoot
      : sessionRoots.productRoot;
  const memoryDir = resolveProjectMemoryDir(projectIdentityRoot, stateAnchor);
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
  // #126 T5:settings 对象缝（测试注入隔离 settings；生产缺省 loadIknowSettings）。
  // 二期 B7：上移到 LSP 装配之前 —— settings.lsp 注入 LspCtx（工具层超时/
  // 等待 + client idle sweep + disabledServers 过滤）。
  const settings = opts.settings ?? loadIknowSettings({ cwd, home: userHome });
  // #251 LSP 联动缝:edit_file 写盘成功后由装配层注入 lspNotifier.invalidate
  // 作为 registry 的 onEdit 回调(notifier 内部 fire-and-forget + 失败降级,
  // 详见 src/harness/lsp/notifier.ts)。SSOT:LspCtx.directory 必须等于
  // sandboxRoot(LS 工具的 NearestRoot 上界 stop 与 fs 软沙箱同根语义),
  // 否则两者分叉会让同一边界出现两个值。
  // 二期 B7:settings.lsp 四字段注入 LspCtx（全部可选；缺席走工具层/client
  // 缺省 —— requestTimeoutMs 20s / diagnosticsWaitMs 2s / idleTimeoutMs 10min /
  // disabledServers 空）。
  const lspCtx: LspCtx = {
    directory: sandboxRoot,
    ...(settings.lsp?.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: settings.lsp.requestTimeoutMs }
      : {}),
    ...(settings.lsp?.diagnosticsWaitMs !== undefined
      ? { diagnosticsWaitMs: settings.lsp.diagnosticsWaitMs }
      : {}),
    // idle sweep 缺省 10min（plan B5）：settings 未配置时注入缺省值；
    // 显式 0 = 关闭 sweep（负数已被 parse 丢掉）。
    ...(settings.lsp?.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: settings.lsp.idleTimeoutMs }
      : { idleTimeoutMs: DEFAULT_LSP_IDLE_TIMEOUT_MS }),
    ...(settings.lsp?.disabledServers !== undefined
      ? { disabledServers: settings.lsp.disabledServers }
      : {}),
  };
  const lspNotifier = createLspNotifier(lspCtx);
  // lsp-optimization plan T4:fire-and-forget 预热 —— 装配完成即按 sandboxRoot
  // 内文件扩展名探测预 spawn LSP server,消掉首次 lsp_* 调用的 initialize
  // 冷启动。不 await:绝不阻塞 build 主路径;warmup 内部全量 catch(ask 同样
  // 装配 lsp 工具,故不做 surface 区分)。
  startLspWarmup(lspCtx);
  const skillCatalog: SkillCatalog = createSkillCatalog(
    await createSkillScanner({
      userHome,
      // T3:项目 skills 是项目身份 → projectIdentityRoot（跨 rebind 不动）。
      projectIdentityRoot,
      env: process.env,
    }).scan()
  );
  // #356 T6:subagent manager 条件装配 — 与 MCP 同门(surface !== "ask"):
  //   - chat/tui/serve 自建 createSubAgentManager({ spawn: defaultSubAgentSpawn });
  //     opts.subagentManager 测试缝覆盖注入。
  //   - ask 不创建(SC8 守门,oneshot 即用即抛,registry 缺 spawn_subagent /
  //     subagent_result 两件 = 23 件,三方视图一致)。
  // 注:TUI 产品入口 buildTuiDeps(#365 T2)现委托 build-engine({surface:"tui"})
  // 装配,自动继承 subagentManager / shutdown 句柄
  // — chat / tui / serve / ask 四入口共用 SSOT,工具面 25 件永不漂移。
  // (#558 T2): 默认路径不再向 deps.system 注入 coordinator 段,引导落点
  // 收敛到 spawn_subagent 工具 description（T1 SSOT）。装配缝保留:
  // createIknowSystemResolver opts.coordinatorText 显式传入非空字符串
  // 仍渲染段(coordinator-segment.test.ts seam 用例覆盖)。
  // 位置在 registry 装配之前:registry 的 subagentManager opt 在此消费,故放
  // MCP 条件装配段之前(同 surface 条件,语义同形)。
  const subagentManager: SubAgentManager | undefined =
    surface !== "ask"
      ? (opts.subagentManager ??
        // #357 T1: 传入 sandboxRoot 作为子代理收窄校验的父根锚点;
        // 子代理 def.sandboxRoot 必须落在该锚点之下(realpath 防 symlink 逃逸)。
        // #358 T4: trace 注入 (生产默认 NoopTraceService,byte-stable;
        // 测试经 opts.subagentTrace / opts.subagentManager 覆盖)。
        // #358 T2: per-task wallclock 链条中段 — env.subagent.taskTimeoutMs
        // (settings/env 合并已由 T1 在 env 层完成, 此处直接消费; 缺省
        // undefined → manager 回退自己的 7200s 常量)。
        // T4: 并发上限由 env.subagent.maxConcurrentWorkers 透传;缺席时
        // manager 回退默认 15。
        createSubAgentManager({
          spawn: createDefaultSubAgentSpawn({
            ...(opts.subagentDiagnosticsDir !== undefined
              ? { traceDir: opts.subagentDiagnosticsDir }
              : {}),
            workspaceRoot,
            // T3 (plans/worktree-session-roots.md): 干活子代理注入的说明书
            // 是 **主仓上已存在** 的 AGENTS.md 与 rules，不是树上的空拷贝 ——
            // 子进程 cwd 可能是裸树，身份发现不能问它。传的是父会话的项目身份根。
            projectIdentityRoot,
            // T5 (硬要求 6): worker bootstrap（tsx loader）锚 installRoot ——
            // 子进程 cwd 是裸 task worktree 时那里没有 node_modules，cwd 相对
            // 解析会以 `Cannot find package 'tsx'` 崩掉。
            installRoot: sessionRoots.installRoot,
            // T5 (hard req 7): 子代理继承父会话改绑后的根 —— 引擎被重建到
            // task worktree（hub buildProductionEngine / CLI rebuildDeps 把
            // cwd/workspaceRoot 切到 `<repo>/.iknow/worktrees/<convId>`）时，
            // worker 子进程以该根为 cwd 启动；未改绑（主仓根，非 task
            // worktree 形状）时不传 → 子进程继承父进程 cwd，行为与今日逐
            // 字节一致。worker 注册表从不携带 isolation 缝 → 子代理不触发
            // 第二棵树 / 二次 provision（worker-tool-surface 测试钉住）。
            ...(taskWorktreeOwnerOf(workspaceRoot) !== undefined
              ? { sessionRoot: workspaceRoot }
              : {}),
          }),
          sandboxRoot,
          trace: opts.subagentTrace ?? createNoopTraceService(),
          diagnosticsDir:
            opts.subagentDiagnosticsDir ?? resolveSubagentTraceDir(),
          taskTimeoutMs: env.subagent.taskTimeoutMs,
          maxConcurrentWorkers: env.subagent.maxConcurrentWorkers,
        }))
      : undefined;
  // #502 T3:bash background 任务管理器 — 条件装配（surface !== "ask"）：
  //   - chat/tui/serve 生产自建 createBackgroundTaskManager({
  //       tasksDir: resolveTasksDir(workspaceRoot), spawn: defaultBackgroundSpawn })
  //     —— registry 落 <productRoot>/.iknow/tasks（ADR-0021 D1.3）。
  //   - ask 不创建（SC8 oneshot 即用即抛；T4 bash_output/bash_stop 也缺席）。
  //   T4 (ADR-0037 §4): 登记表是 per-root 状态，锚与 memoryDir 同一个
  //   `stateAnchor`（改绑后 = productRoot；未改绑 = workspaceRoot，保住
  //   `--workspace-root` 重定向）—— 改绑后 bash_output / bash_stop 仍看得见
  //   改绑前起的任务，树上不另开一份登记。
  const backgroundManager: BackgroundTaskManager | undefined =
    surface !== "ask"
      ? createBackgroundTaskManager({
          tasksDir: resolveTasksDir(stateAnchor),
          spawn: defaultBackgroundSpawn,
        })
      : undefined;
  // #502 T6:启动 stale 清扫（ADR-0021 D1.5）—— 全 surface（含 ask）执行：
  // 回收 owner_pid 已死的遗留后台任务进程组（残留 json 标 dead + log 追加
  // reap marker）。只处理 owner-dead 记录，starttime 不符 / 无 starttime 保守
  // 跳过；绝不 throw —— 清扫失败以 warn 呈现，启动流程不因清扫阻塞。
  if (typeof process !== "undefined") {
    try {
      const summary = await reapStaleTasks({
        tasksDir: resolveTasksDir(stateAnchor),
      });
      if (summary.reaped.length > 0) {
        console.warn(
          `[build-engine] reaped ${summary.reaped.length} stale background task(s): ${summary.reaped.join(", ")}`
        );
      }
    } catch (err) {
      console.warn(
        `[build-engine] background stale reap skipped: ${errorMessage(err)}`
      );
    }
  }
  // ADR-0037 T3/T4:worktree isolation host 缝 + 开关判定上移到 registry
  // 装配之前 —— T4 的 create-task-worktree ACI 工具与 mutate 门禁共用同一
  // 判定源（isolationEnabled），保证「工具在场 ⇔ 门禁已武装」；开关 OFF 时
  // 工具面与今日逐字节一致。开关只在启动加载点读一次（硬要求 9）。
  // #126 T5:settings 对象缝（测试注入隔离 settings；生产缺省 loadIknowSettings）
  // 已上移至 LSP 装配点之前（二期 B7：settings.lsp 注入 LspCtx），此处沿用
  // 同一份 settings（line 398）。
  const isolationHost = opts.worktreeIsolation;
  const isolationEnabled =
    isolationHost !== undefined && resolveWorktreeOnMutate(settings);
  // #406 T4:secret 处理模式 —— settings.secrets.mode 驱动装配。缺省 = "roundtrip"
  // （识别 + 占位符替换 + bash 还原 + 输出 mask）；"block" = 旧 deny-only
  // preToolUse guard（#126 兼容路径），roundtrip 机制整体关闭。非法值已被
  // settings.parseSecrets 丢弃 → 此处只能见到 "roundtrip" | "block" | undefined。
  const secretsMode: "roundtrip" | "block" =
    settings.secrets?.mode ?? "roundtrip";
  // #406 T2/T4:per-engine secret registry —— 仅 roundtrip 模式构造。
  // 构造期编译 DEFAULT + extras(registry.patterns 冻结)。block 模式不构造：
  // loop-engine 在 secretRegistry 缺席 + secretsMode="block" 时跳过识别,
  // bash 工具拿不到 registry,输出 mask 不覆盖 registry 值。
  let secretRegistry: SecretRegistry | undefined;
  if (secretsMode !== "block") {
    secretRegistry = createSecretRegistry({
      patterns: settings.secrets?.patterns,
    });
  }
  // #406 T3:输出 mask 兜底 —— roundtrip 模式下把 registry 追踪的密钥值写入
  // active extras 槽位（jsonl / format / stream-draft / hub 的
  // `currentSecretValues()` 无参调用即覆盖）。block 模式必须清空槽位,
  // 防止同一进程内前一个 roundtrip engine 残留的 extras 泄漏进 block engine。
  if (secretsMode !== "block") {
    setActiveExtraSecrets(secretRegistry!.values());
  } else {
    clearActiveExtraSecrets();
  }
  // #440 T11 MCP resources 条件化装配:registry 必须先看到 mcpManager，
  // 但 createMcpManager 又需要 `reg.registerExternal`（动态 mcp__* 工具注入
  // 缝）。两层相互依赖 → 用闭包 holder 解：
  //   1. 先声明两个 let 变量作为 holder
  //   2. mcpManager 用 `(defs) => reg!.registerExternal(defs)` 闭包捕获
  //      reg（调用发生在 mcpManager.start() 异步阶段,此时 reg 已构造完）
  //   3. 再构造 reg,传入已定义的 mcpManager（list/read 工具闭包同样捕获
  //      holder,handler 实际调用时拿到 mcpManager）
  let reg: AciRegistry | undefined;
  let mcpManager: McpManager | undefined;
  if (surface !== "ask") {
    // T5:config / manager 只消费上方一次 resolve 的 mcpRoots —— 禁止再读 cwd。
    const config = await loadMcpConfig({
      home: userHome,
      mcpConfigRoot: mcpRoots!.mcpConfigRoot,
    });
    mcpManager = (opts.createMcpManager ?? createMcpManager)({
      config: config.servers,
      workspaceRoot: mcpRoots!.workspaceRoot,
      // 闭包捕获 reg holder — mcpManager.start() 异步触发时 reg 已赋值。
      registerExternal: (defs) => {
        if (!reg) {
          throw new Error(
            "[build-engine] reg not constructed when mcpManager tried to register"
          );
        }
        return reg.registerExternal(defs);
      },
      // #337 reload 缝:manager.reload 先按名撤回旧 server 已注册的 mcp__* 工具,
      // 再重建——不注入则 reload 后 stale 名残留 externalByExt,重名 register
      // 触发 Gate2 duplicate,新 server 工具静默注册失败(与 TUI deps 同款装配)。
      unregisterExternal: (names) => {
        if (!reg) return;
        reg.unregisterExternal(names);
      },
      // #378 根因 B: env 注入连接超时(默认 60_000, 缓解 npx -y cold start)。
      timeoutMsOverride: env.mcp.connectTimeoutMs,
      ...(opts.createMcpClient ? { createClient: opts.createMcpClient } : {}),
    });
    // start() 返回的 promise 仅作错误兜底(start 内部 void allSettled,
    // 但保留 promise 引用便于未来加 await + timeout 收尾)。fire-and-forget。
    void mcpManager.start().catch((err) => {
      console.warn(
        `[build-engine] MCP manager start failed: ${errorMessage(err)}`
      );
    });
  }

  // D-α T3 / ADR-0030:overlay 接了才有 graph 装配面。快照对象是本次
  // 装配的单点 —— registry(工具在不在)、promptTools(露不露)、deps.system
  // (编排段进不进)三处读的都是它，不各读各的 holder。
  const graphAssembly: GraphAssembly | undefined = opts.graphMode
    ? createGraphAssembly(opts.graphMode)
    : undefined;
  reg = createDefaultAciRegistry({
    env,
    sandboxRoot,
    // T3:只读放行项目身份文件所在的主仓（ADR-0037 §1 允许只读主仓）。registry
    // 只把它透给 read_file —— bash / write / edit 拿不到，写不进主仓。
    //
    // 只在**隔离开且已改绑**时放行（review round 3/4）：这条放行是本分支新增
    // 的，"今日"是**不放行**，所以开关 OFF 必须一条都不给（硬要求 5）。门必须
    // 同时看 `isolationEnabled` —— `taskWorktreeOwnerOf` 只是路径形状判断，
    // 单靠它会让一个恰好长得像 `<X>/.iknow/worktrees/<name>` 的 cwd 在隔离
    // 关闭时就拿到沙箱外的读放行。与 T7/T8 缝同一个判定源。
    ...(isolationEnabled &&
    taskWorktreeOwnerOf(sessionRoots.taskRoot) !== undefined
      ? { projectIdentityRoot }
      : {}),
    // D-α T3:run_graph 条件化装配 —— 需要 overlay(graphAssembly)与编排
    // 底座(subagentManager)同时在场;registry 内部同门再判一次。
    ...(graphAssembly ? { graphAssembly } : {}),
    ...(memoryToolsEnabled ? { memoryDir } : undefined),
    skillCatalog,
    ...(subagentManager ? { subagentManager } : undefined),
    // #502 T3:bash background 任务管理器透传（同门条件装配）——bash 工具
    // `background: true` 分支可用（立即返 task_id，不占 tier timer）。
    ...(backgroundManager ? { backgroundManager } : {}),
    // #440 T11 mcpManager 条件化装配:在场时 list_mcp_resources /
    // read_mcp_resource 入注册表(handler 闭包捕获外部 mcpManager holder,
    // 实际调用时取当前值)。
    ...(mcpManager ? { mcpManager } : {}),
    onEdit: (file) => lspNotifier.invalidate(file),
    lspCtx,
    // #406 T3:secret registry 透传 → bash 工具 handler 在 spawn 前还原占位符。
    // secretRegistry 已在上方构造（T2 段），registry 工厂只在 handler 调用时
    // 解引用 opts.secretRegistry（惰性），无循环依赖。
    ...(secretRegistry ? { secretRegistry } : {}),
    // #440 D2/D6 seam：surface !== "ask" 时把 host-injected todoDir 透传
    // 给 registry（todo_write 条件化装配的开关）。ask 不传 → tool 不入注册表
    // （与 memoryEnabled / subagentManager / skillCatalog 同形态）。worker
    // 装配路径 (createWorkerDeps → createDefaultAciRegistry) 不传 todoDir
    // → 所有权边界隔在主 loop 内。
    // (#646 T2: 本 gate 表达式与下方 agentStatusTodoDir 处是同语义的两处
    //  内联 —— 改动任一处需同步另一处。)
    ...(surface !== "ask" && opts.todoDir ? { todoDir: opts.todoDir } : {}),
    // ADR-0019 (T4 / review-fix H3): per-root state anchor threaded into
    // bash + read_file factories so the fs-policy fence protects
    // `<workspaceRoot>/.iknow` at parity with `<home>/.iknow`. Always
    // resolved (opts.workspaceRoot wins; env SSOT `IKNOW_WORKSPACE_ROOT`
    // is read from `env.workspaceRoot`, not raw `process.env`, so
    // `.env` / `.env.local` overrides ride the same surface). Spread-guard
    // keeps the legacy callers (no opts.workspaceRoot, no env var) on
    // their `sandboxRoot` fallback inside registry.ts.
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(opts.subagentDiagnosticsDir
      ? { traceDir: opts.subagentDiagnosticsDir }
      : {}),
    // ADR-0037 T4:创建工作树 ACI 工具的条件化装配 —— 与 mutate 门禁同一
    // 判定源（isolationEnabled，见上方上移注释）；host provision 缝透传给
    // registry，handler 闭包绑定 sandboxRoot = 会话当前根。OFF / worker /
    // hub-less 入口不透传 → 工具不入注册表（Gate 3 镜像过滤）。
    ...(isolationEnabled && isolationHost
      ? {
          worktreeProvision: isolationHost.provision,
          // T7:enter 缝在场时透传（与 provision 同一 isolationEnabled 判定源）；
          // 缺席（TUI 只接 provision）→ enter-task-worktree 不入注册表。
          ...(isolationHost.worktreeEnter
            ? { worktreeEnter: isolationHost.worktreeEnter }
            : {}),
          // T8:exit 缝在场时透传（同一 isolationEnabled 判定源）；缺席 →
          // exit-task-worktree 不入注册表。
          ...(isolationHost.worktreeExit
            ? { worktreeExit: isolationHost.worktreeExit }
            : {}),
        }
      : {}),
  });
  // ADR-0040: the parent catalog is not the worker surface. Rebuild the
  // worker registry through the same factory with the worker-only option
  // shape (no parent managers, state tools, or worktree host seams), then
  // apply the worker deny-list path in the classifier below. This keeps
  // host-only write-category tools such as create-task-worktree and bash_stop
  // out of the isolation decision without maintaining a second exclusion list.
  const workerBaseTools = isolationEnabled
    ? createDefaultAciRegistry({
        env,
        sandboxRoot,
        skillCatalog,
        lspCtx,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      }).catalog.all()
    : [];
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
  // #126 T5 / #406 T4:secrets guard 产品装配 —— 仅 mode:"block"（legacy
  // deny-only 路径）装配 preToolUse(Step 1 最早短路):密钥形态在权限层之前拦截,
  // 与既有 opts.hooks(postToolUse,Step 5 观测)互补不重叠。
  //   - secrets.enabled 缺失 → 默认 true(内置集生效);enabled:false → guard 透明。
  //   - secrets.patterns 缺失/空 → 内置默认集;追加的自定义 pattern 构造期编译,
  //     非法正则剔除 + onHookError 告警,不毒化 guard(spec Constraints (a))。
  //   - 默认 roundtrip 模式 → guard 不装配（识别 + 占位符替换 + 还原替代拦截）。
  const secretsGuard =
    secretsMode === "block"
      ? createSecretsGuardHook({
          ...(settings.secrets ? { ...settings.secrets } : {}),
          ...(opts.onHookError ? { onHookError: opts.onHookError } : {}),
        })
      : undefined;
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser,
    hooks: {
      ...(secretsGuard ? { preToolUse: secretsGuard } : {}),
      ...(opts.hooks ? { postToolUse: opts.hooks } : {}),
    },
  });

  // T1 / plans/worktree-live-task-root.md §6 T1 — fold-in: the workspace-
  // mutation classifier SSOT lives in `classifyCall` (worktree-gate.ts) and
  // routes on `FILE_WRITE_TOOL_NAMES` (symbol-mutate.ts). This override only
  // adds the spawn_subagent-specific role-aware decision (ADR-0040); for
  // every other tool name it composes with the SSOT, so there is no second
  // truth source for "does this tool write the workspace".
  //
  // ADR-0040 / T4: `spawn_subagent` is read-only only when the child's
  // effective capability surface passes both dimensions from capability.ts.
  // The role default mirrors spawn-subagent-tool.ts; malformed role values
  // are deliberately mapped to an unknown role so the classifier stays
  // fail-closed before the inner executor performs schema validation.
  const classifyWithSubagentIsolation = (call: ToolCall): MutateClass => {
    if (call.name !== "spawn_subagent") return classifyCall(call);
    const input = (call.input ?? {}) as Record<string, unknown>;
    const rawRole = input.subagent_type;
    const role =
      rawRole === undefined
        ? "general-purpose"
        : typeof rawRole === "string"
          ? rawRole
          : "__invalid_subagent_type__";
    const disallowedTools = Array.isArray(input.disallowedTools)
      ? (input.disallowedTools as ReadonlyArray<string>)
      : undefined;
    const effectiveWorkerTools = buildWorkerToolSurface(
      workerBaseTools,
      disallowedTools
    );
    const decision = assessSubagentIsolation({
      role,
      availableTools: effectiveWorkerTools.map((tool) => tool.name),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
    });
    return decision.conclusion === "readonly" ? "read" : "mutate";
  };

  // ADR-0037 T3:mutate 门禁（harness executor 缝）。开关判定已上移（同一
  // isolationEnabled 同时驱动 T4 create-task-worktree 工具的条件化装配，
  // 见上方 registry 调用）；host 缝（provision / initiallyBound）由
  // session-api hub 注入。OFF / host 缺席 → 不包装，行为与今日逐字节一致。
  const loopExecutor = isolationEnabled
    ? createWorktreeIsolationExecutor({
        enabled: true,
        root: sandboxRoot,
        provision: isolationHost.provision,
        // T4: passthrough 锚定交给 provision 按会话裁决（own task tree →
        // 同根 no-op;外来根 → typed foreign_worktree）——host 缝不再携带
        // conversation-agnostic 的 initiallyBound（per-root 引擎可服务多个
        // 会话，引擎级 bound 标记会把别会话的 mutate 一并放行）。
        classify: classifyWithSubagentIsolation,
        inner: executor,
      })
    : executor;

  // registry 单源:reg.inner 已是按 memoryEnabled 条件化的最终视图(8 或 10 件)。
  // deps.registry / executor / catalog 三方一致 — ask 入口自然不含 memory 工具。
  const registryTools: Registry = reg.inner;

  // #196 IKNOW T4 + issue #584: eager + idempotent 初始化全局 identity
  // workspace(initIknowWorkspaceSafe 内部 try/catch + warn,失败不阻塞装配)。
  // Persona always seeds `<userHome>/.iknow` (userHome is the test seam;
  // workspaceRoot / cwd must not receive user.md).
  await initIknowWorkspaceSafe({
    workspace: path.join(userHome, ".iknow"),
  });
  // #337 T8:MCP 条件化装配。四入口判定（#440 T11 已上移到 registry call 之前,
  // 详见上方 mcpManager 块 + holder 模式 — 此处仅保留历史注释锚点）。
  //   - surface === "ask" → 不创建 manager(SC12 守门,ask 三方视图零 mcp__*)。
  //   - surface ∈ {chat, tui, serve} → loadMcpConfig 两级合并 + createMcpManager
  //     + start() **不 await**(SC8 守门:慢 connect 不阻塞 buildHarnessEngine
  //     返回)。manager.start() 内部 void Promise.allSettled,fire-and-forget;
  //     我们 capture 但不 await,确保返回时间只取决于 registry 装配期(快)。
  //   shutdown 句柄透出 BuiltEngine.shutdown,RuntimeBundle 生命周期钩子
  //   (cli.ts SIGINT/SIGTERM 接线)在进程退出前调它,manager 关闭所有 client +
  //   取消 in-flight + SIGTERM stdio 子孙(SC11)。
  // #631 T2:MCP 概览段快照源 —— deps.system 每 turn 装配期现读
  // (manager.status() × catalog mcp__* 工具),不阻塞异步连接。
  // const 别名:闭包内保留 narrowing(let 绑定进闭包会被 TS 重新加宽)。
  const mcpSnapshotSource = mcpManager;
  const mcpSnapshotCatalog = reg.catalog;
  // #645 T1 / #646 T2 单一 gate 表达式:同一条件 (surface !== "ask" 且 host
  // 注入 todoDir) 同时驱动 loop 注入缝 (deps.agentStatus,栏以 user 消息追加)
  // 与 system 读规则段 (resolver opts.agentStatusReadRule,ADR-0028 的那句
  // 稳定读法) —— 两处永远同门,不会漂移;ask / todoDir 缺席 → 栏与读规则
  // 都缺席。(同语义表达式还在上方 registry todoDir seam 内联一次,改动需同步。)
  const agentStatusTodoDir: string | undefined =
    surface !== "ask" && opts.todoDir ? opts.todoDir : undefined;
  const deps: LoopEngineDeps = {
    adapter,
    executor: loopExecutor,
    registry: registryTools,
    // #406 T2:secretRegistry 注入 deps(roundtrip 模式在场时 loop-engine
    // run() 对用户文本做占位符替换;block 模式缺席 → 跳过识别)。
    ...(secretRegistry ? { secretRegistry } : {}),
    // #406 T4:block 模式显式注入 secretsMode —— loop-engine 识别层据此跳过
    // recognize(见 loop-engine.ts:1300)。roundtrip 缺省 = undefined(零变化)。
    ...(secretsMode === "block" ? { secretsMode: "block" as const } : {}),
    // plan T5-engine / ADR-0012:env 优先(CLI --max-turns 由 surface 注入);
    // undefined = 无限(默认),长程探索不被 turn 计数误杀。
    maxTurns: env.llm.maxTurns,
    detectToolLoop: env.loop?.detectToolLoop !== false,
    timeoutMs: env.llm.timeoutMs,
    // #742 T1:流式臂双钟透传。条件 spread —— 字段缺席时 loop-engine 退回
    // 今日单钟(改前行为逐字节不变);流式臂门禁在 loop-engine 侧按
    // adapter.streamMode 判定,装配层不重复判一次。
    ...(env.llm.idleTimeoutMs !== undefined
      ? { modelIdleTimeoutMs: env.llm.idleTimeoutMs }
      : {}),
    ...(env.llm.hardCapMs !== undefined
      ? { modelHardCapMs: env.llm.hardCapMs }
      : {}),
    // #224 注入装配 — 把 reg.visibleSchemas（含 discovered lazy 工具）注入到
    // promptTools；fallback 路径（缺省回退 deps.registry.list()）由 loop-engine
    // 处理；本期 visibleSchemas ≡ 全量（无 lazy 工具），字节级零变化。
    // D-α T3 / spec SC2:overlay 在场时 promptTools 按本 round 的 graph
    // 快照过滤 —— 关图那次 run() 的可见工具名不含 run_graph,同 round 内
    // 翻键也不改本 round(快照只在 beginRound 更新)。overlay 缺席 → 原样
    // 透传 reg.visibleSchemas(引用相同,字节级零变化)。
    promptTools: graphAssembly
      ? (): ReadonlyArray<import("./tools/types.js").ToolDef> => {
          const visible = reg!.visibleSchemas();
          return graphAssembly.enabled()
            ? visible
            : visible.filter((t) => t.name !== "run_graph");
        }
      : reg.visibleSchemas,
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
      // cwd 只喂 "Project path" 展示段（模型要知道自己真实在哪写）；
      // 项目身份发现走 projectIdentityRoot（T3 / ADR-0037 §4）。
      cwd,
      projectIdentityRoot,
      userHome,
      workspaceRoot,
      surface,
      memoryEnabled: memoryToolsEnabled,
      ...(memoryToolsEnabled
        ? {
            memoryResolver: createSystemResolver({
              projectIdentityRoot,
              userHome,
              // ADR-0019 (T2):memoryResolver ctx 也带 workspaceRoot —
              // refresh discover + assemble 的 user-scope 物理根同源。
              workspaceRoot,
              memoryDir,
              ...(settings.memory?.autoExtract === true
                ? { autoExtract: true }
                : {}),
            }),
          }
        : {}),
      skills: () =>
        skillCatalog.available().map((entry) => ({
          name: entry.name,
          description: entry.description ?? "",
          ...(entry.disabled ? { disabled: true } : {}),
        })),
      // #631 T2:MCP 概览段注入缝(渐进式披露"索引常驻档")—— 仅 mcpManager
      // 在场(chat/tui/serve)时注入;ask 无 manager → 缝缺席 → 段缺席
      // (字节级零变化,守 KV 缓存稳定契约)。每 turn 装配期快照:异步连接
      // 的服务连上后下一 turn 自然出现。
      ...(mcpSnapshotSource
        ? {
            mcp: () =>
              projectMcpServiceSummaries(
                mcpSnapshotSource,
                mcpSnapshotCatalog.all()
              ),
          }
        : {}),
      // #558 T2: 默认路径停止注入 coordinator 段 — 引导落点收敛到
      // spawn_subagent 工具 description (T1 SSOT)。装配缝保留:
      // 调用方可显式传入 coordinatorText 让 createIknowSystemResolver 渲染该段
      // (coordinator-segment.test.ts seam 用例覆盖)。
      // #646 T2: agent-status 读规则段 gate —— 与下方 deps.agentStatus 同一
      // agentStatusTodoDir 表达式派生 (栏在场的表面才装配读规则句)。
      ...(agentStatusTodoDir ? { agentStatusReadRule: true } : {}),
      // D-α T3:编排段与 run_graph 的可见性读同一个 round 快照 —— 段与
      // 工具永远同进同出,不会出现「讲了 run_graph 但工具没露」。
      ...(graphAssembly
        ? { orchestration: (): boolean => graphAssembly.enabled() }
        : {}),
    }),
    // #119 T7:env.compress 透传 → deps.compress(LoopEngineDeps.compress 可选缝)。
    // IknowCompressEnv 必填(contextWindow / thresholdTokens),缺失即压缩关闭由
    // loop-engine 字段缺席兜底;此处无条件透传,类型安全(window 默认 200000 由 env 层兜底)。
    compress: {
      contextWindow: env.compress.contextWindow,
      thresholdTokens: env.compress.thresholdTokens,
    },
    // #645 T1 / ADR-0028:状态栏注入缝 —— surface !== "ask" 且 host 注入
    // todoDir 时在场(与上方 todo_write 注册同门,复用同一 session 目录);
    // loop-engine 据此在每次模型调用前以 user 消息追加现势栏。ask 表面
    // 缺席;worker 装配路径(createWorkerDeps 独立构造 deps)不经过本层,
    // 自然缺席。hub 的 per-run runDeps 展开 build-engine deps,serve 自动
    // 继承;TUI 经 buildTuiDeps(surface "tui" + todoDir)继承。
    // #646 T2:gate 上移为 agentStatusTodoDir 单一表达式,与上方 resolver
    // 的 agentStatusReadRule 同源(两处不漂移)。
    ...(agentStatusTodoDir
      ? { agentStatus: { todoDir: agentStatusTodoDir } }
      : {}),
    // #653 G1 T5 / DESIGN-ENVIRONMENT-PRESENT:环境现势事件缝 —— 仅 tui
    // surface 注入(人读 chrome 的数据源;cwd 来源 = build-engine 已解析的
    // workspaceRoot 优先,回退 cwd)。ask / chat / serve / worker 缺席 →
    // 零 IO、零事件(byte-identical)。readEnvSnapshot 永不 throw,事件只给
    // 宿主 UI,不进 messages / verify / ADR-0028 栏。
    ...(surface === "tui"
      ? { envSnapshot: { cwd: workspaceRoot ?? cwd } }
      : {}),
  };
  const engine = createLoopEngine(deps);
  // auto-memory T4 / ADR-0031 D1+D5:三重同门 —— 显式 opt-in、memory 层在场、
  // 非 ask 表面。任一不成立 → 钩子缺席,宿主侧零调用、零 LLM、零写盘。
  // TUI 例外：层在场时始终装配钩子 + live flags，让 /memory 能在本会话翻转。
  // 读路径预取只跟 autoExtract（dream-only 不灌用户消息）。
  const autoExtractOn = settings.memory?.autoExtract === true;
  const dreamOn = settings.memory?.dream === true;
  const memoryFlags: MemoryLiveFlags = {
    autoExtract: autoExtractOn,
    dream: dreamOn,
  };
  const tuiLive = surface === "tui" && memoryEnabled;
  const autoMemory =
    memoryEnabled && surface !== "ask" && (autoExtractOn || dreamOn || tuiLive)
      ? createAutoMemoryHook({
          memoryDir,
          llm: createAdapterExtractLlm(adapter),
          enabled: autoExtractOn,
          dream: dreamOn,
          flags: memoryFlags,
          staticLayer: () =>
            assembleStaticSystemPrompt({
              projectIdentityRoot,
              userHome,
              workspaceRoot,
            }),
          onError: (error) => {
            console.warn(
              `[memory/auto] ingest skipped: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          },
        })
      : undefined;
  const overlayMemoryPrefetch =
    memoryEnabled && surface !== "ask" && (autoExtractOn || tuiLive)
      ? async (
          query: string,
          prefetchOpts?: PrefetchQueryOpts
        ): Promise<string> => {
          if (memoryFlags.autoExtract !== true) return "";
          try {
            return await buildMemoryPrefetchOverlay({
              memoryDir,
              query,
              excludeIds: prefetchOpts?.excludeIds,
            });
          } catch (error) {
            // EXIT: log-and-continue — missing prefetch must not fail the turn.
            console.warn(
              `[memory/prefetch] overlay skipped: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
            return "";
          }
        }
      : undefined;
  return {
    deps,
    engine,
    ...(autoMemory ? { autoMemory } : {}),
    ...(overlayMemoryPrefetch ? { overlayMemoryPrefetch } : {}),
    ...(tuiLive ? { memoryFlags } : {}),
    ...(subagentManager ? { subagentManager } : {}),
    // #337 T8 / #361 Phase D:透出 skillCatalog + mcpManager + catalog,供
    // TUI deps 构建扩展面(TuiExtensions.skillCatalog / mcp.status / mcp.reload /
    // listMcpTools)。全 surface 通用装配件,非 TUI 专用 — 不改变既有消费方。
    skillCatalog,
    ...(mcpManager ? { mcpManager } : {}),
    ...(mcpRoots ? { mcpRoots } : {}),
    sessionRoots,
    catalog: reg.catalog,
    // D-α T3:host 每次 run() 前调 beginRound() 拍快照(chat / hub 两处 run
    // 入口)。缺席 = 本入口没接 overlay。
    ...(graphAssembly ? { graphAssembly } : {}),
    // #356 T6:shutdown 组合 MCP + subagent + background 三清理。SC12 顺序:
    // mcpManager first → subagentManager second(两者无共享可变状态,Promise.all
    // 并发触发;顺序仅语义标注,非严格串行 — ask 入口三者都缺席时 shutdown 也
    // 缺席)。#502 T6:backgroundManager.shutdown() 加入 —— 杀遗留后台进程组,
    // 与 MCP/subagent 无共享可变状态,可安全并入 Promise.all。
    ...(mcpManager || subagentManager || backgroundManager
      ? {
          shutdown: async (): Promise<void> => {
            await Promise.all([
              mcpManager?.shutdown(),
              subagentManager?.shutdown(),
              backgroundManager?.shutdown(),
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

/**
 * #631 T2 — MCP 概览段投影（deps.system 注入缝的装配侧,纯只读快照）。
 *
 * 数据源（均为既有导出面,不改 manager 行为）：
 *   - `manager.status()` → 服务名 + 状态机快照（装配层只渲染 connected）；
 *   - `catalogTools`（reg.catalog.all(),含 registerExternal 注入的
 *     `mcp__<service>__<tool>` 动态工具）→ 工具名 + description。
 *
 * 工具按 `mcp__<server.name>__` 前缀归属服务 —— 与注册侧形态一致：
 * mcp/manager.ts registerTools 用原始服务名 + 仅工具段被 `sanitize`
 * （`mcp__${slot.config.name}__${sanitize(t.name)}`），故此处不得
 * sanitize 服务名，否则含特殊字符的服务其工具会静默漏出概览。
 * 每装配周期调一次,不 await 任何连接。
 */
function projectMcpServiceSummaries(
  manager: McpManager,
  catalogTools: ReadonlyArray<AciToolDef>
): ReadonlyArray<McpServiceSummary> {
  return manager.status().map((server) => {
    const prefix = `mcp__${server.name}__`;
    const tools: McpToolSummary[] = [];
    for (const def of catalogTools) {
      if (!def.name.startsWith(prefix)) continue;
      tools.push(
        def.description.length > 0
          ? { name: def.name, description: def.description }
          : { name: def.name }
      );
    }
    return { name: server.name, state: server.state, tools };
  });
}
