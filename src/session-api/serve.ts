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
  parsePermissionMode,
  createPermissionModeContext,
} from "../harness/permission/modes.js";

export type ServeOptions = {
  host?: string;
  port?: number;
  json_mode?: boolean;
  /** Session pool root; defaults to ~/.iknow (spec #120 SC 1). */
  dataDir?: string;
  /**
   * ADR-0019 (T2): per-root state anchor — CLI `--workspace-root` flag / env
   * `IKNOW_WORKSPACE_ROOT` 透传到 serve 入口。`initIknowWorkspaceSafe` /
   * `resolveServeDataDir` / hub 的 build-engine 都消费它;host-init 保持
   * global (D1.2 不位移)。
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
  // initIknowWorkspaceSafe 走 iknowWorkspaceRoot()(process.cwd(),T2 D1.1)。
  // review-fix (M1 / H1): 先条件 resolve 一次 —— explicit flag 或 env SSOT
  // 任一在场时走 resolver(CLI flag 非法 → typed WorkspaceRootError
  // fail-fast,打印友好);两者都缺 → undefined(保持 dataDir 默认 ~/.iknow
  // 与 initIknowWorkspaceSafe 默认 cwd 行为,不漂移)。
  const envWsRoot = loadIknowEnv().workspaceRoot;
  const workspaceRoot =
    opts?.workspaceRoot !== undefined || envWsRoot !== undefined
      ? resolveWorkspaceRoot({
          explicit: opts?.workspaceRoot,
          cwd: process.cwd(),
          env: { [WORKSPACE_ROOT_ENV_KEY]: envWsRoot },
        })
      : undefined;
  // #196 IKNOW T5 + ADR-0019 (T2): eager + idempotent 初始化 per-root identity
  // workspace(initIknowWorkspaceSafe 内部 try/catch+warn,失败不阻塞装配 —
  // 幂等备份,build-engine 内还有一次)。workspaceRoot 在场 → seed 落
  // `<workspaceRoot>/.iknow`。
  await initIknowWorkspaceSafe(
    workspaceRoot ? { workspace: join(workspaceRoot, ".iknow") } : undefined
  );
  // W1: serve 入口也执行宿主侧 init 脚本(默认 ~/.iknow/init.sh)。
  // 与 chat/ask 共用 runHostInitScriptSafe;文件不存在则 skip,失败不阻塞。
  // D1.2:host-init 保持 global —— 不 thread workspaceRoot。
  await runHostInitScriptSafe();
  const dataDir = resolveServeDataDir(opts?.dataDir, workspaceRoot);
  // cwd defaults to process.cwd() → the store picks its project namespace.
  const store = new SessionStore(dataDir);

  const hub = new SessionHub({
    store,
    defaultJsonMode: opts?.json_mode ?? false,
    traceOut: opts?.traceOut,
    // #128 T8:settings.verify 段 → 闭环配置。command 缺失 (含 verify 段缺失)
    // → { command: "" }, hub 装配 subagentManager 时 runClassifier 接管
    // (spec #128 Objective); 未装配 → verify-loop 透明关闭向后兼容 (SC7)。
    // serve 的 cwd = 进程启动目录 (与 build-engine sandboxRoot fallback 一致,
    // 见 hub.sandboxRoot 注释)。
    verifyConfig: resolveVerifyConfig(loadIknowSettings().verify),
    // #196 A12（用户 2026-08-08 裁定）：serve 与 chat/tui 同属对话型入口，
    // 激活 BOOTSTRAP（surface="serve" → bootstrapActive=true），共享同一
    // ~/.iknow/state.json bootstrap_seeded 状态机；ask（oneshot 脚本）唯一例外。
    surface: "serve",
    // W2: serve 从 env IKNOW_PERMISSION_MODE 读初始 mode(可选);不暴露
    // 运行时切换(context 不被 set,等同于静态)。
    permissionMode: createPermissionModeContext(
      parsePermissionMode(process.env.IKNOW_PERMISSION_MODE) ?? "default"
    ),
    ...opts?.hubOptions,
    // review-fix (M1 / H1): serve 入口已解析的 workspaceRoot 透传给 hub →
    // 走 build-engine 时 bash fence 对齐 identity seed / dataDir 锚点。
    ...(workspaceRoot ? { workspaceRoot } : {}),
    // Prefer the full handle when provided so web can resolve asks; fall back
    // to the bare askUser (back-compat for callers that only wire `.ask`).
    ...(opts?.askHandle
      ? { askUser: opts.askHandle.ask, askHandle: opts.askHandle }
      : {}),
  });

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
    // ADR-0020: serve accepts --trace-out and mounts the READ side too —
    // `/api/v1/traces*` + `/trace` SPA live on this same server/port.
    ...(opts?.traceOut !== undefined
      ? { trace: { traceDir: path.resolve(opts.traceOut) } }
      : {}),
  });

  return { listening, hub };
}
