/**
 * src/tui/deps.ts
 *
 * #365 T2: buildTuiDeps 委托 buildHarnessEngine({ surface: "tui" }) —— 装配
 * SSOT 化。TUI 不再自建 adapter / executor / permission / registry / system,
 * 全量走 harness 单一装配点(与 chat / ask / serve 同源,工具面永不漂移)。
 * TUI 因此自动继承 subagentManager(surface !== "ask" 自建) + coordinatorText
 * (IKNOW_COORDINATOR_TEXT) + shutdown 组合句柄(MCP + subagent 两清理)。
 *
 * T1 观测缝(#365):opts.onToolEvent + opts.soleInflightId 由本模块 wrapTuiHook
 * 包装成 BuildEngineOpts.hooks(PostToolUseHook),经 build-engine 透传进
 * createAciExecutor —— postToolUse 触发 → soleInflightId 归因 → onToolEvent
 * (工具摘要行事件,Q5b=B;permission/types.ts:118-131 官方观测挂点,每 call 事后触发)。
 * 纯 TS 模块,无 ink / OpenTUI 依赖。
 */
import type { LoopEngineDeps } from "../harness/index.js";
import { buildHarnessEngine } from "../harness/build-engine.js";
import type { PostToolUseHook } from "../harness/permission/types.js";
import type { PermissionModeContext } from "../harness/permission/modes.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import type { SubAgentManager } from "../harness/subagent/manager.js";
import type { RuntimeBundle } from "../cli/runtime.js";
import type { AskUser } from "../harness/permission/types.js";

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
  }
> {
  if (!bundle.env.llm.apiKey) {
    throw new Error(
      `CLI LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${bundle.env.llm.apiKeyEnv}); set the key.`
    );
  }
  const built = await buildHarnessEngine({
    env: bundle.env,
    askUser: opts.askUser,
    surface: "tui",
    memory: { enabled: true },
    // #365 T2: 沙箱根保持 TUI 历史语义(启动目录 = process.cwd());
    // build-engine 缺省即 process.cwd(),故不显式传。
    // memoryDir 同理缺省解析自 cwd(与 #146 TUI 启动目录语义一致)。
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    ...(opts.sessionGrants ? { session: opts.sessionGrants } : {}),
    // T1 观测缝:#175 T4 工具摘要行 — postToolUse 投影为 TuiToolEvent。
    ...(opts.onToolEvent ? { hooks: wrapTuiHook(opts) } : {}),
  });
  return {
    ...built.deps,
    ...(built.subagentManager
      ? { subagentManager: built.subagentManager }
      : {}),
    ...(built.shutdown ? { shutdown: built.shutdown } : {}),
  };
}
