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
  type ThinkingParams,
} from "./index.js";
import { createAciExecutor } from "./aci/index.js";
import {
  setActiveExtraSecrets,
  clearActiveExtraSecrets,
} from "./sandbox/env-isolation.js";
import { createPermissionPolicy } from "./permission/policy.js";
import { resolveProjectPermissionSource } from "./permission/project-settings.js";
import type { PermissionModeContext } from "./permission/modes.js";
import type { GraphModeContext } from "./graph/mode.js";
import { createGraphAssembly, type GraphAssembly } from "./graph/assembly.js";
import type { LiveGraphLedgerHost } from "./graph/ledger.js";
import type { LastReadLedgerHost } from "./aci/last-read-ledger.js";
import { createDefaultAciRegistry } from "./aci/tools/registry.js";
import type { AciRegistry } from "./aci/aci-registry.js";
import { runOverflowJudge } from "./aci/tool-overflow.js";
import { errorMessage } from "./errors.js";
import type { AciCatalog } from "./aci/types.js";
import { createLspNotifier } from "./lsp/notifier.js";
import { withLazyLspWarmup } from "./lsp/warmup.js";
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
  composePostHooks,
  composePreHooks,
  createPluginHooksFromCatalog,
  createSettingsHookContribution,
} from "./hooks/index.js";
import {
  loadIknowSettings,
  resolveWorktreeExclusive,
  resolveWorktreeOnMutate,
  type IknowSettings,
} from "../config/settings.js";
import { createEgressPolicyFactory } from "./sandbox/egress/assembly.js";
import {
  createWorktreeIsolationExecutor,
  createWorktreeOnMutateHolder,
  classifyCall,
  mainCheckoutOf,
  isTaskWorktreePath,
  type MutateClass,
  type WorktreeGateReader,
  type WorktreeIsolationHostOpts,
  type WorktreeOnMutateHolder,
} from "./isolation/worktree-gate.js";
import {
  wireModelFromRoute,
  type IknowEnv,
  type LlmEnv,
} from "../config/env.js";
import {
  createSecretRegistry,
  type SecretRegistry,
} from "./secret-roundtrip/index.js";
import { ValidationError } from "../shared/errors.js";
import {
  createIknowSystemResolver,
  initIknowWorkspaceSafe,
  createGitSnapshotProvider,
  runIndexDemotion,
  type McpServiceSummary,
  type McpToolSummary,
  type SkillSummary,
  type DeferredInternalToolSummary,
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
  type SystemResolver,
} from "./memory/index.js";
import { createAdapterExtractLlm } from "./auto-memory-wire.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import { createSkillScanner, type PluginSkillDir } from "./skill/scanner.js";
import { createSkillCatalog } from "./skill/catalog.js";
import type { SkillCatalog, SkillCatalogFaces } from "./skill/catalog.js";
import { createSkillRescanner, type SkillRescanner } from "./skill/rescan.js";
import {
  createSkillIndexDeltaSeam,
  type SkillIndexSnapshotEntryShape,
} from "./skill/index-delta.js";
import { resolvePluginCatalog, resolvePluginRoots } from "./plugin/roots.js";
import { loadMcpConfig } from "./mcp/config.js";
import { createMcpManager, type McpManager } from "./mcp/manager.js";
import { resolveMcpRoots, type McpRoots } from "./mcp/roots.js";
import {
  createLiveTaskRoot,
  resolveInstallRoot,
  resolveSessionRoots,
  withLiveTaskRootWrite,
  type LiveTaskRoot,
  type SessionRoots,
} from "./session-roots.js";
import {
  createSubAgentManager,
  type SubAgentManager,
} from "./subagent/manager.js";
import { assessSubagentIsolation } from "./subagent/capability.js";
import type { SkillIndexSnapshotEntry } from "./subagent/envelope.js";
import { buildWorkerToolSurface } from "./subagent/role.js";
import {
  createDefaultSubAgentSpawn,
  resolveSubagentTraceDir,
} from "./subagent/spawn.js";
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
  /**
   * live-graph-phase1 T1 / ADR-0047 / ADR-0051:活图账本 host —— 会话
   * runtime 持有（与 graphMode 平行，非 per-engine 快照），host 负责
   * reset / 会话结束销毁。缺席 = `run_graph` handler 不建账（V1 零行为
   * 变化，与 graphMode 缺席同形态）。
   */
  readonly liveGraphLedger?: LiveGraphLedgerHost;
  /**
   * ADR-0084 / D1:last-read 账本 host（`conversationId → 规范 path`）的可选缝。
   * 默认 = 每个 registry 自建一份（进程内存），写闸照常生效。注入同一实例可
   * 让「本 conversation 读过的 path」跨 rebind 重建的 registry 延续；但当前
   * 生产装配**不注入**，所以按 root 重建引擎后新 registry 从空表开始
   * （spec D1 的 lifetime 规则：表随 registry 同寿）。
   */
  readonly lastReadLedger?: LastReadLedgerHost;
  /** #337 T8 测试缝:userHome / cwd 覆盖(默认 homedir() / process.cwd())。 */
  readonly userHome?: string;
  readonly cwd?: string;
  /**
   * ADR-0019 (T2, D1.1/D1.4): per-root state anchor — CLI `--workspace-root`
   * flag / env `IKNOW_WORKSPACE_ROOT`。
   *
   * T4 (plans/worktree-session-roots.md / ADR-0037 §4 amended 2026-08-31):
   * 改绑后宿主把它切到 task worktree，所以它**只在自身不是 task worktree 时**
   * 充当状态锚（记忆库）；是树时退到 `sessionRoots.productRoot`
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
  /**
   * B4 / ADR-0043 §4 测试缝:装配期 firstTurnReady 窗口覆盖。**缺省 =
   * 30_000ms,即生产契约本身**(见下方 `mcpManager.start()` 调用点的常量
   * 注释)—— 生产调用方(CLI / hub / TUI deps)不传本字段,字节级不变。
   *
   * 为什么需要:缺省窗口要求装配期真等满 30s 才 resolve(未连上的 server
   * 按同会话缺席处理)。测试若要验「窗口到点后行为」,真实等满 30s 会让
   * 单条用例的墙钟与窗口长度绑定。注入小值(如 50ms)让同一条窗口路径快
   * 速走完 —— 被测语义(超时 = 缺席、目录冻结、flip-back 不回写)一字不改,
   * 只是窗口参数变小。
   *
   * 注意:本字段只缩短**外层的窗口轮询**;单 server 自身的 connect 超时
   * 仍由 `env.mcp.connectTimeoutMs` 决定(manager 的 `timeoutMsOverride`)。
   * 窗口 < connect 超时 ⇒ 走「窗口到点即缺席」;窗口 > connect 超时 ⇒
   * server 先标 failed、窗口提前 resolve(终态判定)。两者都是真实路径。
   */
  readonly mcpFirstTurnReadyTimeoutMs?: number;
  /**
   * B6 / ADR-0043 §3 测试缝:装配期 countTokens 覆盖的**旁路**开关。
   *
   * `countTokens` 缺席时装配层退回 `adapter.countTokens`(真 SDK 调用)。
   * 该调用打在 env.llm.baseUrl(测试 fixture 恒为不可达的 127.0.0.1:9999),
   * SDK 自带 `maxRetries=2` + 指数退避 ⇒ 每次装配白白烧 ~2.5s 只为了走到
   * 「Connection error → skip 本会话」这个确定性分支。
   *
   * 置 true = 装配期直接走 countTokens 缺席语义(调用方省略 `countTokens`
   * 与不传本字段同形:溢出判定与索引降档都 skip + warn 一行,全部 deferrable
   * 内建件保持常驻)。用于**不验溢出/索引降档**的装配用例 —— 要验这两条
   * 路径的用例必须显式传 `countTokens` stub(见 build-engine-tool-overflow /
   * disclosure-index-align 两套测试)。
   */
  readonly skipCountTokens?: boolean;
  /** #356 T6 测试缝:subagent manager 覆盖注入(生产默认不传则内部自建)。 */
  readonly subagentManager?: SubAgentManager;
  /**
   * T5 (ADR-0071 / SC8 + L2): 子代理 per-agent
   * trace 归属目录 = `<父会话文件夹>/subagents/`(由 caller 用
   * `resolveSubagentTraceDir({ projectDir, conversationId })` 派生后传入)。
   *
   * 在场时 manager 为每次 spawn 懒建 file-mode JsonlTraceService
   * (`<subagentsDir>/agent-<taskId>.jsonl`, conversationId 钉 taskId) +
   * 一次性 `.meta.json` —— 替换掉既有 `subagentTrace` 聚合单实例注入。
   * 缺席 → 退化为 NoopTrace(同既有 build-engine 缺省形态, byte-stable)。
   *
   * 与旧 `subagentTrace` 的关系:`subagentTrace` (conversationId:"subagent"
   * 聚合单文件) 已退役 —— 所有 caller (cli / hub / tui-deps) 改为传
   * `subagentsDir`。`subagentTrace` 字段在本 commit 后无人引用,留作 seam
   * 仅供尚未迁移的测试用,不再注入 manager。
   */
  readonly subagentsDir?: string;
  /**
   * review-fix (M5):装配期根缝 —— `<baseDir>/projects/<slug>` 形式(serve hub
   * 装配期没有 conversationId,跨会话共享 engine 不重建)。透传给
   * `createSubAgentManager({ projectDir })` —— manager 在 spawn 期按
   * `def.conversationId` 两段式派生 per-conversation 叶子
   * `<projectDir>/<sanitize(convId)>/subagents/`,与 todo-write 的
   * `resolveConversationTodoPath` 同构。与 `subagentsDir` 互斥:两者都传时
   * `subagentsDir` 优先(cli/TUI 形态 byte-stable);生产路径按入口二选一。
   * 缺席且 `subagentsDir` 也缺席 → NoopTrace(同既有 byte-stable)。
   */
  readonly projectDir?: string;
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
  /** #440 D2 seam + #950 T2 / session-folder-consolidation:「会话项目目录」
   *  (`resolveProjectSessionDir(baseDir, projectIdentityRoot)`)。host 注入:
   *  三入口 (chat-session / session-hub / TUI deps) 用同一对
   *  `(baseDir, projectIdentityRoot)` 派生同一根,per-conversationId 文件
   *  路径在调用期由 resolveConversationTodoPath 一处钉死。测试可传 mkdtemp
   *  路径隔离。surface === "ask" 路径不传(SC8 oneshot 剥离,与 memory /
   *  subagent / skill 编排同形态)。 */
  readonly todoDir?: string;
  /**
   * ADR-0088(home 项目树):后台任务登记根
   * (`<poolRoot>/projects/<slug>/tasks/`)的 host 注入缝 —— 与 `todoDir`
   * 同门:host 显式传入已解析的绝对目录,build-engine 不自派生。缺席时回退
   * `resolveTasksDir({ dataDir: <userHome>/.iknow, projectIdentityRoot })`,
   * 即 `resolveServeDataDir()` 的默认池根 —— 保持旧调用方仍可用,且**绝不**
   * 回退到 workspaceRoot(那正是 ADR-0088 要拆掉的 per-root 分片)。
   *
   * 三入口 (cli / hub / TUI deps) 用同一对 `(dataDir, projectIdentityRoot)`
   * 派生同一根 —— 与 `todoDir` 的 SSOT 形态同构,registry 与会话文件夹挂在
   * 同一棵 `<slug>` 下不漂移。
   */
  readonly tasksDir?: string;
  /**
   * ADR-0099(home 项目树 memory):项目记忆库根
   * (`<poolRoot>/projects/<slug>/memory/`)的 host 注入缝 —— 与 `tasksDir`
   * 同门。缺席时回退 `resolveProjectMemoryDir({ dataDir: <userHome>/.iknow,
   * projectIdentityRoot })`。绝不回退 workspaceRoot。
   */
  readonly memoryDir?: string;
  /**
   * B6 / ADR-0043 §3:溢出治理 countTokens 注入缝(测试用)。生产默认 =
   * undefined → 装配层取 `adapter.countTokens`(由 `createRealAnthropicAdapter`
   * 实现,透传 SDK `client.messages.countTokens`)。测试用 stub 覆盖:
   * 直接返 `{ inputTokens: <n> }` 控制阈值判定结果,绕开真实网络/SC7
   * 必依赖。
   *
   * 装配期一次性 await —— `buildHarnessEngine` 在 `await mcpManager.start()`
   * 之后调一次(首轮判定,会话内恒定),后续每轮 `promptTools` 不重测
   * (B4 §2 + B6 plan §8 钉死 "会话中不重算")。
   */
  readonly countTokens?: (input: {
    readonly tools?: ReadonlyArray<unknown>;
    readonly system?: string;
  }) => Promise<{ readonly inputTokens: number }>;
  /**
   * ADR-0092 Amendment 2026-09-13 / SC11/SC12:fs 隔离档 holder —— bash
   * 工厂透传,handler per-call `get()` 读一次。生产装配层由 settings 段
   * `isolation.fsMode` 一次性 resolve 后塞进 holder(T8 在 settings.ts 落地
   * `resolveFsIsolationMode`);T8 之前的入口(此处)仅接 holder 注入缝。
   * 缺席 → 全局档(V1 baseline,bash.ts handler 入口 fsMode 缺省回落)。
   */
  readonly fsMode?: import("./sandbox/fs-mode.js").FsModeContext;
  /**
   * ADR-0096 T2：运行期子代理并发上限 holder —— `BuildEngineOpts` 在场时
   * `createSubAgentManager` 透传给 manager(替代 `env.subagent.maxConcurrentWorkers`
   * 的启动期一次性快照)。在场 = TUI /config 面板 Enter 循环调 `holder.set(...)`
   * 对下一次 spawn 闸值即时生效；缺席 = 走 env/subagent opts 静态值（与既有
   * 行为 byte-equal）。与 `fsMode` 同形态：装配期构造一次、运行期持有、命令
   * 面与引擎面读同一份冻结值。
   *
   * 互斥优先：holder 在场 → 完全使用 holder（spawn 闸每次现读），env 值仅作
   * holder 缺席时的初值兜底；都缺 → 默认 15（既有行为）。
   */
  readonly subagentCapacityHolder?: import("./subagent/manager.js").SubagentCapacityHolder;
  /**
   * ADR-0096 T3 ── `isolation.worktreeOnMutate` 运行期开关 cell。装配期把
   * 启动读数（`resolveWorktreeOnMutate(settings)`）注入 holder 初值，运行期由
   * TUI /config 面板 `set` —— mutate 门禁每次 wave 入口现读 `get()`，翻转对
   * 下一波 tool call 生效（D2 一波一读，波内不重读）。
   *
   * 缺席 → 退回启动期冻结值（`createWorktreeOnMutateHolder(启动读数)`）：门禁
   * 形态与今日逐字节一致，OFF 档零回归。
   *
   * 非对称（有意）：门禁的**拦截与否**跟 holder 走（可 ON→OFF→ON 往复）；
   * 而同一 setting 派生的其它装配期消费点 —— worker write-situation
   * (`isolationOn`)、git 作业纪律段、projectIdentityRoot 读栅、T4 create-
   * worktree 工具装配 —— 仍读启动期冻结值（`isolationOnStartup` / `opts.
   * worktreeIsolation` 在场性）。理由：门禁本身恒被装配（见 loopExecutor
   * 注释），OFF 档拦截读数为假即透明；而 worker 面 / 工具面是装配期结构
   * （registry 成员表），运行期改会动摇「无写入工具 = 只读」的静态面判定。
   * ADR-0096 amends 只授权门禁拦截这一件事。
   */
  readonly worktreeOnMutateHolder?: WorktreeOnMutateHolder;
};

