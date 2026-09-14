/**
 * 工作区档 fs-isolation overlay —— 会话级文件系统档开关的单点
 * （ADR-0092 Amendment 2026-09-13, specs/fs-isolation-modes.md SC11/SC12）。
 *
 * fs isolation **不是** `PermissionMode`（授权轴）也不是
 * `worktreeOnMutate`（写门禁）——bash 围栏能碰哪些路径是另一根独立的轴。值域
 * 只有两档：
 *   - `"global"`   — 默认：宿主真路径可读可写，拦写靠权限三层 + hard-wall，
 *                    home 不藏（ADR-0092 主条款）。
 *   - `"workspace"`— home 可见但只读；写 = 活 `taskRoot` ∪ **会话 tmp**；
 *                    home 其余默认不能写（spec SC11）。
 *
 * 本模块承担四件事（与 `graph/mode.ts` 的 GraphModeContext 形态镜像 —— 三入口
 * / TUI / REPL / serve 共用同一份单点）：
 *   - **值域**：`parseFsModeFlag` —— **命令面**（`/config` 的 args 解析与
 *     holder `set` 的兜底网）的档位字面守卫（trim + 小写；非法值 fail-closed
 *     到 undefined）。settings 段不共用它：`isolation.fsMode` 在
 *     `src/config/settings.ts` 按大小写敏感字面量单独校验（与
 *     `worktreeOnMutate` boolean-only 纪律同款），`"Workspace"` 在 settings.json
 *     里被丢弃 → 回落 global；同一字面走 `/config` 经 trim + 小写却命中。
 *     两面有意分叉，不要按「同一套字面」理解。
 *   - **可变 holder**：`FsModeContext` —— 镜像 `PermissionModeContext` /
 *     `GraphModeContext`：运行期就地翻转，引擎不重建。
 *   - **装配期初值来源**：`resolveFsIsolationMode(settings)` 在
 *     `src/config/settings.ts`（与 `resolveWorktreeOnMutate` /
 *     `resolveWorktreeExclusive` 同款 fail-closed 读取点）。
 *   - **命令语义**：`parseConfigCommand` / `applyFsModeCommand` /
 *     `formatFsModeStatus` 同在本文件（三入口共享，见 `/config` 命令段）。
 *
 * 边界：bash 工厂 opt 形态 = holder 而非静态字符串（`fsMode?: FsModeContext`）——
 * handler per-call `fsMode?.get() ?? "global"` 读一次，与 `liveTaskRoot` 的 D2
 * batch snapshot 纪律同款；前台 fence 与后台 spawn 共用同一份冻结值。
 */

/** fs 隔离档值域（闭集,合法字符串仅两个）。 */
export type FsIsolationMode = "global" | "workspace";

/**
 * fs 隔离档 holder —— `bash` 工厂的 opt 接此值,handler per-call `get()`
 * 读取(同 `liveTaskRoot` 的 D2 batch snapshot 纪律)。`/config` 与 Shift+Tab
 * 在会话寿命内就地翻同一个 holder(经 `applyFsModeCommand`)。
 */
export interface FsModeContext {
  /** 当前快照(冻结;改快照不影响 holder)。 */
  readonly get: () => FsIsolationMode;
  readonly set: (mode: FsIsolationMode) => void;
}

/** holder 初始值 —— 缺省 `global`(默认 FS 姿态)。 */
export const FS_ISOLATION_MODE_DEFAULT: FsIsolationMode = "global";

/**
 * 构造 fs 隔离档 holder。`initial` 缺省 = `global`(V1 baseline 与今日逐字
 * 节一致 —— 所有调用方透传 undefined 时 bwrap argv 与既有形态对齐)。
 *
 * `set` 兜底过 `parseFsModeFlag` —— 闭集之外的输入一律忽略(返回值仍是
 * `global` 或 `workspace`)。即使调用方用 `as any` 强塞非法字面,holder 也不
 * 会把非法状态泄给下游 bwrap(避免 mount 层崩在 bwrap argv 解析)。
 */
export function createFsModeContext(
  initial: FsIsolationMode = FS_ISOLATION_MODE_DEFAULT
): FsModeContext {
  let current: FsIsolationMode =
    parseFsModeFlag(initial) ?? FS_ISOLATION_MODE_DEFAULT;
  return Object.freeze({
    get: () => current,
    set: (mode: FsIsolationMode) => {
      const next = parseFsModeFlag(mode);
      if (next !== undefined) current = next;
      // 非法字面 → 静默忽略,holder 维持当前态。这是 fail-closed:不会把
      // 非法状态传给 bwrap(后者对非法 mode 是 silent fallback 到 global,
      // 但 holder 自己先卡住更可观测)。
    },
  });
}

