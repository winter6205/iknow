/**
 * src/tui/deps.ts
 *
 * #343 T6-A 迁移：从 archive/tui-ink/src/deps.ts 迁回 src/tui/。逻辑与原版
 * 一致（#146 TUI 的 harness deps 装配，与 buildHarnessEngine 共用同一 ACI
 * 装配链）；仅文件头注释更新为本次迁移说明。纯 TS 模块，无 ink / OpenTUI
 * 依赖。
 *
 * 与 CLI 入口差异两点：
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
import { createSkillScanner } from "../harness/skill/scanner.js";
import { createSkillCatalog } from "../harness/skill/catalog.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import type { McpServerStatus } from "../harness/mcp/manager.js";
import { loadMcpConfig } from "../harness/mcp/config.js";
import { createMcpManager, type McpManager } from "../harness/mcp/manager.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { RegistryImpl } from "../harness/tools/registry.js";
import type { AciRegistry } from "../harness/aci/aci-registry.js";

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
  /** #337 Phase B 测试缝：userHome 覆盖（默认 homedir()）。 */
  readonly userHome?: string;
  /** #337 Phase B 测试缝：cwd 覆盖（默认 process.cwd()）。 */
  readonly cwd?: string;
  /** #337 Phase B 测试缝：MCP client 工厂覆盖（注入 stub 避免真实 stdio 启动）。 */
  readonly createMcpClient?: (
    server: import("../harness/mcp/config.js").McpServerConfig
  ) => import("../harness/mcp/manager.js").McpClientHandle;
  /**
   * #337 Phase B：装配完成同步回调，透出扩展面（skillCatalog / mcp / shutdown）。
   * Phase C/D 消费（slash 候选派生、MCP 状态显示、退出路径收口）。
   */
  readonly onExtensions?: (ext: TuiExtensions) => void;
}

/**
 * #337 Phase B：装配完成透出的 TUI 扩展面（Phase C/D 消费）。
 *  - skillCatalog：Phase C 读 available()/get() 派生 slash 候选 + 加载正文；
 *  - mcp.status / reload：MCP server 连接状态快照 + 重读两级 config 后重载；
 *  - shutdown：TUI 退出路径调用，关闭所有 MCP client + 取消 in-flight + SIGTERM stdio。
 */
export interface TuiExtensions {
  readonly skillCatalog: SkillCatalog;
  readonly mcp: {
    readonly status: () => readonly McpServerStatus[];
    readonly reload: () => Promise<void>;
  };
  readonly shutdown: () => Promise<void>;
}