/**
 * settings-hot-reload（T3）：从 env 纯函数构造 Anthropic adapter —— 无 I/O、
 * 无装配副作用。build-engine 整条装配链内部调用它（保持既有行为不变）；
 * hub 的 `reloadFromEnv` 也调用它做 adapter 最小面热重建（不重跑
 * buildHarnessEngine / MCP / subagent / skill）。
 *
 * ADR-0094 SC7（thinking 单工厂）：per-turn thinking 覆盖经 `overrides.thinking`
 * 并入本函数 —— `withThinkingOverride`（session-api）不再自建 Anthropic client
 * 字段表，只在此单点改 thinking 入参；同一 env 下 override / 无 override 两路
 * 解析出同一 client（baseUrl / apiKey / headers）与同一 wire model 形状。
 *
 * 返回 `{ client, adapter }`：client 保留给调用方统一关闭句柄
 * （SDK 0.115 无 close API，仅作 APIKey/BaseURL 装载）。
 */
export function createAdapterFromEnv(
  env: { readonly llm: LlmEnv },
  overrides?: { readonly thinking?: ThinkingParams }
): {
  readonly client: Anthropic;
  readonly adapter: LoopEngineDeps["adapter"];
} {
  const client = new Anthropic({
    apiKey: env.llm.apiKey,
    baseURL: env.llm.baseUrl,
    // ADR-0093 / spec tui-model-command SC9：provider.headers 透传为 SDK
    // `defaultHeaders`。条件 spread 而非 `defaultHeaders: env.llm.headers` ——
    // 字段缺席（未命中 provider / provider 无 headers）时 SDK 收到的 options
    // 与今日逐字节一致，不会多出一个显式 `undefined` 键；env 层已保证
    // 「有值 ⇔ 非空映射」，此处不再二次判空。
    ...(env.llm.headers !== undefined
      ? { defaultHeaders: env.llm.headers }
      : {}),
  });
  const adapter = withTransportRetry(
    createRealAnthropicAdapter({
      client,
      model: wireModelFromRoute(env.llm.model),
      maxTokens: env.llm.maxOutputTokens,
      temperature: env.llm.temperature,
      // SSOT env→adapter params (#151/#156) and stream arm (#179/#147).
      // ADR-0094 SC7：overrides.thinking 在场 = per-turn 覆盖；缺席 = env 原值。
      thinking: overrides?.thinking ?? buildThinkingParams(env.llm),
      stream: env.llm.stream === "on",
    }),
    { translate: translateAnthropicTransportFault }
  );
  return { client, adapter };
}

/**
 * #562 T11 / ADR-0037 §6 收敛:engine-bundle SSOT —— 一台重建出来的 engine
 * 必须交回给 host 的最小句柄集合。`BuiltEngine` 是该工厂装配的**全量**视图
 * (`EngineBundle` + 装配期句柄 + 会话三根 + 装配快照等),本类型是 host
 * per-root 重建缝(`chat rebuildDeps` / TUI `buildEngine` / hub `getOrBuildEngine`)
 * 共享的**最小**子集。
 *
 * 为什么 deps 是必填,其它可选:`deps` 是 loop-engine 契约必需;其余 5 个
 * 句柄仅在装配层实际创建时在场(ask surface 没有 subagent / MCP / memory,
 * graphAssembly 仅 graphMode 在场时透出),缺席即宿主不调,行为零变化。
 *
 * 为什么三条缝用同一形状:worktree rebind 后宿主要把句柄 rewire 进 ctx
 * (split-brain 修复,见 Review High-1 / 2026-08-29)。形状不漂移 = 三个
 * host 在同一行类型上对齐;不再在 5 个文件比对内联字面量。
 *
 * hub 路径在此基础上扩展 `mcpRoots?` / `mcpManager?` / `catalog?`(per-root
 * MCP face 切换所需);TUI deps 在此基础上扩展 `memoryFlags?`(TUI 独有)。
 */
export type EngineBundle = {
  readonly deps: LoopEngineDeps;
  /** 装配期组合 shutdown(MCP first → subagentManager second),表面 ask 时缺席。 */
  readonly shutdown?: () => Promise<void>;
  /** 子代理 manager 句柄 —— rebind 后 spawn 落这里,host drain 也消费它。 */
  readonly subagentManager?: SubAgentManager;
  /** graph 装配快照 —— `/graph` 与 Shift+Tab 快照随活跃引擎走(graphMode 在场)。 */
  readonly graphAssembly?: GraphAssembly;
  /** auto-memory 钩子(memory 层在场且非 ask 时透出;双关仍透出,只跑机械段)。 */
  readonly autoMemory?: AutoMemoryHook;
  /** auto-memory 低信任读:每轮 user 文本 overlay 预取(autoExtract 在场时透出)。 */
  readonly overlayMemoryPrefetch?: OverlayPrefetchFn;
};

/**
 * `buildHarnessEngine` 的全量返回 —— `EngineBundle` 的超集,装配面额外透出
 * engine / skillCatalog / mcpManager / mcpRoots / sessionRoots / catalog /
 * memoryFlags。host 装配面字段(engine / sessionRoots)在本类型上保持原位,
 * 6 个 `EngineBundle` 字段保留原顺序以免读者差异;`EngineBundle` 已是这些
 * 字段的命名 SSOT,新增 builder 请优先扩展 `EngineBundle` 而不是本类型。
 */
