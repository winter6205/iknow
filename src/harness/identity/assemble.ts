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
   * ADR-0019 (T2, D1.4): per-root state anchor. user.md / BOOTSTRAP.md reads
   * switch from `path.join(userHome, ".iknow")` to
   * `path.join(workspaceRoot, ".iknow")`. Optional + `userHome` fallback keeps
   * 既有 T337 seam 测 / 直接构造 AssemblyContext 的调用方零破坏;
   * build-engine 装配期总是显式传入解析后的 workspaceRoot。
   */
  readonly workspaceRoot?: string;
  readonly bootstrapActive: boolean;
  readonly memoryEnabled: boolean;
  readonly memoryResolver?: () => Promise<string | undefined>;
  readonly toolList?: () => ReadonlyArray<string> | undefined;
  readonly skills?: () => ReadonlyArray<SkillSummary> | undefined;
  /** #361 T8 subagent coordinator 段注入缝 (可选):build-engine 在
   *  subagentManager 装配 (chat/tui/serve) 时经 createIknowSystemResolver opts
   *  传入 IKNOW_COORDINATOR_TEXT;ask (无 manager) 不传入 → 段缺席,字节级零
   *  变化 (KV 缓存稳定契约)。空串亦视为缺席。 */
  readonly coordinatorText?: string;
}

/** #337 T6 `<available_skills>` 段元素形态(最小投影:name + description + disabled)。
 *  disabled=true → 装配层跳过(SC3),与 catalog.available() 语义一致。 */
export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly disabled?: boolean;
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
  readonly cwd: string;
  readonly userHome: string;
  readonly surface: "chat" | "tui" | "ask" | "serve";
  readonly memoryEnabled: boolean;
  readonly memoryResolver?: () => Promise<string | undefined>;
  /** ADR-0019 (T2, D1.4): per-root state anchor(可选;缺席 → 装配回退 userHome)。 */
  readonly workspaceRoot?: string;
  /** #224 工具名录段注入缝 (可选):见 AssemblyContext.toolList 注释。 */
  readonly toolList?: () => ReadonlyArray<string> | undefined;
  /** #337 T6 skills 注入缝 (可选):见 AssemblyContext.skills 注释。 */
  readonly skills?: () => ReadonlyArray<SkillSummary> | undefined;
  /** #361 T8 subagent coordinator 段注入缝 (可选):build-engine 在
   *  subagentManager 装配 (chat/tui/serve) 时经 createIknowSystemResolver opts
   *  传入 IKNOW_COORDINATOR_TEXT;ask (无 manager) 不传入 → 段缺席,字节级零
   *  变化 (KV 缓存稳定契约)。空串亦视为缺席。 */
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
      // ADR-0019 (T2, D1.4):per-root workspaceRoot > userHome fallback.
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
 * ADR-0019 (T2, D1.4):physical root = `<ctx.workspaceRoot>/.iknow` when
 * provided(user persona state is per-root),否则回退 `userHome`(既有 T337
 * seam 测 / 直接 ctx 构造方零破坏)。
 */
async function readUserProfile(
  ctx: AssemblyContext
): Promise<string | undefined> {
  const stateRoot = ctx.workspaceRoot ?? ctx.userHome;
  const root = path.join(stateRoot, ".iknow");
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

/** rev 2026-08-11 对齐 openharness 隐式完成 + ADR-0019 (T2, D1.4):
 *  bootstrap_active=false → skip;否则读 `<ctx.workspaceRoot>/.iknow/BOOTSTRAP.md`
 *  文件存在性,存在 → 注入内容,缺失 → undefined。
 *  workspaceRoot 缺席 → 回退 userHome(既有 T337 seam 测兼容)。
 *  完成机制 = agent 自己 rm BOOTSTRAP.md(文件驱动)。文件读失败
 *  (EACCES / EISDIR / 其他 IO) → warn + skip(spec 降级契约)。 */
async function readBootstrapIfNeeded(
  ctx: AssemblyContext,
  bootstrapActive: boolean
): Promise<string | undefined> {
  if (!bootstrapActive) return undefined;
  const stateRoot = ctx.workspaceRoot ?? ctx.userHome;
  const wsRoot = path.join(stateRoot, ".iknow");
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
 *  build-engine 在 subagentManager 装配时经 createIknowSystemResolver opts
 *  传入;ask (surface !== chat/tui/serve) 不传 → 段缺席 (字节级零变化)。 */
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