export async function buildTuiDeps(
  bundle: RuntimeBundle,
  opts: BuildTuiDepsOptions
): Promise<LoopEngineDeps> {
  const { env } = bundle;
  if (!env.llm.apiKey) {
    throw new Error(
      `CLI LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${env.llm.apiKeyEnv}); set the key.`
    );
  }
  // #337 Phase B：userHome / cwd 测试缝（默认 = 真实 homedir() / process.cwd()），
  // 与 build-engine #337 T8 同款。装配期 skill scanner + mcp config 都从这里取。
  const userHome = opts.userHome ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
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
  // 沙箱根 = cwd;build-engine 接受 opts.sandboxRoot override,TUI 历史
  // 就硬编码 process.cwd()(与 #146 TUI 启动目录语义一致),本重构保持行为不变。
  // 若 TUI 未来接受 sandboxRoot override,在此镜像 build-engine 的 fallback。
  // env.web 透传 IKNOW_WEB_PROXY / IKNOW_WEB_SEARCH_URL,proxyUrl 非法 → 装配期同步抛。
  const sandboxRoot = cwd;
  // #337 Phase B：skill catalog 装配 — 镜像 build-engine.ts:169-175。扫描器
  // 读三级目录(~/.iknow/skills → <cwd>/.iknow/skills → IKNOW_SKILL_DIRS),
  // scanner 自身 try/catch + warn 降级,scan 抛错被吞掉不阻塞装配。
  const skillCatalog: SkillCatalog = createSkillCatalog(
    await createSkillScanner({
      userHome,
      cwd,
      env: process.env,
    }).scan()
  );
  // #194 T6:tui 与 build-engine chat 对齐 → memoryDir 必传(10 件工具集含
  // memory_recall + memory_save)。#337 Phase B:skillCatalog 传入 → registry
  // 含 skill / skill_search 两件(与 build-engine chat 同款 23 件工具集)。
  const reg: AciRegistry = createDefaultAciRegistry({
    env,
    sandboxRoot,
    memoryDir: resolveProjectMemoryDir(cwd),
    skillCatalog,
  });
  // #337 Phase B：动态 registry 包装 —— 复刻 build-engine.ts:317-353 的
  // createDynamicExecutorRegistry（与 build-engine createDynamicExecutorRegistry
  // 同构）。让 inner executor 能解析 registerExternal 动态注册的 mcp__* 工具:
  // get/getValidator 优先 reg.inner（构造期冻结快照），miss 查 reg.catalog
  // （动态源）;动态 def 的 validator 用与 registry.makeAjv 同配置
  // （strict + allErrors + formats）的 ajv 实例惰性初始化 + Map 缓存。
  const dynamicExecutorRegistry = createDynamicExecutorRegistry(reg);
  const baseExecutor = createExecutor(dynamicExecutorRegistry);
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
  // #337 Phase B：MCP manager 装配 — 镜像 build-engine.ts:224-240。两级 config
  // 合并 + createMcpManager + start() 不 await（SC8 守门:慢 connect 不阻塞装配
  // 返回）。TUI 全量装配（无 ask 的 SC12 条件化），shutdown 句柄经 TuiExtensions
  // 透出,run.tsx 退出路径调用。
  let mcpManager: McpManager | undefined;
  const mcpConfig = await loadMcpConfig({ home: userHome, cwd });
  mcpManager = createMcpManager({
    config: mcpConfig.servers,
    registerExternal: reg.registerExternal,
    ...(opts.createMcpClient ? { createClient: opts.createMcpClient } : {}),
  });
  void mcpManager.start().catch((err) => {
    console.warn(
      `[tui/deps] MCP manager start failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  });

  // reload 实现：重读两级 config（可被用户改 ~/.iknow/mcp.json 或项目级
  // mcp.json 后触发）,manager.reload 内部 shutdown + 重建 + 后台 start。
  // 幂等：无 mcp.json → servers 空 → reload 空集。
  const reload = async (): Promise<void> => {
    const cfg = await loadMcpConfig({ home: userHome, cwd });
    await mcpManager!.reload(cfg.servers);
  };

  // 装配完成后同步回调透出扩展面（Phase C/D 消费）。shutdown 收口于
  // manager.shutdown（关闭 client + 取消 in-flight + SIGTERM stdio 子孙）。
  opts.onExtensions?.({
    skillCatalog,
    mcp: {
      status: () => mcpManager!.status(),
      reload,
    },
    shutdown: () => mcpManager!.shutdown(),
  });

  return {
    adapter,
    executor,
    // #337 Phase B：registry 仍回 reg.inner（T1 契约锁 inner.list() 快照），
    // 与 executor 的 dynamic wrapper 分离 —— createExecutor 内部只消费
    // get/getValidator（executor.ts 注释），静态工具集在 inner 快照内，
    // 动态 mcp__* 由 wrapper 解析,list() 保持构造期快照（与 build-engine
    // registryTools=reg.inner 同款）。
    registry: reg.inner,
    // plan T5-engine / ADR-0012:env 优先(IKNOW_LLM_MAX_TURNS);
    // undefined = 无限。TUI 独立装配点,不经过 buildHarnessEngine。
    maxTurns: env.llm.maxTurns,
    timeoutMs: env.llm.timeoutMs,
    // #196 IKNOW T5:tui 入口走 system 注入缝(spec A12:chat/tui 激活
    // BOOTSTRAP,surface="tui" → bootstrapActive=true)。
    // #194 T6 (ACR 缺口补):tui 装配 memory 层 — memoryEnabled=true +
    // memoryResolver 注入,与 build-engine 的 chat 路径对齐(10 件工具 + memory_layer)。
    // #337 Phase B:skills 注入缝 → <available_skills> 段(skill 工具在场即让
    // 模型知道 available skills,与 build-engine 全 surface 注入同款投影)。
    system: createIknowSystemResolver({
      cwd,
      userHome,
      surface: "tui",
      memoryEnabled: true,
      memoryResolver: createSystemResolver({
        cwd,
        userHome,
        memoryDir: resolveProjectMemoryDir(cwd),
      }),
      skills: () =>
        skillCatalog.available().map((entry) => ({
          name: entry.name,
          description: entry.description ?? "",
          ...(entry.disabled ? { disabled: true } : {}),
        })),
    }),
  };
}

/**
 * #337 Phase B：动态 registry 包装 —— 给 createExecutor 喂一个能解析
 * registerExternal 动态注册的 mcp__ 工具的 RegistryImpl 视图。
 *
 * 与 build-engine.ts:317-353 的 createDynamicExecutorRegistry **同构**（复刻
 * 而非 export 复用——Phase B 约束：不改 build-engine 导出除非必须；此函数
 * 无共享状态、纯装配层私有工具，两侧镜像成本低于跨模块耦合）。约束一致：
 *   - 构造后 reg.inner 冻结（T1 契约），本包装不修改 inner，仅在内层 miss 时
 *     向上查 reg.catalog（动态源）。
 *   - list() 仍返回 reg.inner.list() 快照（与 T1 一致）。
 *   - get()/getValidator() 优先 reg.inner（构造期冻结、零开销），miss 时走
 *     reg.catalog.get(name)（动态源）；动态 def 的 validator 用与 registry.makeAjv
 *     同配置（strict + allErrors + formats）的 ajv 实例现场编译一次并缓存。
 *
 * 仅在此处装配（TUI deps）；aci-registry.ts 与 permission-executor.ts 都不动。
 */
function createDynamicExecutorRegistry(reg: AciRegistry): RegistryImpl {
  // ajv **惰性**初始化：Ajv.default + addFormats 实例化在构造期很重
  // （实测 ~300ms+），而 SC8 要求装配不因 MCP 变慢。首次命中动态源才创建。
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
