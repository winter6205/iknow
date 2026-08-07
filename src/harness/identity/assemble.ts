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
import { IKNOW_BOOTSTRAP_PROMPT } from "./bootstrap.js";
import { IKNOW_SOUL_DEFAULT } from "./soul.js";
import { readIknowState } from "./workspace.js";

/** IKNOW-196 + #194 T6 装配顺序 (5 段,逐步锁死)。 */
export const IKNOW_ASSEMBLY_ORDER = [
  "identity", // 1. 认知层 (代码 LOCKED):Name/Kind/Signature
  "soul", // 2. 人格层 (代码 LOCKED):core truths/boundaries/vibe/continuity
  "user_profile", // 3. 用户画像 (~/.iknow/user.md) — 用户可改
  "bootstrap", // 4. 首启引导 (仅当 bootstrap_seeded=false 注入)
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
  readonly bootstrapActive: boolean;
  readonly memoryEnabled: boolean;
  readonly memoryResolver?: () => Promise<string | undefined>;
  readonly toolList?: () => ReadonlyArray<string> | undefined;
}

/** IKNOW-196 入口范围判定。仅 chat / tui 激活 BOOTSTRAP;ask / serve 跳过。 */
export function shouldIncludeBootstrap(
  surface: "chat" | "tui" | "ask" | "serve"
): boolean {
  return surface === "chat" || surface === "tui";
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
  /** #224 工具名录段注入缝 (可选):见 AssemblyContext.toolList 注释。 */
  readonly toolList?: () => ReadonlyArray<string> | undefined;
}): () => Promise<string | undefined> {
  const bootstrapActive = shouldIncludeBootstrap(opts.surface);
  return () =>
    assembleIdentityContext({
      cwd: opts.cwd,
      userHome: opts.userHome,
      bootstrapActive,
      memoryEnabled: opts.memoryEnabled,
      ...(opts.memoryResolver ? { memoryResolver: opts.memoryResolver } : {}),
      ...(opts.toolList ? { toolList: opts.toolList } : {}),
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
      return readUserProfile(ctx.userHome);
    case "bootstrap":
      return readBootstrapIfNeeded(ctx.userHome, ctx.bootstrapActive);
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

/** 读 user.md:不存在 / 空 → 跳过;读失败 → skip + warn。 */
async function readUserProfile(userHome: string): Promise<string | undefined> {
  const root = path.join(userHome, ".iknow");
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

/** bootstrap_active=false → skip;否则读 state,bootstrap_seeded=false → 注入。
 *  state 读失败(EACCES / EISDIR / 其他 IO)→ warn + skip(spec 降级契约
 *  spec.md:300-326,装配不阻塞) */
async function readBootstrapIfNeeded(
  userHome: string,
  bootstrapActive: boolean
): Promise<string | undefined> {
  if (!bootstrapActive) return undefined;
  const wsRoot = path.join(userHome, ".iknow");
  try {
    const state = await readIknowState(wsRoot);
    if (state.bootstrap_seeded) return undefined;
    return IKNOW_BOOTSTRAP_PROMPT;
  } catch (err) {
    const e = err as { kind?: string; path?: string; cause?: string };
    console.warn(
      `[iknow-identity] state read failed (${e.path ?? wsRoot}): ${e.kind ?? "unknown"} ${e.cause ?? ""}`
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
