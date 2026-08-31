/**
 * src/tui/deps.ts
 *
 * #365 T2: buildTuiDeps 委托 buildHarnessEngine({ surface: "tui" }) —— 装配
 * SSOT 化。TUI 不再自建 adapter / executor / permission / registry / system,
 * 全量走 harness 单一装配点(与 chat / ask / serve 同源,工具面永不漂移)。
 * TUI 因此自动继承 subagentManager(surface !== "ask" 自建) + shutdown 组合
 * 句柄(MCP + subagent 两清理)。coordinator 段默认缺席(#558 T2)—— 引导
 * 落点已迁到 spawn_subagent 工具 description(#557 T1 SSOT);装配缝保留,
 * 调用方显式经 createIknowSystemResolver opts.coordinatorText 仍渲染该段。
 *
 * T1 观测缝(#365):opts.onToolEvent + opts.soleInflightId 由本模块 wrapTuiHook
 * 包装成 BuildEngineOpts.hooks(PostToolUseHook),经 build-engine 透传进
 * createAciExecutor —— postToolUse 触发 → soleInflightId 归因 → onToolEvent
 * (工具摘要行事件,Q5b=B;permission/types.ts:118-131 官方观测挂点,每 call 事后触发)。
 *
 * #337 Phase B / #361 Phase D / #378:装配完成后用 build-engine 透出的
 * skillCatalog + mcpManager + catalog 构建 TUI 扩展面(TuiExtensions),经
 * opts.onExtensions 同步回调消费(slash 候选 / MCP 看板 / 退出收口)。MCP 连接
 * 超时由 env.mcp.connectTimeoutMs 经 build-engine 透传(默认 60_000)。
 * 纯 TS 模块,无 ink / OpenTUI 依赖。
 */
import type { LoopEngineDeps } from "../harness/index.js";
import { buildHarnessEngine } from "../harness/build-engine.js";
import { resolveSessionTodoDir } from "../harness/aci/tools/todo-write.js";
import { LLM_API_KEY_MISSING_MESSAGE } from "../config/messages.js";
import type { PostToolUseHook } from "../harness/permission/types.js";
import type { PermissionModeContext } from "../harness/permission/modes.js";
import type { GraphModeContext } from "../harness/graph/mode.js";
import type { GraphAssembly } from "../harness/graph/assembly.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import type { SubAgentManager } from "../harness/subagent/manager.js";
import { createJsonlTraceService } from "../harness/trace/index.js";
import type {
  AutoMemoryHook,
  MemoryLiveFlags,
  OverlayPrefetchFn,
} from "../harness/memory/index.js";
import type { RuntimeBundle } from "../cli/runtime.js";
import type { AskUser } from "../harness/permission/types.js";
import type { WorktreeIsolationHostOpts } from "../harness/isolation/worktree-gate.js";
import type { IknowSettings } from "../config/settings.js";
import { homedir } from "node:os";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import type { McpServerStatus } from "../harness/mcp/manager.js";
import { loadMcpConfig } from "../harness/mcp/config.js";
import type { AciToolDef } from "../harness/aci/types.js";

