/**
 * ACI 工具集注册层 — 11 件 SSOT（8 基线 + memory_recall/memory_save + tool_search）。
 *
 * **目的**:让所有 harness 入口(CLI `ask` / `chat` / `serve`、TUI `iknow tui`)
 * 共享同一份"工具有哪些 + 怎么注入 env"的装配函数,避免工具集分裂
 * (历史教训:`src/tui/deps.ts` 手写 6 个文件工具漏注册 web_fetch/web_search)。
 *
 * **对齐 upstream**:upstream-ref 用 `ToolRegistry` 类 +
 * `create_default_tool_registry()` 工厂(`upstream-ref/src/<baseline>/tools/__init__.py:48`),
 * `build_runtime()`(`ui/runtime.py:324`)唯一装配点;UI 层从 `RuntimeBundle.tool_registry`
 * 读,不自己注册。本模块同构实现,但更薄 — 仅做"哪些工具 + env 透传",
 * 不替代 `createAciRegistry`(后者还管协议 registry + 延迟加载 catalog)。
 *
 * **append-only**:不重排既有 8 工具顺序(policy byName 键空间与 ADR-0006 稳定);
 * Web 类工具(bash / read_file / grep / glob / edit_file / write_file 之后)
 * 沿用 build-engine.ts 历史顺序;memory_recall / memory_save(#228 layer 3,
 * 条件化:memoryDir 缺席时不入注册表)在 Web 类之后追加;`tool_search`(#224
 * 扩展路径)末尾追加。
 */
import type { IknowEnv } from "../../../config/env.js";
import { createAciRegistry, type AciRegistry } from "../aci-registry.js";
import type { AciToolDef } from "../types.js";
import { createBashTool } from "./bash.js";
import type { SecretRegistry } from "../../secret-roundtrip/index.js";
import { createReadFileTool } from "./read-file.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createEditFileTool } from "./edit-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createMemoryRecallTool } from "../../memory/tools/recall.js";
import { createMemorySaveTool } from "../../memory/tools/save.js";
import { createToolSearchTool } from "./tool-search.js";
import { createLspToolSet } from "./lsp.js";
import { createSkillTool } from "./skill.js";
import { createSkillSearchTool } from "./skill-search.js";
import { createSpawnSubAgentTool } from "../../subagent/spawn-subagent-tool.js";
import { createSubAgentResultTool } from "../../subagent/subagent-result-tool.js";
import type { SubAgentManager } from "../../subagent/manager.js";
import type { BackgroundTaskManager } from "../../background/manager.js";
import type { McpManager } from "../../mcp/manager.js";
import { createListMcpResourcesTool } from "./list-mcp-resources.js";
import { createReadMcpResourceTool } from "./read-mcp-resource.js";
import { createBashOutputTool } from "./bash-output.js";
import { createBashStopTool } from "./bash-stop.js";
import { buildWorkerToolSurface } from "../../subagent/role.js";
import { RegistryConstructionError, ToolExecutionError } from "../../errors.js";
import type { SkillCatalog } from "../../skill/catalog.js";
import { createTodoWriteTool } from "./todo-write.js";

/**
 * 11 件生产工具的命名常量 — SSOT（8 基线 + memory_recall + memory_save + tool_search）。
 *
 * 这是给 LLM agent 调的 11 个生产工具(bash / read_file / grep / glob /
 * edit_file / write_file / web_fetch / web_search / memory_recall /
 * memory_save / tool_search)的命名真值,不是测试 fixture。导出它让两个层分工:
 *   - 装配层:`createDefaultAciRegistry()` 实际把 factories 拼起来,
 *     返回 AciRegistry;生产入口(build-engine / TUI)只跟工厂交互
 *   - 命名层:本常量承载「这 11 个名字是 iknow 工具集」的声明真值,
 *     被测试断言消费(`registry.test.ts` 用它锁工具集不变),也给未来
 *     诊断 / tool_search 类 hook 按名查工具用
 *
 * 即「测试断言消费」不等于「测试工具」— 它是工具集的命名权威,
 * 测试只是这条权威的消费者之一。
 *
 * **Gate 3（SSOT append-only 纪律）**:`createDefaultAciRegistry` 把 factories
 * 按此名单派生装配;若 factories 键与名单不一致(长度/顺序/成员任何一处
 * 分歧),装配期即抛 `RegistryConstructionError`。将来加件只改 factories 忘
 * append 名单(或反之,或重排既有项)装配期立刻失败,不给运行期留隐患。
 * memory_recall / memory_save 是条件化的(memoryDir 缺席时同时缺席,
 * Gate 3 在 `toolsetNames` 端做镜像过滤,见工厂尾部注释)。
 */