/**
 * `parseFsModeFlag` —— **命令面**的 fs 档值域守卫:`/config` 的 args 解析
 * (`parseConfigCommand` / `splitConfigArgs` 一侧)与 holder `set` 的兜底网
 * (`createFsModeContext`)。`trim + 大小写不敏感`,合法值仅 `"global" /
 * "workspace"`;非字符串 / 非法字面 → undefined(fail-closed)。
 *
 * 与 settings 段**不共用**同一套字面:`isolation.fsMode` 由
 * `src/config/settings.ts` 的 `isFsIsolationMode` 按大小写敏感字面量单独
 * 校验(有意,与 `worktreeOnMutate` boolean-only 纪律一致)。所以
 * `"Workspace"` 在 settings.json 里非法(丢弃 → 回落 global),而
 * `/config fs Workspace` 合法(trim + 小写 → workspace)。放宽 settings
 * 侧的大小写需要 ADR 裁定,不要顺手对齐。
 *
 * 不加别名(`on` / `off` 等)—— 闭集只有两档;别名会让命令面自身漂移。
 */
export function parseFsModeFlag(raw: unknown): FsIsolationMode | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "global") return "global";
  if (v === "workspace") return "workspace";
  return undefined;
}

// ── `/config` 命令（非 TTY 对等物）──────────────────────────────────────────

/**
 * `/config` 的三态命令（三入口共享）。
 *  - `status`：查询当前档；
 *  - `set`：翻 holder 到指定档；
 *  - `usage`：参数不合法（含多余 args）—— 不静默忽略。
 */
export type ConfigCommand =
  | { readonly kind: "status" }
  | { readonly kind: "set"; readonly mode: FsIsolationMode }
  | { readonly kind: "usage" };

export const FS_MODE_USAGE_TEXT =
  "Usage: /config [status|fs global|fs workspace]";

/**
 * `/config` args 解析（三入口共享）。
 *
 * 规则（镜像 `parseGraphCommand` 的形态，多余 args 不被静默忽略）：
 *  - 空 / `["status"]` → `status`；
 *  - `["fs", "global"|"workspace"]` → `set`（mode 经 `parseFsModeFlag`
 *    trim + 小写；`"  FS  "` / `"  Workspace  "` 亦命中）；
 *  - 其它（`["fs"]` 缺 mode / 非法 mode / 多余 args / 未知首 token）→
 *    `usage`。
 */
export function parseConfigCommand(args: ReadonlyArray<string>): ConfigCommand {
  if (args.length === 0) return { kind: "status" };
  const head = (args[0] ?? "").trim().toLowerCase();
  if (head === "status" && args.length === 1) return { kind: "status" };
  if (head === "fs" && args.length === 2) {
    const mode = parseFsModeFlag(args[1]);
    if (mode !== undefined) return { kind: "set", mode };
  }
  return { kind: "usage" };
}

/** 各档一句差异（三入口同一行；用户要能一眼看出两档差别）。 */
function fsModeDetail(mode: FsIsolationMode): string {
  return mode === "global"
    ? "宿主真路径可读写，拦写靠权限 + hard-wall"
    : "home 可见只读；写 = taskRoot + 会话 tmp";
}

/** 状态回显（三入口同一行）。 */
export function formatFsModeStatus(state: FsIsolationMode): string {
  return `文件系统隔离档: ${state}（${fsModeDetail(state)}）`;
}

/** 执行结果：`ok=false` 表示没改任何状态，`text` 是给用户看的那一行。 */
export interface FsModeCommandResult {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * 在 holder 上执行一条 `/config` 命令，并给出用户可见文案。
 *
 * 三入口都调本函数：chat 走 stdout/stderr、TUI 走 notice、serve 把 `text`
 * 放进响应体交给 web 渲染 —— 载体不同，语义与字面同源。
 *
 * usage 路径的 `text` 恒为 `FS_MODE_USAGE_TEXT`（不拼用户输入 —— 回显非法
 * 输入会诱导注入且与 graph 先例漂移）。
 */
export function applyFsModeCommand(
  ctx: FsModeContext,
  args: ReadonlyArray<string>
): FsModeCommandResult {
  const cmd = parseConfigCommand(args);
  switch (cmd.kind) {
    case "status":
      return { ok: true, text: formatFsModeStatus(ctx.get()) };
    case "set":
      ctx.set(cmd.mode);
      return {
        ok: true,
        text: `已切换: ${cmd.mode}（${fsModeDetail(cmd.mode)}；下一次 bash 调用生效）`,
      };
    case "usage":
      return { ok: false, text: FS_MODE_USAGE_TEXT };
  }
}

/**
 * 自由文本 args 切词（`/config fs workspace` 的 "fs workspace" 段）。serve 的
 * wire 上传的是已切好的数组；TUI / web 从一行原文里取剩余段时用它（镜像
 * `splitGraphArgs`）。
 */
export function splitConfigArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}