/** 工具摘要行事件（postToolUse 投影，observability-only）。 */
export interface TuiToolEvent {
  readonly conversationId: string;
  readonly toolName: string;
  /** T4 (#175): tool_use_id — TUI 用此与流式 tool_call_start 配对转 ok/failed
   * 摘要行;缺省时(host 未注入 / 旧版回放) 落回 legacy 字符串行追加。 */
  readonly toolUseId?: string;
  /** ok | validation_failed | tool_not_found | execution_failed */
  readonly kind: string;
  readonly input: unknown;
  readonly message?: string;
  /**
   * T4 (#298):观测 side-channel 载体 — handler envelope 的 meta(old/new 全文)。
   * 注意与模型面(MCP/Anthropic)的 `payload` 概念无关:此字段只承载 diff 的
   * old/new 内容,绝不进模型 tool_result。仅在 ok 且有 meta 时存在。
   */
  readonly payload?: {
    readonly oldContent?: string;
    readonly newContent?: string;
  };
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
  /**
   * 可变权限模式上下文（TUI 按 Shift+Tab 翻转它）。
   * 缺省 = 静态 default 上下文（保留历史行为；hub 内 ToolExecutionContext
   * 仍走 asModeContext 自适配）。
   */
  readonly permissionMode?: PermissionModeContext;
  /**
   * #279 项3：会话级授权登记表 —— 权限 modal「总是允许」写入 session 层
   * allow 规则（最高优先 normal 层），后续同工具调用 checkPermission 直接
   * 放行不再 ask。缺省 = 无 session 层（历史行为）。
   */
  readonly sessionGrants?: SessionGrants;
  /**
   * D-α T5 / ADR-0030：graph 编排 overlay holder（TUI 按 Shift+Tab 或敲
   * `/graph` 翻它）。透传给 build-engine —— `run_graph` 与编排段按返回的
   * `graphAssembly` 每 round 快照 gate。缺席 = 本入口未接 overlay。
   */
  readonly graphMode?: GraphModeContext;
  /** #337 Phase B 测试缝：userHome 覆盖（默认 homedir()）。 */
  readonly userHome?: string;
  /** #337 Phase B 测试缝：cwd 覆盖（默认 process.cwd()）。 */
  readonly cwd?: string;
  /**
   * ADR-0019 (T2): per-root state anchor — CLI `--workspace-root` flag 透传
   * 到 build-engine。TUI 入口(tui/run.tsx)从 `RunTuiOptions.workspaceRoot`
   * 透传到 buildTuiDeps → buildHarnessEngine。TUI 不再持有 userHome/cwd
   * 之外的全局 state,workspaceRoot 在 deps 层单向透明。
   */
  readonly workspaceRoot?: string;
  /**
   * T6 / worktree-mcp-rebind-lifecycle:稳定主 checkout root。首次装配捕获后
   * 跨 rebind 原样透传；reload 的 mcpConfigRoot 只由此派生，禁止用 cwd 重算。
   */
  readonly productRoot?: string;
  /** Review (round 2/3):跨 rebind 稳定的项目身份根（启动 cwd）。 */
  readonly projectIdentityRoot?: string;
  /**
   * 观测性地板:JSONL trace 写目录。在场时把 subagent 三事件交给 build-engine
   * （与 serve hub 同形：`<traceOut>/subagent.jsonl`）。
   */
  readonly traceOut?: string;
  /** #337 Phase B 测试缝：MCP client 工厂覆盖（注入 stub 避免真实 stdio 启动）。 */
  readonly createMcpClient?: (
    server: import("../harness/mcp/config.js").McpServerConfig
  ) => import("../harness/mcp/manager.js").McpClientHandle;
  /**
   * #378 测试缝：createMcpManager 工厂覆盖。与 createMcpClient 对偶——
   * 测试经此捕获 createMcpManager 入参（如 timeoutMsOverride 透传），
   * 避免 mock.module 触发 bun require 死锁（bun 1.3.14 已知问题）。
   */
  readonly createMcpManager?: typeof import("../harness/mcp/manager.js").createMcpManager;
  /**
   * #337 Phase B：装配完成同步回调，透出扩展面（skillCatalog / mcp / shutdown）。
   * Phase C/D 消费（slash 候选派生、MCP 状态显示、退出路径收口）。
   */
  readonly onExtensions?: (ext: TuiExtensions) => void;
  /**
   * Review High-1 (2026-08-29 / ADR-0037)：worktree isolation host 缝 ——
   * 透传给 buildHarnessEngine。开关本体由 build-engine 在启动加载点从
   * `settings` 读取（硬要求 9）；ON 时 TUI 引擎的 mutate 被门禁拦截，provision
   * 负责建 task worktree + 仅本会话根改绑（TUI hub 的 per-root 重建缝见
   * run.tsx / hub-bridge）。缺席 → 不包装，行为与今日逐字节一致。
   */
  readonly worktreeIsolation?: WorktreeIsolationHostOpts;
  /**
   * Review High-2 (2026-08-29 / 硬要求 9)：启动装配点读取的 settings 对象。
   * 透传给 buildHarnessEngine 的 `settings` 缝 —— rebind 后 per-root 重建的
   * 引擎复用 run.tsx 传入的同一对象，worktree 内 `.iknow/` 缺席（gitignore）
   * 也绝不隐式重载 project settings。缺席 → build-engine 自行缺省加载
   * （与今日等价）。
   */
  readonly settings?: IknowSettings;
}

