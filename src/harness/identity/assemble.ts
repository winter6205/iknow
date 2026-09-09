/**
 * IKNOW-196 装配流水线 (spec `specs/196-identity-assembly.md`
 * spec.md:122-132 装配顺序约束 + spec.md:246-256 注入缝 + spec.md:260-266
 * 入口覆盖矩阵)。
 *
 * 模块责任:在每次 model turn 把 identity 装配成 system 文本块;
 * build-engine 在 deps.system 注册此函数 (T4) 每 turn 调一次。
 * 顺序 LOCKED —— Spec 锁死,不得重排。
 *
 * 6 段顺序:identity / soul / usage / user_profile / bootstrap / memory_layer。
 *  `usage` 是 IKNOW-symbol-primary T1 (spec `specs/symbol-primary-aci.md`)
 *  新增的恒在段(soul 之后、user_profile 之前),chat / tui / serve / ask 全部
 *  注入(SC1),声明"代码主路径走符号工具、grep 三类回退、edit_file 让位"等
 *  优先级要点。`memory_layer` 由 build-engine 注入 `memoryResolver` 装配,
 *  降级契约:resolver 抛错 → warn + undefined(沿用 #194 T6 落地后的合并形态)。
 *  #194 T6 落地前为 user_agents / priority_dec / project_agents /
 *  existence_pointer / promote 五段合并后的单 slot。
 *
 * 锁定约束:
 * - 字段缺席 → 返回 undefined (不写空 system,KV 缓存字节级稳定,T1 决策)
 * - user.md 不存在 / 空 → 跳过 (不报错)
 * - state.json 缺失 / 损坏 → bootstrap_seeded 默认 false → 注入 BOOTSTRAP
 * - state.json.bootstrap_seeded=true → 跳过 BOOTSTRAP (T5 入口由显式
 *   writeIknowState({ bootstrap_seeded: true }) 关闭)
 * - memory_layer: ctx.memoryEnabled=false → 跳过;ctx.memoryResolver
 *   抛错 → console.warn + 跳过(降级契约对齐 readUserProfile)。
 */

import path from "node:path";
import { promises as fs } from "node:fs";

import { IKNOW_IDENTITY_DEFAULT } from "./identity.js";
import { IKNOW_SOUL_DEFAULT } from "./soul.js";
import { IKNOW_USAGE_DEFAULT } from "./usage.js";
import { bootstrapFilePath } from "./workspace.js";
import { assembleStaticSystemPrompt } from "../memory/assembly.js";
import { gitSnapshotSegment, type GitSnapshot } from "./git-snapshot.js";
import { IKNOW_GIT_WORK_TEXT, gitWorkSegment } from "./git-work.js";

export { IKNOW_GIT_WORK_TEXT, gitWorkSegment } from "./git-work.js";

/** IKNOW-196 + #194 T6 + IKNOW-symbol-primary T1 装配顺序 (6 段 LOCKED)。 */
export const IKNOW_ASSEMBLY_ORDER = [
  "identity", // 1. 认知层 (代码 LOCKED):Name/Kind/Signature
  "soul", // 2. 人格层 (代码 LOCKED):core truths/boundaries/vibe/continuity
  "usage", // 3. 使用规则 (代码 LOCKED, IKNOW-symbol-primary T1):
  //          代码主路径走符号工具 + grep 三类回退 + edit_file 让位
  "user_profile", // 4. 用户画像 (~/.iknow/user.md) — 用户可改
  "bootstrap", // 5. 首启引导 (rev 2026-08-11:文件驱动 — BOOTSTRAP.md 存在即注入)
  "memory_layer", // 6. 记忆层 (#194 / #121:AGENTS.md / rules / memory promote)
] as const;

/** 装配顺序常量数组的元素类型。 */
export type IdentitySegmentKind = (typeof IKNOW_ASSEMBLY_ORDER)[number];

/** IKNOW-196 装配上下文 (build-engine 每 turn 注入)。
 *  #194 T6:新增 `memoryEnabled` 与 `memoryResolver` 字段,memory_layer 段据
 *  此开关降级:enabled=false → 跳过;resolver 抛错 → warn + 跳过。
 *  #224 工具名录段注入缝(本期空壳):提供时且返回非空名录才追加一个
 *  "Available tools:" 名录段;缺席或返回 undefined/空数组 → 跳过,
 *  输出与无此缝完全一致 (KV 缓存字节级稳定契约,字段缺席 → 不写空 system)。 */