export type BuiltEngine = EngineBundle & {
  readonly engine: ReturnType<typeof createLoopEngine>;
  /**
   * #337 T8:skill catalog(全 surface 装配;ask 也装配——SC12 skill 两件在场)。
   * TUI deps 消费其 available()/get() 派生 slash 候选 + 加载正文(deps.ts
   * TuiExtensions.skillCatalog)。chat/serve 缺省不读。
   */
  readonly skillCatalog?: SkillCatalog;
  /**
   * T5 / ADR-0098:技能 rescan 缝(T6)—— 与 `deps.skillIndexDelta` **同一个**
   * 持有者(装配期一次,跨会话共用)。透出给 host 的显式 reload 面:plugin
   * skill 根的换血(`setPluginSkillDirs`)必须落在同一台上,下一次 rescan 才
   * 看得到新根。`surface === "ask"` 时缺席(ask 不装配增量缝)。
   */
  readonly skillRescanner?: SkillRescanner;
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
   * 活 taskRoot cell（specs/skill-load-write-root.md）：host 装配期句柄透出，
   * 供 chat-session rebind / TUI chrome 渲染等活根消费面使用。ADR-0079 后
   * skill 正文装配（`loadSkillBody` / ACI `skill()` / TUI slash）不再读此
   * cell —— 写处境披露的权威路径是 worker prior + chat-session rebind 通知
   * （共用 `writeRootSegment` helper）。缺席（旧 host 注入 deps 形态）→
   * 上述消费面各自退化，与历史行为一致。
   */
  readonly liveTaskRoot?: LiveTaskRoot;
  /**
   * T4 (plans/write-situation-disclosure.md) — worktree isolation 档判定结果
   *（装配期一次性读取，`resolveWorktreeOnMutate(settings)`，硬要求 9）。
   * chat-session rebind 注入与 ACI registry 透出面用它算
   * `writeSituation(isolationOn, currentRoot)`——不重复读 settings 也避免
   * 宿主层重判。ADR-0079 后 skill 正文装配不再消费此档（同上，披露路径迁
   * worker prior / rebind 通知）。缺席（注入 deps 形态）→ 消费方默认按
   * `writable_main` 处理（与旧 build-engine 默认形态一致）。
   */
  readonly isolationOn?: boolean;
  /**
   * issue 1059:worktree-on-mutate 活 holder 单例 —— 门禁 `enabled`、主/ask
   * registry 的 bash UNBOUND_FENCE、subagent spawn env 与 host verify 装配
   * 共用**同一个**实例。透出给 hub 的 verify 缝,使 verify fence 与门禁在
   * 此轴上判定一致(G3)。缺席(注入 deps 形态)→ 消费面不发段。
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
  /**
   * T2 / plans/worktree-exclusive-lock.md / ADR-0070 — enter-worktree
   * 占用锁档判定结果（装配期一次性读取，`resolveWorktreeExclusive(settings)`，
   * ADR-0037 §5 硬要求 9：开关只在启动加载点读一次，会话根改绑不重载）。
   *
   * 透传缝：session-api hub（T3 实施 bullet）在构造 `worktreeEnter` host
   * closure 时读此值；true → closure 内部跑占用检查（typed `worktree_claimed`
   * 拒绝），false → 完全跳过（行为与今日逐字节一致，spec SC2）。
   *
   * 该字段**没有**消费方在 T2 内使用（仅占位与透传）；缺席（注入 deps 形态）
   * → T3 消费方按 OFF 处理，与旧 build-engine 默认形态一致。
   *
   * 注意：与 `isolationOn` 不同——`isolationOn` 仅在 host 提供了
   * `worktreeIsolation` 缝时才为 true（gate 武装的前置），`worktreeExclusive`
   * 是**纯设置**判定（不依赖 host 缝在场），OFF 默认 = 严格走今日 enter 路径。
   */
  readonly worktreeExclusive?: boolean;
  /**
   * TUI live flags for /memory. Present when surface is `tui` and the memory
   * layer is on. The TUI mutates this box on Esc; the hook reads it per turn.
   */
  readonly memoryFlags?: MemoryLiveFlags;
  /**
   * memory-toggle-live: drop the memory_layer system snapshot so the next
   * turn reassembles it under the current live flags. Present only for the
   * TUI surface (the only host that can flip /memory mid-session); the
   * caller must tolerate a one-off prefix change (KV-cache break is the
   * accepted cost of an explicit user toggle).
   */
  readonly invalidateMemorySystem?: () => void;
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
  // T4 (plans/worktree-live-task-root.md §5 D1 / §6 T4) — live `taskRoot`
  // holder. Wraps `sessionRoots.taskRoot` as the initial snapshot. Writes
  // are gated through the build-engine wrapper around host seams
  // (`withLiveTaskRootWrite`); no consumer reads this in T4, so the cell
  // sits dormant until T5/T7/T8/T9 wire readers. Stable roots
  // (productRoot / projectIdentityRoot / installRoot / mcpConfigRoot /
  // stateAnchor / memoryDir / todoDir / traceDir) stay frozen (D3) — the
  // cell only carries `taskRoot`.
  const liveTaskRoot: LiveTaskRoot = createLiveTaskRoot(sessionRoots.taskRoot);
  // Review (round 2/3): 项目身份根 —— 身份发现（AGENTS.md / rules / 项目
  // skills / 子代理继承）与记忆库命名空间共用它，**不**用 `productRoot`：后者
  // 取自 `workspaceRoot`，在 `--workspace-root <dir>` 重定向档下不是项目本身。
  const projectIdentityRoot = sessionRoots.projectIdentityRoot;
  // ADR-0099:项目记忆跟会话池同一项目树,不再锚 workspaceRoot。
  const memoryDir = selectProjectMemoryDir(
    opts.memoryDir,
    userHome,
    projectIdentityRoot
  );
  // 10 件工具集 SSOT 工厂(append-only 顺序;env.web 透传 IKNOW_WEB_PROXY /
  // IKNOW_WEB_SEARCH_URL)。proxyUrl 非法 → 装配期同步抛(见 registry.ts)。
  // #194 T6:reg 按 memoryEnabled 条件化构造 — enabled 时传 memoryDir(reg.inner 10
  // 件,含 memory_recall + memory_save);disabled(ask)时不传 memoryDir(reg.inner 8
  // 件)。registry / executor / catalog 因此三方一致,不再手工过滤(SC9 保留
  // `memoryEnabled ? ... : undefined` 形态)。
  // #337 T8:skill catalog 装配 — scanSkillDirs 读三级目录
  // (~/.iknow/skills → <cwd>/.iknow/skills → IKNOW_SKILL_DIRS),createSkillCatalog
  // 装好后注入 reg 的 skillCatalog opt → registry 含 skill 一件
  // (全 surface,ask 也装配 — SC12 守门)。disclosure-index-align T2:skill_search
  // 已删(spec ADR-0046 / SC5),只剩 skill 一件。
  // **降级契约**:scanner 自身 try/catch + warn(目录缺失跳过),scan 抛错被
  // createSkillScanner 的 warn 吞掉,build 不阻塞装配。
  // #126 T5:settings 对象缝（测试注入隔离 settings；生产缺省 loadIknowSettings）。
  // 二期 B7：上移到 LSP 装配之前 —— settings.lsp 注入 LspCtx（工具层超时/
  // 等待 + client idle sweep + disabledServers 过滤）。
  const settings = opts.settings ?? loadIknowSettings({ cwd, home: userHome });
  // memory-toggle-live: TUI live flags 在 settings 加载后立即算出 ——
  // memoryResolver 构造点（下方 system 注入缝）需要它，原定义点
  // （auto-memory 钩子装配段）随之复用同一值。
  const autoExtractOn = settings.memory?.autoExtract === true;
  const dreamOn = settings.memory?.dream === true;
  const memoryFlags: MemoryLiveFlags = {
    autoExtract: autoExtractOn,
    dream: dreamOn,
  };
  const tuiLive = surface === "tui" && memoryEnabled;
  // T6 (plans/write-situation-disclosure.md): worktree 隔离档上移到 settings
  // 加载后立即算出 —— `subagentManager` 构造(line 617)需透传
  // `isolationOn` 给 `createSubAgentManager`,manager.buildWorkerPayload
  // 用它与 resolved sandboxRoot 算 `writeSituation` 进 envelope。
  // 单一读取点不变(worktreeIsolation host + resolveWorktreeOnMutate),
  // 仅位置前移 —— 装配期多算一次枚举(纯函数 O(1))。
  const isolationHost = opts.worktreeIsolation;
  const isolationEnabled =
    isolationHost !== undefined && resolveWorktreeOnMutate(settings);
  // issue 1059:holder 单例上移 —— 门禁 `enabled`、bash registry 的
  // UNBOUND_FENCE holder、subagent spawn 的 env 快照、verify 消费面共用
  // **同一个**活 holder(缺席时是包裹启动读数的冻结 holder)。若各消费点
  // 各自调用 `resolveWorktreeOnMutateSource`,holder 缺席路径会建出多个
  // 独立 cell:面板翻一个、其余不动,门禁与物理围栏判定分裂。
  const worktreeOnMutateSource = resolveWorktreeOnMutateSource(opts, settings);
  // T2 / plans/worktree-exclusive-lock.md / ADR-0070:enter-worktree
  // 占用锁开关的装配期解析 —— 与 `isolationEnabled` 同款 fail-closed 读取点
  // （缺失 / 非 true → false）。**仅在这里读一次**（ADR-0037 §5 硬要求 9）：
  // 会话根改绑（rebind）不触发 settings 重载，构造期冻结值贯穿本引擎寿命。
  // OFF 档 → `worktreeExclusiveEnabled === false` → T3 在 session-api
  // `enterWorktree` 装配 closure 时跳过占用检查，`enter-worktree` 行
  // 为与今日逐字节一致（spec SC2 / ADR-0070「OFF 档零回归」钉死）。
  const worktreeExclusiveEnabled = resolveWorktreeExclusive(settings);
  // #251 LSP 联动缝:edit_file 写盘成功后由装配层注入 lspNotifier.invalidate
  // 作为 registry 的 onEdit 回调(notifier 内部 fire-and-forget + 失败降级,
  // 详见 src/harness/lsp/notifier.ts)。SSOT:LspCtx.directory 必须等于
  // sandboxRoot(LS 工具的 NearestRoot 上界 stop 与 fs 软沙箱同根语义),
  // 否则两者分叉会让同一边界出现两个值。
  // 二期 B7:settings.lsp 四字段注入 LspCtx（全部可选；缺席走工具层/client
  // 缺省 —— requestTimeoutMs 20s / diagnosticsWaitMs 2s / idleTimeoutMs 10min /
  // disabledServers 空）。
  // LSP 子进程生命周期:warmup / lsp_* spawn 的 language server 子进程 stdio
  // 管道不释放,宿主事件循环排不空,进程（如 TUI /quit 后）永不退出。池是
  // 进程级共享（client.ts defaultPool,warmup spawn 缓存同源 —— per-engine
  // 池会让测试/多引擎场景每次装配重新 spawn）;终止收口在宿主进程退出缝
  // （run.tsx shutdownExtensions / cli.ts chat 退出缝,经
  // shutdownDefaultLspPool）,不在本引擎 shutdown —— rebind 中途会调用它。
  const lspCtx: LspCtx = {
    directory: sandboxRoot,
    // T8（D5, plans/worktree-live-task-root.md §6 T8）: LSP `directory` 走
    // live taskRoot cell —— 装配期冻结的 sandboxRoot 仅为初值;rebind 后
    // `getClient` 入口从 cell 读 `taskRoot` 作为 effective directory,
    // NearestRoot 上界 stop 跟活根走。门禁未翻 ⇒ cell 初值 = sandboxRoot,
    // `resolveDirectorySnapshot` 退回本字段冻结值,行为与今日逐字节一致。
    directoryCell: liveTaskRoot,
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
  // #global-plugins T1/T2: 解析插件根 + 扫描插件子目录 → catalog（skill
  // dirs / hooks 文件源两面）。装配期一次解析,同 engine 实例内复用以避免
  // 每次 scan 重 IO。「解析 → 扫描 → disabled 过滤」走 roots.ts 的共用装
  // 配 helper（与 worker 同源；disabled 过滤条件化的 branch 数留在 helper），
  // 消费面用 enabledInstallations（disabled 插件整体跳过，§3.3）。
  // pluginAgentDirs 走 createMergedCatalogResolver() 自解析（ACR #5: 解析
  // 面单一来源），不需要 build-engine 注入。
  const { catalog: pluginCatalog, enabled: enabledInstallations } =
    await resolvePluginCatalog({
      roots: resolvePluginRoots({
        ...(userHome !== undefined ? { userHome } : {}),
        settings,
      }),
      plugins: settings.plugins,
    });
  const pluginSkillDirs: PluginSkillDir[] = enabledInstallations.map((p) => ({
    dir: path.join(p.root, "skills"),
    plugin: p.name,
  }));
  const skillCatalog: SkillCatalogFaces = createSkillCatalog(
    await createSkillScanner({
      userHome,
      // T3:项目 skills 是项目身份 → projectIdentityRoot（跨 rebind 不动）。
      projectIdentityRoot,
      env: process.env,
      // 空数组 = 无插件 skill（scanner 缺省即空数组），无须条件展开。
      pluginSkillDirs,
    }).scan()
  );
  // T5 / ADR-0098:技能索引进场增量缝 —— 与冻表（上面 skillCatalog）同一份
  // 装配期扫描结果的 rescan 缝：`rescan()` 用**当时**根列表重扫，冻表不被
  // 它改写（那是 `skillIndexList` holder 的事，见下方 system 段）。
  // 会话锚（conversationId）/ 进场史叶子根（projectDir）都是**调用期**参数
  // —— serve 的引擎跨会话共享，装配期拿不到 conversationId（与 todoDir /
  // agentStatus 同款「装配期常量 + 调用期叶子」形状）。
  // 抽到模块级构造（S5 ratchet，理由同上）。
  const skillRescanner = createEngineSkillRescanner({
    surface,
    userHome,
    projectIdentityRoot,
    pluginSkillDirs,
  });
  // T5 / T7 / ADR-0098:增量缝 —— loop 增量（T5）与 worker 快照（T7）共用
  // 同一台：两处的「已进场」必须是同一份史（建两台会各自记账，worker 快照
  // 里的「已进场」与 loop 贴的「已进场」漂移）。
  //
  // 声明在前、赋值在后：manager 构造点在本行之下、而 seam 的两个入参
  // （`agentStatusTodoDir` / `skillIndexList`）在更下方才定稿。getter 只在
  // spawn 期读，故调用期一定已赋值；`let` 而非 const 正是为这条 declarative
  // 顺序让路（同 `skillIndexList` 自己的 let 形态）。
  let skillIndexSeam: ReturnType<typeof createSkillIndexDeltaSeam> | undefined;
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
            // T5 (hard req 7) + T8 (D6, plans/worktree-live-task-root.md §6 T8):
            // 子代理继承父会话改绑后的根 —— 引擎被重建到
            // task worktree（hub buildProductionEngine / CLI rebuildDeps 把
            // cwd/workspaceRoot 切到 `<repo>/.iknow/worktrees/<convId>`）时，
            // worker 子进程以该根为 cwd 启动；未改绑（主仓根，非 task
            // worktree 形状）时不传 → 子进程继承父进程 cwd，行为与今日逐
            // 字节一致。worker 注册表从不携带 isolation 缝 → 子代理不触发
            // 第二棵树 / 二次 provision（worker-tool-surface 测试钉住）。
            //
            // T8 (D6) 与 T5 的区别:sessionRoot 不再写死 `workspaceRoot`——
            // 改用 `() => liveTaskRoot.read()` 的 getter 形态，spawn closure
            // 执行时再取值。rebind 后第一次 spawn 自动落到新 taskRoot,旧
            // taskRoot 下不再生成新 worker（配合 manager sandboxRootCell 同
            // 形态: 旧 root 的 def 校验会拒）。
            ...(isTaskWorktreePath(workspaceRoot)
              ? { sessionRoot: () => liveTaskRoot.read() }
              : {}),
            // ADR-0092 Amendment 2026-09-13 / SC11:fs 档同样过进程边界 ——
            // 子代理的 bash 围栏必须与父会话同档,否则工作区档的「home 其余
            // 不能写」在 subagent→bash 这条臂上被绕开(spec SC11)。透传的是
            // holder 对象本身(不是 `.get()` 的快照):spawn 工厂在**每次
            // spawn 时**读它,运行期 `/config fs workspace` 对下一次 spawn
            // 生效。与主链 registry 的 holder 是同一份(`opts.fsMode`);
            // 缺席(测试 / 未接入口)→ 子进程不带该 env 键,byte-stable。
            // 直接赋值(tsconfig 未开 exactOptionalPropertyTypes):spawn 侧
            // 判据是 `fsMode?.get() !== undefined`(spawn.ts),`undefined` 与
            // 「key 缺席」同义 —— 省掉一个三元分支(S5 ratchet 零容忍)。
            fsMode: opts.fsMode,
            // issue 1059:开关同样 spawn 期读 holder 过界(IKNOW_WORKTREE_GATE_ON)
            // —— worker bash 围栏的 UNBOUND_FENCE 判定必须与父会话同源,
            // 透传 holder 单例本身,运行期面板翻转对下一次 spawn 生效。
            worktreeGate: worktreeOnMutateSource,
          }),
          // T8 (D6): manager 的父 sandboxRoot 上界也走活根 —— 同源逻辑,
          // getter 形态让 buildWorkerPayload 入口读 cell current value,
          // 旧根里 def.sandboxRoot 的 prefix-of-parent 校验自动拒绝。
          sandboxRootCell: () => liveTaskRoot.read(),
          sandboxRoot,
          // T6 (plans/write-situation-disclosure.md): 透传 worktree 隔离档
          // —— manager.buildWorkerPayload 用它与 resolved sandboxRoot 一起
          // 算 `writeSituation` 进 envelope；worker prior 据此渲染写根段。
          // 判定源 = `isolationEnabled`(line 716 单一读取点),worker 不重判。
          isolationOn: isolationEnabled,
          // T5 (ADR-0071 / SC8 + L2):
          //   opts.subagentsDir 在场 → manager 内 per-agent file-mode
          //   JsonlTraceService 形态,替换掉既有 `subagentTrace` 聚合单实例。
          //   opts.subagentsDir 缺席 → manager 走 NoopTrace,语义同既有
          //   (测试 seam: opts.subagentManager 已注入时由 caller 控制)。
          //   opts.subagentDiagnosticsDir 仍保留,用于 subagent stderr pointer
          //   —— T5 内部默认跟随 subagentsDir(manager 兜底),caller 不再
          //   强绑。
          //
          // review-fix (M5):opts.projectDir 缝透传 —— serve hub 装配期
          // 无 conversationId,manager spawn 期按 def.conversationId 两段式
          // 派生 per-conversation 叶子。与 subagentsDir 互斥共用(同传时
          // manager 内 subagentsDir 优先,cli/TUI byte-stable)。
          ...(opts.subagentsDir !== undefined
            ? { subagentsDir: opts.subagentsDir }
            : {}),
          ...(opts.projectDir !== undefined
            ? { projectDir: opts.projectDir }
            : {}),
          // ADR-0085 / SC9:父会话账本锚点透传 —— manager spawn 期把
          // `{projectDir: opts.todoDir, conversationId: def.conversationId}`
          // 落进 worker envelope,worker 的 todo_write 因此挂到与本 loop
          // registry 同一本 todos.md(读 / 更新;添加对 worker typed 拒绝)。
          // 与 subagentsDir / projectDir 同门:缺席时 manager 不发该字段,
          // worker 工具面维持旧形态(byte-stable)。
          ...(opts.todoDir !== undefined ? { todoDir: opts.todoDir } : {}),
          diagnosticsDir:
            opts.subagentDiagnosticsDir ??
            opts.subagentsDir ??
            resolveSubagentTraceDir(),
          taskTimeoutMs: env.subagent.taskTimeoutMs,
          maxConcurrentWorkers: env.subagent.maxConcurrentWorkers,
          // ADR-0096 T2：闸值 holder 透传。holder 在场 → manager.spawn 闸每
          // 次现读 holder.get()（命令面与引擎面同源），env 值仅作 holder 缺
          // 席时的兜底初值；opts.maxConcurrentWorkers 仍传是兼容既有 assemble
          // 路径（manager 在 holder 缺席时把它作 fail-closed 初值）。
          subagentCapacityHolder: opts.subagentCapacityHolder,
          // T7 / SC10:父会话「当时」模型索引快照 —— 每次 spawn 现读。
          // **per spawn 的 def.conversationId 是入参**：进场史是会话级叶子
          // （`<projectDir>/<sanitize(convId)>/skill-index.json`），一次
          // build-engine 实例跨会话共享，故不能把 conversationId 钉进装配期。
          // 冻表名那一半与会话无关（system 冻表对所有会话相同），由 seam 的
          // ledger 以 `initialNames` 承载；这里只并上「该会话已进场」的条目。
          // seam 缺席（todoDir / rescanner 不在场 / ask）→ getter 缺席 →
          // envelope 省键 → worker 走自有 rescan（旧形态 byte-stable）。
          // 门条件在此可静态判定（todoDir / rescanner 在 manager 构造点都已
          // 定稿；ask 已在上一层的三元里排除，故不再重复判表面）；缝本体走
          // lazy 读取（它在冻表定稿后才建）。
          ...skillIndexSnapshotOption({
            todoDir: opts.todoDir,
            rescanner: skillRescanner,
            readSeam: () => skillIndexSeam,
          }),
        }))
      : undefined;
  // #502 T3:bash background 任务管理器 — 条件装配（surface !== "ask"）：
  //   - chat/tui/serve 生产自建 createBackgroundTaskManager({
  //       tasksDir: <host 注入 | 池根默认>, spawn: defaultBackgroundSpawn })
  //     —— registry 落 `<poolRoot>/projects/<slug>/tasks/`（ADR-0088）。
  //   - ask 不创建（SC8 oneshot 即用即抛；T4 bash_output/bash_stop 也缺席）。
  // ADR-0088:登记表跟**会话池**同一项目树,不再锚 workspaceRoot —— 同一
  // `projectIdentityRoot` 的多份 checkout 共用一份活账本,throwaway
  // `--workspace-root` 不另开登记。`projectIdentityRoot` 与上方
  // `sessionRoots` 同值(会话文件夹与任务登记必须落同一个 slug)。
  const tasksDir = selectBackgroundTasksDir(
    opts.tasksDir,
    userHome,
    projectIdentityRoot
  );
  // T4 (ADR-0037 §4) 的 `stateAnchor` 已不再是 tasks / memory 的锚
  // (ADR-0088 / ADR-0099 拆掉 per-root 分片)。
  const backgroundManager: BackgroundTaskManager | undefined =
    surface !== "ask"
      ? createBackgroundTaskManager({
          tasksDir,
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
        tasksDir,
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
  // 装配之前。**Amendment 2026-09-11 撤销了「工具在场 ⇔ 门禁已武装」**：
  // 工具面只跟 host 缝在场挂钩（见下方 registry 透传处），`isolationEnabled`
  // 只武装 mutate 门禁 —— 开关 OFF 时模型仍可 create/enter 显式 rebind，
  // 只是没有门禁拦写。开关只在启动加载点读一次（硬要求 9）。
  // T6: `isolationHost` / `isolationEnabled` 已上移至 settings 加载后
  // (下方 isolationEnabled 声明处)—— subagentManager 构造需要透传 isolationOn。
  // T4 (plans/worktree-live-task-root.md §5 D1 / §6 T4) — single writer
  // seam wrap. Host `provision` / `enter` / `exit` are wrapped with
  // `withLiveTaskRootWrite` so successful resolutions update the live
  // `taskRoot` cell. Failed seams (typed errors) leave the cell unchanged
  // and the error propagates verbatim — no write, no rollback. T4 has no
  // consumer reading the cell, so the wrap is dormant; T5/T7/T8/T9 will
  // wire readers. The wrap is a **pure pass-through** for the resolved
  // value (registry / gate behavior is byte-identical to today).
  const wrappedProvision = isolationHost
    ? withLiveTaskRootWrite(isolationHost.provision, liveTaskRoot)
    : undefined;
  const wrappedEnter = isolationHost?.worktreeEnter
    ? withLiveTaskRootWrite(
        isolationHost.worktreeEnter,
        liveTaskRoot,
        // T9 (write-situation-disclosure SC10): the enter seam resolves to
        // `{ path, receipt }` — the cell keeps receiving the root; the
        // receipt flows verbatim to the enter-worktree tool.
        (resolved) => resolved.path
      )
    : undefined;
  const wrappedExit = isolationHost?.worktreeExit
    ? withLiveTaskRootWrite(isolationHost.worktreeExit, liveTaskRoot)
    : undefined;
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
  /**
   * B4 / ADR-0043 §4:手动重连 pending 事件 holder(loop-engine
   * `deps.mcpReconnect.takePending` 的消费源)。manager.onManualReconnect
   * 回调 push;loop-engine 在 step 边界 take + 清空(一次性消费)。
   * ask surface(无 manager)恒 undefined → 缝缺席,零追加。
   */
  let mcpReconnectPending:
    { events: Array<{ server: string; tools: string[] }> } | undefined;
  /**
   * B4 / ADR-0043 §4 + spec model-prefix-layering §4:MCP 名字目录会话级
   * 快照 holder。firstTurnReady 窗口 resolve 后冻结一次(chat/tui/serve);
   * deps.system 的 mcp 缝只读此快照(会话内恒定,断言②)。ask surface
   * (无 manager)恒 undefined → 缝缺席,段缺席。
   */
  let mcpNameDirectorySnapshot: ReadonlyArray<McpServiceSummary> | undefined;
  // D-α T3 / ADR-0030:overlay 接了才有 graph 装配面。快照对象是本次
  // 装配的单点 —— registry(工具在是不是在)、promptTools(露不露)、deps.system
  // (编排段进不进)三处读的都是它，不各读各的 holder。ask surface 没有
  // graphAssembly(graphMode 装配仅在 chat/tui/serve 触发),保持 undefined。
  const graphAssembly: GraphAssembly | undefined = opts.graphMode
    ? createGraphAssembly(opts.graphMode)
    : undefined;
  // B4 / ADR-0043 §4 顺序关键:`reg` 必须先于下方 `if (surface !== "ask")`
  // 块内的 `await mcpManager.start()` 构造 —— mcpManager 内部的
  // registerExternal 闭包依赖 reg 已就位,否则 bootSlot 在
  // listTools → registerTools → registerExternal 路径上拿到
  // `reg === undefined` 抛错,标 slot 为 failed(不再翻回,见 #378
  // flip-back 守卫仅放过 timedOut 的迟到成功)。旧依赖顺序(reg 在
  // await start 之后)在此 B4 引入 firstTurnReady 阻塞等待时被打破
  // —— 必须显式上移到此处(早于所有可能触发 registerExternal 的路径)。
  //
  // 关键:此处的 reg 暂以 mcpManager === undefined 占位装配。真实
  // mcpManager 在 if 块内同步构造完成后,if 块结尾的"rebuild reg with
  // mcpManager"会重新构造一次 reg(因为 registry 的工具集构造期已固
  // 定 mcpManager,无 cell 透传),把 list_mcp_resources /
  // read_mcp_resource 等条件化工具补齐。两次构造 = mcpManager 装配
  // 的唯一稳定方案,reg 实例在 rebuild 后被替换为最终值,外部消费者
  // 始终看到含 mcpManager 的最终 reg。
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
    // B4 / ADR-0043 §4:手动重连事件 holder —— manager.onManualReconnect
    // 回调在 TUI / CLI 重连动作的成功路径上触发,事件 push 到这里;
    // loop-engine 在下一步边界 take 走 + 追加 user 消息(transcript) +
    // 清空。reload 路径(manager 内部 reload 完成后由 host 决定)目前
    // 不主动触发本 holder —— 重连 UI 在 reload 成功后由 host 显式调
    // 一次 manualReconnectListeners(详见 plan B4 / 实现 B5 reload 路径)。
    mcpReconnectPending = {
      events: [],
    };
    mcpManager.onManualReconnect((serverName, toolNames) => {
      mcpReconnectPending!.events.push({
        server: serverName,
        tools: [...toolNames],
      });
    });
    // 第一次 reg 构造(占位,等真实 mcpManager 就位后 rebuild 一次)
    reg = createDefaultAciRegistry({
      env,
      sandboxRoot,
      // ADR-0097 / T7 + ADR-0104:egress 允许集数据面 —— 全集 = 代码承载
      // preset ∪ settings.isolation.network 用户增量,经
      // createEgressPolicyFactory 收口;无配置段 → preset-only,工厂恒返
      // policy = egress session 必起(--unshare-net 恒在)。askApproval
      // 把既有 AskUser 转写为 `(host) => Promise<boolean>`:交互入口首见
      // 新域名走 ask 面问一次(T6 批准流);worker / hub-less 入口不构造
      // 本入口,保持 fail-closed。
      egressPolicyFactory: createEgressPolicyFactory({
        settings,
        commandLabel: "bash",
      }),
      askApproval: (host) =>
        askUser({
          tool: "egress-domain-approval",
          input: { host },
          summaryHint: `允许沙箱内访问域 ${host}?`,
        }),
      // T5 (plans/worktree-live-task-root.md §6): 把活 taskRoot cell 透传给
      // write_file / edit_file 工厂。门禁未翻 ⇒ cell 初值 = sandboxRoot,
      // 行为逐字节同今日；handler 内 cell.read() 取 snapshot。stable 根（D3）
      // 不走这条缝，仍由各工厂按 opts 接各自的稳定根。
      liveTaskRoot,
      // ADR-0092 Round 2 / SC11/SC12:fs 隔离档 holder + homeRoot 透传给
      // bash 工厂。holder 缺席 → 全局档(V1 baseline);homeRoot 取本层已
      // resolve 的 `userHome`(opts.userHome 测试缝 ?? homedir(),见上文)——
      // 不留给 bash 工厂再 `homedir()` 一次,否则 `userHome` 缝只改 settings /
      // persona / state 却改不动工作区档围栏的 home ro-bind 源端。
      fsMode: opts.fsMode,
      homeRoot: userHome,
      // issue 1059:UNBOUND_FENCE holder 透传给 bash 工厂(单例,见上)。
      worktreeOnMutate: worktreeOnMutateSource,
      // T3:只读放行项目身份文件所在的主仓（ADR-0037 §1 允许只读主仓）。registry
      // 把它透给 read_file / grep / glob，也传入 bash 工厂作闭世界读白名单成员
      // （ADR-0037 §9.2 #6：registry.ts 的 bash 工厂装配把它接进 createBashTool
      // → fs-policy，fence 以 --ro-bind 只读挂载，写不进主仓）；write / edit 仍
      // 不获得该根。ON 档即便初始根仍是主仓也要把稳定身份根交给这些工厂；它们按
      // handler 调用时的 live taskRoot 再判定 task-worktree 形状，因此同一 run
      // 的下一波也能看到 rebind，而 OFF 档完全不传这条根。
      ...(isolationEnabled ? { projectIdentityRoot } : {}),
      // ADR-0041 / plans/model-prefix-layering.md B3:graphAssembly 只承载
      // handler isEnabled gate 与 loop-engine 切换判定(常驻注册后 registry
      // 不再按它过滤工具面)。overlay 缺席 → 不传,handler 缺省恒关。
      ...(graphAssembly ? { graphAssembly } : {}),
      // live-graph-phase1 T1:活图账本 host 透传 — handler 拿到后按
      // ctx.conversationId 解析会话账本。缺席 → 工具零行为变化。
      ...(opts.liveGraphLedger
        ? { liveGraphLedger: opts.liveGraphLedger }
        : {}),
      // ADR-0084 / D1:last-read 账本跨 rebind 重建共享同一实例（读记忆不因
      // 换根丢失）；宿主未接（ask / 测试直调）→ registry 自建一份，闸照常。
      ...lastReadLedgerOption(opts),
      ...(memoryToolsEnabled ? { memoryDir } : undefined),
      skillCatalog,
      ...(subagentManager ? { subagentManager } : undefined),
      // ADR-0096 T2：闸值 holder 透传给 registry → 工具工厂
      // （`createSpawnSubAgentTool` 在场时把 holder 透给工具 description
      // getter —— description 与 manager 闸值同源，TUI /config 面板翻转立即
      // 反映在模型拉取的工具描述上）。与 subagentManager 同形态：缺席时
      // 工厂走 manager.getCapacity() 退化路径，与既有装配行为一致。
      subagentCapacityHolder: opts.subagentCapacityHolder,
      // #502 T3:bash background 任务管理器透传（同门条件装配）——bash 工具
      // `background: true` 分支可用（立即返 task_id，不占 tier timer）。
      ...(backgroundManager ? { backgroundManager } : {}),
      // #440 T11 mcpManager 条件化装配:首次构造时已就位 —— 见上方 mcpManager
      // = createMcpManager(...) 调用,故此处传入真实 manager,list_mcp_resources /
      // read_mcp_resource 在场。
      ...(mcpManager ? { mcpManager } : {}),
      onEdit: (file) => lspNotifier.invalidate(file),
      lspCtx,
      // #406 T3:secret registry 透传 → bash 工具 handler 在 spawn 前还原占位符。
      // secretRegistry 已在上方构造（T2 段），registry 工厂只在 handler 调用时
      // 解引用 opts.secretRegistry（惰性），无循环依赖。
      ...(secretRegistry ? { secretRegistry } : {}),
      // #440 seam：host-injected todoDir 透传给 registry（todo_write 条件化
      // 装配的开关）。ask 分支在上方 registry 调用点不传 → tool 不入注册表
      // （与 memoryEnabled / subagentManager / skillCatalog 同形态）。
      // worker 装配路径 (createWorkerDeps → createDefaultAciRegistry) 在父会话
      // 经 envelope 透传 `todoLedger` 时传入同一 todoDir（ADR-0085 / SC9：
      // 共享父账本，`add` 在工具 handler 内 typed 拒绝）。
      // (#646 T2: 本 gate 表达式与下方 agentStatusTodoDir 处是同语义的两处
      //  内联 —— 改动任一处需同步另一处。)
      ...(opts.todoDir ? { todoDir: opts.todoDir } : {}),
      // ADR-0019 (T4 / review-fix H3): per-root state anchor threaded into
      // bash + read_file factories so the fs-policy fence protects
      // `<workspaceRoot>/.iknow` at parity with `<home>/.iknow`. Always
      // resolved (opts.workspaceRoot wins; env SSOT `IKNOW_WORKSPACE_ROOT`
      // is read from `env.workspaceRoot`, not raw `process.env`, so
      // `.env` / `.env.local` overrides ride the same surface). Spread-guard
      // keeps the legacy callers (no opts.workspaceRoot, no env var) on their
      // `sandboxRoot` fallback inside registry.ts.
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      ...(opts.subagentDiagnosticsDir
        ? { traceDir: opts.subagentDiagnosticsDir }
        : {}),
      // ADR-0037 Amendment 2026-09-11 (specs/agent-control-surface.md Slice A /
      // SC1):工作树 ACI 工具在场只跟 host 缝在场挂钩,与 mutate 门禁判定
      // (isolationEnabled)解耦 —— 开关 OFF 时模型仍可 create/enter 显式 rebind,
      // 只是没有门禁拦写。单个缝的条件 spread 保持原样,只接 provision 的入口
      // (TUI/CLI)因此仍只注册 create-worktree。worker / hub-less 入口不传 host
      // 缝 → 工具不入注册表(Gate 3 镜像过滤)。
      ...(isolationHost
        ? {
            worktreeProvision: wrappedProvision!,
            // T7:enter 缝在场时透传；缺席（TUI 只接 provision）→
            // enter-worktree 不入注册表。
            ...(wrappedEnter ? { worktreeEnter: wrappedEnter } : {}),
            // T8:exit 缝在场时透传；缺席 → exit-worktree 不入注册表。
            ...(wrappedExit ? { worktreeExit: wrappedExit } : {}),
            // task-worktree-lifecycle: discovery and explicit removal are
            // host-only seams; they do not change the live root themselves.
            ...(isolationHost.worktreeList
              ? { worktreeList: isolationHost.worktreeList }
              : {}),
            ...(isolationHost.worktreeRemove
              ? { worktreeRemove: isolationHost.worktreeRemove }
              : {}),
          }
        : {}),
    });
    // B4 / ADR-0043 §4:build-engine 装配期 `await manager.start({firstTurnReadyTimeoutMs})`。
    // 窗口长度 = 模块级常量 `MCP_FIRST_TURN_READY_TIMEOUT_MS`(hard-req 装配
    // 期窗口的生产契约)—— 窗口内连上的 server 进首轮装配(注册到 ACI
    // registry,session 在册);窗口内未连上的 server = session 缺席(不进名字
    // 目录,不进 tools),缺席者本会话不再有自动重试。装配照常发首轮 —— 仅
    // 缺席者退到下一轮由用户手动重连(`onManualReconnect` 缝)。
    // start 内部 bootSlot 仍是 fire-and-forget,但本调用方在装配期 await 至
    // 窗口到点。
    //
    // `opts.mcpFirstTurnReadyTimeoutMs` 是测试缝:缺席 ⇒ 用上面的常量(生产
    // 字节级不变,见 BuildEngineOpts 字段注释);在场 ⇒ 用注入值。两者走的是
    // 同一条窗口轮询路径,只有窗口长度不同。
    //
    // 顺序关键:`reg` 必须在 `await mcpManager.start()` 之前构造完毕(见
    // 上面 `reg = createDefaultAciRegistry({...})` 调用)。mcpManager
    // 内部的 `registerExternal` 闭包依赖 reg 已就位,否则 bootSlot 在
    // listTools → registerTools → registerExternal 路径上会拿到
    // `reg === undefined` 抛错,标 slot 为 failed(不再翻回)。
    try {
      await mcpManager.start({
        firstTurnReadyTimeoutMs: resolveFirstTurnReadyTimeoutMs(
          opts.mcpFirstTurnReadyTimeoutMs
        ),
      });
    } catch (err) {
      // start 内部 void allSettled 不会 reject;此 catch 留作未来加 timeout
      // 收尾时的兜底,目前仅 warn。装配照常发首轮,缺席者按 session 缺席处理。
      console.warn(
        `[build-engine] MCP manager start window error: ${errorMessage(err)}`
      );
    }
    // B4 / ADR-0043 §4 + spec model-prefix-layering §4:名字目录首轮定稿、
    // 会话内恒定 —— 在 firstTurnReady 窗口 resolve 后把 connected 服务 +
    // 工具名冻结为一份会话级快照,deps.system 的 mcp 缝只读快照。窗口内
    // 未连上的 server 迟到连上(#378 flip-back)不再渗回目录;否则相邻轮
    // system 字节漂移,破断言②(实测:迟到连接曾使目录中途出现新 server)。
    // 手动重连成功的目录更新走 onManualReconnect → messages 尾追加通知
    // (不回写目录)。
    mcpNameDirectorySnapshot = mcpManager
      .status()
      .map((server) => {
        const prefix = `mcp__${server.name}__`;
        const tools: McpToolSummary[] = [];
        for (const def of reg!.catalog.all()) {
          if (!def.name.startsWith(prefix)) continue;
          // description 缺席/空 → tool 行不带描述（契约允许态,见
          // mcpNameDirectorySegment 注释）。toAciToolDef 已经把
          // tool.description ?? "" 落进 ToolDef.description,所以这里读
          // 出空字符串一律视为"无描述"。
          tools.push({
            name: def.name,
            ...(def.description.length > 0
              ? { description: def.description }
              : {}),
          });
        }
        return {
          name: server.name,
          state: server.state,
          tools,
        } satisfies McpServiceSummary;
      })
      .filter((s) => s.state === "connected");
  } else {
    // ask 路径:无 mcpManager,reg 一次构造,无 manager 工具,无 start。
    reg = createDefaultAciRegistry({
      env,
      sandboxRoot,
      liveTaskRoot,
      // ADR-0092 Round 2 / SC11/SC12 (ask 路径):fs 隔离档 holder + homeRoot
      // 透传给 bash 工厂。holder 缺席 → 全局档(V1 baseline);homeRoot 同主
      // 构造路径取本层 `userHome`。
      fsMode: opts.fsMode,
      homeRoot: userHome,
      // issue 1059:UNBOUND_FENCE holder(ask 路径,与主构造同一单例)。
      worktreeOnMutate: worktreeOnMutateSource,
      ...(isolationEnabled ? { projectIdentityRoot } : {}),
      ...(graphAssembly ? { graphAssembly } : {}),
      ...(opts.liveGraphLedger
        ? { liveGraphLedger: opts.liveGraphLedger }
        : {}),
      // ADR-0084 / D1:同首次构造 —— 共享 last-read 账本（ask 路径无会话
      // conversationId，闸退化为「非空覆写一律拒」，与 spec 的 fail-closed
      // 一致；read / bash 仍可执行，只是不入账）。
      ...lastReadLedgerOption(opts),
      ...(memoryToolsEnabled ? { memoryDir } : undefined),
      skillCatalog,
      ...(subagentManager ? { subagentManager } : undefined),
      ...(backgroundManager ? { backgroundManager } : {}),
      // 无 mcpManager,不传 → list_mcp_resources / read_mcp_resource 不入表。
      onEdit: (file) => lspNotifier.invalidate(file),
      lspCtx,
      ...(secretRegistry ? { secretRegistry } : {}),
      // ask 路径（本分支）不传 todoDir → todo_write 不装配（与首次构造的
      // todoDir 透传同门；此处条件再兜一次 surface !== "ask"）。
      ...(surface !== "ask" && opts.todoDir ? { todoDir: opts.todoDir } : {}),
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      ...(opts.subagentDiagnosticsDir
        ? { traceDir: opts.subagentDiagnosticsDir }
        : {}),
      // 同主构造路径:工具在场 ⇔ host 缝在场(ADR-0037 Amendment 2026-09-11)。
      ...(isolationHost
        ? {
            worktreeProvision: wrappedProvision!,
            ...(wrappedEnter ? { worktreeEnter: wrappedEnter } : {}),
            ...(wrappedExit ? { worktreeExit: wrappedExit } : {}),
            ...(isolationHost.worktreeList
              ? { worktreeList: isolationHost.worktreeList }
              : {}),
            ...(isolationHost.worktreeRemove
              ? { worktreeRemove: isolationHost.worktreeRemove }
              : {}),
          }
        : {}),
    });
  }

  // B6 / ADR-0043 §3:溢出治理(装配期首轮判定,session 内冻结,后续每轮
  // promptTools 不重测)。判定点 = `await mcpManager.start()` 之后(若 mcp
  // 装配)或 reg 构造完即跑(ask 路径):MCP tools 此时已 registerExternal
  // 到 reg.catalog,MCP schema 计入 countTokens 实测量,但 MCP 件本身已
  // 是 lazy(不进 visibleSchemas)—— 仅内建 deferrable 5 件参与退场。
  //
  // 判定函数 `runOverflowJudge`(纯逻辑,本文件不内嵌判定循环,见
  // aci/tool-overflow.ts)只负责:1) 收集 deferrable 池(内建 + MCP);
  // 2) 调 countTokens;3) 按 DEFERRABLE_BUILTIN_RETIRE_ORDER 逐件退;
  // 4) 返回 retire 名单 + reason。本文件负责 wire:取系统文本、调
  // countTokens、把 retire 名单 stamp 到 reg。
  //
  // countTokens 来源优先级:opts.countTokens(测试缝) > adapter.countTokens
  // (createRealAnthropicAdapter 实现,真 SDK 调)。后者缺席(undefined)→
  // 跳过本会话(skip 语义,见下方 catch + reason 分支)。
  //
  // system 文本 = assembleStaticSystemPrompt 装配的 6 段 LOCKED + 已知
  // 加性段(项目路径 / 技能 / mcp 名字目录 / git 块)。countTokens 接收
  // 与 model turn 装配期同一份 resolver(为简化,装配期一次性取一次
  // 冻结快照—— B6 plan §8 "countTokens 实测的对象" 实际装配的 system
  // 文本;系统 prompt 在不同 turn 间会变,但首轮判定只用首轮的)。
  // 为避免把"装配件 vs 装配件之外的 resolver"再次拼装,本实现用
  // `assembleStaticSystemPrompt` 简化版拿静态段(无 IKNOW 装配件外部
  // 副作用的),加上 IKNOW_IDENTITY/SOUL/USAGE 常量拼成 system 文本
  // —— 真实测的是工具面面积(占绝对主体),不是 system 文本细微差异。
  const overflowSystemText = await assembleStaticSystemPrompt({
    projectIdentityRoot,
    userHome,
    workspaceRoot,
  });
  const overflowInput = {
    // 简化 system 文本(常量段 + 静态说明书);full resolver 在 loop
    // turn 边界才拼(system / mcp / git 块都需装配件现读)。溢出治理
    // 关心工具面面积(占 95%+)—— 此简化不破坏判定。
    system:
      "## Identity\n" +
      // IKNOW 常量拼一段(不必走 import 链,简化;运行时量小不影响判定)
      "iknow harness identity.\n\n" +
      overflowSystemText,
  };
  const countTokensFn = selectCountTokensFn(adapter, opts);
  // 装配期首轮判定:只跑一次(session 内恒定,后续每轮 promptTools
  // 不重测)。失败/缺席 = 跳过本会话 + warn(全部 deferrable 内建件
  // 保持常驻);超阈值 = 退场次序内 stamp lazy:true。
  let deferredRetireNames: ReadonlyArray<string> = [];
  if (countTokensFn !== undefined) {
    // 我们传给 runOverflowJudge 的 countTokens 闭包要"在 retire 后重测"
    // —— 闭包内部重读 reg.visibleSchemas()(反映最新可见集)。
    const sampleTools = (): ReadonlyArray<unknown> => reg.visibleSchemas();
    try {
      const result = await runOverflowJudge({
        tools: reg.catalog.all(),
        // 阈值 = contextWindow * 0.1(env.compress.contextWindow SSOT)。
        threshold: env.compress.contextWindow * 0.1,
        countTokens: async () => {
          const v = await countTokensFn({
            tools: sampleTools(),
            system: overflowInput.system,
          });
          return v.inputTokens;
        },
      });
      if (result.reason === "retired") {
        deferredRetireNames = result.retire;
        reg.retireBuiltin([...result.retire]);
      } else if (result.reason === "countTokens_failed") {
        // 失败/缺席 → 跳过本会话;全部 deferrable 内建件保持常驻。
        // spec §5 钉死:首轮不抛错、不重试,console.warn 一行。
        console.warn(
          `[build-engine] overflow judge skipped: countTokens failed: ${errorMessage(
            result.cause
          )}`
        );
      }
      // reason === "no_overflow" → 零动作(全部保持常驻)
    } catch (err) {
      // runOverflowJudge 自身不抛(吞 SDK 错到 countTokens_failed 分支);
      // 此 catch 为未来防御:任何 throw 不阻塞装配,只 warn。
      console.warn(
        `[build-engine] overflow judge unexpected error: ${errorMessage(err)}`
      );
    }
  }
  // session 内恒定的退场名单(holder;系统 resolver 每轮调同一闭包)。
  // T4 / spec ASSUMPTIONS #5:索引段渲染 **名 + 描述**,故 holder 携带描述
  // 而非裸名 —— 描述取 retire 当刻 registry 里该件的 `ToolDef.description`
  // (SSOT = registry;`retireBuiltin` 只翻 `aci.lazy`,不动 description)。
  // 名字在 catalog 里查不到(理论不该发生:retire 名单由 catalog 派生)→
  // 只带名字进段,渲染层降级为裸名行。
  const deferredInternalToolsList: ReadonlyArray<DeferredInternalToolSummary> =
    deferredRetireNames.map((name) => {
      const def = reg.catalog.get(name);
      return def?.description
        ? { name, description: def.description }
        : { name };
    });

  // T5 / ADR-0046 Decision 2 + spec Does #6:索引降档(MCP 目录 +
  // `<available_skills>` 合计超端点窗口 10% → 从大到小剥描述只留名)。
  //
  // 时点 = 与内建 schema 退场同一装配期首轮判定(先退内建 schema,再看索引),
  // 会话内不重算 —— 判定结果落进下面两个 holder,`deps.system` 的两条缝只读
  // holder,故相邻轮 system deep-equal(SC2)。
  //
  // 为什么不与 `runOverflowJudge` 共用同一次 countTokens:退场梯子测的是
  // **整个首轮请求面**(tools schema + system),而本闸门按 operator 终锁测的
  // 是**索引两段合计**。同一次实测拿不出后者这个量,合并会把闸门语义偷换成
  // 「整个 prompt 超阈」。故复用同一 countTokens 来源与同一时点,各测各的量。
  //
  // `<deferred_internal_tools>` 不进本判定的入参 —— 退场内建描述保留
  // (ADR-0046 Decision 2),不存在误剥路径。
  //
  // 失败(countTokens 抛错 / 非有限数)/ 缺席 → 跳过本会话 + console.warn 一行,
  // 两段保持带描述形态(与 B6 退场 skip 合同同形)。
  let skillIndexList: ReadonlyArray<SkillSummary> = skillCatalog
    .available()
    .map((entry) => ({
      name: entry.name,
      description: entry.description ?? "",
      ...(entry.disabled ? { disabled: true } : {}),
    }));
  if (countTokensFn !== undefined) {
    try {
      const demotion = await runIndexDemotion({
        mcp: mcpNameDirectorySnapshot ?? [],
        skills: skillIndexList,
        threshold: env.compress.contextWindow * 0.1,
        countTokens: async (indexText) => {
          // 实测面 = 模型真正看到的这两段文本(禁 chars/4 估算)。tools 不传:
          // 本闸门只治理索引面积,schema 面由退场梯子上一步已判定。
          const v = await countTokensFn({ system: indexText });
          return v.inputTokens;
        },
      });
      if (demotion.reason === "demoted") {
        mcpNameDirectorySnapshot = demotion.mcp;
        skillIndexList = demotion.skills;
      } else if (demotion.reason === "countTokens_failed") {
        console.warn(
          `[build-engine] index demotion skipped: countTokens failed: ${errorMessage(
            demotion.cause
          )}`
        );
      }
      // no_index / no_overflow → 零动作(两段保持带描述形态)
    } catch (err) {
      // runIndexDemotion 自身不抛(吞错到 countTokens_failed 分支);此 catch
      // 为未来防御:任何 throw 不阻塞装配,只 warn。
      console.warn(
        `[build-engine] index demotion unexpected error: ${errorMessage(err)}`
      );
    }
  }

  // D-α T3 / ADR-0030:overlay 接了才有 graph 装配面。快照对象是本次
  // 装配的单点 —— registry(工具在不在)、promptTools(露不露)、deps.system
  // (编排段进不进)三处读的都是它，不各读各的 holder。
  // (B4: `reg` 与 `graphAssembly` 已在 mcp 装配块内先于
  //  `await mcpManager.start()` 构造，见上方上移注释。)
  // ADR-0040: the parent catalog is not the worker surface. Rebuild the
  // worker registry through the same factory with the worker-only option
  // shape (no parent managers, state tools, or worktree host seams), then
  // apply the worker deny-list path in the classifier below. This keeps
  // host-only write-category tools such as create-worktree and bash_stop
  // out of the isolation decision without maintaining a second exclusion list.
  const workerBaseTools = isolationEnabled
    ? createDefaultAciRegistry({
        env,
        sandboxRoot,
        skillCatalog,
        lspCtx,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
        // ADR-0092 Round 2 / SC11/SC12 (worker 派生面):fs 隔离档 holder +
        // homeRoot 透传给 bash 工厂,与父会话同形态。worker surface 派生自
        // 同一 registry 工厂,assembly 字节一致 —— 仅 deny-list 不同。
        // homeRoot 同取本层 `userHome`。
        fsMode: opts.fsMode,
        homeRoot: userHome,
        // issue 1059:UNBOUND_FENCE holder(worker 派生面,同一单例)。
        worktreeOnMutate: worktreeOnMutateSource,
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
  // ADR-0084 / SC5:项目 `settings.permissions` 段进 project 层。读根 =
  // `projectIdentityRoot`(项目身份锚,见上文 sessionRoots 注释)——项目契约
  // 只在身份根上;改绑后 cwd 是裸 task worktree,读 cwd 会静默丢掉项目规则。
  // fail-loud 原路上抛(typed ProjectSettingsError):schema 违规 / toml 与
  // JSON 两份 SSOT 并存都必须在启动时可见,不吞成降级配置。
  // 「无项目规则」= undefined,由 `createPermissionPolicy` 的 spread-guard
  // 丢弃(与 key 缺席同形),此处不再叠一层条件分支。
  // ADR-0090: 声明式规则的相对路径锚 = session sandboxRoot;`knownToolNames`
  // 取 reg.catalog 全量(内建 + 动态 mcp__*),让未知工具名的 deny/ask 规则
  // 加载期告警(规则本身仍保留编译,动态注册后即生效)。
  const policy = createPermissionPolicy({
    project: resolveProjectPermissionSource({
      projectIdentityRoot,
      workRoot: sandboxRoot,
      knownToolNames: new Set(reg.catalog.all().map((def) => def.name)),
    }),
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
  // 用户 command 钩子：settings.hooks（Claude PreToolUse/PostToolUse）编进
  // Pre/Post 缝，与 secrets guard 经 multiplexer 组合（builtin 在前）。
  // 段缺席 → 空贡献。TUI Post 观测（opts.hooks）是 Step 5，与 Pre 互不覆盖。
  const settingsHooks = createSettingsHookContribution({
    hooks: settings.hooks,
    userHome,
    projectDir: projectIdentityRoot,
    cwd: sandboxRoot,
    env: process.env,
    ...(opts.onHookError ? { onError: opts.onHookError } : {}),
  });
  // 插件 hooks 文件源。链序 = builtin → settings command → plugin。
  // 前两者命中时插件 hook 不 spawn（少一次 I/O，也不改变既有拦截归属）。
  // 无 hooksFiles → 不构造插件贡献（贡献恒为空对象），pre/post 逐字节与
  // 今日一致（既有测试零回归）。cwd = taskRoot（§5.6；装配期冻结的
  // sandboxRoot —— hook 子进程 cwd 不参与会话根 rebind 计算）。
  // onError 的 spread-guard 收进 opts 对象：缺席 = 键缺席（exactOptional
  // 语义与逐字段展开一致），少一处条件表达式。
  const pluginHooksOpts: Parameters<typeof createPluginHooksFromCatalog>[0] = {
    entries: pluginCatalog.hooksEntries,
    installations: enabledInstallations,
    userHome,
    projectDir: projectIdentityRoot,
    cwd: sandboxRoot,
    env: process.env,
    onError: opts.onHookError,
  };
  const pluginHooks = createPluginHooksFromCatalog(pluginHooksOpts);
  // 组合器跳过 undefined 槽（未配的源），装配层无需条件展开 —— 含插件贡献
  // 空时的 `.pre` / `.post`（双缺席 = 本源无声明）。
  const preToolUse = composePreHooks([
    secretsGuard,
    settingsHooks.pre,
    pluginHooks.pre,
  ]);
  // Post: TUI 观测（opts.hooks，Step 5）→ settings command Post → 插件 Post。
  const postToolUse = composePostHooks([
    opts.hooks,
    settingsHooks.post,
    pluginHooks.post,
  ]);
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser,
    hooks: {
      preToolUse,
      ...(postToolUse ? { postToolUse } : {}),
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

  // ADR-0037 T3:mutate 门禁（harness executor 缝）。host 缝（provision /
  // enter / exit）由 session-api hub / TUI / CLI 注入。**host 缺席 → 不包装**
  // （无 provision 可裁决，门禁拦下也无出路）—— 行为与今日逐字节一致。
  //
  // ADR-0096 T3（开关判定从 isolationEnabled 解耦）：包装条件改为「host 在场」
  // 而非「启动期 isolationEnabled」。理由：面板可把开关从 OFF 翻到 ON，若装配
  // 期就按 OFF 不包装，翻 ON 后没有任何东西拦得住未绑树 mutate —— 验收句
  // 「面板翻转 ON → 未绑树 mutate 被拦且不自动建树」将无法成立。门禁拦截与否
  // 交给 holder 在每波入口现读（D2 一波一读）；**OFF 档拦截读数为假即透明**
  // （runAll 直接透传，逐字节等于不包装）。**从不 auto-provision 不变**：
  // 翻 ON 只恢复「拦下未绑树 mutate + 指向 create-worktree ACI 工具」这一条
  // 反应（ADR-0037 §1 原文保留）。
  //
  // 与门禁解耦后保持启动期冻结的其它消费点（worker write-situation /
  // git 作业纪律段 / projectIdentityRoot 读栅 / T4 工具装配）仍读
  // `isolationEnabled` —— 见 BuildEngineOpts.worktreeOnMutateHolder 注释。
  //
  // T10 (plans/worktree-live-task-root.md §6 T10 / D1/D2): 门禁读活根 —
  // 把 `root: sandboxRoot`（装配期冻结）换成活 `liveTaskRoot` cell（也是
  // T4 装配出来的同一持有者，由 `withLiveTaskRootWrite` 单点写入）。门禁
  // 在 executeAll 入口 snapshot 一次活根 — D2 一波一个根，D11 门禁裁决
  // 根等于消费者写根。未 rebind 时 cell 初值 = sandboxRoot，行为逐字节
  // 等于原 T3 装配期冻结字段。
  const loopExecutor =
    isolationHost !== undefined
      ? createWorktreeIsolationExecutor({
          enabled: worktreeOnMutateSource,
          liveTaskRoot,
          provision: wrappedProvision!,
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
  // Locked sentence 5:warmup 不在装配期起,改由该视图惰性 arm —— 装配期只读
  // list();第一次 language server 工具名解析才触发(SSOT 见 lsp/warmup.ts)。
  const registryTools: Registry = withLazyLspWarmup(reg.inner, lspCtx);

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
  // B4 / ADR-0043 §4:MCP 名字目录段快照源由 deps.system resolver 现读
  // (manager.status() × reg.catalog mcp__* 工具名);手动重连 pending 由
  // mcpReconnectPending holder 承载(见上方 manager 装配段)。
  // #645 T1 / #646 T2 单一 gate 表达式:同一条件 (surface !== "ask" 且 host
  // 注入 todoDir) 同时驱动 loop 注入缝 (deps.agentStatus,栏以 user 消息追加)
  // 与 system 读规则段 (resolver opts.agentStatusReadRule,ADR-0028 的那句
  // 稳定读法) —— 两处永远同门,不会漂移;ask / todoDir 缺席 → 栏与读规则
  // 都缺席。(同语义表达式还在上方 registry todoDir seam 内联一次,改动需同步。)
  const agentStatusTodoDir: string | undefined =
    surface !== "ask" && opts.todoDir ? opts.todoDir : undefined;
  // T5 / T7 / ADR-0098：两个入参都已定稿（`skillIndexList` 是降档后的冻表，
  // `agentStatusTodoDir` 是本段表达式）—— 到这里才建缝。manager 的 spawn
  // getter 只读闭包引用，故构造顺序（manager 在上、赋值在此）安全。
  skillIndexSeam = buildSkillIndexSeamOrUndefined({
    todoDir: agentStatusTodoDir,
    rescanner: skillRescanner,
    frozenNames: skillIndexList.map((skill) => skill.name),
    frozenEntries: skillIndexList.map((skill) =>
      skill.description === undefined
        ? { name: skill.name }
        : { name: skill.name, description: skill.description }
    ),
  });
  // memory-toggle-live: memory_layer resolver 提前构造 —— deps.system 注入缝
  // 与 BuiltEngine.invalidateMemorySystem 消费同一实例。TUI 表面挂 live flags
  // （catalog 装配档随 /memory 翻转），其余表面维持原快照形态。
  const memorySystemResolver = memoryToolsEnabled
    ? buildMemorySystemResolver({
        projectIdentityRoot,
        userHome,
        workspaceRoot,
        memoryDir,
        autoExtract: settings.memory?.autoExtract === true,
        flags: memoryFlags,
        flagsActive: tuiLive,
      })
    : undefined;
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
    // ADR-0041 / plans/model-prefix-layering.md B3:`run_graph` 常驻,promptTools
    // 不再按 graph 快照过滤 —— 关图那次 run() 工具面仍含 run_graph(handler
    // isEnabled gate 拒调,SC5 实测)。邻轮 promptTools 字节稳定,前缀
    // 不再被翻图行为打断。
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
      // T9 (ADR-0037 §4):"Project path" 段改读稳定 projectIdentityRoot
      // —— 装配层不再消费 cwd 缝。活 taskRoot 仅经下方 envSnapshot 段暴露
      // 给人读面(rebind 后人读面跟随活根,system prompt 字节保持稳定,
      // KV 缓存契约保留)。cwd 因此不传。
      projectIdentityRoot,
      userHome,
      workspaceRoot,
      surface,
      memoryEnabled: memoryToolsEnabled,
      ...(memorySystemResolver ? { memoryResolver: memorySystemResolver } : {}),
      // T5 / spec Does #6:skills 索引 = 装配期首轮判定后冻结的 holder
      // (`skillIndexList`)—— 降档把超阈条目的 description 剥掉只留名,渲染层
      // 按数据形态输出裸名行(单一 SSOT,不在段函数里做第二套判定)。未超阈
      // 则 holder 就是 `catalog.available()` 的原样投影。会话内恒定 → 相邻轮
      // system deep-equal(SC2)。
      skills: () => skillIndexList,
      // #631 T2 → B4 (ADR-0043 §3):MCP 名字目录段注入缝(渐进式披露
      // "索引常驻档")—— 仅 mcpManager 在场(chat/tui/serve)时注入;ask
      // 无 manager → 缝缺席 → 段缺席(字节级零变化,守 KV 缓存稳定契约)。
      // 名字目录 = 会话级快照(见上方 mcpNameDirectorySnapshot 冻结点):
      // firstTurnReady 窗口 resolve 后定稿,相邻轮 deep-equal(断言②)。
      // 窗口内未连上的 server 迟到连上不渗回;手动重连成功的目录增量走
      // messages 尾追加通知(不回写目录)。
      ...(mcpNameDirectorySnapshot
        ? {
            mcp: () => mcpNameDirectorySnapshot,
          }
        : {}),
      // B6 / ADR-0043 §3 + T4:溢出治理退场件索引段(可选)—— 首轮判定后
      // 冻结,会话内恒定(deferredInternalToolsList holder 上方定义)。空
      // 名单(无超限 / 失败)→ 闭包返空数组 → 段缺席;非空 → 渲染
      // <deferred_internal_tools> 段(每行 `- 名: 描述`,字母序稳定;
      // 描述缺席降级裸名)。与 mcp 名字目录同形态,加性段不触碰
      // IKNOW_ASSEMBLY_ORDER。ask surface 无 manager / 同样走此缝(无 MCP
      // 但可能有内建退场);失败跳过 → list 必空 → 段缺席。
      deferredInternalTools: () => deferredInternalToolsList,
      // #558 T2: 默认路径停止注入 coordinator 段 — 引导落点收敛到
      // spawn_subagent 工具 description (T1 SSOT)。装配缝保留:
      // 调用方可显式传入 coordinatorText 让 createIknowSystemResolver 渲染该段
      // (coordinator-segment.test.ts seam 用例覆盖)。
      // #646 T2: agent-status 读规则段 gate —— 与下方 deps.agentStatus 同一
      // agentStatusTodoDir 表达式派生 (栏在场的表面才装配读规则句)。
      ...(agentStatusTodoDir ? { agentStatusReadRule: true } : {}),
      // plans/model-prefix-layering.md B5 / spec §9:git 块注入缝 —— 取
      // `projectIdentityRoot` 为 cwd (稳定根,与会话 rebind 解耦),装配期
      // 同步取一次快照、会话内冻结。退化态(非 git 仓库 / git 不可用 /
      // cwd 不可解析)→ provider 返回 undefined → 装配段缺席,不报错。
      git: createGitSnapshotProvider({ cwd: projectIdentityRoot }),
      // git 作业纪律段:与 isolationEnabled 同一判定源(启动一次、会话稳定)。
      // ON → chat/tui/serve 注入;OFF → 字段缺席(字节级等同未传 gate)。
      // ask 在 createIknowSystemResolver 内再挡一层(无工作树工具)。
      // worker createWorkerDeps 不经过本层、不传 gate。
      ...(isolationEnabled ? { gitWorkDiscipline: true } : {}),
      // ADR-0041 / plans/model-prefix-layering.md B3:`orchestration` system
      // 段撤出 —— 内容并入 graph 模式切换提示(loop-engine 消息尾追加,
      // 见下方 graphModeChange 缝)。graph 装配快照改为单点供 loop-engine
      // 判定开/关:不读 system,经 loop-engine 内部持有的上一次快照比较。
    }),
    // #119 T7:env.compress 透传 → deps.compress(LoopEngineDeps.compress 可选缝)。
    // IknowCompressEnv 必填(contextWindow / thresholdTokens),缺失即压缩关闭由
    // loop-engine 字段缺席兜底;此处无条件透传,类型安全(策略预算窗口缺省 256000 由 env 层兜底)。
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
    ...skillIndexDeltaOption(skillIndexSeam),
    // #653 G1 T5 / DESIGN-ENVIRONMENT-PRESENT + T9 / ADR-0037 §4:环境现势事件缝
    // —— 仅 tui surface 注入(人读 chrome 的数据源;cwd 来源 =
    // liveTaskRoot.read —— 装配层活持有者,每次即将调模型前现读)。rebind
    // 后下一波 tool calls 的人读面 (TUI cwd / git 摘要) 跟随活根。ask /
    // chat / serve / worker 缺席 → 零 IO、零事件 (byte-identical)。
    // readEnvSnapshot 永不 throw,事件只给宿主 UI,不进 messages / verify
    // / ADR-0028 栏。
    ...(surface === "tui"
      ? { envSnapshot: { readCwd: liveTaskRoot.read } }
      : {}),
    // ADR-0041 / plans/model-prefix-layering.md B3:graph 模式切换注入缝
    // —— `graphAssembly` 在场时透给 loop-engine,step 边界比较本次快照
    // 与上一次的值,翻转时把单行 user 提示(开图含编排指引 / 关图
    // 关闭提示)immutable 追加到 messages 尾部;同值零追加。缺席(ask /
    // worker / 未接 overlay 的入口)= 零追加。形态镜像 agentStatus:
    // `promptTools` 同形态的「未接 → 原样透传」是 byte-identical 契约。
    // `lastSeenEnabled.value = undefined` 表示「尚未在本 deps 寿命里看过
    // 一次」 —— loop-engine 首步只记初值不追加(新会话没有「翻转」可言,
    // 关图开局不灌 off 提示),之后每次相邻 step 比较翻转。
    ...(graphAssembly
      ? {
          graphModeChange: {
            assembly: graphAssembly,
            lastSeenEnabled: { value: undefined as boolean | undefined },
          },
          // ADR-0081:每个 run() 一次短现势注入缝
          // —— graphAssembly 在场时一并透给 loop-engine(与上面 graphModeChange
          // 同源 assembly,两缝解耦:change 持翻转状态,presence 只读 round 快照)。
          // 缺席(ask / worker / 未接 overlay)→ 零追加。
          graphModePresence: {
            assembly: graphAssembly,
            appendedThisRun: { value: false },
          },
        }
      : {}),
    // B4 / ADR-0043 §4:MCP 手动重连追加缝 —— mcpReconnectPending holder
    // 在场(manager 装配成功,chat/tui/serve)时透给 loop-engine;takePending
    // 取走 + 清空(一次性消费)。ask(无 manager)→ 缝缺席 → 零追加。
    ...(mcpReconnectPending
      ? {
          mcpReconnect: {
            takePending: (): ReadonlyArray<{
              server: string;
              tools: ReadonlyArray<string>;
            }> => {
              const taken = [...mcpReconnectPending!.events];
              mcpReconnectPending!.events.length = 0;
              return taken;
            },
          },
        }
      : {}),
  };
  const engine = createLoopEngine(deps);
  // auto-memory T4 / ADR-0031 D1+D5:两重同门 —— memory 层在场、非 ask 表面。
  // 任一不成立 → 钩子缺席,宿主侧零调用、零 LLM、零写盘。
  // 读路径预取只跟 autoExtract（dream-only 不灌用户消息）。
  // （autoExtractOn / dreamOn / memoryFlags / tuiLive 定义在 settings 加载点。）
  // ADR-0031 D5 amendment 2026-09-11（specs/runtime-capability-memory-gate.md）：
  // extract 与 dream 均关时钩子仍在场 —— 机械段（memory_gc + capability
  // sweep）仍要按 completed 闸跑，否则旧能力条永远等不到软禁。零 LLM 由钩子
  // 内部保证（dual-off 只进 runMechanicalPass），extract 仍由 live `enabled`
  // 把门。原先的 `(autoExtractOn || dreamOn || tuiLive)` 项随之退役：三者
  // 皆假时机械段恰恰是最需要的。
  const autoMemory =
    memoryEnabled && surface !== "ask"
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
    ...tuiMemoryInvalidateField(tuiLive, memorySystemResolver),
    ...(subagentManager ? { subagentManager } : {}),
    // #337 T8 / #361 Phase D:透出 skillCatalog + mcpManager + catalog,供
    // TUI deps 构建扩展面(TuiExtensions.skillCatalog / mcp.status / mcp.reload /
    // listMcpTools)。全 surface 通用装配件,非 TUI 专用 — 不改变既有消费方。
    skillCatalog,
    // T5 / ADR-0098:rescan 缝透出 —— 它是**跨入口共享**的那个可变持有者
    // (plugin skill 根列表在显式 reload 时换血,SC11):serve hub 的
    // skill reload 端点在 **同一台引擎** 上调 setPluginSkillDirs,冻表 holder
    // 与索引进场增量缝的下一次 rescan 才看得到新根。host 未注入 todoDir /
    // ask 表面 → 缺席(与 deps.skillIndexDelta 同门,行为零变化)。
    ...skillRescannerOption(skillRescanner),
    ...(mcpManager ? { mcpManager } : {}),
    ...(mcpRoots ? { mcpRoots } : {}),
    sessionRoots,
    catalog: reg.catalog,
    // specs/skill-load-write-root.md：活 taskRoot cell 透出，hub loadSkillBody
    // 调用时机读快照 —— 与 registry 工厂消费同一 cell 实例。
    liveTaskRoot,
    // T4 (write-situation-disclosure): 透出隔离档判定，hub / ACI skill /
    // chat-session rebind 注入三处消费方用它算 writeSituation(isolationOn,
    // currentRoot)。单一来源 = `isolationEnabled`（buildHarnessEngine 启动
    // 加载点一次性读取），与门禁武装同源（决策 1 钉死）。
    isolationOn: isolationEnabled,
    // T2 (plans/worktree-exclusive-lock.md / ADR-0070): enter 占用锁档
    // 透传 —— session-api hub（T3 实施 bullet）构造 `worktreeEnter` host
    // closure 时读此值决定是否跑占用检查；T2 不读、不消费、不修改 host 缝
    // （`worktreeExclusiveEnabled` 仅作 settings 一次性 resolve 的镜像）。
    // 与 `isolationOn` 不同：不依赖 `worktreeIsolation` host 缝在场；
    // 严格反映 settings 解析结果（默认 OFF / 缺失 / 非 true 一律 false）。
    worktreeExclusive: worktreeExclusiveEnabled,
    // D-α T3:host 每次 run() 前调 beginRound() 拍快照(chat / hub 两处 run
    // 入口)。缺席 = 本入口没接 overlay。
    ...(graphAssembly ? { graphAssembly } : {}),
    // #356 T6:shutdown 组合 MCP + subagent + background 三清理。SC12 顺序:
    // mcpManager first → subagentManager second(两者无共享可变状态,Promise.all
    // 并发触发;顺序仅语义标注,非严格串行 — ask 入口三者都缺席时 shutdown 也
    // 缺席)。#502 T6:backgroundManager.shutdown() 加入 —— 杀遗留后台进程组,
    // 与 MCP/subagent 无共享可变状态,可安全并入 Promise.all。
    // 注意:LSP 子进程终止**不在此处** —— 引擎 shutdown 会在进程中途被调用
    // （chat rebind 收口旧引擎）,而 LSP 池是进程级共享（per-engine 池会让
    // 测试/多引擎场景每次装配重新 spawn language server）;终止+latch 必须
    // 只发生在宿主进程退出缝（TUI shutdownExtensions / chat 退出缝）,见
    // client.ts shutdownDefaultLspPool。
    ...(mcpManager || subagentManager || backgroundManager || autoMemory
      ? {
          shutdown: async (): Promise<void> => {
            await Promise.all([
              mcpManager?.shutdown(),
              subagentManager?.shutdown(),
              backgroundManager?.shutdown(),
              // ADR-0086 / spec Assumptions 8: best-effort `memory_gc` +
              // capability sweep on process exit. The hook's `onExit` is
              // optimistic by contract (never throws) and is deliberately not
              // the only gate — the completed-turn gate stays authoritative.
              autoMemory?.onExit?.(),
            ]);
          },
        }
      : {}),
  };
}

/**
 * ADR-0084 / D1:last-read 账本 host 的条件透传面（两次 registry 构造共用）。
 *
 * 宿主未接（ask / 测试直调）→ 返回空对象 → registry 自建一份，写闸照常生效
 * （只是读记忆不跨 registry 共享）。单一表达式同时供两处装配，避免两处各写
 * 一遍 `?( … ) : {}` 的分支（S5 ratchet：buildHarnessEngine 是既有 god
 * function，只允许等量或更少的分支）。
 */
function lastReadLedgerOption(opts: BuildEngineOpts): {
  readonly lastReadLedger?: LastReadLedgerHost;
} {
  return opts.lastReadLedger ? { lastReadLedger: opts.lastReadLedger } : {};
}

/** T5 / ADR-0098:rescan 缝的条件透出（理由同 `lastReadLedgerOption`）。 */
function skillRescannerOption(rescanner: SkillRescanner | undefined): {
  readonly skillRescanner?: SkillRescanner;
} {
  return rescanner ? { skillRescanner: rescanner } : {};
}

/**
 * T5 / ADR-0098:技能索引进场增量缝 —— 与 agentStatus 同门（同一 todoDir
 * 表达式 = 「会话文件夹在场 + 非 ask」）且同一形态：装配期给常量缝
 * （rescanner + projectDir + 冻表名集），loop-engine 在每次即将调模型前调用，
 * 会话锚（`deps.conversationId`）由缝在调用期解析成
 * `<projectDir>/<sanitize(convId)>/skill-index.json` 进场史叶子。
 *
 * 冻表名集取本层 holder（降档后的定稿形态）—— 冻表里已有的名一律不算新建
 * （SC3）。host 未注入 todoDir / ask 表面 / 无 rescan 缝 → 缝缺席，零注入
 * （既有装配与测试 byte-identical）。
 *
 * 抽到模块级的理由同 `lastReadLedgerOption` / `resolveWorktreeOnMutateSource`
 * （S5 ratchet：`buildHarnessEngine` 是既有 god function，只允许等量或更少的
 * 分支）。
 */
function skillIndexDeltaOption(
  seam: ReturnType<typeof createSkillIndexDeltaSeam> | undefined
): {
  readonly skillIndexDelta?: ReturnType<typeof createSkillIndexDeltaSeam>;
} {
  return seam === undefined ? {} : { skillIndexDelta: seam };
}

/**
 * T7 / SC10:worker 快照 getter 的条件透出面（缝缺席 → 键都省，与
 * `lastReadLedgerOption` 同款）。
 *
 * **缝缺席时返回 `{}`（不是「传一个恒返回 undefined 的 getter」）**：manager
 * 侧「getter 缺席」与「getter 返回 undefined」虽同归省键，但前者是声明式的
 * 「本装配没有这条线」，后者要读进函数体才知道 —— 也让接线测试能直接断言
 * 「装配传没传」。
 *
 * getter 内层仍**原样透传 `undefined`**（不是空数组）：envelope 的三态里
 * 「省略键」= worker 退回自有 rescan，「空数组」= 父确定无技能。把「该会话
 * 还没加载过」说成空数组会让 worker 渲染空清单句、丢掉它本来能自扫到的技能。
 */
function skillIndexSnapshotOption(input: {
  /** 装配期即可判定的门（与 `agentStatusTodoDir` 同一条：非 ask + 有落点）。 */
  readonly todoDir: string | undefined;
  readonly rescanner: SkillRescanner | undefined;
  /** 缝的**调用期**读取 —— 缝本体在冻表定稿后才建（见赋值点注释）。 */
  readonly readSeam: () =>
    ReturnType<typeof createSkillIndexDeltaSeam> | undefined;
}): {
  readonly skillIndexSnapshot?: (
    conversationId: string | undefined
  ) => readonly SkillIndexSnapshotEntry[] | undefined;
} {
  // 门的分支数留在 helper（S5 ratchet：buildHarnessEngine 只允许等量或更少
  // 的分支）；与 `buildSkillIndexSeamOrUndefined` 同一对条件。
  if (input.todoDir === undefined || input.rescanner === undefined) return {};
  return {
    skillIndexSnapshot: (conversationId) =>
      input.readSeam()?.enteredEntries(conversationId),
  };
}

/**
 * T7 / SC10：增量缝本体（或缺席）—— 与 `buildSkillIndexDeltaSeam` 同门同源，
 * 单独抽出是因为 **worker 快照 getter 也要它**（`enteredEntries` 是同一台缝
 * 上的同步面）。两条消费线共用一个实例：worker 快照里的「已进场」与 loop
 * 增量贴的「已进场」必须是同一份史，建两台会各自记账。
 *
 * 缺席（todoDir / rescanner 任一不在场）→ undefined：worker 快照 getter 随之
 * 缺席，worker 退回自有 rescan（旧形态 byte-stable）。
 */
function buildSkillIndexSeamOrUndefined(input: {
  readonly todoDir: string | undefined;
  readonly rescanner: SkillRescanner | undefined;
  readonly frozenNames: readonly string[];
  readonly frozenEntries?: readonly SkillIndexSnapshotEntryShape[];
}): ReturnType<typeof createSkillIndexDeltaSeam> | undefined {
  if (input.todoDir === undefined || input.rescanner === undefined)
    return undefined;
  return createSkillIndexDeltaSeam({
    rescanner: input.rescanner,
    projectDir: input.todoDir,
    initialNames: input.frozenNames,
    ...(input.frozenEntries !== undefined
      ? { initialEntries: input.frozenEntries }
      : {}),
    // 不传 `isIndexedName`（缺省全收）：写入名单已经由
    // `computeSkillIndexDelta` 从 **rescan 面**的 `modelIndex()` 产出 ——
    // 资格判定在那一拍完成。若在此再拿装配期 catalog 过一道闸，会话内
    // **新建**的技能名（装配期还不存在）会被判非法，正是 SC2 要贴的那种
    // 增量被自己丢掉。
  });
}

/**
 * T5 / ADR-0098:rescan 缝的装配期构造 —— `ask` 表面不装配（oneshot 即用即抛，
 * 增量缝与冻表 holder 都缺席）；其余表面建一台持有者，
 * `pluginSkillDirs` 只是**初始**值，之后只由显式 reload 经
 * `setPluginSkillDirs()` 换血（SC11）。
 *
 * 抽到模块级的理由同 `lastReadLedgerOption` / `buildSkillIndexDeltaSeam`
 * （S5 ratchet：`buildHarnessEngine` 是既有 god function，只允许等量或更少的
 * 分支）。
 */
function createEngineSkillRescanner(input: {
  readonly surface: "chat" | "tui" | "ask" | "serve";
  readonly userHome: string;
  readonly projectIdentityRoot: string;
  readonly pluginSkillDirs: readonly PluginSkillDir[];
}): SkillRescanner | undefined {
  if (input.surface === "ask") return undefined;
  return createSkillRescanner({
    userHome: input.userHome,
    projectIdentityRoot: input.projectIdentityRoot,
    env: process.env,
    pluginSkillDirs: input.pluginSkillDirs,
  });
}

/**
 * ADR-0096 T3 ── 门禁开关来源解析（holder 在场 → 用注入的活 cell；缺席 →
 * 以启动读数现场建一个冻结 holder）。
 *
 * 抽到模块级的理由同 `lastReadLedgerOption`（S5 ratchet：`buildHarnessEngine`
 * 是既有 god function，只允许等量或更少的分支）：holder 缺席路径必须与今日
 * 逐字节一致 —— `resolveWorktreeOnMutate` 仍是唯一 fail-closed 读取点，仍在
 * settings 加载后读一次（硬要求 9），只是包进 holder 供门禁 `get()`。
 */
function resolveWorktreeOnMutateSource(
  opts: BuildEngineOpts,
  settings: IknowSettings
): WorktreeGateReader {
  return (
    opts.worktreeOnMutateHolder ??
    createWorktreeOnMutateHolder(resolveWorktreeOnMutate(settings))
  );
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
 * memory-toggle-live: memory_layer system resolver 构造收口（从
 * `buildHarnessEngine` 内联三态表达式抽出，S5 复杂度回归整改）。
 *
 * TUI 表面（`flags` 在场）挂 live flags —— resolver 按 flag 值分档快照，
 * `/memory` 翻转经 `invalidateMemorySystem` 在下一轮生效（ADR-0042
 * Amendment 2026-09-11）；其余表面维持原单快照形态，行为逐字节不变。
 * `autoExtract` 载入 ctx 与 ADR-0034 装配契约同源（false → 不注入 catalog）。
 */
function buildMemorySystemResolver(args: {
  readonly projectIdentityRoot: string;
  readonly userHome: string;
  readonly workspaceRoot: string;
  readonly memoryDir: string;
  readonly autoExtract: boolean;
  readonly flags?: MemoryLiveFlags;
  /** TUI 表面才挂 live flags（其它表面 flags 传了也不生效）。 */
  readonly flagsActive?: boolean;
}): SystemResolver {
  const ctx = {
    projectIdentityRoot: args.projectIdentityRoot,
    userHome: args.userHome,
    workspaceRoot: args.workspaceRoot,
    memoryDir: args.memoryDir,
    ...(args.autoExtract ? { autoExtract: true } : {}),
  };
  return args.flagsActive && args.flags
    ? createSystemResolver(ctx, { flags: args.flags })
    : createSystemResolver(ctx);
}

/**
 * memory-toggle-live（S5 整改）: TUI 表面才透出的快照失效字段 —— resolver
 * 在场且表面为 TUI 时产出 `{ invalidateMemorySystem }`，否则空对象。
 */
function tuiMemoryInvalidateField(
  tuiLive: boolean,
  resolver: SystemResolver | undefined
): { readonly invalidateMemorySystem: () => void } | Record<string, never> {
  return tuiLive && resolver
    ? { invalidateMemorySystem: resolver.invalidate }
    : {};
}

/**
 * B4 / ADR-0043 §4:hard-req 装配期 firstTurnReady 窗口的生产契约(ms)——
 * 窗口内连上的 MCP server 进首轮装配(session 在册);窗口内未连上 = 本会话
 * 缺席(不进名字目录,不进 tools),不自动重试。测试缝只在窗口长度上覆盖,
 * 生产调用方不传该缝 ⇒ 走本常量,字节级不变。
 */
const MCP_FIRST_TURN_READY_TIMEOUT_MS = 30_000;

/**
 * 测试缝 `opts.mcpFirstTurnReadyTimeoutMs` 的 resolver:缺席 ⇒ 生产契约常量;
 * 在场 ⇒ 注入值(见 BuildEngineOpts 字段注释)。两种走同一条窗口轮询路径,
 * 只有窗口长度不同 —— 故这里只选长度,不做任何窗口语义分支。
 */
function resolveFirstTurnReadyTimeoutMs(injected?: number): number {
  return injected ?? MCP_FIRST_TURN_READY_TIMEOUT_MS;
}

/**
 * B6 / ADR-0043 §3:装配期 countTokens 来源选择(自 `buildHarnessEngine`
 * 抽出,使装配主体不必内联四分支的优先级判定)。
 *
 * 优先级:显式 `countTokens` > `skipCountTokens` 旁路 > adapter 真调用。
 * 显式注入必须永远最高 —— 否则「验溢出路径」的调用方一旦同时设了 skip
 * 就会被静默旁路,断言悄悄失效。
 *
 * `skipCountTokens` 缝见 BuildEngineOpts 字段注释:绕开 adapter 的 SDK
 * 调用(测试 env 的 baseUrl 不可达,SDK maxRetries=2 + 退避让每次装配
 * 白烧 ~2.5s);与 countTokens 缺席同形。adapter 自身未实现(Stub / 离线
 * adapter)也归入缺席语义 —— 装配层跳过本会话的溢出判定与索引降档。
 */
function selectCountTokensFn(
  adapter: LoopEngineDeps["adapter"],
  opts: Pick<BuildEngineOpts, "countTokens" | "skipCountTokens">
): BuildEngineOpts["countTokens"] {
  if (opts.countTokens !== undefined) return opts.countTokens;
  if (opts.skipCountTokens === true) return undefined;
  if (adapter.countTokens === undefined) return undefined;
  // 真实 adapter:仅传 tools + system(messages 缺席 = SDK 接受空消息;
  // 首轮判定场景下 messages 必空)。
  return async (input: {
    readonly tools?: ReadonlyArray<unknown>;
    readonly system?: string;
  }) => {
    return adapter.countTokens!({
      tools: input.tools as ReadonlyArray<unknown> | undefined,
      system: input.system,
    });
  };
}

/**
 * ADR-0088:tasksDir 来源选择(自 `buildHarnessEngine` 抽出,装配主体只留一次
 * 调用 —— 与 `selectCountTokensFn` 同门,避免给既有大函数加分支)。
 *
 * host 注入优先(三入口显式派生);缺席回退**池根**默认 `~/.iknow`
 * (`resolveServeDataDir()` 的默认,`userHome` 测试缝沿用)—— 绝不回退
 * workspaceRoot,那正是 ADR-0087/0088 要拆掉的 per-root 分片。
 */
function selectBackgroundTasksDir(
  injected: string | undefined,
  userHome: string,
  projectIdentityRoot: string
): string {
  return (
    injected ??
    resolveTasksDir({
      dataDir: path.join(userHome, ".iknow"),
      projectIdentityRoot,
    })
  );
}

/**
 * ADR-0099:memoryDir 来源选择 —— host 注入优先;缺席回退池根默认
 * `~/.iknow`。绝不回退 workspaceRoot。
 */
function selectProjectMemoryDir(
  injected: string | undefined,
  userHome: string,
  projectIdentityRoot: string
): string {
  return (
    injected ??
    resolveProjectMemoryDir({
      dataDir: path.join(userHome, ".iknow"),
      projectIdentityRoot,
    })
  );
}
