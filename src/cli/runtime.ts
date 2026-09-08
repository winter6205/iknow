/**
 * Runtime bootstrap for CLI: env + harness engine.
 *
 * CLI ask/chat 产品路径,走 harness foundation(real Anthropic adapter +
 * LoopEngine)。ACI 装饰层工具集 8 件（bash / read_file / grep / glob /
 * edit_file / write_file / web_fetch / web_search），与 permission
 * policy byName 键对齐（ADR-0004 / ADR-0006）。
 *
 * 工具装配本身已下沉到 `src/harness/build-engine.ts`（SSOT）：CLI 与 serve
 * 共享同一份 8 件工具集,本模块只做 bundle 装配(env/session)并转发。
 */
import {
  buildHarnessEngine as buildCoreEngine,
  type BuiltEngine,
} from "../harness/build-engine.js";
import {
  initIknowWorkspaceSafe,
  runHostInitScriptSafe,
} from "../harness/identity/index.js";
import type { AskUser } from "../harness/permission/types.js";
import {
  parsePermissionMode,
  createPermissionModeContext,
  type PermissionModeContext,
} from "../harness/permission/modes.js";
import type { GraphModeContext } from "../harness/graph/mode.js";
import { loadIknowEnv, type IknowEnv } from "../config/env.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import type { SessionContext } from "../shared/schema.js";

export type RuntimeBundle = {
  env: IknowEnv;
  session: SessionContext;
};

/**
 * Resolve the initial permission mode for CLI entry points.
 * Priority: explicit > env IKNOW_PERMISSION_MODE > default.
 *
 * The returned context is always mutable (PermissionModeContext exposes
 * `set`); ask/serve callers simply don't call it. Only the chat REPL's
 * `/permissions` slash command actually flips it.
 */
export function resolvePermissionMode(
  explicit: unknown
): PermissionModeContext {
  const parsed =
    parsePermissionMode(explicit) ??
    parsePermissionMode(process.env.IKNOW_PERMISSION_MODE);
  return createPermissionModeContext(parsed ?? "default");
}

export async function prepareRuntime(): Promise<RuntimeBundle> {
  const env = loadIknowEnv();

  const session: SessionContext = {};

  return { env, session };
}

// Re-export BuiltEngine so existing callers (`cli.ts` / `chat-session.ts` /
// tests) keep importing it from this module unchanged.
export type { BuiltEngine } from "../harness/build-engine.js";

/**
 * CLI ask/chat 产品路径的 harness 装配(020 新主路径)。
 *
 * Thin wrapper around `buildHarnessEngine` in `src/harness/build-engine.ts`:
 * pulls `env` from the CLI runtime bundle and forwards. Tool assembly
 * itself (ACI 8 件 + Anthropic adapter + permission middleware) is the
 * harness layer's responsibility so CLI and serve cannot drift.
 *
 * #162 三入口装配 askUser：`askUser: AskUser` 是必传参数；缺则启动 throw
 * `ask_inlet_missing`（在 `buildHarnessEngine` 内部抛）。
 */
/**
 * CLI wrapper 的装配 opts（导出以便宿主 **标注** 自己的 opts 字面量）。
 *
 * 为什么必须标注：宿主写了本接口没声明的字段会被静默丢掉，而未标注的 `const`
 * 不触发 TS 的 excess-property 检查（review round 3 实测：`projectIdentityRoot`
 * 在 `iknow chat` 上整条失效）。
 *
 * 反方向（本接口声明了、转发漏接）编译器管不了，所以转发**不再手写白名单**：
 * 除三个需要变形的字段外，其余按 rest 整体透传，新字段自动跟上
 * （review round 4：手写白名单只关住了一个方向）。
 */