export interface AssemblyContext {
  /**
   * 历史兼容字段:T9 起 "Project path" 段刻意不再读取此值(改由稳定
   * projectIdentityRoot 渲染)。装配层仅在 `projectIdentityRoot` 缺席/空
   * 时作兜底参考(直接 `assembleIdentityContext` 调用方路径),生产装配
   * (build-engine) 不再注入。误把活 taskRoot 投到此字段会触发 T9 违规
   * (KV 缓存抖动)—— 仅填稳定的 projectIdentityRoot。
   */
  readonly cwd?: string;
  /**
   * T3 (plans/worktree-session-roots.md / ADR-0037 §4)：项目身份根 —— 宿主
   * 启动时钉一次的「用户此刻在做的项目」。项目 `AGENTS.md` / `.iknow/rules`
   * 的唯一发现根，跨 rebind 不变。
   */
  readonly projectIdentityRoot: string;
  readonly userHome: string;
  /**
   * Per-root state for memory/sessions/settings. Persona files
   * (user.md / BOOTSTRAP.md) are **not** read from here — issue #584:
   * identity seed + assemble always use `userHome/.iknow`.
   * Kept optional so callers may still thread the resolved workspace root
   * without affecting persona segments.
   */
  readonly workspaceRoot?: string;
  readonly bootstrapActive: boolean;
  readonly memoryEnabled: boolean;
  /** Inject AGENTS.md/rules without enabling memory-library behavior. */
  readonly staticInstructions?: boolean;
  readonly memoryResolver?: () => Promise<string | undefined>;
  readonly toolList?: () => ReadonlyArray<string> | undefined;
  readonly skills?: () => ReadonlyArray<SkillSummary> | undefined;
  /** #631 T2 → B4 (ADR-0043 §3) MCP 名字目录段注入缝 (可选,渐进式披露
   *  "索引常驻档"):每 turn 装配期现读快照 —— 异步连接的服务连上后下一装配
   *  周期自然出现,不阻塞不空等。缺席 / 返回空 / 过滤后无 connected 服务 →
   *  段缺席 (KV 缓存字节级稳定);调用抛错 → console.warn + 跳过 (降级契约
   *  对齐 memory_layer)。schema 不进本段(名字目录只承载服务名 + 工具名)。 */
  readonly mcp?: () => ReadonlyArray<McpServiceSummary> | undefined;
  /** B6 / ADR-0043 §3 + T4:溢出治理退场内建件索引段(可选,渐进式披露第二档)。
   *  返回**会话级冻结**的退场件投影(闭包在 build-engine 装配期首轮判定一次
   *  后冻结,会话内恒定)。缺席 / 空数组 → 段缺席(字节级零变化)。
   *  T4 / spec ASSUMPTIONS #5:元素是 **名 + 描述**,模型直呼该件即 hydrate
   *  (permission-executor gateOne 对 `aci.lazy && !isDiscovered` 走
   *  `discover()`,schema 从下一轮 visibleSchemas 尾部回来),不必先
   *  `tool_search`。核心件永不在此名单(tool-overflow.ts CORE_TOOL_NAMES 守门)。 */
  readonly deferredInternalTools?: () =>
    ReadonlyArray<DeferredInternalToolSummary> | undefined;
  /** #558 T2 coordinator 段注入缝 (可选):默认路径(build-engine 在
   *  chat/tui/serve 自建 manager)不再注入 —— 引导落点已迁到 spawn_subagent
   *  工具 description (#557 T1 SSOT)。调用方显式传入非空字符串仍渲染
   *  "## Sub-agent coordination" 段;缺席/undefined/空串 → 段缺席 (KV 缓存
   *  稳定契约)。 */
  readonly coordinatorText?: string;
  /** #646 T2 agent-status 读规则段注入缝 (可选,布尔 gate;命名指读规则而非
   *  栏本身 —— 栏永不进 deps.system,ADR-0028):true → 装配一句静态读规则
   *  (IKNOW_AGENT_STATUS_READ_RULE);缺席/false → 段缺席 (字节级零变化,
   *  守 KV 缓存稳定契约)。build-engine 从驱动 deps.agentStatus (T1 注入缝)
   *  的同一 gate 派生 —— 栏会注入的表面才有读规则;ask / worker 永不注入。 */
  readonly agentStatusReadRule?: boolean;
  /** plans/model-prefix-layering.md B5 / spec §9:git 块注入缝 (可选)。
   *  返回一个**会话级冻结**的快照(闭包取一次,build-engine / worker 装配
   *  期同步取一次)。装配层每 turn 调同一闭包 → 相邻两轮 byte-identical
   *  (D9 / KV 缓存契约)。缺席 / 返回 undefined → 段缺席(字节级零变化);
   *  退化态(cwd_unavailable / not_a_git_repo / git_unavailable)→ 段缺席
   *  不报错(spec §9:「接受缺席即字节变化」)。 */
  readonly git?: () => GitSnapshot | undefined;
  /** git 作业纪律段注入缝 (可选,布尔 gate):true → 装配 "## Git work" 段;
   *  缺席 / false → 段缺席 (不写空串,不补教程,KV 缓存字节级稳定)。
   *  生产路径仅 isolation ON 的 chat/tui/serve 传入;ask / worker 不传。
   *  与 `## Git` 快照段正交,不替换、不改名。 */
  readonly gitWorkDiscipline?: boolean;
}

/** #337 T6 `<available_skills>` 段元素形态(最小投影:name + description + disabled)。
 *  disabled=true → 装配层跳过(SC3),与 catalog.available() 语义一致。
 *
 *  T5 / ADR-0046 Decision 2:`description` 转为可选 —— 索引降档把超阈条目剥成
 *  **仅名字**(名字永不删)。缺席/空/纯空白 → 渲染裸名行,与 `McpToolSummary`
 *  同规则(降档只改喂进来的数据,渲染层不做第二套判定)。 */
