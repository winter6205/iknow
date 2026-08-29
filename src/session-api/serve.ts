/**
 * Bootstrap: SessionHub + HTTP listen + static web.
 * 022 T5: SessionStore required (hub needs it); caller_role retired from wire.
 */
import { homedir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { SessionHub, type SessionHubOptions } from "./hub.js";
import { listenSessionServer, type ListeningServer } from "./http.js";
import { SessionStore } from "./store/index.js";
import { loadIknowEnv } from "../config/env.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import { loadIknowSettings } from "../config/settings.js";
import {
  initIknowWorkspaceSafe,
  runHostInitScriptSafe,
} from "../harness/identity/index.js";
import type { ServeAskUserHandle } from "../harness/permission/ask-user.js";
import {
  resolveSessionDefaultWorkspace,
  ensureDefaultWorkspace,
} from "./default-workspace.js";
import {
  parsePermissionMode,
  createPermissionModeContext,
} from "../harness/permission/modes.js";
import {
  createGraphModeContext,
  resolveGraphMode,
} from "../harness/graph/mode.js";

export type ServeOptions = {
  host?: string;
  port?: number;
  json_mode?: boolean;
  /** Session pool root; defaults to ~/.iknow (spec #120 SC 1). */
  dataDir?: string;
  /**
   * ADR-0019 (T2): per-root state anchor — CLI `--workspace-root` flag / env
   * `IKNOW_WORKSPACE_ROOT` 透传到 serve 入口。`resolveServeDataDir` / hub
   * 的 build-engine 消费它;persona seed 不跟 workspaceRoot (issue #584)。
   * host-init 保持 global (D1.2 不位移)。
   */
  workspaceRoot?: string;
  hubOptions?: Omit<SessionHubOptions, "store">;
  /** Trace output file path; forwarded to SessionHub for per-session JSONL trace (T5, #64). */
  traceOut?: string;
  /** Optional serve AskUser handle so the SPA can list + resolve pending
   *  permission requests. When omitted, hubOptions.askUser is used verbatim. */
  askHandle?: ServeAskUserHandle;
};

/**
 * Resolve the session pool root: explicit dataDir wins (absolute-pathed);
 * else workspace-rooted `<workspaceRoot>/.iknow`(ADR-0019 T2, per-root state
 * anchor — D1.4 follow-on for serve data directory);
 * else the shared pool root `~/.iknow`(legacy default, spec #120 SC 1 / SC 2,
 * T2 之前唯一行为)。Pure (no IO) and exported so tests can assert the
 * default without ever writing to the real $HOME.
 */
export function resolveServeDataDir(
  dataDir?: string,
  workspaceRoot?: string
): string {
  if (dataDir) return path.resolve(dataDir);
  if (workspaceRoot) return join(workspaceRoot, ".iknow");
  return join(homedir(), ".iknow");
}

// 共享装配 (cli / serve / tui 三入口共用, SSOT): settings.verify → VerifyConfig。
// serve 保留 re-export 供 tui/run.tsx 复用 (tui → session-api 同向依赖)。
import { resolveVerifyConfig } from "../config/verify-config.js";
export { resolveVerifyConfig };

export async function startSessionServe(
  opts?: ServeOptions
): Promise<{ listening: ListeningServer; hub: SessionHub }> {
  // 显式 workspaceRoot(CLI --workspace-root / env IKNOW_WORKSPACE_ROOT)注入
  // per-root identity + data 锚点;缺省 → dataDir 走 legacy ~/.iknow,
  // identity seed 跳过(unbound — ADR-0023:serve 不把 process.cwd() 当 seed)。
  // review-fix (M1 / H1): 先条件 resolve 一次 —— explicit flag 或 env SSOT
  // 任一在场时走 resolver(CLI flag 非法 → typed WorkspaceRootError
  // fail-fast,打印友好);两者都缺 → undefined,保持 hub unbound
  // (dataDir 默认 ~/.iknow,不 seed 任何 cwd 状态)。
  const envWsRoot = loadIknowEnv().workspaceRoot;
  const workspaceRoot =
    opts?.workspaceRoot !== undefined || envWsRoot !== undefined
      ? resolveWorkspaceRoot({
          explicit: opts?.workspaceRoot,
          cwd: process.cwd(),
          env: { [WORKSPACE_ROOT_ENV_KEY]: envWsRoot },
        })
      : undefined;
  // #196 IKNOW T5 + issue #584: persona seed 永远 `<homedir>/.iknow`。
  // Bound `--workspace-root` must not receive user.md. Failures warn, do
  // not block (build-engine repeats this with the userHome seam).
  await initIknowWorkspaceSafe();
  // W1: serve 入口也执行宿主侧 init 脚本(默认 ~/.iknow/init.sh)。
  // 与 chat/ask 共用 runHostInitScriptSafe;文件不存在则 skip,失败不阻塞。
  // D1.2:host-init 保持 global —— 不 thread workspaceRoot。
  await runHostInitScriptSafe();
  const dataDir = resolveServeDataDir(opts?.dataDir, workspaceRoot);
  // cwd defaults to process.cwd() → the store picks its project namespace.
  const store = new SessionStore(dataDir);

  // W2: serve 从 env IKNOW_PERMISSION_MODE 读初始 mode(可选)。holder 提为
  // 局部变量,hub 与 http 层共用同一实例 —— web Shift+Tab 经
  // POST /api/v1/permission-mode 运行时切换(与 TUI 同 SSOT nextShiftTabMode)。
  const permissionModeCtx = createPermissionModeContext(
    parsePermissionMode(process.env.IKNOW_PERMISSION_MODE) ?? "default"
  );
  // Review High-2 (2026-08-29 / hard req 9):settings 只在启动加载点读一次，
  // 同一对象既驱动 graph / verify 装配，也经 hub opts.settings 钉给后续所有
  // engine 构建 —— rebind 后 worktree 根内 `.iknow/` 缺席（gitignore），隐式
  // loadIknowSettings({cwd: worktreeRoot}) 会静默丢 project settings。
  const startupSettings = loadIknowSettings();
  // D-α V1 / ADR-0030:graph overlay holder —— 初值走 settings(默认关),
  // 运行中由 POST /api/v1/graph-mode(`/graph` 的 serve 对等物)翻。与
  // permissionModeCtx 同款:hub 与 http 层共用同一实例(SC3 三入口同 holder)。
  const graphModeCtx = createGraphModeContext(
    resolveGraphMode({ settings: startupSettings.graph })
  );

  const hub = new SessionHub({
    store,
    defaultJsonMode: opts?.json_mode ?? false,
    traceOut: opts?.traceOut,
    // #128 T8:settings.verify 段 → 闭环配置。command 缺失 (含 verify 段缺失)
    // → { command: "" }, hub 装配 subagentManager 时 runClassifier 接管
    // (spec #128 Objective); 未装配 → verify-loop 透明关闭向后兼容 (SC7)。
    // serve 的 cwd = 进程启动目录 (与 build-engine sandboxRoot fallback 一致,
    // 见 hub.sandboxRoot 注释)。
    verifyConfig: resolveVerifyConfig(startupSettings.verify),
    // Review High-2 (hard req 9):启动装配的 settings 对象钉给 hub —— rebind
    // 后 worktree 根构建的新引擎复用同一对象，不隐式重载 project settings。
    settings: startupSettings,
    // #196 A12（用户 2026-08-08 裁定）：serve 与 chat/tui 同属对话型入口，
    // 激活 BOOTSTRAP（surface="serve" → bootstrapActive=true），共享同一
    // ~/.iknow/state.json bootstrap_seeded 状态机；ask（oneshot 脚本）唯一例外。
    surface: "serve",
    permissionMode: permissionModeCtx,
    graphMode: graphModeCtx,
    ...opts?.hubOptions,
    // review-fix (M1 / H1): serve 入口已解析的 workspaceRoot 透传给 hub →
    // 走 build-engine 时 bash fence 对齐 identity seed / dataDir 锚点。
    ...(workspaceRoot ? { workspaceRoot } : {}),
    // serve-workspace T4 (ADR-0023): recents/trust 名单落 home —— 显式
    // `--workspace-root` / `IKNOW_WORKSPACE_ROOT` 预绑时以 confirmTrust=true
    // 写入 `<homedir>/.iknow/workspaces.json`(规则 3:显式指定 = 显式信任)。
    // 缺席 → hub 保持 T2 语义(无 trust gate、不落 recents),见 hub.ts。
    recentsHome: homedir(),
    // Prefer the full handle when provided so web can resolve asks; fall back
    // to the bare askUser (back-compat for callers that only wire `.ask`).
    ...(opts?.askHandle
      ? { askUser: opts.askHandle.ask, askHandle: opts.askHandle }
      : {}),
  });

  // serve-workspace T4 (ADR-0023): flag/env 解析出 absolute root → 启动即预绑
  // 到 hub(boundRoot = resolved,recents 写入)。用户显式 `--workspace-root` /
  // `IKNOW_WORKSPACE_ROOT` = 显式信任,必须传 confirmTrust:true(未被 recents
  // 收录的新绝对路径才能过信任门)。
  //
  // T9a (serve-workspace-folder-browse): flag/env 缺席时,auto-bind 到
  // `<homedir()>/.iknow/default` —— 进站默认新会话,无需 SPA 选 workspace。
  // 用户偏好(显式 flag/env)仍优先 —— 该分支在前;此处只覆盖 implicit-default
  // 路径。confirmTrust:true 因为 default 是 hard-coded path,等同显式信任。
  if (workspaceRoot !== undefined) {
    await hub.bindWorkspace(workspaceRoot, { confirmTrust: true });
  } else {
    await ensureDefaultWorkspace();
    await hub.bindWorkspace(resolveSessionDefaultWorkspace(), {
      confirmTrust: true,
    });
  }

  const port =
    opts?.port ??
    (process.env.IKNOW_SERVE_PORT
      ? Number(process.env.IKNOW_SERVE_PORT)
      : 8787);
  const host = opts?.host ?? "127.0.0.1";
  // 上下文窗口：走 env SSOT（loadIknowEnv），供 HealthResponse 下发
  // （context-usage-display 计划：百分比分母）。与 hub.ensureDeps 同源。
  const env = loadIknowEnv();

  const listening = await listenSessionServer({
    hub,
    host,
    port: Number.isFinite(port) ? port : 8787,
    contextWindow: env.compress.contextWindow,
    // 模型名（settings.llm.model SSOT）：HealthResponse 下发，web 状态条显示。
    // Review High-2:同一启动装配对象（不重读 settings 文件）。
    model: startupSettings.llm?.model,
    traceWriteFailures: () => hub.getTraceWriteFailures(),
    permissionMode: permissionModeCtx,
    graphMode: graphModeCtx,
    // ADR-0020: serve accepts --trace-out and mounts the READ side too —
    // `/api/v1/traces*` + `/trace` SPA live on this same server/port.
    ...(opts?.traceOut !== undefined
      ? { trace: { traceDir: path.resolve(opts.traceOut) } }
      : {}),
  });

  return { listening, hub };
}
