/**
 * IKNOW-196 9 段装配流水线 (spec `specs/196-identity-assembly.md`
 * spec.md:122-132 装配顺序约束 + spec.md:246-256 注入缝 + spec.md:260-266
 * 入口覆盖矩阵)。
 *
 * 模块责任:在每次 model turn 把 identity 装配成 system 文本块;
 * build-engine 在 deps.system 注册此函数 (T4) 每 turn 调一次。
 * 顺序 LOCKED —— Spec 锁死,不得重排。
 *
 * 锁定约束:
 * - 字段缺席 → 返回 undefined (不写空 system,KV 缓存字节级稳定,T1 决策)
 * - user.md 不存在 / 空 → 跳过 (不报错)
 * - state.json 缺失 / 损坏 → bootstrap_seeded 默认 false → 注入 BOOTSTRAP
 * - state.json.bootstrap_seeded=true → 跳过 BOOTSTRAP (T5 入口由显式
 *   writeIknowState({ bootstrap_seeded: true }) 关闭)
 * - user_agents / priority_dec / project_agents / existence_pointer / promote
 *   5 段在 master 上未实装 (#121 worktree 未合入),返回 undefined —
 *   T4 由 build-engine 在 master + #121 worktree merge 后接 #121 装配。
 */

import path from "node:path";
import { promises as fs } from "node:fs";

import { IKNOW_IDENTITY_DEFAULT } from "./identity.js";
import { IKNOW_BOOTSTRAP_PROMPT } from "./bootstrap.js";
import { IKNOW_SOUL_DEFAULT } from "./soul.js";
import { readIknowState } from "./workspace.js";

/** IKNOW-196 装配顺序 (9 段,逐步锁死)。 */
export const IKNOW_ASSEMBLY_ORDER = [
  "identity", // 1. 认知层 (代码 LOCKED):Name/Kind/Signature
  "soul", // 2. 人格层 (代码 LOCKED):core truths/boundaries/vibe/continuity
  "user_profile", // 3. 用户画像 (~/.iknow/user.md) — 用户可改
  "bootstrap", // 4. 首启引导 (仅当 bootstrap_seeded=false 注入)
  "user_agents", // 5. user AGENTS.md (#121 既有)
  "priority_dec", // 6. PRIORITY_DECLARATION (#121 既有)
  "project_agents", // 7. project AGENTS.md (#121 既有)
  "existence_pointer", // 8. EXISTENCE_POINTER (#121 既有, memory non-empty)
  "promote", // 9. promote 段 (#121 既有)
] as const;

/** 装配顺序常量数组的元素类型。 */
export type IdentitySegmentKind = (typeof IKNOW_ASSEMBLY_ORDER)[number];

/** IKNOW-196 装配上下文 (build-engine 每 turn 注入)。 */
export interface AssemblyContext {
  readonly cwd: string;
  readonly userHome: string;
  readonly bootstrapActive: boolean;
}

/** IKNOW-196 入口范围判定。仅 chat / tui 激活 BOOTSTRAP;ask / serve 跳过。 */
export function shouldIncludeBootstrap(
  surface: "chat" | "tui" | "ask" | "serve"
): boolean {
  return surface === "chat" || surface === "tui";
}

/** IKNOW-196 deps.system 工厂。build-engine / tui-deps 两处装配层用同一
 *  工厂消除字面级复制(spec A12 矩阵:bootstrapActive 由 surface 决定)。
 *  每 turn 解析一次(用户改 user.md turn 级生效,spec 不做 TTL 缓存)。 */
export function createIknowSystemResolver(opts: {
  readonly cwd: string;
  readonly userHome: string;
  readonly surface: "chat" | "tui" | "ask" | "serve";
}): () => Promise<string | undefined> {
  const bootstrapActive = shouldIncludeBootstrap(opts.surface);
  return () =>
    assembleIdentityContext({
      cwd: opts.cwd,
      userHome: opts.userHome,
      bootstrapActive,
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
    case "user_agents":
    case "priority_dec":
    case "project_agents":
    case "existence_pointer":
    case "promote":
      // #121 段在 master 上不存在 (#121 worktree 未合入);T4 由 build-engine
      // 路径在 #121 merge 后接 #121 装配。当前 master 上装配层不解析。
      return undefined;
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