export interface SkillSummary {
  readonly name: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

/** disclosure-index-align T1 / ADR-0043 §3 — MCP 名字目录段工具元素形态(最小投影)。
 *  description 缺席/空 → 只渲染工具名。 */
export interface McpToolSummary {
  readonly name: string;
  readonly description?: string;
}

/** disclosure-index-align T4 / spec ASSUMPTIONS #5 — schema 退场内建件的索引
 *  元素形态(最小投影:名 + 描述)。描述来自该工具 `ToolDef.description`
 *  (build-engine 装配期从 registry 现取);缺席/空 → 只渲染工具名(与
 *  `McpToolSummary` 同规则)。**同形不同名**:MCP 条目在索引降档时会被剥成
 *  仅名字,退场内建件不参与该降档 —— 两个数据源的降档纪律不同,故不共用
 *  一个类型名以免读者误以为同一治理面。 */
export interface DeferredInternalToolSummary {
  readonly name: string;
  readonly description?: string;
}

/** disclosure-index-align T1 / #631 T2 / B4 (ADR-0043 §3) MCP 名字目录段
 *  服务元素形态(最小投影):name + 可选服务描述 + 工具集(每工具 = 名 + 可选
 *  描述);schema 与长 description 一律不进 system。`state` 词汇表与
 *  mcp/manager McpServerState 同形但不跨模块导入;仅 "connected" 服务入段:
 *  pending(还在连) / failed / disabled 不渲染。服务描述缺席是契约允许态
 *  —— mcp 只读元数据面当前无服务级描述来源,暂不为此新开数据管道(Keep It
 *  Simple),装配层渲染时降级为裸名行。 */
export interface McpServiceSummary {
  readonly name: string;
  readonly state: "pending" | "connected" | "failed" | "disabled";
  readonly description?: string;
  readonly tools: ReadonlyArray<McpToolSummary>;
}

/** disclosure-index-align T1 / #631 T2 工具短描述限值:取 description 首行,
 *  超过此长度截断 + 省略号。120 字与 #631 T2 原始契约一致(KV cache 中
 *  "索引常驻档"需要一行可读)。 */
export const MCP_TOOL_SHORT_DESCRIPTION_MAX = 120;

/** disclosure-index-align T1 / T4 索引段末行引导(SSOT):有描述 = 知道工具
 *  干什么 = 直接调用即可。ADR-0046 修订 ADR-0043「必经 tool_search」——
 *  MCP 目录与退场内建段共用同一句,两段不各写一份文案。 */
export const DIRECT_CALL_GUIDANCE =
  "Call a listed tool directly to load its schema and use it.";

/**
 * disclosure-index-align T1 / B4 / ADR-0043 §3 `<mcp_name_directory>` 段
 * 渲染(对应旧 #631 T2 形态 + B4 名字目录落地):
 *   - 每 connected 服务一行(名字,描述在场时 ": <short desc>")；
 *   - 其下每工具一行(" - <tool>" / " - <tool>: <short desc>");
 *   - 描述取首行 + 限 120 字 + 超出加省略号;
 *   - 描述缺席 → 只渲染名字（契约允许态）。
 *
 * 加性段,不触碰 IKNOW_ASSEMBLY_ORDER;仅渲染 state === "connected" 的
 * 服务;过滤后为空 → 返回 undefined(装配层不追加,绝不写空串)。
 * 字节稳定契约:connected 服务集 + 工具名 + 描述快照会话内恒定 → 相邻轮
 * deep-equal;装配期现读快照,不阻塞不空等,迟到 server 不渗回目录。
 *
 * 末行引导(spec disclosure-index-align Does #1):有描述时直呼工具即可,
 * 不再强制 "call tool_search first";旧 B4 末行的 "Use tool_search ..." 句
 * 移除(spec 决策:有描述 = 知道工具干什么 = 直接调用即可)。
 */
export function mcpNameDirectorySegment(
  services: ReadonlyArray<McpServiceSummary>
): string | undefined {
  const connected = services
    .filter((s) => s.state === "connected")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (connected.length === 0) return undefined;
  const lines: string[] = [];
  for (const service of connected) {
    // 服务描述(可选):mcp 只读元数据面暂无服务级描述来源,缺席 → 裸名行
    // (契约允许态,不改数据管道)。
    lines.push(
      service.description && service.description.trim().length > 0
        ? `${service.name}: ${service.description}`
        : service.name
    );
    const tools = [...service.tools].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const t of tools) {
      const short = shortToolDescription(t.description);
      lines.push(short === undefined ? `- ${t.name}` : `- ${t.name}: ${short}`);
    }
  }
  lines.push(DIRECT_CALL_GUIDANCE);
  return `<mcp_name_directory>\n${lines.join("\n")}\n</mcp_name_directory>`;
}

/**
 * disclosure-index-align T1 / #631 T2 工具短描述:取首行 + 限值截断
 * (~120 字符);缺席/空/首行为空 → undefined(调用方只渲染工具名)。
 *
 * SSOT:截断位置 = 字符串按字符切片 + 单字符省略号（中文/emoji 多字节
 * 切分按 JavaScript 字符串码点;test suite 内的 150-字符 ASCII 用例已
 * 验证截断点 + 省略号字节级对齐)。
 */
export function shortToolDescription(
  description: string | undefined
): string | undefined {
  if (description === undefined || description.length === 0) return undefined;
  const firstLine = description.split("\n", 1)[0].trim();
  if (firstLine.length === 0) return undefined;
  if (firstLine.length <= MCP_TOOL_SHORT_DESCRIPTION_MAX) return firstLine;
  return `${firstLine.slice(0, MCP_TOOL_SHORT_DESCRIPTION_MAX)}…`;
}

/**
 * B6 / ADR-0043 §3 `<deferred_internal_tools>` 段渲染 —— 溢出治理退场
 * 的内建件索引。退场件 = 标 `aci.deferrable: true` 的内建件中,首轮
 * `countTokens` 实测超出 context window 10% 阈值后被 stamp `aci.lazy: true`
 * 的部分(schema 从 promptTools 抽出)。
 *
 * disclosure-index-align T4 / spec ASSUMPTIONS #5:本段渲染 **名 + 描述**
 * —— 退场只降一档「schema → 名+描述」,不再降到裸名、不参与索引降档剥描述
 * (那一档只作用于 MCP / skill 条目)。有描述 = 模型知道工具干什么 = 直呼
 * 即可(`DIRECT_CALL_GUIDANCE`),不必先 `tool_search`。
 *
 * 与 mcp 名字目录同形态(`- <name>: <short desc>`,复用
 * `shortToolDescription` 的首行 + 120 字截断 SSOT),但不分组(内建件无
 * server 维度),按字母序输出以保证字节稳定。描述缺席/空/纯空白 → 裸名行
 * (契约允许态,与 MCP 目录同规则)。空数组 → 返回 undefined(段缺席,
 * 字节级零变化)。
 */
