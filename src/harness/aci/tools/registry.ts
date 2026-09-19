/**
 * ACI 工具集注册层 — 11 件 SSOT（8 基线 + memory_recall/memory_save + tool_search）。
 *
 * **目的**:让所有 harness 入口(CLI `ask` / `chat` / `serve`、TUI `iknow tui`)
 * 共享同一份"工具有哪些 + 怎么注入 env"的装配函数,避免工具集分裂
 * (历史教训:`src/tui/deps.ts` 手写 6 个文件工具漏注册 web_fetch/web_search)。
 *
 * 本模块仅做"哪些工具 + env 透传",
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
import { createReadImageTool } from "./read-image.js";
import { createGrepTool } from "./grep.js";
import { createGlobTool } from "./glob.js";
import { createEditFileTool } from "./edit-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createWebFetchTool } from "./web-fetch.js";
import { createWebSearchTool } from "./web-search.js";
import { createMemoryRecallTool } from "../../memory/tools/recall.js";
import { createMemorySaveTool } from "../../memory/tools/save.js";
import { createToolSearchTool } from "./tool-search.js";
import { createSymbolQueryToolSet } from "./symbol.js";
import { createSymbolMutateToolSet } from "./symbol-mutate.js";
import type { LspCtx } from "../../lsp/types.js";
import type { FsModeContext } from "../../sandbox/fs-mode.js";
import { createSkillTool } from "./skill.js";
import { createSpawnSubAgentTool } from "../../subagent/spawn-subagent-tool.js";
import { createSubAgentResultTool } from "../../subagent/subagent-result-tool.js";
import { createSubAgentStopTool } from "../../subagent/subagent-stop-tool.js";
import { createSubAgentContinueTool } from "../../subagent/subagent-continue-tool.js";
import { createRunGraphTool } from "../../graph/run-graph-tool.js";
import type { LiveGraphLedgerHost } from "../../graph/ledger.js";
import {
  createLastReadLedgerHost,
  type LastReadLedgerHost,
} from "../last-read-ledger.js";
import type { SubAgentManager } from "../../subagent/manager.js";
import type { SubagentCapacityHolder } from "../../subagent/manager.js";
import type { WorktreeGateReader } from "../../isolation/worktree-gate.js";
import type { BackgroundTaskManager } from "../../background/manager.js";
import type { McpManager } from "../../mcp/manager.js";
import type { AgentCatalogResolver } from "../../subagent/catalog.js";
import { createListMcpResourcesTool } from "./list-mcp-resources.js";
import { createReadMcpResourceTool } from "./read-mcp-resource.js";
import { createBashOutputTool } from "./bash-output.js";
import { createBashStopTool } from "./bash-stop.js";
import { buildWorkerToolSurface } from "../../subagent/role.js";
import { RegistryConstructionError, ToolExecutionError } from "../../errors.js";
import type { SkillCatalog } from "../../skill/catalog.js";
import { createTodoWriteTool, type TodoWriteActor } from "./todo-write.js";
import { createQueryTraceTool } from "./query-trace.js";
import { createListSessionsTool } from "./list-sessions.js";
import { createGetRecordTool } from "./get-record.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import {
  createCreateWorktreeTool,
  type CreateWorktreeProvisionFn,
} from "./create-worktree.js";
import {
  createEnterWorktreeTool,
  type WorktreeEnterToolDeps,
} from "./enter-worktree.js";
import {
  createExitWorktreeTool,
  type WorktreeExitToolDeps,
} from "./exit-worktree.js";
import {
  createListWorktreesTool,
  type ListWorktreesToolDeps,
} from "./list-worktrees.js";
import {
  createRemoveWorktreeTool,
  type RemoveWorktreeToolDeps,
} from "./remove-worktree.js";
import { join } from "node:path";

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
  // #337 T5 skill 工具集 append-only：21→22。
  // 一件工具,条件化装配（skillCatalog 缺席时不入注册表,与 memoryDir
  // 同形态：Gate 3 在 toolsetNames 端镜像过滤,见工厂尾部注释）。
  // disclosure-index-align T2:#337 T5 的 `skill_search` 已删（spec ADR-0046
  // / SC5：未描述的 skill 靠 `skill({name})` 带回正文,索引文件
  // `<available_skills>` 已给名+描述,直呼路径不依赖二次检索）。
  "skill", // #337 T5 直呼取 skill 正文
  // #356 T4 spawn_subagent append-only：22→23。条件化装配（subagentManager
  // 缺席时不入注册表，与 skillCatalog / memoryDir 同形态：Gate 3 在
  // toolsetNames 端镜像过滤，见工厂尾部注释）。
  "spawn_subagent", // #356 T4 主代理派发子代理（异步返 task_id）
  // #356 T5 subagent_result append-only：23→24。条件化装配（subagentManager
  // 缺席时不入注册表，与 spawn_subagent / skillCatalog / memoryDir 同形态：
  // Gate 3 在 toolsetNames 端镜像过滤，见工厂尾部注释）。
  "subagent_result", // #356 T5 主代理轮询子代理四态（not_found/running/completed/failed）
  // #440 双 Stream 工具集 append-only：24→27（并集，#480 Stream B 先合 +
  // #481 Stream A 后合）。三件都条件化装配（Gate 3 在 toolsetNames 端
  // 镜像过滤，见工厂尾部注释）：
  //   - todo_write: todoDir 缺席时不入注册表 — ask 表面不传（SC8 oneshot
  //     剥离）；worker 装配路径在父会话经 envelope 透传 `todoLedger` 时
  //     传入 todoDir + todoActor{canAdd:false}（ADR-0085 / SC9：与父共用
  //     同一本账，可读可更；`add` 拒绝在工具 handler 内，不是「工具不在场」）
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
  // #502 T4 bash_output / bash_stop append-only：27→29（Track A 模型操作面，
  // 与 T3 bash background:true 成对）。两件都条件化装配（backgroundManager
  // 缺席时不入注册表——ask 入口零件；bash 常驻不在此列，参数级能力由 handler
  // 运行时决策——Gate 3 在 toolsetNames 端镜像过滤，见工厂尾部注释）。
  "bash_output", // #502 T4 读后台任务日志尾部 + 状态/exit_code（read-only 默认 allow）
  "bash_stop", // #502 T4 终止后台任务进程组（SIGTERM→2s→SIGKILL；write 默认 ask）
  // D-α T3 run_graph append-only：29→30。条件化装配（graphAssembly +
  // subagentManager 同时在场才入注册表——ask / worker / 未接 overlay 的入口
  // 三者皆缺席；Gate 3 在 toolsetNames 端镜像过滤，见工厂尾部注释）。
  // 注册 ≠ 可见：本 round 的 graph 快照关着时装配层把它滤出 promptTools,
  // handler 亦二次 EXIT（ADR-0030 —— overlay 是运行期可翻的,registry 是
  // 构造期冻结的,两者只能这样对齐）。
  "run_graph", // D-α T3 父代理声明 DAG，host 走 waves + 前景 spawn 编排
  "query_trace", // trace read-side projection and record drill-down
  // T4 (plans/worktree-isolation-model-provision.md) 创建工作树 ACI 工具
  // append-only：30→31。条件化装配（worktreeProvision host 缝缺席时不入
  // 注册表 —— 无 hub 的入口 / worker 装配路径；ADR-0037 Amendment 2026-09-11
  // 已撤销「工具在场 ⇔ 开关 ON」，开关 OFF 不再卸掉工具。Gate 3 在
  // toolsetNames 端镜像过滤，见工厂尾部注释）。名字与 T3 门禁 hint 常量
  // `CREATE_WORKTREE_TOOL_HINT`（"create-worktree ACI tool"）
  // 逐字对齐 —— 被拦 mutate 的 block 文案指向的工具名必须真实存在。
  // ADR-0082 改名：注册名去掉 `-task`（位置不动，仍 append-only）。
  "create-worktree",
  // T7 (plans/worktree-isolation-model-provision.md) enter-worktree
  // append-only：32→33。条件化装配（worktreeEnter host 缝缺席时不入注册表
  // —— TUI 只接 provision / worker 装配路径 / 无 hub 的入口；Gate 3 在
  // toolsetNames 端镜像过滤，见工厂尾部注释）。工具只收 owner conversationId，
  // 目标路径由 SSOT `taskWorktreePath` 派生，不收自由路径。
  "enter-worktree",
  // T8 (plans/worktree-isolation-model-provision.md) exit-worktree
  // append-only：33→34。条件化装配（worktreeExit host 缝缺席时不入注册表
  // —— TUI 只接 provision / worker 装配路径 / 无 hub 的入口；Gate 3 在
  // toolsetNames 端镜像过滤，见工厂尾部注释）。工具无参数；主仓根由 host
  // 从树本身派生（git common dir），树保留不删。
  "exit-worktree",
  // symbol-primary-aci T2 符号查询工具集 append-only：34→44。
  // 与 #251 的 10 件 `lsp_*` **并存**（T5 才把坐标面从模型面移除）：本批以
  // 符号身份（`{ file, symbol_path }`）提问，行列译码封在 symbol-resolver.ts。
  // append 在末尾而非插在 lsp_* 之后 —— 本文件的 append-only 纪律（policy
  // byName 键空间与 ADR-0006 稳定）要求不重排既有 34 件。
  "find_symbol", // 工作区按名字/模式找符号（空 query 由 schema 拒绝）
  "find_declaration", // 声明/定义
  "find_referencing_symbols", // 引用（含声明）
  "find_implementations", // 接口/抽象成员 → 具体实现
  "get_symbols_overview", // 单文件大纲（拿 symbol_path 的入口）
  "get_hover", // 类型/签名/文档
  "get_diagnostics_for_file", // 文件诊断（file 与 files 互斥）
  "prepare_call_hierarchy", // 调用图 item
  "list_incoming_calls", // 调用者
  "list_outgoing_calls", // 被调用者
  // symbol-primary-aci T4 符号改工具集 append-only:32→36（去掉旧 lsp_* 后
  // 的末位 5 件,常驻,category=write）。以符号身份（`{ file, symbol_path }`）
  // 改代码，行列译码封在 symbol-resolver.ts。category="write"，写盘后经
  // onEdit → lspNotifier 触发 textDocument/didChange 与 edit_file 同链路。
  // edit_file 仍在 —— 留给不是单一符号的文本补丁（spec §使用规则段）。
  // spec symbol-primary-aci.md T5 + ADR-0037 + #803 T9 的 tool surface 加法：
  // 8 基线 + memory_* (2 件) + tool_search + skill 1（disclosure-index-align
  // T2 删 skill_search，#337 原 2 件 → 1 件）+ subagent 2 + todo + mcp 2 +
  // bg 2 + run_graph + query_trace + 10 符号查询 + 5 符号改 + worktree 3 =
  // 39 件名，T5b 目录轴再 append 1 件 = 40 件名，T6 内容轴再 append 1 件
  // = 41 件名，task-worktree-lifecycle 再 append list/remove = 43 件名。本表
  // 长度以数组为 source of truth。
  "rename_symbol", // 全项目按符号改名（textDocument/rename + applyEdit）
  "replace_symbol_body", // 替换定义体（range = node.range，签名 + body）
  "insert_before_symbol", // 在符号定义前插入（range.start 位置）
  "insert_after_symbol", // 在符号定义后插入（range.end 位置）
  "safe_delete_symbol", // 无引用才删；仍有引用返 typed 失败 + 引用列表
  // plan `trace-mcp-read-side-split` T5b append-only：39→40。trace 读侧的**目录轴**
  // （有哪些会话），与 query_trace 的行轴正交；常驻装配（与 query_trace 同门，
  // 无 host 缝可条件化）。
  //
  // 位置是契约不是风格：Gate 3 按「长度 + 顺序 + 成员」比对 factories 键与本名单，
  // 所以对应工厂必须是 `factories` 字面量的**最后一个键**（在 symbolMutateTools
  // 展开之后）。另有一批下游测按下标锁中段（run-graph-assembly.test.ts 的
  // idx 19-22），插在它们之前即红 —— 尾部追加才是安全改法。
  "list_sessions",
  // plan `trace-mcp-read-side-split` T6 append-only：40→41。trace 读侧的**内容轴**
  // （一条记录里的一段字符窗），与目录轴、行轴正交；常驻装配（与 query_trace /
  // list_sessions 同门，无 host 缝可条件化）。
  //
  // 仍然只能追加在尾部：中段插入会撞上下游按下标锁定的断言（
  // run-graph-assembly.test.ts 的 idx 19-22 等），尾部才是 append-only 契约。
  "get_record",
  // task-worktree-lifecycle: discovery and explicit cleanup are appended after
  // the existing ACI surface. Both host seams are independently conditional.
  "list-worktrees",
  "remove-worktree",
  // plan subagent-stop-and-continue T2 (ADR-0101) subagent_stop append-only:
  // 43→44。条件化装配（subagentManager 缺席时不入注册表 —— 与
  // spawn_subagent / subagent_result 同门条件；Gate 3 在 toolsetNames 端
  // 镜像过滤）。父模型停工人 = 操作员 Ctrl+X 的模型面对称臂。
  "subagent_stop",
  // plan subagent-stop-and-continue T4 (ADR-0102) subagent_continue append-only:
  // 44→45。同门条件（subagentManager）；死工人 + 有账才再拉起，闸在
  // manager.resumeTask，等待契约与 spawn 相同。
  "subagent_continue",
  // read-image-vision T2 (spec SC6) read_image append-only:45→46。常驻装配
  // （无 host 缝可条件化，与 read_file / grep / glob 同门）；围栏内图片按
  // 魔数读为 SDK image block，不入 last-read ledger（ADR-0084 入账面不变）。
  "read_image",
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
  /** #337 T5 skill 索引层(catalog)。缺席时 skill 不入注册表
   *  （disclosure-index-align T2 删 skill_search 后只剩 skill 一件）。 */
  readonly skillCatalog?: SkillCatalog;
  /** #356 T4 主代理本地子代理生命周期管理器。缺席时 spawn_subagent 不入注册表
   * （ask 入口零件场景；chat/tui/serve 由 build-engine 按 surface 条件构造传入）。 */
  readonly subagentManager?: SubAgentManager;
  /** ADR-0096 T2：闸值 holder —— 与 subagentManager 配对传入工具工厂，
   * description getter 现读 holder；缺席时退化到 manager.getCapacity()。 */
  readonly subagentCapacityHolder?: SubagentCapacityHolder;
  /**
   * #global-plugins T1（review C1 装配接线）：spawn_subagent 工具
   * 默认走 `createMergedCatalogResolver()`（与 capability 解析面同源），
   * 该默认路径 ledger-aware —— 读本机 `<home>/.iknow/plugins` ledger
   * 加载插件 agent。测试 / hub-less 入口若想与本机已装插件解耦，注
   * 入显式 resolver（d9 描述守卫、ask 装配路径等都是该 seam 的消费
   * 面）。生产 build-engine 路径**不**注入，走默认与 capability 同
   * 源 resolver（ACR #5）。
   */
  readonly agentCatalog?: AgentCatalogResolver;
  /** #440 T11 MCP 资源通道管理器。缺席时 list_mcp_resources / read_mcp_resource
   *  不入注册表（ask 入口零件场景 + 任务型 worker；chat/tui/serve 由 build-engine
   *  按 surface 条件构造传入）。与 subagentManager / skillCatalog / memoryDir
   *  同形态：Gate 3 在 toolsetNames 端镜像过滤，见工厂尾部注释。 */
  readonly mcpManager?: McpManager;
  /** #251 onEdit 接缝:edit_file 写盘成功后回调(装配层接 LSP notifier)。 */
  readonly onEdit?: (file: string) => void;
  /**
   * lsp-optimization 二期 B7 closeout：完整 LspCtx 透传给符号工具集
   * （symbol.ts / symbol-resolver.ts / symbol-mutate.ts 内部消费 lsp.ts
   * SSOT 时取用本 ctx —— T5 起旧的 10 件 `lsp_*` 已从模型面退役，本字段
   * 仅服务符号工具）。缺席时回落 `{ directory: sandboxRoot }`（与一轮
   * 行为一致）。build-engine / worker 必须传入与 notifier/warmup 同一份
   * 对象，否则 settings.lsp（timeout / wait / idle / disabledServers）
   * 对符号工具路径不生效。
   */
  readonly lspCtx?: LspCtx;
  /** ADR-0019 (T4): per-root state anchor. Threaded into read_file so its
   *  `extraReadRoots` admit `<workspaceRoot>/.iknow` at parity with the home
   *  profile (the agent's per-root persona state). ADR-0092 global mode: not a
   *  bind root; bash no longer threads it (no predicate, no per-root mount).
   *  Defaults to `sandboxRoot` (legacy shape) when absent. */
  readonly workspaceRoot?: string;
  /** T3 (plans/worktree-session-roots.md / ADR-0037 §4): 项目身份根 —— 会话
   *  隔离开关 ON 时交给 `read_file` / `grep` / `glob` 的稳定只读根。工具在
   *  handler 调用时再要求 live `taskRoot` 是 task worktree，因此同一 run 的
   *  rebind 可生效而 OFF 档仍不获得额外读根。**不**透给 bash / write / edit
   *  —— 写不得出沙箱。缺席 / 等于 sandboxRoot → 无额外读根。 */
  readonly projectIdentityRoot?: string;
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
   *  todo_write 不入注册表（与 memoryDir 同形态：ask 入口零件场景）。
   *
   *  ADR-0085 / SC9:worker 装配路径也注入本项 —— worker 与父会话共用同一
   *  本账（读 / 更新），与 `todoActor` 配对表达「添加仅父会话」。 */
  readonly todoDir?: string;
  /** ADR-0085 / SC9:todo_write 调用方能力（actor）。conversationId 是
   *  `ctx.conversationId` 的回退源（worker 进程的 executor 不合成该 ctx
   *  字段）；`canAdd:false` 时工具的 `add` 在 handler 内 typed 拒绝。
   *  缺席 → 旧行为逐字节不变（canAdd 视为 true、只看 ctx.conversationId）。 */
  readonly todoActor?: TodoWriteActor;
  /**
   * T3: current-identity fence `/tmp` pad. Worker assembly points this at
   * `subagents/<taskId>/fence-tmp`. Absent → bash/write keep the existing
   * session/fallback resolve.
   */
  readonly tmpDir?: string;
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
  /** D-α T3 / ADR-0030:本 round 的 graph 装配快照（`GraphAssembly` 的读侧）。
   *  与 `subagentManager` 同时在场时 `run_graph` 入注册表；缺席时不装
   *  （ask / worker / 未接 overlay 的入口）。工具**可见性**由快照决定,
   *  装配层据此过滤 promptTools —— 见 build-engine。 */
  readonly graphAssembly?: { readonly enabled: () => boolean };
  /**
   * live-graph-phase1 T1:活图账本 host（ADR-0047 / ADR-0051）。与会话
   * runtime 同寿 —— host 持有 / 销毁，账本权威在 harness/graph。缺席时
   * `run_graph` handler 不建账（V1 零行为变化）。
   */
  readonly liveGraphLedger?: LiveGraphLedgerHost;
  /**
   * ADR-0084 / D1: last-read 账本 host（`conversationId → 规范 path 集合`）的
   * 可选缝。不传则 registry 自建一份（默认接线，写闸即生效）；注入同一实例
   * 可让跨 registry（rebind 重建 / hub cachedDeps 复用）延续旧读 —— 但当前
   * 生产装配不注入，per-root 重建的 registry 从空表开始（spec D1 的 lifetime
   * 规则）。账本只影响「非空 write_file 是否需要先读」这一个闸，缺席时行为
   * 与 ADR-0084 之前一致（不拒），故不作为 Gate 3 的条件化装配开关。
   */
  readonly lastReadLedger?: LastReadLedgerHost;
  /** Trace directory for the read-only query_trace tool. */
  readonly traceDir?: string;
  /**
   * T4 / ADR-0037 (amended 2026-08-30): worktree isolation host provision
   * seam (session-api hub, threaded by build-engine). Present → the
   * `create-worktree` ACI tool enters the registry; absent (switch
   * OFF, worker assembly, hub-less inlets) → excluded via the Gate 3 mirror
   * filter, keeping OFF byte-identical to today's tool surface.
   */
  readonly worktreeProvision?: CreateWorktreeProvisionFn;
  /**
   * T7 / ADR-0037 (amended 2026-08-30): explicit-enter host seam. Present →
   * the `enter-worktree` ACI tool enters the registry; absent (TUI
   * provision-only wiring, worker assembly, hub-less inlets) → excluded via
   * the Gate 3 mirror filter.
   */
  readonly worktreeEnter?: WorktreeEnterToolDeps["worktreeEnter"];
  /**
   * T8 / ADR-0037 (amended 2026-08-30): symmetric-exit host seam. Present →
   * the `exit-worktree` ACI tool enters the registry; absent (TUI
   * provision-only wiring, worker assembly, hub-less inlets) → excluded via
   * the Gate 3 mirror filter.
   */
  readonly worktreeExit?: WorktreeExitToolDeps["worktreeExit"];
  /**
   * Task-worktree discovery seam. Present → list-worktrees enters the
   * registry; absent → the worker / OFF / hub-less surfaces omit it.
   */
  readonly worktreeList?: ListWorktreesToolDeps["worktreeList"];
  /**
   * Explicit task-worktree removal seam. Present → remove-worktree enters
   * the registry; absent → the tool is excluded by the Gate 3 mirror.
   */
  readonly worktreeRemove?: RemoveWorktreeToolDeps["worktreeRemove"];
  /**
   * T5 (plans/worktree-live-task-root.md §6): live `taskRoot` cell. When
   * provided, `write_file` / `edit_file` factories receive the cell and the
   * handler reads the snapshot at call time — `worktree rebind` in the same
   * run reaches them. When absent (legacy / one-shot callers), factories
   * receive `sandboxRoot` as a string — existing tests and behavior stay
   * byte-identical. The cell only carries the live `taskRoot` (D3: stable
   * roots stay frozen), so this field is intentionally narrow.
   */
  readonly liveTaskRoot?: LiveTaskRoot;
  /**
   * T4 (plans/write-situation-disclosure.md): worktree isolation 档判定
   *（`buildHarnessEngine` 启动加载点一次性读取，与门禁武装同源）。ADR-0079
   * 后 `skill()` 正文装配不再消费此档（skill 正文不再挂写根 trailer，
   * createSkillTool 只吃 catalog）；字段保留给未来可能的隔离档消费面。
   * 缺席 → 无消费面受影响。
   */
  readonly isolationOn?: boolean;
  /**
   * ADR-0092 Amendment 2026-09-13 / SC11/SC12:fs 隔离档 holder —— bash
   * 工厂透传,handler per-call `get()` 读取(同 `liveTaskRoot` D2 batch
   * snapshot 纪律)。holder 在场 → bash fence 据此叠 `--ro-bind <home>` 等
   * 三层；缺席 → 全局档(V1 baseline)。T8 在 build-engine 装配处把
   * `resolveFsIsolationMode(settings)` 一次解析,装入 holder 透传。
   */
  readonly fsMode?: FsModeContext;
  /**
   * ADR-0092 Round 2 / SC11:工作区档 home ro-bind 源端宿主绝对路径。
   * 缺省 → build-engine 装配层从 `userHome` 派生(测试可注入)。
   */
  readonly homeRoot?: string;
  /**
   * issue 1059:worktree-on-mutate 活开关 holder(只读视图)—— bash 工厂
   * 透传,handler 入口与 waveRoot 同 vintage 读一次。gate ON ∧ waveRoot 是
   * 主 checkout → 前台 / 后台 fence 叠 UNBOUND_FENCE 物理 ro-bind 段;
   * 缺席 → 永不发段(V1 baseline 逐字节不变)。
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
  /**
   * ADR-0097 / T7:egress 允许集策略工厂 —— 透传给 bash 工厂
   * (`createBashTool({ egressPolicyFactory })`)。生产由 build-engine 经
   * `createEgressPolicyFactory({ settings })` 构造;缺席 = 本次装配无
   * egress 数据面 → bash handler 内 `policyInput === undefined` → 不起
   * session,fence 走纯断网(`--unshare-net` 恒在,fail-closed 合法态)。
   * worker / hub-less 入口不传,与「非交互入口只能走预置配置」语义一致。
   */
  readonly egressPolicyFactory?: () =>
    import("../../sandbox/egress/session.js").EgressPolicyInput | undefined;
  /**
   * ADR-0097 / T6:首次域名批准 ask inlet —— 透传给 bash 工厂,由工厂闭包
   * 期包成 `EgressApprovalGate`(allowed/denied 会话级集 + in-flight 合并)。
   * 缺省(无交互入口)→ gate 内部 fail-closed:首见新域名直接记
   * `no-approval-inlet` 违例。生产由 build-engine 把既有 `AskUser` 转写
   * 为 `(host) => Promise<boolean>`(见 bash.ts askApproval 装配纪律注释)。
   */
  readonly askApproval?: import("../../sandbox/egress/approval.js").AskApproval;
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
 * `lsp.ts` 的 10 件坐标 `lsp_*` AciToolDef（`createLspToolSet`）已从模型面
 * 退役（spec symbol-primary-aci.md §37-53 + SC2 + SC7）—— `lsp.ts` 仍作
 * 内部 SSOT：`LSP_ACI_META` / `renderNoServer` / `extractCallHierarchyItems` /
 * `getClientForWorkspaceDetailed` / `compileValidator` / `stringifyResult` /
 * `createRequestCancellation` / `timeoutError` / `isLspFailureSentinel` /
 * `makeOperationTool` / `makeDiagnosticsTool` / `makeCallHierarchyCallTool`
 * 诸导出由 symbol-resolver / symbol-mutate 直接 import 复用，
 * 不再走 factories map 的 `...lspTools(lspCtx)` 展开路径。
 *
 * 内部 SSOT 覆盖测试（`tests/harness/aci/lsp.test.ts` 等）仍按 AciToolDef
 * 形态直接调 `createLspToolSet` —— 见 lsp.ts 顶部 SSOT 注释。T5 后本
 * `createDefaultAciRegistry` 不再 export 任何把 lsp_* 拉入模型面的接口。
 */