/**
 * #337 Phase B：装配完成透出的 TUI 扩展面（Phase C/D 消费）。
 *  - skillCatalog：Phase C 读 available()/get() 派生 slash 候选 + 加载正文；
 *  - mcp.status / reload：MCP server 连接状态快照 + 重读两级 config 后重载；
 *  - listMcpTools（#361 Phase D）：一次拉全量 mcp__* 工具 → 平铺
 *    `{ server, tool }[]`，detail view 按 server 过滤（避免 N 次过滤）。
 *    只追加 readonly 字段，不改 Phase B 既有逻辑；
 *  - shutdown：TUI 退出路径调用，关闭所有 MCP client + 取消 in-flight + SIGTERM stdio。
 */
export interface TuiExtensions {
  readonly skillCatalog: SkillCatalog;
  readonly mcp: {
    readonly status: () => readonly McpServerStatus[];
    readonly reload: () => Promise<void>;
  };
  readonly listMcpTools: () => ReadonlyArray<McpToolExtEntry>;
  readonly shutdown: () => Promise<void>;
}

/** MCP 看板消费的最小扩展面（TuiAppProps.mcp 用；deps.ts SSOT）。 */
export interface TuiMcpViewExt {
  readonly status: () => readonly McpServerStatus[];
  readonly reload: () => Promise<void>;
  readonly listMcpTools: () => ReadonlyArray<McpToolExtEntry>;
}

export interface McpToolExtEntry {
  readonly server: string;
  readonly tool: AciToolDef;
}

/**
 * 从动态工具名反解 server 名：`mcp__<server>__<tool>`（server / tool 段都
 * 可能含 `__` —— manager 的 sanitizeSegment 只把非 `[A-Za-z0-9_]` 替换成 `_`，
 * 连字符 / 点保留）。返回中间段 `server`；段数不足（非标准形态）返回原名。
 * 纯函数 + exported 供单测直接断言。
 */
export function mcpServerOfToolName(name: string): string {
  const body = name.startsWith("mcp__") ? name.slice("mcp__".length) : name;
  const sep = body.indexOf("__");
  if (sep === -1) return name;
  return body.slice(0, sep);
}

/**
 * T1 观测缝(#365):把 TUI 的 onToolEvent + soleInflightId 归因包装成
 * build-engine 的 PostToolUseHook(透传进 createAciExecutor)。语义与委托前
 * 一致:postToolUse 触发 → soleInflightId 归因 → onToolEvent 投影为
 * TuiToolEvent。soleInflightId 缺省/undefined(多会话并发)→ 事件抑制。
 */
function wrapTuiHook(opts: BuildTuiDepsOptions): PostToolUseHook {
  return (result) => {
    if (!opts.onToolEvent) return;
    const conversationId = opts.soleInflightId?.();
    // 多会话并发 → 无法归因 → 抑制（v1 已知边界，见 hub-bridge.ts）。
    if (conversationId === undefined) return;
    opts.onToolEvent({
      conversationId,
      toolName: result.name,
      // T4 (#175): 把 tool_use_id 透传,TUI 据此与流式 tool_call_start 配对
      // (result.toolUseId 是必填字段,见 permission/types.ts PostToolUseHook)。
      toolUseId: result.toolUseId,
      kind: result.kind,
      input: result.input,
      message: result.message,
      // T4 (#298): meta 透传 → TuiToolEvent.payload(观测 side-channel)。
      payload: result.meta,
    });
  };
}

export async function buildTuiDeps(
  bundle: RuntimeBundle,
  opts: BuildTuiDepsOptions
): Promise<
  LoopEngineDeps & {
    subagentManager?: SubAgentManager;
    shutdown?: () => Promise<void>;
    /** D-α T5:graph 装配快照句柄（仅注入 graphMode 时透出，交给 hub 拍 round）。 */
    graphAssembly?: GraphAssembly;
    autoMemory?: AutoMemoryHook;
    overlayMemoryPrefetch?: OverlayPrefetchFn;
    memoryFlags?: MemoryLiveFlags;
  }