export const ACI_TOOLSET_NAMES = Object.freeze([
  "bash",
  "read_file",
  "grep",
  "glob",
  "edit_file",
  "write_file",
  "web_fetch",
  "web_search",
  "memory_recall", // #228 layer 3（条件化:memoryDir 缺席时不装配）
  "memory_save", // #228 layer 3（同上）
  "tool_search", // #224 扩展路径
  // #251 LSP 工具集 append-only：10 件（9 operation + lsp_diagnostics）。
  // spec 写「8 operation + lsp_diagnostics = 9 件」但列了 9 个 operation 名
  // → 实为 10 件；总量 11→21。append-only 纪律：不重排既有 11 件。
  "lsp_definition", // #251 LSP operation
  "lsp_references", // #251
  "lsp_hover", // #251
  "lsp_document_symbol", // #251
  "lsp_workspace_symbol", // #251
  "lsp_go_to_implementation", // #251
  "lsp_prepare_call_hierarchy", // #251
  "lsp_incoming_calls", // #251
  "lsp_outgoing_calls", // #251
  "lsp_diagnostics", // #251
  // #337 T5 skill 工具集 append-only：21→23。
  // 两件工具都条件化装配（skillCatalog 缺席时不入注册表,与 memoryDir
  // 同形态：Gate 3 在 toolsetNames 端镜像过滤,见工厂尾部注释）。
  "skill", // #337 T5 直呼取 skill 正文
  "skill_search", // #337 T5 大小写不敏感子串检索
  // #356 T4 spawn_subagent append-only：23→24。条件化装配（subagentManager
  // 缺席时不入注册表，与 skillCatalog / memoryDir 同形态：Gate 3 在
  // toolsetNames 端镜像过滤，见工厂尾部注释）。
  "spawn_subagent", // #356 T4 主代理派发子代理（异步返 task_id）
  // #356 T5 subagent_result append-only：24→25。条件化装配（subagentManager
  // 缺席时不入注册表，与 spawn_subagent / skillCatalog / memoryDir 同形态：
  // Gate 3 在 toolsetNames 端镜像过滤，见工厂尾部注释）。
  "subagent_result", // #356 T5 主代理轮询子代理四态（not_found/running/completed/failed）
  // #440 双 Stream 工具集 append-only：25→28（并集，#480 Stream B 先合 +
  // #481 Stream A 后合）。三件都条件化装配（Gate 3 在 toolsetNames 端
  // 镜像过滤，见工厂尾部注释）：
  //   - todo_write: todoDir 缺席时不入注册表 — worker 装配路径 + ask 表面
  //     均不传 todoDir（D6 所有权边界 / SC8 oneshot 剥离）
  //   - list_mcp_resources / read_mcp_resource: mcpManager 缺席时不入
  //     注册表 — ask 入口零件 + 任务型 worker；与 subagentManager /
  //     skillCatalog / memoryDir 同形态
  // M2 决议：MCP resources read-only / 默认 ask 关闭；与 web_fetch /
  // web_search 先例对齐（ask 是副作用守门，不是内容审查门）。list 由
  // iknow 自写 meta 工具行为透明，诚实标 read-only（与 mcp__* 动态工具
  // 的保守 write 默认不同）。
  "todo_write", // #440 D1/D2 session 作用域 ledger（host 注入 todoDir）
  "list_mcp_resources", // #440 T11 list MCP server 暴露的 resources（聚合 / 可选 server + cursor）
  "read_mcp_resource", // #440 T11 读单个 resource 内容（必填 server + uri）
  // #502 T4 bash_output / bash_stop append-only：28→30（Track A 模型操作面，
  // 与 T3 bash background:true 成对）。两件都条件化装配（backgroundManager
  // 缺席时不入注册表——ask 入口零件；bash 常驻不在此列，参数级能力由 handler
  // 运行时决策——Gate 3 在 toolsetNames 端镜像过滤，见工厂尾部注释）。
  "bash_output", // #502 T4 读后台任务日志尾部 + 状态/exit_code（read-only 默认 allow）
  "bash_stop", // #502 T4 终止后台任务进程组（SIGTERM→2s→SIGKILL；write 默认 ask）
] as const);

