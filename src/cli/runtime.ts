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
