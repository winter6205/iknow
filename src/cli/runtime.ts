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
import { loadIknowEnv, type IknowEnv } from "../config/env.js";
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
export async function buildHarnessEngine(
  bundle: RuntimeBundle,
  opts: {
    askUser: AskUser;
    surface?: "chat" | "tui" | "ask" | "serve";
    /** #194 T6:memory 层开关透传(ask 显式关,chat 显式开;缺席默认 true)。 */
    memory?: { readonly enabled: boolean };
    /** W2: 权限模式上下文。chat REPL 传可变 context(可被 /permissions 翻);
     *  ask/serve 传静态 context(不可变但类型相同)。缺省 → 引擎内 default。 */
    permissionMode?: PermissionModeContext;
  }
): Promise<BuiltEngine> {
  // #196 IKNOW T5: eager + idempotent 初始化 ~/.iknow/(initIknowWorkspaceSafe
  // 内部 try/catch+warn,失败不阻塞装配 — 幂等备份,build-engine 内还有一次)。
  await initIknowWorkspaceSafe();
  // W1: 宿主侧执行用户初始化脚本(默认 ~/.iknow/init.sh,可被
  // IKNOW_HOST_INIT_SCRIPT 覆盖)。spawn 由宿主进程发起,不经过 agent
  // bash 工具 → 无权限确认、无 allowlist 限制。文件不存在则 skip;
  // 失败 warn + 不阻塞装配(降级契约)。先后顺序:先 initIknowWorkspaceSafe
  // (seed 模板),再 runHostInitScriptSafe(用户脚本),用户脚本可读模板。
  await runHostInitScriptSafe();
  // surface 透传到 buildCoreEngine,build-engine 据此判定 BOOTSTRAP 段是否激活;
  // memory 开关透传,#194 T6 双分支在 buildCoreEngine (build-engine.ts) 内;
  // permissionMode (W2) 透传到 policy.mode,chat REPL 持 context 翻 /permissions。
  return buildCoreEngine({
    env: bundle.env,
    askUser: opts.askUser,
    surface: opts.surface ?? "chat",
    ...(opts.memory ? { memory: opts.memory } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
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
  // 守门:第二次信号落地后 force-exit,不再 re-kill,统一"二次强杀语义"。
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
    void dispose().finally(() => {
      if (reKilled) {
        // 第二次信号直接退出(用户强杀语义),不等待 close 兜底。
        const code = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 128;
        process.exit(code);
      }
      reKilled = true;
      process.kill(process.pid, sig);
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