/**
 * 把符号查询工具集展开成 factories 记录（symbol-primary-aci T2，10 件：
 * find_symbol / find_declaration / find_referencing_symbols /
 * find_implementations / get_symbols_overview / get_hover /
 * get_diagnostics_for_file / prepare_call_hierarchy / list_incoming_calls /
 * list_outgoing_calls）。共享同一份 lspCtx（B7 语义）：旧 10 件 `lsp_*` 与
 * 本批共同消费 `lsp.ts` 内部 SSOT，模型面仅符号工具可见（spec §37-53 + SC2 + SC7）。
 */
function symbolQueryTools(ctx: LspCtx): Record<string, () => AciToolDef> {
  const tools = createSymbolQueryToolSet(ctx);
  const map: Record<string, () => AciToolDef> = {};
  for (const t of tools) {
    map[t.name] = () => t;
  }
  return map;
}

/**
 * 把符号改工具集展开成 factories 记录（symbol-primary-aci T4，5 件：
 * rename_symbol / replace_symbol_body / insert_before_symbol /
 * insert_after_symbol / safe_delete_symbol）。与 symbolQueryTools
 * 同形态：工厂返回冻结 AciToolDef 列表，按 ACI_TOOLSET_NAMES 中的 key 索引；
 * 共享同一份 lspCtx（B7 语义）。`onEdit` 透传自 registry 的 opts，写盘后
 * 触发 lspNotifier.invalidate(file) 与 edit_file 同一接缝（plan T1）。
 */
