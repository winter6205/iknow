/**
 * IKNOW-196 装配流水线 (spec `specs/196-identity-assembly.md`
 * spec.md:122-132 装配顺序约束 + spec.md:246-256 注入缝 + spec.md:260-266
 * 入口覆盖矩阵)。
 *
 * 模块责任:在每次 model turn 把 identity 装配成 system 文本块;
 * build-engine 在 deps.system 注册此函数 (T4) 每 turn 调一次。
 * 顺序 LOCKED —— Spec 锁死,不得重排。
 *
 * 5 段顺序:#194 T6 落地后,user_agents / priority_dec / project_agents /
 * existence_pointer / promote 5 段合并为单 `memory_layer` 段(由 build-engine
 * 注入 `memoryResolver` 装配,降级契约:resolver 抛错 → warn + undefined)。
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
import { bootstrapFilePath } from "./workspace.js";

/** IKNOW-196 + #194 T6 装配顺序 (5 段,逐步锁死)。 */
export const IKNOW_ASSEMBLY_ORDER = [
  "identity", // 1. 认知层 (代码 LOCKED):Name/Kind/Signature
  "soul", // 2. 人格层 (代码 LOCKED):core truths/boundaries/vibe/continuity
  "user_profile", // 3. 用户画像 (~/.iknow/user.md) — 用户可改
  "bootstrap", // 4. 首启引导 (rev 2026-08-11:文件驱动 — BOOTSTRAP.md 存在即注入)
  "memory_layer", // 5. 记忆层 (#194 / #121:AGENTS.md / rules / memory promote)
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
  readonly cwd: string;
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
  readonly memoryResolver?: () => Promise<string | undefined>;
  readonly toolList?: () => ReadonlyArray<string> | undefined;
  readonly skills?: () => ReadonlyArray<SkillSummary> | undefined;
  /** #631 T2 MCP 概览段注入缝 (可选,渐进式披露"索引常驻档"):每 turn 装配期
   *  现读快照 —— 异步连接的服务连上后下一装配周期自然出现,不阻塞不空等。
   *  缺席 / 返回空 / 过滤后无 connected 服务 → 段缺席 (KV 缓存字节级稳定);
   *  调用抛错 → console.warn + 跳过 (降级契约对齐 memory_layer)。 */
  readonly mcp?: () => ReadonlyArray<McpServiceSummary> | undefined;
  /** #558 T2 coordinator 段注入缝 (可选):默认路径(build-engine 在
   *  chat/tui/serve 自建 manager)不再注入 —— 引导落点已迁到 spawn_subagent
   *  工具 description (#557 T1 SSOT)。调用方显式传入非空字符串仍渲染
   *  "## Sub-agent coordination" 段;缺席/undefined/空串 → 段缺席 (KV 缓存
   *  稳定契约)。 */
  readonly coordinatorText?: string;
}

/** #337 T6 `<available_skills>` 段元素形态(最小投影:name + description + disabled)。
 *  disabled=true → 装配层跳过(SC3),与 catalog.available() 语义一致。 */
export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly disabled?: boolean;
}

/** #631 T2 MCP 概览段工具元素形态(最小投影)。description 缺席/空 →
 *  只渲染工具名。 */
export interface McpToolSummary {
  readonly name: string;
  readonly description?: string;
}

/** #631 T2 MCP 概览段服务元素形态(最小投影,与 mcp/manager McpServerState
 *  同词汇表但不跨模块导入——装配层只依赖字面量联合)。仅 "connected" 服务
 *  入段:pending(还在连) / failed / disabled 整体不渲染。 */
export interface McpServiceSummary {
  readonly name: string;
  readonly state: "pending" | "connected" | "failed" | "disabled";
  readonly description?: string;
  readonly tools: ReadonlyArray<McpToolSummary>;
}