export function deferredInternalToolsSegment(
  tools: ReadonlyArray<DeferredInternalToolSummary>
): string | undefined {
  if (tools.length === 0) return undefined;
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const lines = sorted.map((t) => {
    const short = shortToolDescription(t.description);
    return short === undefined ? `- ${t.name}` : `- ${t.name}: ${short}`;
  });
  lines.push(DIRECT_CALL_GUIDANCE);
  return (
    `<deferred_internal_tools>\n${lines.join("\n")}\n` +
    `</deferred_internal_tools>`
  );
}

/** IKNOW-196 入口范围判定。对话型入口(chat / tui / serve)激活 BOOTSTRAP;
 *  仅脚本型(ask)跳过。serve 是同一主体的浏览器交互面(iknow serve + SPA),
 *  与 chat/tui 共享同一 identity 状态机,不再单独降级(用户 2026-08-08 裁定)。 */
export function shouldIncludeBootstrap(
  surface: "chat" | "tui" | "ask" | "serve"
): boolean {
  return surface !== "ask";
}

/** IKNOW-196 deps.system 工厂。build-engine / tui-deps 两处装配层用同一
 *  工厂消除字面级复制(spec A12 矩阵:bootstrapActive 由 surface 决定)。
 *  每 turn 解析一次(用户改 user.md turn 级生效,spec 不做 TTL 缓存)。
 *  #194 T6:增 `memoryEnabled` + `memoryResolver` 透传到 ctx,驱动 memory_layer
 *  段降级装配(ask surface 默认 memoryEnabled=false)。 */
export function createIknowSystemResolver(opts: {
  /** 兼容输入:历史上的"展示用工作目录"。T9 起 "Project path" 段刻意不再
   *  读取此字段(改由稳定 projectIdentityRoot 渲染),装配层**不**消费它。
   *  该缝保留仅为外部调用方(直接 new resolver 跳过 build-engine)的兼容
   *  过渡 —— 但 build-engine 与所有生产入口不再注入。 */
  readonly cwd?: string;
  /** T3 / ADR-0037 §4 + T9:项目身份发现根 = 宿主启动时钉下的稳定根。
   *  必填 —— "Project path" 段的唯一权威数据源(rebind 不抖动该段)。
   *  build-engine 等所有真实调用方都已显式传入,绝不依赖 cwd 兜底。
   *  警告:若仅传 cwd 不传 projectIdentityRoot,会回退到 cwd,等价于把活
   *  taskRoot 投到 system,违反 T9 / KV 缓存字节稳定契约 —— 请显式传稳定根。 */
  readonly projectIdentityRoot: string;
  readonly userHome: string;
  readonly surface: "chat" | "tui" | "ask" | "serve";
  readonly memoryEnabled: boolean;
  /** Inject AGENTS.md/rules while keeping memory tools/library disabled. */
  readonly staticInstructions?: boolean;
  readonly memoryResolver?: () => Promise<string | undefined>;
  /** Optional per-root state; ignored for user.md / BOOTSTRAP.md reads. */
  readonly workspaceRoot?: string;
  /** #224 工具名录段注入缝 (可选):见 AssemblyContext.toolList 注释。 */
  readonly toolList?: () => ReadonlyArray<string> | undefined;
  /** #337 T6 skills 注入缝 (可选):见 AssemblyContext.skills 注释。 */
  readonly skills?: () => ReadonlyArray<SkillSummary> | undefined;
  /** #631 T2 → B4 (ADR-0043 §3) MCP 名字目录段注入缝 (可选):见 AssemblyContext.mcp 注释。 */
  readonly mcp?: () => ReadonlyArray<McpServiceSummary> | undefined;
  /** B6 / ADR-0043 §3 + T4:溢出治理退场内建件索引段注入缝 (可选):见
   *  AssemblyContext.deferredInternalTools 注释。**会话级冻结**(闭包
   *  取一次后不再变),首轮判定的退场名单 = 整会话的退场名单。 */
  readonly deferredInternalTools?: () =>
    ReadonlyArray<DeferredInternalToolSummary> | undefined;
  /** #558 T2 coordinator 段注入缝 (可选):默认路径(build-engine 在
   *  chat/tui/serve 自建 manager)不再注入 —— 引导落点已迁到 spawn_subagent
   *  工具 description (#557 T1 SSOT)。调用方显式传入非空字符串仍渲染
   *  "## Sub-agent coordination" 段;缺席/undefined/空串 → 段缺席 (KV 缓存
   *  稳定契约)。 */
  readonly coordinatorText?: string;
  /** #646 T2:见 AssemblyContext.agentStatusReadRule 注释(布尔 gate,同门驱动)。 */
  readonly agentStatusReadRule?: boolean;
  /** plans/model-prefix-layering.md B5 / spec §9:git 块注入缝 (可选)。
   *  闭包在工厂调用时同步取一次快照,会话内冻结。详见
   *  AssemblyContext.git 注释。 */
  readonly git?: () => GitSnapshot | undefined;
  /** git 作业纪律段:见 AssemblyContext.gitWorkDiscipline。
   *  ask surface 即使为 true 也不透传到 ctx。 */
  readonly gitWorkDiscipline?: boolean;
}): () => Promise<string | undefined> {
  const bootstrapActive = shouldIncludeBootstrap(opts.surface);
  return () =>
    assembleIdentityContext({
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      projectIdentityRoot: opts.projectIdentityRoot,
      userHome: opts.userHome,
      ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
      bootstrapActive,
      memoryEnabled: opts.memoryEnabled,
      ...(opts.staticInstructions ? { staticInstructions: true } : {}),
      ...(opts.memoryResolver ? { memoryResolver: opts.memoryResolver } : {}),
      ...(opts.toolList ? { toolList: opts.toolList } : {}),
      ...(opts.skills ? { skills: opts.skills } : {}),
      ...(opts.mcp ? { mcp: opts.mcp } : {}),
      ...(opts.deferredInternalTools
        ? { deferredInternalTools: opts.deferredInternalTools }
        : {}),
      ...(opts.coordinatorText
        ? { coordinatorText: opts.coordinatorText }
        : {}),
      ...(opts.agentStatusReadRule ? { agentStatusReadRule: true } : {}),
      ...(opts.git ? { git: opts.git } : {}),
      ...(opts.gitWorkDiscipline && opts.surface !== "ask"
        ? { gitWorkDiscipline: true }
        : {}),
    });
}