export interface CliBuildEngineOpts {
  askUser: AskUser;
  surface?: "chat" | "tui" | "ask" | "serve";
  /** #194 T6:memory 层开关透传(ask 显式关,chat 显式开;缺席默认 true)。 */
  memory?: { readonly enabled: boolean };
  /** W2: 权限模式上下文。chat REPL 传可变 context(可被 /permissions 翻);
   *  ask/serve 传静态 context(不可变但类型相同)。缺省 → 引擎内 default。 */
  permissionMode?: PermissionModeContext;
  /** D-α T3 / ADR-0030: graph 编排 overlay holder 透传（chat 传可变
   *  context；ask 不传 → run_graph 与编排段都不装配）。 */
  graphMode?: GraphModeContext;
  /** #440 T1-fix + #950 T2:host 注入的 session-scoped todoDir,语义为「会话项目根」
   *  (`resolveProjectSessionDir(baseDir, projectIdentityRoot)`)。todo_write 在主
   *  loop 装配时消费,per-conv 文件路径在调用期由 `resolveConversationTodoPath`
   *  派生(SSOT 在 todo-write.ts)。chat/ask CLI 入口由调用方解析后透传。 */
  todoDir?: string;
  /** ADR-0019 (T2): per-root state anchor — CLI `--workspace-root` flag 透传
   *  到 build-engine(priority chain `[explicit, env, cwd]` 在 build-engine
   *  层执行)。CLI 入口(runChat/runOneShot/runTui/runServe)各自解析后透传。 */
  workspaceRoot?: string;
  /**
   * T6 / worktree-mcp-rebind-lifecycle:稳定主 checkout root。首次装配捕获后
   * 跨 rebind 原样透传；`resolveMcpRoots` 由此派生 `mcpConfigRoot`。wrapper
   * 只透传，不从 `process.cwd()` 重算。
   */
  productRoot?: string;
  /**
   * Review round 2/3 (ADR-0037 §4): 项目身份根 —— 宿主启动时钉一次，跨 rebind
   * 原样透传。wrapper 只透传，不从 `process.cwd()` 重算；判在场用
   * `!== undefined` 而非真值 —— 空串必须透下去触 SSOT 的 fail-closed，
   * 真值判会把它吞掉，装配层继而静默退 `mainCheckoutOf(cwd)`
   * （review round 4 实测）。
   */
  projectIdentityRoot?: string;
  /** Crash diagnostics / worker trace root for subagent lifecycle evidence. */
  subagentDiagnosticsDir?: string;
  /**
   * Review High-1 (2026-08-29 / ADR-0037): worktree isolation host 缝 ——
   * 透传给 build-engine。开关本体由 build-engine 从 `settings` 在启动加载点
   * 读取（硬要求 9）；ON 时 chat 引擎的 mutate 被门禁拦截，provision 负责
   * 建 task worktree + 仅本会话根改绑。缺席 → 不包装（行为与今日一致）。
   */
  worktreeIsolation?: import("../harness/isolation/worktree-gate.js").WorktreeIsolationHostOpts;
  /**
   * Review High-2 (2026-08-29 / 硬要求 9): 启动装配的 settings 对象透传。
   * rebind 后 per-root 重建（chat rebuildDeps 缝）复用同一对象 —— worktree
   * 内 `.iknow/` 缺席（gitignore），绝不隐式重载 project settings。缺席 →
   * build-engine 自行缺省加载。
   */
  settings?: import("../config/settings.js").IknowSettings;
  /**
   * Review High-1: 引擎根覆盖（per-root 重建时传 task worktree 路径）。
   * 缺省 = process.cwd()（与 build-engine 缺省一致）。
   */
  cwd?: string;
}

/**
 * 抹掉值为 `undefined` 的键（`exactOptionalPropertyTypes` 下「键在但值是
 * undefined」与「键不在」类型不同）。只看 `undefined`，不做真值过滤。
 *
 * 返回类型是「每个键可选、且值不含 `undefined`」——不是 `T`：删键后必填字段
 * 可能已不在，cast 回 `T` 是不成立的（review round 5）。
 */