/** #631 T2 工具短描述限值:取 description 首行,超过此长度截断 + 省略号。 */
export const MCP_TOOL_SHORT_DESCRIPTION_MAX = 120;

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
  readonly cwd: string;
  readonly userHome: string;
  readonly surface: "chat" | "tui" | "ask" | "serve";
  readonly memoryEnabled: boolean;
  readonly memoryResolver?: () => Promise<string | undefined>;
  /** Optional per-root state; ignored for user.md / BOOTSTRAP.md reads. */
  readonly workspaceRoot?: string;
  /** #224 工具名录段注入缝 (可选):见 AssemblyContext.toolList 注释。 */
  readonly toolList?: () => ReadonlyArray<string> | undefined;
  /** #337 T6 skills 注入缝 (可选):见 AssemblyContext.skills 注释。 */
  readonly skills?: () => ReadonlyArray<SkillSummary> | undefined;
  /** #631 T2 MCP 概览段注入缝 (可选):见 AssemblyContext.mcp 注释。 */
  readonly mcp?: () => ReadonlyArray<McpServiceSummary> | undefined;
  /** #558 T2 coordinator 段注入缝 (可选):默认路径(build-engine 在
   *  chat/tui/serve 自建 manager)不再注入 —— 引导落点已迁到 spawn_subagent
   *  工具 description (#557 T1 SSOT)。调用方显式传入非空字符串仍渲染
   *  "## Sub-agent coordination" 段;缺席/undefined/空串 → 段缺席 (KV 缓存
   *  稳定契约)。 */
  readonly coordinatorText?: string;
}): () => Promise<string | undefined> {
  const bootstrapActive = shouldIncludeBootstrap(opts.surface);
  return () =>
    assembleIdentityContext({
      cwd: opts.cwd,
      userHome: opts.userHome,
      ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
      bootstrapActive,
      memoryEnabled: opts.memoryEnabled,
      ...(opts.memoryResolver ? { memoryResolver: opts.memoryResolver } : {}),
      ...(opts.toolList ? { toolList: opts.toolList } : {}),
      ...(opts.skills ? { skills: opts.skills } : {}),
      ...(opts.mcp ? { mcp: opts.mcp } : {}),
      ...(opts.coordinatorText
        ? { coordinatorText: opts.coordinatorText }
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
  // additive segment: does not touch IKNOW_ASSEMBLY_ORDER. Renders the cwd so
  // the agent can sense which project it is operating in without running
  // `pwd` (which is `execute` → ask by default). Cwd is constant per process,
  // so output stays byte-stable across turns (KV cache contract).
  segments.push(projectPathSegment(ctx.cwd));
  // #337 T6 加性段 `<available_skills>`:append 在 projectPath 之后;随后还有
  // #361 T8 coordinator 段在其后追加(见下),故本段不再是最末。不触碰 LOCKED
  // 顺序。缺席(seam 未注入)→ 跳过(字节级零变化);提供且经 disabled 过滤后
  // 为空 → 渲染空清单显式语句;提供且非空 → 渲染名字序列表。
  const skills = ctx.skills?.();
  if (skills !== undefined) {
    segments.push(skillsSegment(skills));
  }
  // #631 T2 加性段 `<mcp_tools_overview>`(渐进式披露"索引常驻档"):append 在
  // skills 之后、coordinator 之前,不触碰 LOCKED 顺序。装配期现读快照 ——
  // 异步连接的服务下一周期自然出现。降级契约对齐 memory_layer:缝缺席 /
  // 返回空 / 过滤后无 connected 服务 → 段缺席(字节级零变化);调用抛错 →
  // console.warn + 跳过,不污染其余段。
  if (ctx.mcp) {
    let summaries: ReadonlyArray<McpServiceSummary> | undefined;
    try {
      summaries = ctx.mcp();
    } catch (err) {
      console.warn(
        `[identity/assemble] mcp overview resolver failed: ${String(err)}`
      );
      summaries = undefined;
    }
    if (summaries) {
      const overview = mcpOverviewSegment(summaries);
      if (overview !== undefined) segments.push(overview);
    }
  }
  // #361 T8 加性段 subagent coordinator slot:append 在最末,不触碰 LOCKED 顺序。
  // 仅 subagentManager 装配 (chat/tui/serve) 时 build-engine 注入
  // coordinatorText;ask (无 manager) 不注入 → 段缺席 (字节级零变化,守 KV
  // 缓存稳定契约)。文本是 ADR-0014 决策 3 引导层 → model 实际可见的 system
  // prompt 一部分 (验收6 的 proactive 关键词即出于此)。
  if (ctx.coordinatorText) {
    segments.push(coordinatorSegment(ctx.coordinatorText));
  }
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
    case "user_profile":
      return readUserProfile(ctx);
    case "bootstrap":
      return readBootstrapIfNeeded(ctx, ctx.bootstrapActive);
    case "memory_layer":
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

/** rev 2026-08-11 对齐 openharness 隐式完成 + issue #584:
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

/** 当前项目路径段渲染:小标题 + cwd。加性段,不触碰 LOCKED 顺序。
 *  让 agent 感知当前项目路径(无需 `pwd` → execute→ask)。cwd 在进程内稳定,
 *  字节级稳定契约保留(KV 缓存不抖动)。 */
function projectPathSegment(cwd: string): string {
  return `## Project path\n${cwd}`;
}

/** #337 T6 `<available_skills>` 段渲染:XML 风格标签 + 名字序列表 +
 *  description 同行 + 空清单显式 "No skills installed"。
 *  加性段,不触碰 IKNOW_ASSEMBLY_ORDER;disabled 在调用前已被装配层过滤。 */
export function skillsSegment(skills: ReadonlyArray<SkillSummary>): string {
  const visible = skills
    .filter((s) => !s.disabled)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (visible.length === 0) {
    return "<available_skills>\nNo skills installed\n</available_skills>";
  }
  const body = visible.map((s) => `${s.name}: ${s.description}`).join("\n");
  return `<available_skills>\n${body}\n</available_skills>`;
}

/** #631 T2 工具短描述:取首行 + 限值截断(~120 字符);缺席/空/空行 →
 *  undefined(调用方只渲染工具名)。 */
function shortToolDescription(
  description: string | undefined
): string | undefined {
  if (description === undefined || description.length === 0) return undefined;
  const firstLine = description.split("\n", 1)[0].trim();
  if (firstLine.length === 0) return undefined;
  if (firstLine.length <= MCP_TOOL_SHORT_DESCRIPTION_MAX) return firstLine;
  return `${firstLine.slice(0, MCP_TOOL_SHORT_DESCRIPTION_MAX)}…`;
}

/** #631 T2 `<mcp_tools_overview>` 段渲染(渐进式披露"索引常驻档"):
 *  每 connected 服务一行(名字 [+ description]),其下每工具一行
 *  (名字 [+ 短描述]),末行引导 tool_search 精查。
 *  加性段,不触碰 IKNOW_ASSEMBLY_ORDER;仅渲染 state === "connected" 的服务
 *  (pending 还在连 / failed / disabled 整体不渲染);过滤后为空 →
 *  返回 undefined(装配层不追加,绝不写空串)。 */
export function mcpOverviewSegment(
  services: ReadonlyArray<McpServiceSummary>
): string | undefined {
  const connected = services
    .filter((s) => s.state === "connected")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (connected.length === 0) return undefined;
  const lines: string[] = [];
  for (const service of connected) {
    lines.push(
      service.description && service.description.trim().length > 0
        ? `${service.name}: ${service.description}`
        : service.name
    );
    const tools = service.tools
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const tool of tools) {
      const short = shortToolDescription(tool.description);
      lines.push(
        short === undefined ? `- ${tool.name}` : `- ${tool.name}: ${short}`
      );
    }
  }
  lines.push(
    "Use tool_search to look up the full schema and details of any tool listed above before calling it."
  );
  return `<mcp_tools_overview>\n${lines.join("\n")}\n</mcp_tools_overview>`;
}

/** #361 T8 subagent coordinator 引导文本正文 (SSOT,不含段标题——标题由
 *  coordinatorSegment 加 "## Sub-agent coordination" 渲染,projectPathSegment /
 *  skillsSegment 同形态)。ADR-0014 决策 3 引导层:前景 spawn 为默认契约。
 *
 *  内容覆盖 ADR 决策 3 五要点:
 *   ① 两工具是谁 —— spawn_subagent + subagent_result
 *   ② 何时派   —— multi-step exploration / independent verification /
 *                parallelizable work(句子同 opencode 工具描述对照)
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

(Default contract today: spawn blocks until the sub-agent finishes. A future version may add an explicit asynchronous mode for fire-and-forget work.)
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
 * 内容契约 (plan T7):
 *   - 允许命令族:coreutils 读族 (cat/grep/ls/head/tail/wc/stat/...)、
 *     git 只读子命令 (status/log/diff/show/ls-files/...)、rg、jq。
 *   - 显式 reject:输出重定向 (>)、后台 (&)、find -delete/-exec、
 *     sort -o、git --output、env/xargs/time/nohup/timeout。
 *   - 替代工具引导:read_file / grep / glob / lsp_*。
 *
 * 措辞 mirror CC Agent tool constraints 段;纯函数,无 ctx 依赖,
 * mode 缺省或 "any" → caller 不调用本函数 (段缺席, V1 byte-stable)。
 * 加性段不触碰 IKNOW_ASSEMBLY_ORDER 的 5 段 LOCKED 顺序;由 worker
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

For non-bash reads, prefer the dedicated tools:
- read_file — read a file at a path
- grep — search file contents
- glob — match paths by pattern
- lsp_definition / lsp_references / lsp_hover / lsp_document_symbol / lsp_workspace_symbol / lsp_go_to_implementation / lsp_prepare_call_hierarchy / lsp_incoming_calls / lsp_outgoing_calls — code navigation
- lsp_diagnostics — diagnostics for a file`;
}