/** IKNOW-196 装配流水线入口。每 turn 调一次,返回 system 文本。
 *  返回 undefined → 跳过注入 (字段全部缺席,行为零变化)。 */
export async function assembleIdentityContext(
  ctx: AssemblyContext
): Promise<string | undefined> {
  const segments: string[] = [];
  for (const seg of IKNOW_ASSEMBLY_ORDER) {
    const text = await resolveSegment(seg, ctx);
    if (text !== undefined) segments.push(text);
  }
  // #224 工具名录段注入缝:仅在提供且返回非空名录时追加,否则不追加
  // (字节级零变化,守 KV 缓存稳定契约)。加性段,不触碰 LOCKED 顺序。
  const toolList = ctx.toolList?.();
  if (toolList !== undefined && toolList.length > 0) {
    segments.push(toolListSegment(toolList));
  }
  if (segments.length === 0) return undefined;
  // Additive (non-LOCKED) — project path awareness. Mirrors the toolList
  // additive segment: does not touch IKNOW_ASSEMBLY_ORDER. Renders the
  // **stable** `projectIdentityRoot` so the agent can sense which project it
  // is operating in without running `pwd` (which is `execute` → ask by
  // default). The live task worktree (rebinds after isolation worktrees are
  // provisioned) is intentionally NOT projected here — that surface belongs to
  // the `env_snapshot` stream (T9 / ADR-0037 §4). Because projectIdentityRoot
  // is constant per process, output stays byte-stable across turns and across
  // rebinds (KV cache contract).
  // 直接调用兜底:`projectIdentityRoot` 缺失时沿用 `cwd`(只对绕过 build-
  // engine 的旧装配代码可见);生产装配必须传稳定根。
  segments.push(projectPathSegment(ctx.projectIdentityRoot ?? ctx.cwd ?? ""));
  // git 作业加性纪律段:append 在 projectPath 之后、skills 之前,不触碰
  // LOCKED 顺序。仅 isolation ON 的 chat/tui/serve 传 gitWorkDiscipline;
  // ask 即使传入也不透传;worker 缝缺席 → 段缺席 (不写空串、不补教程)。
  // 正文是单段不可变常量。标题 "## Git work",不替换既有 "## Git" 快照段。
  if (ctx.gitWorkDiscipline) {
    segments.push(gitWorkSegment(IKNOW_GIT_WORK_TEXT));
  }
  // #337 T6 加性段 `<available_skills>`:append 在 projectPath 之后;随后还有
  // #361 T8 coordinator 段在其后追加(见下),故本段不再是最末。不触碰 LOCKED
  // 顺序。缺席(seam 未注入)→ 跳过(字节级零变化);提供且经 disabled 过滤后
  // 为空 → 渲染空清单显式语句;提供且非空 → 渲染名字序列表。
  const skills = ctx.skills?.();
  if (skills !== undefined) {
    segments.push(skillsSegment(skills));
  }
  // #631 T2 → B4 (ADR-0043 §3) 加性段 `<mcp_name_directory>`(渐进式披露
  // "索引常驻档",替代旧 `<mcp_tools_overview>`):append 在 skills 之后、
  // coordinator 之前,不触碰 LOCKED 顺序。装配期现读快照 —— 异步连接的服务
  // 下一周期自然出现。降级契约对齐 memory_layer:缝缺席 / 返回空 / 过滤后
  // 无 connected 服务 → 段缺席(字节级零变化);调用抛错 → console.warn +
  // 跳过,不污染其余段。schema 不进本段(名字目录只承载服务名 + 工具名,
  // schema 由 tool_search 按需拉取)。
  if (ctx.mcp) {
    let summaries: ReadonlyArray<McpServiceSummary> | undefined;
    try {
      summaries = ctx.mcp();
    } catch (err) {
      console.warn(
        `[identity/assemble] mcp name directory resolver failed: ${String(err)}`
      );
      summaries = undefined;
    }
    if (summaries) {
      const directory = mcpNameDirectorySegment(summaries);
      if (directory !== undefined) segments.push(directory);
    }
  }
  // B6 / ADR-0043 §3 加性段 `<deferred_internal_tools>`:append 在 mcp
  // 名字目录之后、git 块之前;不触碰 LOCKED 顺序。降级契约对齐 mcp 段:
  // 缝缺席 / 返回空 / 解析抛错 → 段缺席(字节级零变化)。会话级冻结:
  // 闭包在 build-engine 装配期首轮判定后冻结,相邻轮 deep-equal。
  if (ctx.deferredInternalTools) {
    let deferred: ReadonlyArray<DeferredInternalToolSummary> | undefined;
    try {
      deferred = ctx.deferredInternalTools();
    } catch (err) {
      console.warn(
        `[identity/assemble] deferred internal tools resolver failed: ${String(err)}`
      );
      deferred = undefined;
    }
    if (deferred) {
      const segment = deferredInternalToolsSegment(deferred);
      if (segment !== undefined) segments.push(segment);
    }
  }
  // plans/model-prefix-layering.md B5 / spec §9:加性段 `## Git`(会话级常量层,
  // 与 `## Project path` 同形态——内容字节稳定)。append 在 mcp 名字目录之后、
  // agent-status 读规则之前;不触碰 LOCKED 6 段顺序,也不与 agentStatusReadRule
  // 共门。数据源 = `git-snapshot.ts` 创建的闭包,会话期同步取一次后冻结;
  // 退化态(cwd_unavailable / not_a_git_repo / git_unavailable)→ 段缺席
  // (字节级零变化,spec §9)。build-engine / worker 装配期均同步取一次。
  if (ctx.git) {
    let snapshot: GitSnapshot | undefined;
    try {
      snapshot = ctx.git();
    } catch (err) {
      console.warn(
        `[identity/assemble] git snapshot resolver failed: ${String(err)}`
      );
      snapshot = undefined;
    }
    const segment = gitSnapshotSegment(snapshot);
    if (segment !== undefined) segments.push(segment);
  }
  // #646 T2 / ADR-0028 加性段 agent-status 读规则:读规则进 system 一次,
  // 不写进每条栏(栏本身永不进 deps.system)。仅栏会注入的表面(build-engine
  // 从 deps.agentStatus 的同一 gate 派生 agentStatusReadRule=true)在场;
  // ask / worker 永远看不到栏,读一条 absent 栏的规则是永久噪音 → 段缺席
  // (字节级零变化)。一段 = 一句静态文本 (IKNOW_AGENT_STATUS_READ_RULE,
  // 无 per-turn 插值)→ 跨回合字节级不变 (KV cache 契约;surface/todoDir
  // 会话内恒定)。追加在 coordinator 之前,coordinator 仍是最末段。
  if (ctx.agentStatusReadRule) {
    segments.push(IKNOW_AGENT_STATUS_READ_RULE);
  }
  // #361 T8 加性段 subagent coordinator slot:append 在最末,不触碰 LOCKED 顺序。
  // 仅 subagentManager 装配 (chat/tui/serve) 时 build-engine 注入
  // coordinatorText;ask (无 manager) 不注入 → 段缺席 (字节级零变化,守 KV
  // 缓存稳定契约)。文本是 ADR-0014 决策 3 引导层 → model 实际可见的 system
  // prompt 一部分 (验收6 的 proactive 关键词即出于此)。
  if (ctx.coordinatorText) {
    segments.push(coordinatorSegment(ctx.coordinatorText));
  }
  // D-α T3 / ADR-0030 加性段 graph 编排:append 在最末,不触碰 LOCKED 顺序。
  // ADR-0041 / plans/model-prefix-layering.md B3:graph orchestration 段撤出
  // system —— 内容并入模式切换时的 messages 尾部追加(见 loop-engine
  // appendGraphModeChange + graph/notification.ts)。前缀稳定契约保留:
  // 关图前后 system 字节相同,翻图时仅 messages 尾追加一条 `<graph_mode>`
  // 单行文本(KV 缓存前缀 = tools/system 同序,消息尾追加不破坏缓存命中)。
  return segments.join("\n\n");
}