/**
 * 工厂入参:仅消费 env.web 字段(端点覆写 + 出站代理)与沙箱根。
 * 不接收完整 IknowEnv — 避免误传 LLM key 等敏感字段越界。
 */
export interface CreateDefaultAciRegistryOptions {
  readonly env: Pick<IknowEnv, "web">;
  /** 软沙箱根(传入 process.cwd() 或调用方显式路径;fs 工具据此越界拒绝)。 */
  readonly sandboxRoot: string;
  /** 记忆库根目录(#228 layer 3)。缺席时 memory_recall / memory_save 不入注册表。 */
  readonly memoryDir?: string;
  /** #337 T5 skill 索引层(catalog)。缺席时 skill / skill_search 不入注册表。 */
  readonly skillCatalog?: SkillCatalog;
  /** #356 T4 主代理本地子代理生命周期管理器。缺席时 spawn_subagent 不入注册表
   * （ask 入口零件场景；chat/tui/serve 由 build-engine 按 surface 条件构造传入）。 */
  readonly subagentManager?: SubAgentManager;
  /** #440 T11 MCP 资源通道管理器。缺席时 list_mcp_resources / read_mcp_resource
   *  不入注册表（ask 入口零件场景 + 任务型 worker；chat/tui/serve 由 build-engine
   *  按 surface 条件构造传入）。与 subagentManager / skillCatalog / memoryDir
   *  同形态：Gate 3 在 toolsetNames 端镜像过滤，见工厂尾部注释。 */
  readonly mcpManager?: McpManager;
  /** #251 onEdit 接缝:edit_file 写盘成功后回调(装配层接 LSP notifier)。 */
  readonly onEdit?: (file: string) => void;
  /** ADR-0019 (T4): per-root state anchor. Threaded into bash + read_file
   *  factories so the fs-policy fence binds `<workspaceRoot>` and the
   *  protected-state pathset covers `<workspaceRoot>/.iknow` at parity
   *  with `<home>/.iknow`. Defaults to `sandboxRoot` (legacy shape) when
   *  absent — preserves existing registry callers that don't thread
   *  per-root state. */
  readonly workspaceRoot?: string;
  /** #406 T3:per-engine secret registry。透传给 bash 工具工厂——handler
   *  执行前把占位符还原为真值（见 bash.ts restore 段）。缺席时 bash 命令
   *  原样透传（行为 byte-identical，向后兼容）。 */
  readonly secretRegistry?: SecretRegistry;
  /** #468 deny-list：def-list 期宽容裁剪（buildWorkerToolSurface 语义）——
   *  缺席 / undefined / 空数组不裁剪，向后兼容。与既有条件化装配
   *  （memoryDir / skillCatalog / subagentManager）正交组合（Gate 3 镜像
   *  过滤保证 toolsetNames 与 factories 键集一致）。 */
  readonly disallowedTools?: ReadonlyArray<string>;
  /** #440 D2/D6:session 作用域 todos.md 目录。host 注入：build-engine
   *  从 session/conversationId 解析（每 conversationId 一份）。缺席时
   *  todo_write 不入注册表（与 memoryDir 同形态：worker 装配路径不注入
   *  todoDir 即把所有权边界隔在主 loop 内,跨 executor 竞态由装配期排除）。 */
  readonly todoDir?: string;
  /** #502 T3:background 任务管理器。在场时透传给 bash 工厂 —— `background: true`
   *  分支可用（handler 经 manager.spawn 立即返 task_id）。缺席时 bash 的
   *  background:true → ToolExecutionError（fail-fast）。与 subagentManager /
   *  skillCatalog 同形态：只透传不条件化装配名称 —— bash 是常驻工具，参数级
   *  能力由 handler 运行时决策。 */
  readonly backgroundManager?: BackgroundTaskManager;
  /** #562 T6:bash 模式由 worker.ts 显式透传 —— "readonly" 时 bash handler
   *  调 validateReadonlyCommand + fence 收 cwdReadonly:true (T4+T5 双闸)。
   * registry 这里只透传, 不读 catalog (catalog 路由归 spawn-subagent-tool
   * 工厂负责 — plan T3 决议)。缺省 → bash 字节与 V1 一致。 */
  readonly bashMode?: "any" | "readonly";
}