> {
  if (!bundle.env.llm.apiKey) {
    // settings-model-extension：key 来源 = settings.llm.apiKey（字面或 ${VAR}）。
    throw new Error(LLM_API_KEY_MISSING_MESSAGE);
  }
  // #337 Phase B：userHome / cwd 测试缝（默认 = 真实 homedir() / process.cwd()），
  // 与 build-engine #337 T8 同款。装配期 skill scanner + mcp config 都从这里取。
  const userHome = opts.userHome ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  // 子代理生命周期事件落盘 —— 与 serve hub 同款：单例 manager 聚合到
  // `<traceOut>/subagent.jsonl`（reader 按 task_id 过滤）。TUI 会话 turn
  // 仍走 hub-bridge 的 per-conversation JSONL；子代理三事件与此对齐。
  const traceOut = opts.traceOut;
  const subagentTrace = traceOut
    ? createJsonlTraceService({
        filePath: traceOut,
        conversationId: "subagent",
      })
    : undefined;
  // #440 T1-fix:TUI 入口注入 todoDir 让 todo_write 在主 loop 在场
  // (per-conversationId resolution 是后续 ticket — soleInflightId 动态,
  // per-conversationId 需 engine 重建,代价太高;v1 共享 ~/.iknow/todos/tui/)。
  const built = await buildHarnessEngine({
    env: bundle.env,
    askUser: opts.askUser,
    surface: "tui",
    memory: { enabled: true },
    todoDir: resolveSessionTodoDir({ userHome, surface: "tui" }),
    // #365 T2: 沙箱根保持 TUI 历史语义(启动目录 = process.cwd());
    // build-engine 缺省即 process.cwd(),故不显式传。
    // memoryDir 同理缺省解析自 cwd(与 #146 TUI 启动目录语义一致)。
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.sessionGrants ? { session: opts.sessionGrants } : {}),
    // D-α T5:overlay holder 透传 —— run_graph / 编排段的条件装配缝。
    ...(opts.graphMode ? { graphMode: opts.graphMode } : {}),
    // T1 观测缝:#175 T4 工具摘要行 — postToolUse 投影为 TuiToolEvent。
    ...(opts.onToolEvent ? { hooks: wrapTuiHook(opts) } : {}),
    // #337 Phase B 测试缝:userHome / cwd 覆盖(与 build-engine 同款)。
    ...(opts.userHome ? { userHome } : {}),
    ...(opts.cwd ? { cwd } : {}),
    // ADR-0019 (T2): per-root state anchor 透传到 build-engine。
    // 判在场一律 `!== undefined`（三个根同规则，review round 5）：空串必须
    // 透下去触 SSOT 的 fail-closed，真值判会把它吞掉再静默回退。
    ...(opts.workspaceRoot !== undefined
      ? { workspaceRoot: opts.workspaceRoot }
      : {}),
    // T6:稳定 productRoot 透传（缺席 → build-engine 桥接为 workspaceRoot）。
    ...(opts.productRoot !== undefined
      ? { productRoot: opts.productRoot }
      : {}),
    // Review (round 2/3):启动期项目身份根透传（缺席 → build-engine 退
    // `mainCheckoutOf(cwd)`）。判在场用 `!== undefined`:空串要透下去触 SSOT
    // 的 fail-closed，真值判会吞掉它（review round 4）。
    ...(opts.projectIdentityRoot !== undefined
      ? { projectIdentityRoot: opts.projectIdentityRoot }
      : {}),
    // 观测性地板:traceOut 在场 → subagent 三事件落 `<traceOut>/subagent.jsonl`。
    ...(subagentTrace !== undefined
      ? { subagentTrace, subagentDiagnosticsDir: traceOut }
      : {}),
    // #378 测试缝:createMcpManager 工厂覆盖(透传,捕获入参断言)。
    // prettier-ignore（master 一致单行：L3 review 复原；88 字符超 80 列，禁用 prettier 重排）。
    // prettier-ignore
    ...(opts.createMcpManager ? { createMcpManager: opts.createMcpManager } : {}),
    // #337 Phase B 测试缝:MCP client 工厂覆盖。
    ...(opts.createMcpClient ? { createMcpClient: opts.createMcpClient } : {}),
    // Review High-2 / High-1 (2026-08-29):启动装配 settings 对象 +
    // worktree isolation host 缝透传（开关读取仍在 build-engine 启动加载点）。
    ...(opts.settings ? { settings: opts.settings } : {}),
    ...(opts.worktreeIsolation
      ? { worktreeIsolation: opts.worktreeIsolation }
      : {}),
  });

  // #337 Phase B / #361 Phase D：用 build-engine 透出的装配件构建 TUI 扩展面。
  // skillCatalog / mcpManager / catalog 均来自 buildHarnessEngine 单一装配点
  // (surface="tui" 全装配;mcpManager 仅在 manager 缺席时缺省防御)。
  const mcpManager = built.mcpManager;
  const skillCatalog = built.skillCatalog;
  const catalog = built.catalog;

  // reload 实现：重读两级 config（可被用户改 ~/.iknow/mcp.json 或项目级
  // mcp.json 后触发）,manager.reload 内部 shutdown + 重建 + 后台 start。
  // 幂等：无 mcp.json → servers 空 → reload 空集。
  // T6:mcpConfigRoot 锁定装配时的 productRoot / BuiltEngine.mcpRoots，
  // 不随 task cwd 漂移，也不读 process.cwd()。
  const mcpConfigRoot =
    built.mcpRoots?.mcpConfigRoot ??
    opts.productRoot ??
    opts.workspaceRoot ??
    cwd;
  const reload = async (): Promise<void> => {
    if (!mcpManager) return;
    const cfg = await loadMcpConfig({ home: userHome, mcpConfigRoot });
    await mcpManager.reload(cfg.servers);
  };

  // #361 Phase D：listMcpTools 实现 — 从 catalog.all() 取全部 mcp__* 动态
  // 工具，按 server 名反解（mcp__<server>__<tool>），平铺成 {server, tool}[]。
  // reload 后工具集变化（unregister + register），detail view 每次进入重拉最新
  // 即可（TuiApp 侧缓存 policy：看板首次进入拉一次，reload 后刷新）。
  const listMcpTools = (): ReadonlyArray<McpToolExtEntry> => {
    if (!catalog) return [];
    const out: McpToolExtEntry[] = [];
    for (const def of catalog.all()) {
      if (!def.name.startsWith("mcp__")) continue;
      out.push({ server: mcpServerOfToolName(def.name), tool: def });
    }
    out.sort((a, b) => a.server.localeCompare(b.server));
    return out;
  };

  // 装配完成后同步回调透出扩展面（Phase C/D 消费）。shutdown 收口于
  // build-engine 组合 shutdown（MCP 关闭 client + 取消 in-flight + SIGTERM
  // stdio 子孙 + subagent drain）。surface="tui" 全装配:skillCatalog /
  // mcpManager / shutdown 均在 ask 之外必建(T6 + T8 契约),此处以必达断言
  // 收窄类型;极端防御缺省(空 catalog / no-op shutdown)保证回调不抛。
  opts.onExtensions?.({
    skillCatalog: skillCatalog!,
    mcp: {
      status: () => mcpManager?.status() ?? [],
      reload,
    },
    listMcpTools,
    shutdown: async () => {
      // surface="tui" 必建 shutdown(T8 + T6 契约);极端防御缺省 no-op。
      if (built.shutdown) await built.shutdown();
    },
  });

  return {
    ...built.deps,
    ...(built.subagentManager
      ? { subagentManager: built.subagentManager }
      : {}),
    ...(built.shutdown ? { shutdown: built.shutdown } : {}),
    ...(built.graphAssembly ? { graphAssembly: built.graphAssembly } : {}),
    // auto-memory T4:自动记忆钩子随 deps 平铺透出，run.tsx 解构后交给
    // createTuiBridge → SessionHub。缺席（默认 OFF）→ 字段不出现。
    ...(built.autoMemory ? { autoMemory: built.autoMemory } : {}),
    ...(built.overlayMemoryPrefetch
      ? { overlayMemoryPrefetch: built.overlayMemoryPrefetch }
      : {}),
    ...(built.memoryFlags ? { memoryFlags: built.memoryFlags } : {}),
  };
}