/** 单段解析:表驱动 (spec.md:122-132 装配顺序)。 */
async function resolveSegment(
  seg: IdentitySegmentKind,
  ctx: AssemblyContext
): Promise<string | undefined> {
  switch (seg) {
    case "identity":
      return IKNOW_IDENTITY_DEFAULT;
    case "soul":
      return IKNOW_SOUL_DEFAULT;
    case "usage":
      // IKNOW-symbol-primary T1: 使用规则段 — 代码主路径走符号工具 + grep
      // 三类回退 + edit_file 让位。SC1 全 surface (chat / tui / serve / ask)
      // 注入;条件缺席清单见 tests/harness/identity/usage-segment.test.ts。
      return IKNOW_USAGE_DEFAULT;
    case "user_profile":
      return readUserProfile(ctx);
    case "bootstrap":
      return readBootstrapIfNeeded(ctx, ctx.bootstrapActive);
    case "memory_layer":
      // T6:静态说明书与记忆库解耦。worker 通过 staticInstructions 注入
      // AGENTS.md / rules,但不启用 memory_recall / promote / existence pointer。
      if (ctx.staticInstructions) {
        const staticPrompt = await assembleStaticSystemPrompt(ctx);
        return staticPrompt || undefined;
      }
      // #194 T6:memory 层由 build-engine 注入的 resolver 装配。降级契约
      // 对齐 readUserProfile / readBootstrapIfNeeded:enabled=false →
      // 跳过;resolver 未注入 → 跳过;resolver 抛错 → console.warn + 跳过。
      if (!ctx.memoryEnabled) return undefined;
      if (!ctx.memoryResolver) return undefined;
      try {
        return await ctx.memoryResolver();
      } catch (err) {
        console.warn(
          `[identity/assemble] memory_layer resolver failed: ${err}`
        );
        return undefined;
      }
    default:
      return undefined;
  }
}

/**
 * 读 user.md:不存在 / 空 → 跳过;读失败 → skip + warn。
 * Physical root is always `<ctx.userHome>/.iknow` (issue #584).
 * `ctx.workspaceRoot` is ignored so `--workspace-root` cannot assemble a
 * project-local persona.
 */
async function readUserProfile(
  ctx: AssemblyContext
): Promise<string | undefined> {
  const root = path.join(ctx.userHome, ".iknow");
  const p = path.join(root, "user.md");
  try {
    const content = await fs.readFile(p, "utf8");
    if (content.trim().length === 0) return undefined;
    return content;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return undefined;
    console.warn(`[iknow-identity] user.md read failed (${p}): ${e.message}`);
    return undefined;
  }
}

/** rev 2026-08-11 隐式完成 + issue #584:
 *  bootstrap_active=false → skip;否则读 `<ctx.userHome>/.iknow/BOOTSTRAP.md`。
 *  `ctx.workspaceRoot` 不参与 persona。完成机制 = agent 自己 rm BOOTSTRAP.md。
 *  文件读失败 (EACCES / EISDIR / 其他 IO) → warn + skip。 */