function withoutUndefined<T extends object>(
  value: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export async function buildHarnessEngine(
  bundle: RuntimeBundle,
  opts: CliBuildEngineOpts
): Promise<BuiltEngine> {
  // review-fix (M1 / H1/H2): CLI entry 层条件 resolve workspaceRoot —— 当
  // explicit flag 或 env SSOT 任一存在时,在 entry 集中走 resolver 拿到
  // typed WorkspaceRootError(打印友好);否则透传 undefined 让 build-engine
  // 走 cwd fallback(legacy 默认 `~/.iknow` 行为)。条件解析目的:不无条件
  // 把 cwd 当 workspaceRoot,否则 serve / tui 的 `resolveServeDataDir`
  // 默认从 `~/.iknow` 漂移到 `<cwd>/.iknow`(回归 ——
  // 见 plans/workspace-root-launch.md T5 决策:dataDir default 锚点)。
  const envWsRoot = bundle.env.workspaceRoot;
  const resolvedWorkspaceRoot =
    opts.workspaceRoot !== undefined || envWsRoot !== undefined
      ? resolveWorkspaceRoot({
          explicit: opts.workspaceRoot,
          cwd: process.cwd(),
          env: { [WORKSPACE_ROOT_ENV_KEY]: envWsRoot },
        })
      : undefined;
  // #196 IKNOW T5 + issue #584: seed persona at `<homedir>/.iknow` only.
  // `--workspace-root` / cwd must not receive user.md. Failures warn, do
  // not block (build-engine repeats this with the userHome seam).
  await initIknowWorkspaceSafe();
  // W1: 宿主侧执行用户初始化脚本(默认 ~/.iknow/init.sh,可被
  // IKNOW_HOST_INIT_SCRIPT 覆盖)。spawn 由宿主进程发起,不经过 agent
  // bash 工具 → 无权限确认、无 allowlist 限制。文件不存在则 skip;
  // 失败 warn + 不阻塞装配(降级契约)。先后顺序:先 initIknowWorkspaceSafe
  // (seed 模板),再 runHostInitScriptSafe(用户脚本),用户脚本可读模板。
  await runHostInitScriptSafe();
  // surface 透传到 buildCoreEngine,build-engine 据此判定 BOOTSTRAP 段是否激活;
  // memory 开关透传,#194 T6 双分支在 buildCoreEngine (build-engine.ts) 内;
  // permissionMode (W2) 透传到 policy.mode,chat REPL 持 context 翻 /permissions;
  // workspaceRoot (ADR-0019 T2) 透传到 per-root identity / memoryDir seam;
  // todoDir (#440 T1-fix) 透传到 registry 让 todo_write 在场(surface !== ask 限定)。
  // 只有这三个字段需要 wrapper 变形（env 换源 / surface 兜默认 / workspaceRoot
  // 走 entry 层 resolver），其余一律 rest 整体透传 —— 白名单一手写，接口加了
  // 新字段而转发漏接就是编译全绿的静默丢弃（review round 4）。
  const {
    askUser,
    surface,
    workspaceRoot: _resolvedByEntry,
    ...passthrough
  } = opts;
  return buildCoreEngine({
    // 显式给了 `undefined` 的键必须抹掉:`exactOptionalPropertyTypes` 下
    // `{ cwd: undefined }` 与「没有 cwd」不是一回事。值本身不做真值过滤 ——
    // 空串要透下去触各根的 fail-closed，不能在这里被吞。
    ...withoutUndefined(passthrough),
    // 透传**之后**再写 wrapper 自己负责的字段:rest 里若混进 `env` 等本层
    // 注入的键（本接口没声明，但类型只在字面量上挡得住），也覆盖不掉注入值
    // （review round 5）。
    env: bundle.env,
    askUser,
    surface: surface ?? "chat",
    ...(resolvedWorkspaceRoot !== undefined
      ? { workspaceRoot: resolvedWorkspaceRoot }
      : {}),
  });
}

/**
 * #337 T8 / #356 T6 生命周期钩子 — 把 `shutdown` 句柄挂到进程退出事件上。
 *
 * 长程 CLI 入口（chat REPL / serve / tui）持有 MCP manager 后台连接 +
 * subagent manager 子进程池,进程退出前必须显式关闭 stdio 子进程 + 取消
 * in-flight 调用（SC11 / SC16 / SC12）。T6 起 `BuiltEngine.shutdown` 是
 * 组合句柄（Promise.all([mcpManager?.shutdown(), subagentManager?.shutdown()])） —
 * 顺序 mcpManager first → subagentManager second（两者无共享可变状态,
 * Promise.all 并发;顺序仅语义标注,非严格串行）。本钩子保持调用
 * shutdown 一次即可,不再展开。
 * ask 入口 manager 未创建 → shutdown 缺席 → 本函数直接返回 no-op 句柄,
 * 调用方无需特判。
 *
 * 参数类型故意放宽为结构 `{ readonly shutdown?: () => Promise<void> }` —
 * `BuiltEngine` / `SessionHub` / TUI 入口本地 subagent 句柄都满足;
 * 注册钩子只关心 shutdown 一次调用,deps/engine 形态与本函数无关。
 *
 * 用法:
 *   const built = await buildHarnessEngine(...);
 *   registerShutdown(built);  // chat:hook 一次即可
 *   const { hub } = await startSessionServe(...);
 *   registerShutdown(hub);    // serve:hub 暴露 built.shutdown
 *
 * `dispose()` 用于测试或一次性清理场景主动调用（不影响已经绑定的进程
 * 信号监听器,后者由进程退出触发）。
 */
export function registerShutdown(built: {
  readonly shutdown?: () => Promise<void>;
}): {
  readonly dispose: () => Promise<void>;
} {
  let shuttingDown = false;
  // #365 DRIFT-1 (源自 #356 review-High4):re-kill one-shot —— 首次信号
  // dispose 完成后,重发一次让外部处理器(chat-session 的 onSigint 计数器
  // 等)有机会强退;但无外部处理器(serve / 纯 registerShutdown) 时,
  // unconditional re-kill 会与自身 handler 互踢成 microtask 死循环(vitest
  // process.emit 同步路径掩盖;node/bun 真实信号投递实测挂死)。reKilled
  // 守门:首次信号入口即置位;第二次信号落地后 force-exit,不再 re-kill。
  // re-kill 放到 setImmediate,让 handler 先回到事件循环,降低 Unix 同
  // 信号合并导致二次 SIGINT/SIGTERM 丢失。
  let reKilled = false;
  const dispose = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (built.shutdown) {
      try {
        await built.shutdown();
      } catch (err) {
        console.warn(
          `[runtime] shutdown hook failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    if (reKilled) {
      // 第二次信号直接退出(用户强杀语义),不等待 close 兜底。
      const code = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 128;
      process.exit(code);
      return;
    }
    reKilled = true;
    void dispose().finally(() => {
      setImmediate(() => {
        process.kill(process.pid, sig);
      });
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // once:true — process.beforeExit 每轮触发,我们只在最后一刻跑一次。
  process.once("beforeExit", () => {
    void dispose();
  });
  return Object.freeze({ dispose });
}