function symbolMutateTools(
  ctx: LspCtx,
  onEdit: ((file: string) => void) | undefined
): Record<string, () => AciToolDef> {
  const tools = createSymbolMutateToolSet({ ctx, onEdit });
  const map: Record<string, () => AciToolDef> = {};
  for (const t of tools) {
    map[t.name] = () => t;
  }
  return map;
}

/**
 * ADR-0084 / D1:last-read 账本 host 的解析口。注入者优先（跨 registry 共享
 * 的宿主缝），缺席则 registry 自建一份 —— 闸的默认接线在 registry 这一层，
 * 装配层不必知道它存在（也就没有第四个「必须记得传」的入口）。生产当前走
 * 自建臂：per-root 重建的 registry 各自从空表开始。
 */
function resolveLastReadLedger(
  opts: CreateDefaultAciRegistryOptions
): LastReadLedgerHost {
  return opts.lastReadLedger ?? createLastReadLedgerHost();
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
  const graphAssembly = opts.graphAssembly;
  const liveGraphLedger = opts.liveGraphLedger;
  // ADR-0084 / D1: last-read 账本。注入缺席 → registry 自建一份（默认接线:
  // write_file 的闸自本切片起对每个 registry 装配入口生效）；跨 registry
  // 延续旧读（rebind 重建 / hub cachedDeps 复用）需装配层注入同一实例，
  // 当前生产不注入。
  const lastReadLedger = resolveLastReadLedger(opts);
  // #562 T6: bashMode 显式透传到 createBashTool。registry 不读 catalog —
  // spawn-subagent-tool 工厂是 catalog 路由的真正 owner。
  const bashMode = opts.bashMode;
  // ADR-0019 (T4): per-root state anchor. Threaded to read_file so its
  // `extraReadRoots` admit `<workspaceRoot>/.iknow` at parity with the home
  // profile. ADR-0092 global mode: bash no longer reads it. Falls back to
  // sandboxRoot when absent (legacy shape) so existing callers without
  // per-root state stay byte-identical.
  const workspaceRoot = opts.workspaceRoot ?? sandboxRoot;
  // #440 T4 todo_write 条件化装配的开关。host 注入；build-engine 在
  // surface !== "ask" 解析 session 级目录并透传；ask 不传 → tool 不入
  // 注册表（SC8 oneshot 剥离）。worker 装配路径经 `todoLedger` 透传同一
  // 父会话根（ADR-0085 / SC9：共享账本，`add` 由工具 handler typed 拒绝，
  // 工具本身仍在 worker 面上）。Gate 3 镜像过滤见下。
  const todoDir = opts.todoDir;
  // ADR-0085 / SC9:todo_write 的 actor 能力位(父 vs worker)——只透传,
  // Gate 3 开关仍以 todoDir 单键为准(工具名/件数不因 actor 漂移)。
  const todoActor = opts.todoActor;
  // T4:创建工作树 ACI 工具的条件化装配开关（host provision 缝）。build-engine
  // 在 hub 注入 host 缝时透传，与 isolationEnabled 解耦（ADR-0037
  // Amendment 2026-09-11 / SC1：开关 OFF 也注册）；worker / ask / hub-less
  // 入口不传 → create-worktree 不入注册表。Gate 3 镜像过滤见下。
  const worktreeProvision = opts.worktreeProvision;
  // T7:enter-worktree 的条件化装配开关（host enter 缝）。build-engine
  // 在 host 注入 enter 缝时透传；TUI（只接 provision）/ worker / hub-less
  // 入口不传 → 工具不入注册表。Gate 3 镜像过滤见下。
  const worktreeEnter = opts.worktreeEnter;
  // T8:exit-worktree 的条件化装配开关（host exit 缝）。同 worktreeEnter
  // 形态：TUI（只接 provision）/ worker / hub-less 入口不传 → 不入注册表。
  const worktreeExit = opts.worktreeExit;
  const worktreeList = opts.worktreeList;
  const worktreeRemove = opts.worktreeRemove;

  // holder:tool_search 自引用的惰性解引用点(装配完成前闭包返回 undefined,
  // tool-search.ts:resolveRegistry 触发 ToolExecutionError 兜底)。
  const assembled: { reg?: AciRegistry } = {};

  // #251 / symbol-primary-aci T2:坐标面与符号面共享同一份 LspCtx —— 两套
  // 工具走同一条客户端/取消/超时链路,ctx 分叉即 settings.lsp 半生效。
  // B7 closeout:优先用装配层同一份 lspCtx,缺席回落 sandboxRoot-only。
  const lspCtx: LspCtx = opts.lspCtx ?? { directory: sandboxRoot };

  // 读侧工具（query_trace / list_sessions，T6 再加 get_record）必须解析到同一个
  // 目录，否则列出来的会话查不到；三态回落因此只在这里出现一次。写成闭包是为了
  // 不把它提前到模块加载期 —— 读取时机与合并前逐字一致（都在这两个 factory 各自
  // 被调用的那一刻，也就是 registry 构造期）。
  const traceReadDir = () =>
    opts.traceDir ??
    process.env.IKNOW_TRACE_OUT ??
    join(workspaceRoot, "trace");

  // append-only:顺序与 build-engine.ts 既有策略(policy byName 键空间)一致。
  // memoryDir 缺席 → memory_recall / memory_save 从 factories 剔除
  // (memoryEnabled=false 的 ask 路径;见 build-engine.ts 条件构造)。
  // skillCatalog 缺席 → skill 从 factories 剔除（disclosure-index-align T2
  // 删 skill_search 后只剩一件;见 spec ADR-0046 / SC5）。
  // 键顺序必须与 ACI_TOOLSET_NAMES 逐项一致(Gate 3):memory_* 在
  // tool_search 之前,skill 在末尾。
  const factories: Record<string, () => AciToolDef> = {
    bash: () =>
      createBashTool(sandboxRoot, {
        secretRegistry,
        ...(backgroundManager ? { backgroundManager } : {}),
        // #562 T6: bashMode 透传 — readonly 模式触发 validator + fence cwdReadonly。
        ...(bashMode !== undefined ? { bashMode } : {}),
        // T7: 透传 live taskRoot cell。门禁未翻 ⇒ cell 初值 = sandboxRoot,
        // handler 内 cell.read() 一次取得 waveRoot,前台 fence + background
        // spawn 共用该值（D2）。liveTaskRoot 缺席 → 退回 sandboxRoot
        // （legacy parity,与 V1 字节一致）。
        ...(opts.liveTaskRoot !== undefined
          ? { liveTaskRoot: opts.liveTaskRoot }
          : {}),
        // T1: todoDir is the session project dir; bash resolves
        // `<sessionFolder>/fence-tmp` per conversationId (ADR-0074).
        ...(opts.todoDir !== undefined ? { projectDir: opts.todoDir } : {}),
        // T3: worker identity pad (nested under subagents/<taskId>/).
        ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
        // ADR-0084 / D1: 成功白名单单文件读入账（bash 是入账两条源之一）。
        lastReadLedger,
        // ADR-0092 Round 2 / SC11/SC12:fs 隔离档 holder + homeRoot 透传。
        // holder 在场 → bash handler per-call `get()` 读一次;缺席 → 全局档
        // (V1 baseline)。homeRoot 装配层从 userHome 派生。
        ...(opts.fsMode !== undefined ? { fsMode: opts.fsMode } : {}),
        ...(opts.homeRoot !== undefined ? { homeRoot: opts.homeRoot } : {}),
        // issue 1059:UNBOUND_FENCE holder 透传(缺席 = 不发段)。
        ...(opts.worktreeOnMutate !== undefined
          ? { worktreeOnMutate: opts.worktreeOnMutate }
          : {}),
        // ADR-0097 / T7:egress 数据面 + 批准 ask 面。二者都由装配层
        // (build-engine)注入;缺席 = 无缝断网 / 无 ask 面 fail-closed,
        // 与 worker / hub-less 入口的「非交互 = 拒绝」语义一致。
        ...(opts.egressPolicyFactory !== undefined
          ? { egressPolicyFactory: opts.egressPolicyFactory }
          : {}),
        ...(opts.askApproval !== undefined
          ? { askApproval: opts.askApproval }
          : {}),
      }),
    // T6 (plans/worktree-live-task-root.md §6 T6): read 路径工具工厂参数
    // 从冻结 sandboxRoot 扩为 `liveTaskRoot ?? sandboxRoot` (cell 缺席 / 未
    // rebind → 退回 sandboxRoot,byte-identical 于 T5 之前的形态)。factory
    // handler 内 cell.read() 取一次 snapshot,与 read_file 的 extraReadRoots
    // 同 vintage(D9)。glob / grep 同样的 per-call 读取。
    //
    // D10 处置：**接通** registry.ts:471-473 死缝 → read-file.ts 现在真实
    // 消费 `projectIdentityRoot`(ADR-0037 §1 身份根只读直通)。registry 这层
    // 仍以 spread guard 透传,但 read-file.ts 把它纳入 extraReadRoots(D9
    // 同 vintage,rebind 后身份根文件仍可达)。
    read_file: () =>
      createReadFileTool(opts.liveTaskRoot ?? sandboxRoot, {
        workspaceRoot,
        ...(opts.projectIdentityRoot !== undefined
          ? { projectIdentityRoot: opts.projectIdentityRoot }
          : {}),
        ...(opts.projectIdentityRoot !== undefined
          ? { allowProjectIdentityRoot: true }
          : {}),
        // ADR-0092: read 面与 write/edit 共用同一会话 tmp 身份（透传形态
        // 与下方 write_file / edit_file 逐项一致）。
        ...(opts.todoDir !== undefined ? { projectDir: opts.todoDir } : {}),
        ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
        // ADR-0084 / D1: 成功读（含空文件与截断页）入账 —— 写闸的入账源。
        lastReadLedger,
      }),
    grep: () =>
      createGrepTool(opts.liveTaskRoot ?? sandboxRoot, {
        ...(opts.projectIdentityRoot !== undefined
          ? { projectIdentityRoot: opts.projectIdentityRoot }
          : {}),
        allowProjectIdentityRoot: opts.projectIdentityRoot !== undefined,
      }),
    glob: () =>
      createGlobTool(opts.liveTaskRoot ?? sandboxRoot, {
        ...(opts.projectIdentityRoot !== undefined
          ? { projectIdentityRoot: opts.projectIdentityRoot }
          : {}),
        allowProjectIdentityRoot: opts.projectIdentityRoot !== undefined,
      }),
    // T5:write_file / edit_file 读活 taskRoot。门禁未翻 ⇒ cell 初值 =
    // sandboxRoot，逐字节同今日；handler 内 cell.read() 一次取得 snapshot，
    // 同 handler 内 resolve 与写入共用该值（D2）。
    edit_file: () =>
      createEditFileTool(opts.liveTaskRoot ?? sandboxRoot, {
        onEdit,
        ...(opts.todoDir !== undefined ? { projectDir: opts.todoDir } : {}),
        ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
      }),
    write_file: () =>
      createWriteFileTool(opts.liveTaskRoot ?? sandboxRoot, {
        ...(opts.todoDir !== undefined ? { projectDir: opts.todoDir } : {}),
        ...(opts.tmpDir !== undefined ? { tmpDir: opts.tmpDir } : {}),
        // ADR-0084 / D1: 非空覆写查 last-read 表（本切片新增的写闸）。
        lastReadLedger,
      }),
    web_fetch: () =>
      createWebFetchTool({
        proxyUrl,
        backend: env.web.searchBackend,
        exaApiKey: env.web.exaApiKey,
        tavilyApiKey: env.web.tavilyApiKey,
        braveApiKey: env.web.braveApiKey,
      }),
    // #826 T4: 把 searchBackend + 三个 vendor key 透传给 web_search。
    // env loader 已把 EXA_API_KEY / TAVILY_API_KEY / BRAVE_API_KEY 经
    // expandPlaceholders 解析（空 / "yes" / 占位符解析失败 → undefined）；
    // T3 handler 的 assertBackendConfig 据此三态 fail-closed（missing_key /
    // backend_unset_with_key / 默认 bing）—— 本层只透传，不二次校验。
    // searchBackend 在 schema reject 非法值后落到闭集（loader 抛 typed error
    // 时 buildHarnessEngine 装配即失败，不会到这里），故透传即可。
    web_search: () =>
      createWebSearchTool({
        envSearchUrl: searchUrl,
        proxyUrl,
        backend: env.web.searchBackend,
        exaApiKey: env.web.exaApiKey,
        tavilyApiKey: env.web.tavilyApiKey,
        braveApiKey: env.web.braveApiKey,
      }),
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
    // #251 / symbol-primary-aci T5：坐标面 lsp_* 已从模型面移除（spec
    // symbol-primary-aci.md §37-53 + SC2 / SC7 / ACR complexity-anti-drift）；
    // lsp.ts 实现的 client / cancel / timeout / sentinel / diagnostics / call
    // hierarchy 等 SSOT 复用层由 symbol.ts / symbol-resolver.ts / symbol-mutate.ts
    // 消费，model surface 由符号工具（find_* / get_* / *_calls + 5 件改工具）
    // 接班。nearestRoot 边界、settings.lsp / idle / disabledServers 等 B7 语义
    // 落 lspCtx 一份 → 符号工具共享。
    // #337 T5 skill 工具（条件化装配：skillCatalog 缺席时不入注册表）。
    // disclosure-index-align T2:skill_search 已删（spec ADR-0046 / SC5：索引
    // 段 `<available_skills>` 已给名+描述,直呼 `skill({name})` 不依赖二次
    // 检索）。
    ...(skillCatalog
      ? {
          // ADR-0079 — skill 正文不再挂写根 trailer：createSkillTool 不再
          // 消费 liveTaskRoot / isolationOn；写处境披露的权威路径迁到
          // worker prior（subagent/worker.ts）与 chat-session rebind 通知
          // （chat-session.ts），共用同一 helper writeRootSegment。
          skill: () => createSkillTool({ catalog: skillCatalog }),
        }
      : {}),
    // #356 T4 spawn_subagent 工具集（条件化装配：subagentManager 缺席时
    // 不入注册表——ask 入口零件；与 skillCatalog / memoryDir 同形态）。
    // review C1：opts.agentCatalog 透传给 spawn 工厂（缺省走
    // createMergedCatalogResolver() 默认路径，与 capability 解析面同
    // 源，ACR #5）。
    // ADR-0096 T2：opts.subagentCapacityHolder 同步透传（最小注入 —
    // 不参与 Gate 3 镜像过滤，与 subagentManager 同门条件）。缺席时的
    // 语义：spawn 工厂内部退化到 `manager.getCapacity()`（manager 自己
    // 持有同一闸值，spawn-subagent-tool.ts readCapacity）—— 闸值真相
    // 单一在 manager/holder 链上，此处条件透传只是「有 holder 就优先
    // 用 holder 现读」的运行期选择，两条路径产出等价 description N。
    ...(subagentManager
      ? {
          spawn_subagent: () =>
            createSpawnSubAgentTool({
              manager: subagentManager,
              ...(opts.agentCatalog !== undefined
                ? { catalog: opts.agentCatalog }
                : {}),
              ...(opts.subagentCapacityHolder !== undefined
                ? { capacityHolder: opts.subagentCapacityHolder }
                : {}),
            }),
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
    // ask 表面 build-engine 不传 todoDir（SC8 oneshot 剥离）；Gate 3 镜像
    // 过滤，见下）。
    // ADR-0085 / SC9:worker 装配路径也传 todoDir + todoActor{canAdd:false}
    // —— 工具在场（模型能读到 `add` 的 typed 拒绝原因），actor 缝承载父会话
    // id 与能力位。
    ...(todoDir
      ? {
          todo_write: () =>
            createTodoWriteTool({
              todoDir,
              ...(todoActor !== undefined ? { actor: todoActor } : {}),
            }),
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
    // ADR-0041 / plans/model-prefix-layering.md B3:`run_graph` 常驻注册
    // —— graph 模式开/关只由 handler 层 isEnabled gate 决定（拒绝时
    // ToolExecutionError,SC5 实测）。`subagentManager` 缺席时同条件
    // 化装配跳过（编排底座缺一不可,与 spawn_subagent 同形态）。
    //
    // live-graph-phase1 T1:活图账本（ADR-0047 / ADR-0051）随 host 缝透传;
    // 缺席 → 工具 handler 不建账（V1 零行为变化）。
    ...(subagentManager
      ? {
          run_graph: () =>
            createRunGraphTool({
              manager: subagentManager,
              isEnabled: graphAssembly
                ? () => graphAssembly.enabled()
                : undefined,
              ...(liveGraphLedger ? { ledger: liveGraphLedger } : {}),
            }),
        }
      : {}),
    query_trace: () => createQueryTraceTool(traceReadDir()),
    // T4 创建工作树 ACI 工具（条件化装配：worktreeProvision host 缝缺席时
    // 不入注册表）。handler 闭包绑定本引擎的 sandboxRoot = 会话当前根；
    // 建树 + 改绑副作用全部委托 host provision 缝（session-api hub）。
    ...(worktreeProvision
      ? {
          "create-worktree": () =>
            createCreateWorktreeTool({
              provision: worktreeProvision,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    // T7 enter-worktree（条件化装配：worktreeEnter host 缝缺席时不入
    // 注册表）。handler 闭包绑定本引擎的 sandboxRoot = 会话当前根（主仓）；
    // 树校验 + 改绑副作用全部委托 host enter 缝。
    ...(worktreeEnter
      ? {
          "enter-worktree": () =>
            createEnterWorktreeTool({
              worktreeEnter,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    // T8 exit-worktree（条件化装配：worktreeExit host 缝缺席时不入
    // 注册表）。handler 闭包绑定本引擎的 sandboxRoot = 会话当前 task 树；
    // 回绑主仓根 + 树保留的副作用全部委托 host exit 缝。
    ...(worktreeExit
      ? {
          "exit-worktree": () =>
            createExitWorktreeTool({
              worktreeExit,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    // symbol-primary-aci T2 符号查询工具集（常驻，符号主路径是默认）。
    // 与符号改工具共享同一份 lspCtx；键顺序必须与 ACI_TOOLSET_NAMES 末尾
    // 10 项逐项一致（Gate 3）。
    ...symbolQueryTools(lspCtx),
    // symbol-primary-aci T4 符号改工具集（常驻，category=write）。
    // 与符号查询共享同一份 lspCtx；onEdit 来自 registry 的 opts.onEdit
    // （build-engine 装配时注入 lspNotifier.invalidate）—— 写盘后触发
    // textDocument/didChange 与 edit_file 同链路。键顺序必须与
    // ACI_TOOLSET_NAMES 末尾 5 项逐项一致（Gate 3）。
    ...symbolMutateTools(lspCtx, onEdit),
    // plan T5b：本键曾是字面量最后一个键 —— Gate 3 比对 factories 键顺序与
    // ACI_TOOLSET_NAMES 顺序（名单尾部同项）。目录经 traceReadDir() 与
    // query_trace 同源，列出来的会话才查得到。
    list_sessions: () => createListSessionsTool(traceReadDir()),
    // plan T6：现在本键是字面量最后一个键（同上 Gate 3）。三轴共用 traceReadDir()
    // 解析出的目录，get_record 点名的 conversation_id 才是 list_sessions 给过的那个。
    get_record: () => createGetRecordTool(traceReadDir()),
    // task-worktree-lifecycle: host-only discovery/cleanup tools remain at the
    // append-only tail so existing tool positions stay stable.
    ...(worktreeList
      ? {
          "list-worktrees": () =>
            createListWorktreesTool({
              worktreeList,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    ...(worktreeRemove
      ? {
          "remove-worktree": () =>
            createRemoveWorktreeTool({
              worktreeRemove,
              root: opts.liveTaskRoot ?? sandboxRoot,
            }),
        }
      : {}),
    // plan subagent-stop-and-continue T2 (ADR-0101)：本键曾是 factories 字面量
    // 的最后一个键（Gate 3 顺序契约，见 ACI_TOOLSET_NAMES 尾部注释）。
    // 条件化装配与 spawn_subagent / subagent_result 同门（subagentManager
    // 缺席 → 工具不入注册表）。
    ...(subagentManager
      ? {
          subagent_stop: () =>
            createSubAgentStopTool({ manager: subagentManager }),
          // plan subagent-stop-and-continue T4 (ADR-0102)：本键曾是字面量
          // 最后一个键。同门条件、尾部追加。
          subagent_continue: () =>
            createSubAgentContinueTool({ manager: subagentManager }),
        }
      : {}),
    // read-image-vision T2 (spec SC6)：现在是字面量最后一个键（Gate 3 顺序
    // 契约，见 ACI_TOOLSET_NAMES 尾部注释）。常驻、无缺席条件；root 与
    // read_file 同一挂法 —— `liveTaskRoot ?? sandboxRoot`，handler 内
    // cell.read() 取一次 snapshot（D2/D9 同 vintage）。不接 lastReadLedger
    // （spec 假设 10：读图不入账）。
    read_image: () => createReadImageTool(opts.liveTaskRoot ?? sandboxRoot),
  };

  // Gate 3 校验:factories 键与 ACI_TOOLSET_NAMES 严格一致(长度+顺序+成员)。
  // memoryDir 缺席时 memory_recall/memory_save 不装配,skillCatalog 缺席时
  // skill 不装配,故对照名单需先剔除这些条件键。任何不一致
  // 均装配期失败,不留到运行期。
  // #468 deny-list：deny 名并入 excluded（toolsetNames 端剔除），factories 键
  // 端同源过滤 → Gate 3 双侧镜像一致（与 memoryDir 条件化同款机制）。
  const denySet = new Set(disallowedTools ?? []);
  const factoryNames = Object.keys(factories).filter((n) => !denySet.has(n));
  const excluded: ReadonlyArray<string> = [
    ...(memoryDir ? [] : ["memory_recall", "memory_save"]),
    ...(skillCatalog ? [] : ["skill"]),
    ...(subagentManager ? [] : ["spawn_subagent", "subagent_result"]),
    // plan subagent-stop-and-continue T2/T4：subagent_stop / subagent_continue
    // 与 spawn / result 同门条件（尾部追加名单顺序 = ACI_TOOLSET_NAMES 末位）。
    ...(subagentManager ? [] : ["subagent_stop", "subagent_continue"]),
    ...(todoDir ? [] : ["todo_write"]),
    ...(mcpManager ? [] : ["list_mcp_resources", "read_mcp_resource"]),
    ...(backgroundManager ? [] : ["bash_output", "bash_stop"]),
    // ADR-0041:run_graph 常驻后只剩 subagentManager 同门条件(graphAssembly
    // 缺席不再触发缺席 —— handler isEnabled 缺省恒关,run_graph 仍在注册表)。
    ...(subagentManager ? [] : ["run_graph"]),
    // T4：host 缝缺席（worker / hub-less 入口）→ 建树工具不入注册表。开关
    // OFF 不在此列（ADR-0037 Amendment 2026-09-11：工具面常在，只有门禁跟开关）。
    // T7：enter 缝缺席（TUI provision-only / worker / hub-less 入口）→
    // enter 工具不入注册表。
    ...(worktreeProvision ? [] : ["create-worktree"]),
    ...(worktreeEnter ? [] : ["enter-worktree"]),
    ...(worktreeExit ? [] : ["exit-worktree"]),
    ...(worktreeList ? [] : ["list-worktrees"]),
    ...(worktreeRemove ? [] : ["remove-worktree"]),
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