async function readBootstrapIfNeeded(
  ctx: AssemblyContext,
  bootstrapActive: boolean
): Promise<string | undefined> {
  if (!bootstrapActive) return undefined;
  const wsRoot = path.join(ctx.userHome, ".iknow");
  const bp = bootstrapFilePath(wsRoot);
  try {
    const content = await fs.readFile(bp, "utf8");
    if (content.trim().length === 0) return undefined;
    return content;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return undefined;
    console.warn(
      `[iknow-identity] BOOTSTRAP.md read failed (${bp}): ${e.message}`
    );
    return undefined;
  }
}

/** #224 工具名录段渲染:小标题 + 名录(每行一个工具名)。
 *  本期仅在装配层被调用;build-engine 暂不传 toolList,
 *  故真实路径上不会渲染。函数独立封装便于后续测试断言文本形态。 */
function toolListSegment(names: ReadonlyArray<string>): string {
  return `Available tools:\n${names.join("\n")}`;
}

/** Project path 段渲染:小标题 + 稳定 projectIdentityRoot。加性段,
 *  不触碰 LOCKED 顺序。让 agent 感知项目身份根(无需 `pwd` → execute→ask)
 *  —— 活 taskRoot 在 rebind 后会变化,刻意不进入此段(改由 env_snapshot 流
 *  暴露给人读面,T9 / ADR-0037 §4)。projectIdentityRoot 在进程内稳定,
 *  rebind 不影响本段字节,KV 缓存契约保留。 */
function projectPathSegment(projectIdentityRoot: string): string {
  return `## Project path\n${projectIdentityRoot}`;
}

/** #337 T6 `<available_skills>` 段渲染:XML 风格标签 + 名字序列表 +
 *  description 同行 + 空清单显式 "No skills installed"。
 *  加性段,不触碰 IKNOW_ASSEMBLY_ORDER;disabled 在调用前已被装配层过滤。
 *
 *  T5 / ADR-0046 Decision 2:description 缺席/空/纯空白 → 渲染**裸名行**
 *  (索引降档把超阈条目剥成仅名字;名字永不删、段永不缺席)。降档判定不在
 *  本函数里 —— 渲染层只按数据形态输出(单一 SSOT,见 identity/index-demotion.ts)。
 *
 *  描述不截 120 字(MCP/退场内建段走 shortToolDescription,本段不走):
 *  #337 T6 起该段即渲染完整 description,长度由 skill frontmatter 作者控制;
 *  索引降档(countTokens 实测)会把超阈条目整条剥成裸名,与靠固定 cap
 *  压体积是两条不同治理路径,不在渲染层混用。 */
export function skillsSegment(skills: ReadonlyArray<SkillSummary>): string {
  const visible = skills
    .filter((s) => !s.disabled)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (visible.length === 0) {
    return "<available_skills>\nNo skills installed\n</available_skills>";
  }
  const body = visible
    .map((s) => {
      const description = s.description?.trim();
      return description === undefined || description.length === 0
        ? s.name
        : `${s.name}: ${s.description}`;
    })
    .join("\n");
  return `<available_skills>\n${body}\n</available_skills>`;
}

/** #646 T2 / ADR-0028 / CONTEXT「状态栏」:状态栏读规则 —— 装配进
 *  deps.system 的单句静态文本 (SSOT,装配/测试只引用,绝不复制/切片)。
 *
 *  内容契约 (plans/agent-status-bar.md T2 / ADR-0028 Consequences):
 *   - 以最后一条 `<agent_status>` 消息为准 (旧栏留在 transcript,仅历史);
 *   - `last_tool` = 本回合上一个完成的工具 (尚未跑工具为 idle);
 *   - todo 段在场 = 当前未勾项清单;todo 段缺席 = 当前无未勾项
 *     (空槽不广告,缺席即语义)。
 *
 *  形态契约:一句、英文 (与 IKNOW_IDENTITY_DEFAULT / IKNOW_SOUL_DEFAULT 同
 *  语言)、纯静态 (无任何 per-turn 插值 → 跨回合字节级不变,KV cache 契约)、
 *  不印在每条栏上 (栏只承载代码算出的现势,栏内不含政策散文)。
 *  仅栏会注入的表面渲染 (ctx.agentStatusReadRule gate;ask / worker 永不注入)。 */
export const IKNOW_AGENT_STATUS_READ_RULE =
  "The latest `<agent_status>` message is authoritative for current state: `last_tool` is the last tool that finished this turn (`idle` before any tool has run this turn), the todos section lists the current open items, and an absent todos section means there are no open items.";

/** #361 T8 subagent coordinator 引导文本正文 (SSOT,不含段标题——标题由
 *  coordinatorSegment 加 "## Sub-agent coordination" 渲染,projectPathSegment /
 *  skillsSegment 同形态)。ADR-0014 决策 3 引导层:前景 spawn 为默认契约。
 *
 *  内容覆盖 ADR 决策 3 五要点:
 *   ① 两工具是谁 —— spawn_subagent + subagent_result
 *   ② 何时派   —— multi-step exploration / independent verification /
 *                parallelizable work
 *   ③ 前景默认"阻塞等待结果" —— blocks until finished,same-turn envelope
 *   ④ 一回合多 spawn 并行 —— issue multiple spawn_subagent calls in one turn
 *   ⑤ 结果处置 —— envelope 直接返回 / failed 也是数据读 reason + summary
 *
 *  验收 6 硬挂钩 (model 实际可见的 system prompt 含):
 *    proactive(proactively) · parallelizable · blocks until finished
 *  措辞 "Default contract today" 为 V2 追加异步纪律段留空间。
 *
 *  #558 T2:build-engine 默认路径不再注入该常量 —— 引导落点已迁到
 *  spawn_subagent 工具 description (#557 T1 SSOT)。装配缝仍保留:调用方
 *  经 createIknowSystemResolver opts.coordinatorText 显式传入仍渲染该段。 */