/**
 * 默认工具注册工厂 — SSOT（memoryDir 缺席 → 9 件:8 + tool_search;
 * memoryDir 存在 → 11 件:8 + memory_recall + memory_save + tool_search）。
 *
 * **装配期 fail-fast**:
 *   - proxyUrl 非法(非 http/https / 含凭据)→ `createWebFetchTool` /
 *     `createWebSearchTool` 工厂内 `createDefaultGuardDeps` 同步抛
 *     ToolExecutionError,与 build-engine.ts 既有行为一致
 *     (tests/build-engine.test.ts:94 已锁)。
 *   - **Gate 3（SSOT append-only 纪律）**:`ACI_TOOLSET_NAMES` 与下面
 *     `factories` 记录键不一致（长度/顺序/成员任何一处分歧）→ 同步抛
 *     `RegistryConstructionError`。derived-from-map 形态让闸门有真牙:
 *     将来加件只改 factories 忘 append names(或反之)装配期立刻失败,
 *     不给运行期留隐患（D4）。memory 条件化:memoryDir 缺席时 toolsetNames
 *     先剔除 memory_recall / memory_save 再做 Gate 3 对比,与 factories
 *     键集一致。
 *
 * **返回值**:`AciRegistry`(含 `inner` 协议层 + `catalog` 权限/延迟加载层),
 * 调用方可直接交给 `createExecutor` 与 `createAciExecutor`。
 *
 * **tool_search 自引用**:`tool_search` 需要的是"已装配完成的 registry",
 * 但 registry 自身包含 tool_search（直接持有即自引用循环）。故 deps 用
 * `getRegistry: () => AciRegistry` 惰性闭包,装配完成后由 `assembled.reg`
 * 解引用。装配未完成即被调用 → 抛 ToolExecutionError（fail-fast）。
 */
/**
 * 把 LSP 工具集展开成 factories 记录（10 件:lsp_definition / lsp_references
 * / lsp_hover / lsp_document_symbol / lsp_workspace_symbol /
 * lsp_go_to_implementation / lsp_prepare_call_hierarchy / lsp_incoming_calls
 * / lsp_outgoing_calls / lsp_diagnostics）。createLspToolSet(ctx) 返回冻结
 * AciToolDef 列表；每件按 ACI_TOOLSET_NAMES 中的 key 索引。
 */
function lspTools(directory: string): Record<string, () => AciToolDef> {
  const tools = createLspToolSet({ directory });
  const map: Record<string, () => AciToolDef> = {};
  for (const t of tools) {
    map[t.name] = () => t;
  }
  return map;
}

