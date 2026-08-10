/**
 * src/tui/deps.ts
 *
 * #146 TUI 的 harness deps 装配：与 buildHarnessEngine 共用同一 ACI 装配链 —
 * real Anthropic adapter + 8 件工具集（走 `createDefaultAciRegistry` SSOT 工厂，
 * 见 src/harness/aci/tools/registry.ts）+ permission policy。与 CLI 入口差异两点：
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
import { createAciExecutor } from "../harness/aci/index.js";
import { createPermissionPolicy } from "../harness/permission/policy.js";
import { createDefaultAciRegistry } from "../harness/aci/tools/registry.js";
import { createIknowSystemResolver } from "../harness/identity/index.js";
import {
  resolveProjectMemoryDir,
  createSystemResolver,
} from "../harness/memory/index.js";
import type { AskUser } from "../harness/permission/types.js";
import type { PermissionModeContext } from "../harness/permission/modes.js";
import type { SessionGrants } from "../harness/permission/session-grants.js";
import type { RuntimeBundle } from "../cli/runtime.js";
import { homedir } from "node:os";
import { createSubAgentManager } from "../harness/subagent/manager.js";
import { defaultSubAgentSpawn } from "../harness/subagent/spawn.js";
import type { SubAgentManager } from "../harness/subagent/manager.js";

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
   * #356 T6:测试缝——覆盖注入 SubAgentManager（生产默认自建 defaultSubAgentSpawn）。
   * 与 buildHarnessEngine 同语义：subagentManager 缺席时 spawn_subagent /
   * subagent_result 两件工具不在 registry（surface 门控不删，但 TUI 不传 →
   * 23 件；本票默认自建 → 25 件）。
   */
  readonly subagentManager?: SubAgentManager;
}

export function buildTuiDeps(
  bundle: RuntimeBundle,
  opts: BuildTuiDepsOptions
): LoopEngineDeps & { subagentManager?: SubAgentManager } {
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
    // T3 (D2): TUI 真实走流式臂,与 build-engine SSOT 同源。
    stream: env.llm.stream === "on",
  });
  // 8 件工具集 SSOT 工厂(与 buildHarnessEngine 同源,见 registry.ts)。
  // 沙箱根 = process.cwd();build-engine 接受 opts.sandboxRoot override,TUI 历史
  // 就硬编码 process.cwd()(与 #146 TUI 启动目录语义一致),本重构保持行为不变。
  // 若 TUI 未来接受 sandboxRoot override,在此镜像 build-engine 的 fallback。
  // env.web 透传 IKNOW_WEB_PROXY / IKNOW_WEB_SEARCH_URL,proxyUrl 非法 → 装配期同步抛。
  const sandboxRoot = process.cwd();
  // #194 T6:tui 与 build-engine chat 对齐 → memoryDir 必传(10 件工具集含
  // memory_recall + memory_save)。
  // #356 T6:subagent manager — TUI 入口与 build-engine chat 同门(surface ∈
  // {chat, tui, serve} 挂载 spawn_subagent / subagent_result)。测试缝可注入
  // 覆盖,生产默认 defaultSubAgentSpawn。
  const subagentManager =
    opts.subagentManager ??
    createSubAgentManager({ spawn: defaultSubAgentSpawn });
  const reg = createDefaultAciRegistry({
    env,
    sandboxRoot,
    memoryDir: resolveProjectMemoryDir(process.cwd()),
    subagentManager,
  });
  const baseExecutor = createExecutor(reg.inner);
  const policy = createPermissionPolicy({
    ...(opts.permissionMode ? { mode: opts.permissionMode } : {}),
    ...(opts.sessionGrants ? { session: opts.sessionGrants } : {}),
  });
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
          // T4 (#175): 把 tool_use_id 透传,TUI 据此与流式 tool_call_start 配对
          // (result.toolUseId 是必填字段,见 permission/types.ts PostToolUseHook)。
          toolUseId: result.toolUseId,
          kind: result.kind,
          input: result.input,
          message: result.message,
          // T4 (#298): meta 透传 → TuiToolEvent.payload(观测 side-channel)。
          payload: result.meta,
        });
      },
    },
  });
  return {
    adapter,
    executor,
    registry: reg.inner,
    // plan T5-engine / ADR-0012:env 优先(IKNOW_LLM_MAX_TURNS);
    // undefined = 无限。TUI 独立装配点,不经过 buildHarnessEngine。
    maxTurns: env.llm.maxTurns,
    timeoutMs: env.llm.timeoutMs,
    // #196 IKNOW T5:tui 入口走 system 注入缝(spec A12:chat/tui 激活
    // BOOTSTRAP,surface="tui" → bootstrapActive=true)。
    // #194 T6 (ACR 缺口补):tui 装配 memory 层 — memoryEnabled=true +
    // memoryResolver 注入,与 build-engine 的 chat 路径对齐(10 件工具 + memory_layer)。
    system: createIknowSystemResolver({
      cwd: process.cwd(),
      userHome: homedir(),
      surface: "tui",
      memoryEnabled: true,
      memoryResolver: createSystemResolver({
        cwd: process.cwd(),
        userHome: homedir(),
        memoryDir: resolveProjectMemoryDir(process.cwd()),
      }),
    }),
    // #356 T7 (SC7):TUI 入口与 build-engine chat 同门 — subagentManager 透出,
    // createTuiBridge 把它传给 SessionHub options → host drain 生效(TUI 上
    // spawn_subagent 完成的子代理结果进入下一轮 run)。
    subagentManager,
  };
}