export const IKNOW_COORDINATOR_TEXT = `
Fork work to sub-agents running in separate processes. Two tools drive this:

- spawn_subagent — spawn a sub-agent for a \`task\` (optionally \`systemPrompt\`, \`model\`, \`disallowedTools\`, \`maxTurns\`, \`timeoutMs\`). By default it blocks until finished: the tool result is the sub-agent's envelope, returned directly in the same turn.
- subagent_result — poll a spawned task by \`task_id\` (status: not_found / running / completed / failed) when you need a fresh status without re-spawning.

Use spawn_subagent proactively for multi-step exploration, independent verification, or parallelizable work — anything self-contained that can run in its own process without the main loop's state. Do not spawn for trivial lookups you can do directly.

Result handling: a completed spawn returns the envelope {status: "ok", summary, result, fileRefs?, usage?} directly. A failed worker is data, not an error — read {status: "failed", reason, summary} and decide next steps from it.

Parallelize by issuing multiple spawn_subagent calls in one turn: each spawns an independent worker process and they run concurrently. Keep each task self-contained; sub-agents cannot spawn further sub-agents.

(For wait:false in chat/tui/serve, terminal completion wakes a silent run through the host mailbox/subscription; use subagent_result only for an explicit status query.)
`.trim();

/** #361 T8 subagent coordinator 段渲染:段标题 + 正文 (coordinatorSegment 在
 *  assembleIdentityContext 内对 ctx.coordinatorText 调用,加性段不触碰 LOCKED
 *  顺序;缺席 → 跳过,字节级零变化)。 */
export function coordinatorSegment(text: string): string {
  return `## Sub-agent coordination\n${text}`;
}

/**
 * #562 T7 readonly worker 的 "Tool constraints for this run" 段渲染。
 *
 * 内容契约 (plan T7 + spec symbol-primary-aci T3):
 *   - 允许命令族:coreutils 读族 (cat/grep/ls/head/tail/wc/stat/...)、
 *     git 只读子命令 (status/log/diff/show/ls-files/...)、rg、jq。
 *   - 显式 reject:输出重定向 (>)、后台 (&)、find -delete/-exec、
 *     sort -o、git --output、env/xargs/time/nohup/timeout。
 *   - 符号工具优先 + grep/read_file 三类回退 (spec SC8):列出 10 件符号
 *     查询工具(find_symbol / find_declaration / ...),明示 grep / read_file
 *     仅三类回退场景 (非代码 / 还没找到符号名 / 语言服务器不可用重试一次
 *     仍失败)。旧 `lsp_*` 此步仍在 model face (T5 才删),但本段不再并列
 *     成与 grep 同等首选 —— spec Assumptions 2/9 + T3 acceptance。
 *
 * 措辞 mirror CC Agent tool constraints 段;纯函数,无 ctx 依赖,
 * mode 缺省或 "any" → caller 不调用本函数 (段缺席, V1 byte-stable)。
 * 加性段不触碰 IKNOW_ASSEMBLY_ORDER 的 6 段 LOCKED 顺序;由 worker
 * 装配期 (withRoleExtras) 在 persona 之后追加,顺序契约:
 *   base < persona < constraints < addendum。
 */
export function toolConstraintsSegment(mode: "readonly"): string {
  if (mode !== "readonly") {
    // 类型契约守门:本函数当前仅支持 readonly 模式;其他 mode 由调用方
    // 自行决定是否调用本函数。编译期已限定字面量,运行时守门是冗余
    // 防御 (callable 边)。
    throw new Error(`toolConstraintsSegment: unsupported mode '${mode}'`);
  }
  return `## Tool constraints for this run

You may invoke bash commands only for read-only operations in this task. Writes, deletions, and side-effecting operations are rejected.

Allowed command families:
- coreutils read: ls, cat, grep, wc, stat, du, df, ps, diff, head, tail, sha256sum, md5sum, sort (without -o/--output), file, basename, dirname, realpath, readlink, nl, fold, od, xxd, hexdump, strings, column
- find (without -delete/-exec/-execdir/-ok/-okdir) — read-only traversal
- git read-only subcommands: status, log, diff, show, ls-files, ls-tree, describe, rev-parse, shortlog, blame, reflog, rev-list, cat-file, name-rev, grep, whatchanged, count-objects, verify-pack, fsck, remote
- search tools: rg
- json tools: jq

Rejected:
- output redirection (>, >>, &>) and background operators (&) — readonly mode does not write
- find -delete / -exec / -execdir / -ok / -okdir — write or execute side effects
- sort -o / --output — writes output to a file
- git --output — any path that writes; git subcommands not in the read-only whitelist are denied
- env, xargs, time, nohup, timeout — execution agents that mutate environment or shell state
- command substitution (\$(...) / backticks / \${}) and process substitution (<(...)) — caught upstream
- any command not in the policy table — deny-by-default

For non-bash reads, prefer the symbol tools over grep:

- find_symbol — locate a symbol by name (substring / pattern when the exact name is unknown)
- find_declaration — jump to the symbol's declaration or definition
- find_referencing_symbols — list every reference to the symbol across the project
- find_implementations — find the concrete implementations of an interface or method
- get_symbols_overview — read the symbol tree of a single file
- get_hover — read the type, signature or doc attached to a symbol
- get_diagnostics_for_file — surface diagnostics for a file
- prepare_call_hierarchy / list_incoming_calls / list_outgoing_calls — walk the call graph

\`grep\` and \`read_file\` are restricted to three fallback situations:

- Non-code content — comments, string literals, configuration files, documentation
- Unknown symbol — still prefer \`find_symbol\` substring / pattern before falling back to grepping source
- Language server unavailable — retry once; if it still fails, fall back to grep with the readable failure string from the tool

Other helpers:

- read_file — read a file at a path (when symbol tools are not the right fit)
- glob — match paths by pattern (not for searching file contents)`;
}