export function createDefaultAciRegistry(
  opts: CreateDefaultAciRegistryOptions
): AciRegistry {
  const { env, sandboxRoot } = opts;
  const onEdit = opts.onEdit;
  const proxyUrl = env.web.proxy;
  const searchUrl = env.web.searchUrl;
  const memoryDir = opts.memoryDir;
  const skillCatalog = opts.skillCatalog;
  const subagentManager = opts.subagentManager;
  const mcpManager = opts.mcpManager;
  const secretRegistry = opts.secretRegistry;
  const disallowedTools = opts.disallowedTools;
  const backgroundManager = opts.backgroundManager;
  // #562 T6: bashMode 显式透传到 createBashTool。registry 不读 catalog —
  // spawn-subagent-tool 工厂是 catalog 路由的真正 owner。
  const bashMode = opts.bashMode;
  // ADR-0019 (T4): per-root state anchor. Threaded to bash + read_file so
  // the fence protects `<workspaceRoot>/.iknow` the same way it does
  // `<home>/.iknow`. Falls back to sandboxRoot when absent (legacy shape)
  // so existing callers without per-root state stay byte-identical.
  const workspaceRoot = opts.workspaceRoot ?? sandboxRoot;
  // #440 T4 todo_write 条件化装配的开关。host 注入；build-engine 在
  // surface !== "ask" 解析 session 级目录并透传。worker 装配路径不传 →
  // todo_write 不入 worker 工具面（D6 所有权边界）；ask 不传 → tool 不
  // 入注册表（SC8 oneshot 剥离）。Gate 3 镜像过滤见下。
  const todoDir = opts.todoDir;

  // holder:tool_search 自引用的惰性解引用点(装配完成前闭包返回 undefined,
  // tool-search.ts:resolveRegistry 触发 ToolExecutionError 兜底)。
  const assembled: { reg?: AciRegistry } = {};

  // append-only:顺序与 build-engine.ts 既有策略(policy byName 键空间)一致。
  // memoryDir 缺席 → memory_recall / memory_save 从 factories 剔除
  // (memoryEnabled=false 的 ask 路径;见 build-engine.ts 条件构造)。
  // skillCatalog 缺席 → skill / skill_search 从 factories 剔除
  // (#337 T5 T8 装配时才真接;装配未启用 skill 源时与 memory 同形态)。
  // 键顺序必须与 ACI_TOOLSET_NAMES 逐项一致(Gate 3):memory_* 在
  // tool_search 之前,skill / skill_search 在末尾。
  const factories: Record<string, () => AciToolDef> = {
    bash: () =>
      createBashTool(sandboxRoot, {
        secretRegistry,
        workspaceRoot,
        ...(backgroundManager ? { backgroundManager } : {}),
        // #562 T6: bashMode 透传 — readonly 模式触发 validator + fence cwdReadonly。
        ...(bashMode !== undefined ? { bashMode } : {}),
      }),
    read_file: () => createReadFileTool(sandboxRoot, { workspaceRoot }),
    grep: () => createGrepTool(sandboxRoot),
    glob: () => createGlobTool(sandboxRoot),
    edit_file: () => createEditFileTool(sandboxRoot, { onEdit }),
    write_file: () => createWriteFileTool(sandboxRoot),
    web_fetch: () => createWebFetchTool({ proxyUrl }),
    web_search: () =>
      createWebSearchTool({ envSearchUrl: searchUrl, proxyUrl }),
    ...(memoryDir
      ? {
          memory_recall: () => createMemoryRecallTool({ memoryDir }),
          memory_save: () => createMemorySaveTool({ memoryDir }),
        }
      : {}),
    tool_search: () =>
      createToolSearchTool({
        getRegistry: () => {
          const r = assembled.reg;
          if (!r) {
            throw new ToolExecutionError("tool_search: registry not assembled");
          }
          return r;
        },
      }),
    // #251 LSP 工具集：NearestRoot 上界 stop=ctx.directory=sandboxRoot
    // （build-engine 传 process.cwd()，与 fs 工具软沙箱同根语义一致）。
    ...lspTools(sandboxRoot),
    // #337 T5 skill 工具集（条件化装配：skillCatalog 缺席时不入注册表）。
    ...(skillCatalog
      ? {
          skill: () => createSkillTool({ catalog: skillCatalog }),
          skill_search: () => createSkillSearchTool({ catalog: skillCatalog }),
        }
      : {}),
    // #356 T4 spawn_subagent 工具集（条件化装配：subagentManager 缺席时
    // 不入注册表——ask 入口零件；与 skillCatalog / memoryDir 同形态）。
    ...(subagentManager
      ? {
          spawn_subagent: () =>
            createSpawnSubAgentTool({ manager: subagentManager }),
        }
      : {}),
    // #356 T5 subagent_result 工具集（条件化装配：subagentManager 缺席时
    // 不入注册表，与 spawn_subagent 同形态；Gate 3 镜像过滤，见下）。
    ...(subagentManager
      ? {
          subagent_result: () =>
            createSubAgentResultTool({ manager: subagentManager }),
        }
      : {}),
    // #440 T4 todo_write 工具集（条件化装配：todoDir 缺席时不入注册表 —
    // worker 装配路径不传 todoDir（D6 所有权边界）；ask 表面 build-engine
    // 也不传 todoDir（SC8 oneshot 剥离）；Gate 3 镜像过滤，见下）。
    ...(todoDir
      ? {
          todo_write: () => createTodoWriteTool({ todoDir }),
        }
      : {}),
    // #440 T11 MCP resources 工具集（条件化装配：mcpManager 缺席时
    // 不入注册表——ask 入口零件 + 任务型 worker；与 subagentManager /
    // skillCatalog / memoryDir 同形态；Gate 3 镜像过滤，见下）。
    // list / read 都通过 getManager 惰性闭包解引用 manager；装配期
    // mcpManager 缺席则工具不入注册表（handler 永不被路由）。
    ...(mcpManager
      ? {
          list_mcp_resources: () =>
            createListMcpResourcesTool({
              getManager: () => mcpManager,
            }),
          read_mcp_resource: () =>
            createReadMcpResourceTool({
              getManager: () => mcpManager,
            }),
        }
      : {}),
    // #502 T4 bash_output / bash_stop 工具集（条件化装配：backgroundManager
    // 缺席时不入注册表——ask 入口零件；bash 常驻工具不在此列，T3 参数级
    // 能力由 handler 运行时决策。Gate 3 镜像过滤，见下）。
    ...(backgroundManager
      ? {
          bash_output: () => createBashOutputTool({ backgroundManager }),
          bash_stop: () => createBashStopTool({ backgroundManager }),
        }
      : {}),
  };

  // Gate 3 校验:factories 键与 ACI_TOOLSET_NAMES 严格一致(长度+顺序+成员)。
  // memoryDir 缺席时 memory_recall/memory_save 不装配,skillCatalog 缺席时
  // skill/skill_search 不装配,故对照名单需先剔除这两个条件键。任何不一致
  // 均装配期失败,不留到运行期。
  // #468 deny-list：deny 名并入 excluded（toolsetNames 端剔除），factories 键
  // 端同源过滤 → Gate 3 双侧镜像一致（与 memoryDir 条件化同款机制）。
  const denySet = new Set(disallowedTools ?? []);
  const factoryNames = Object.keys(factories).filter((n) => !denySet.has(n));
  const excluded: ReadonlyArray<string> = [
    ...(memoryDir ? [] : ["memory_recall", "memory_save"]),
    ...(skillCatalog ? [] : ["skill", "skill_search"]),
    ...(subagentManager ? [] : ["spawn_subagent", "subagent_result"]),
    ...(todoDir ? [] : ["todo_write"]),
    ...(mcpManager ? [] : ["list_mcp_resources", "read_mcp_resource"]),
    ...(backgroundManager ? [] : ["bash_output", "bash_stop"]),
    ...(disallowedTools ?? []),
  ];
  const toolsetNames = (ACI_TOOLSET_NAMES as ReadonlyArray<string>).filter(
    (n) => !excluded.includes(n)
  );
  if (
    factoryNames.length !== toolsetNames.length ||
    factoryNames.some((n, i) => n !== toolsetNames[i])
  ) {
    throw new RegistryConstructionError(
      `ACI_TOOLSET_NAMES / factories diverge: have=[${factoryNames.join(",")}] want=[${toolsetNames.join(",")}]`
    );
  }

  const tools = toolsetNames.map((n) => factories[n]!());
  // #468 def-list 期裁剪（构造期保证 inner/visibleSchemas 双面只剩保留项）。
  // buildWorkerToolSurface 宽容模式合并默认 deny [spawn_subagent] + 用户 deny；
  // 默认 deny 在 worker 装配路径上属合法冗余（subagentManager 缺席 →
  // spawn_subagent 不在 tools）。仅当 disallowedTools 非空才调用 —
  // build-engine.ts:294 既有调用（subagentManager 在场、未传
  // disallowedTools）若无条件调用 buildWorkerToolSurface，宽容模式默认
  // deny 会误剥离 spawn_subagent，破坏向后兼容。Gate 3 excluded 已先把
  // deny 名从 toolsetNames 剔除，此处 buildWorkerToolSurface 是双机制的
  // 幂等兜底（actual surface 二次断言）。
  const finalTools =
    disallowedTools !== undefined && disallowedTools.length > 0
      ? buildWorkerToolSurface(tools, disallowedTools)
      : tools;
  const reg = createAciRegistry(finalTools);
  assembled.reg = reg;
  return reg;
}
