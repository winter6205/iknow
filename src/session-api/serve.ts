/**
 * Bootstrap: SessionHub + HTTP listen + static web.
 * 022 T5: SessionStore required (hub needs it); caller_role retired from wire.
 */
import { homedir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { SessionHub, type SessionHubOptions } from "./hub.js";
import { liteTitleGeneratorOptions } from "./title-generation.js";
import { listenSessionServer, type ListeningServer } from "./http.js";
import { SessionStore } from "./store/index.js";
import { loadIknowEnv } from "../config/env.js";
import { createEnvLoader, type EnvLoader } from "../config/env-loader.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import {
  loadIknowSettings,
  resolveFsIsolationMode,
  resolveWorktreeExclusive,
} from "../config/settings.js";
import {
  initIknowWorkspaceSafe,
  runHostInitScriptSafe,
} from "../harness/identity/index.js";
import { deriveProjectIdentityRoot } from "../harness/session-roots.js";
import { readProjectDefaultMode } from "../harness/permission/project-settings.js";
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
import { createFsModeContext } from "../harness/sandbox/fs-mode.js";
import { createLiveGraphLedgerHost } from "../harness/graph/ledger.js";

export type ServeOptions = {
  host?: string;
  port?: number;
  json_mode?: boolean;
  /** Session pool root; defaults to ~/.iknow (spec #120 SC 1). */
  dataDir?: string;
  /**
   * ADR-0019: per-root state anchor — CLI `--workspace-root` flag / env
   * `IKNOW_WORKSPACE_ROOT` 透传到 serve 入口。hub / build-engine 消费它;
   * persona seed 不跟 workspaceRoot (issue #584)。host-init 保持 global
   * (D1.2)。会话池根不跟它分片（ADR-0087）。
   */
  workspaceRoot?: string;
  /**
   * SC6 / ADR-0094: 用户层 settings 根（EnvLoader + recents/trust 名单）。
   * 生产缺省 = homedir()（与既有 loadIknowSettings / recentsHome 同源）。
   * 测试可注入 tmp 路径以隔离真实 ~/.iknow。
   */
  home?: string;
  hubOptions?: Omit<SessionHubOptions, "store">;
  /** Trace output file path; forwarded to SessionHub for per-session JSONL trace (T5, #64). */
  traceOut?: string;
  /** Optional serve AskUser handle so the SPA can list + resolve pending
   *  permission requests. When omitted, hubOptions.askUser is used verbatim. */
  askHandle?: ServeAskUserHandle;
};

/**
 * Resolve the session pool root: explicit dataDir wins (absolute-pathed);
 * else `~/.iknow` (ADR-0071 / ADR-0087). Does **not** shard on workspaceRoot
 * — transcripts are not per-checkout state. Pure (no IO).
 */
export function resolveServeDataDir(dataDir?: string): string {
  if (dataDir) return path.resolve(dataDir);
  return join(homedir(), ".iknow");
}

// 共享装配 (cli / serve / tui 三入口共用, SSOT): settings.verify → VerifyConfig。
// serve 保留 re-export 供 tui/run.tsx 复用 (tui → session-api 同向依赖)。
import { resolveVerifyConfig } from "../config/verify-config.js";
export { resolveVerifyConfig };

/**
 * SC6 / ADR-0094：serve 入口 EnvLoader 构造（home 缺省 = homedir()，与
 * loadIknowSettings / recentsHome 同源；测试可经 `opts.home` 注入 tmp 路径）。
 * 抽出为单点，避免 startSessionServe 装配函数承担分支复杂度。
 */
function createServeEnvLoader(opts?: ServeOptions): EnvLoader {
  return createEnvLoader({
    cwd: process.cwd(),
    home: opts?.home ?? homedir(),
  });
}

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
  const dataDir = resolveServeDataDir(opts?.dataDir);
  // T1 (session-folder-consolidation): store namespace keys by
  // projectIdentityRoot, not cwd. mirror build-engine.ts:523 — derive from
  // the same root the engine will independently validate inside
  // resolveSessionRoots so the two stores never disagree.
  const projectIdentityRoot = deriveProjectIdentityRoot({
    cwd: workspaceRoot,
  });
  const store = new SessionStore(dataDir, projectIdentityRoot);

  // T6:稳定 productRoot = 启动 bind root（显式 workspace 或 default workspace）。
  // rebind 后 task worktree 只换 session workspaceRoot，MCP config 仍读本根。
  let productRoot: string;
  if (workspaceRoot !== undefined) {
    productRoot = workspaceRoot;
  } else {
    await ensureDefaultWorkspace();
    productRoot = resolveSessionDefaultWorkspace();
  }

  // Review High-2 (2026-08-29 / hard req 9):settings 只在启动加载点读一次，
  // 同一对象既驱动 graph / verify 装配，也经 hub opts.settings 钉给后续所有
  // engine 构建 —— rebind 后 worktree 根内 `.iknow/` 缺席（gitignore），隐式
  // loadIknowSettings({cwd: worktreeRoot}) 会静默丢 project settings。
  const startupSettings = loadIknowSettings();
  // W2 + T5 (ADR-0090): serve 启动初始 mode 优先级 env IKNOW_PERMISSION_MODE
  // > 项目 permissions.defaultMode > "default"(CLI flag 是 tui 专属)。
  // 项目 settings 读根 = projectIdentityRoot(上述派生,不是 cwd):rebind 后
  // cwd 是没有 `.iknow` 的裸 task worktree。fail-loud(legacy / full_auto)
  // 原路上抛,启动错误路径呈现。holder 提为局部变量,hub 与 http 层共用同一
  // 实例 —— web Shift+Tab 经 POST /api/v1/permission-mode 运行时切换(与 TUI
  // 同 SSOT nextShiftTabMode),holder 在 new SessionHub 之前定义即可。
  const projectDefaultMode = readProjectDefaultMode({
    cwd: projectIdentityRoot,
  });
  const permissionModeCtx = createPermissionModeContext(
    parsePermissionMode(process.env.IKNOW_PERMISSION_MODE) ??
      projectDefaultMode ??
      "default"
  );
  // D-α V1 / ADR-0030:graph overlay holder —— 初值走 settings(默认关),
  // 运行中由 POST /api/v1/graph-mode(`/graph` 的 serve 对等物)翻。与
  // permissionModeCtx 同款:hub 与 http 层共用同一实例(SC3 三入口同 holder)。
  const graphModeCtx = createGraphModeContext(
    resolveGraphMode({ settings: startupSettings.graph })
  );
  // ADR-0092 / SC13:filesystem isolation 档 holder —— 初值走 settings
  // （缺省 global），运行中由 POST /api/v1/fs-mode（`/config` 的 serve
  // 对等物）翻。与 permissionModeCtx 同款:hub 与 http 层共用同一实例
  // （SC3 三入口同 holder）。与 permissionMode / graphMode 正交。
  const fsModeCtx = createFsModeContext(
    resolveFsIsolationMode(startupSettings)
  );
  // T3 / plans/worktree-exclusive-lock.md / ADR-0070: enter-worktree
  // 占用锁档一次性解析。`resolveWorktreeExclusive(settings)` 是单读点
  // （与 `resolveWorktreeOnMutate` 同款形状；缺失 / 非 true 一律 OFF），
  // 此处解析后透传给 hub opts.worktreeExclusive；hub 构造时再喂给
  // createTaskWorktreeProvisioner（闭包冻结，rebind 不重读；ADR-0037 §5
  // 硬要求 9）。OFF 默认 = 严格走今日 enter 路径（SC2 零回归钉死）。
  const worktreeExclusive = resolveWorktreeExclusive(startupSettings);
  // live-graph-phase1 T1 / ADR-0051:活图账本 host —— serve 进程级单例,
  // 按 conversationId 解析会话账本;resetSession / hub.shutdown 销毁。
  const liveGraphLedger = createLiveGraphLedgerHost();

  // SC6 / ADR-0094：runtime LLM env 单源（serve 入口）—— EnvLoader 注入 hub。
  // 与 TUI run.tsx 同形：构造 → envProvider 透传 hub → subscribe 触发
  // hub.reloadFromEnv 热重建（白名单字段 model 变化）。EnvLoader.stop() 在
  // listening.close() 期间同步释放（mirror TUI combinedShutdown）。
  const envLoader: EnvLoader = createServeEnvLoader(opts);

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
    // ADR-0092 / SC13:fs isolation holder —— hub 引擎消费（bash 工厂
    // per-call 读）。
    fsMode: fsModeCtx,
    // T3 / plans/worktree-exclusive-lock.md / ADR-0070: 启动加载点一次性
    // 解析的 boolean —— 透传给 hub → provisioner 闭包冻结。OFF 档 →
    // `worktreeExclusive` 不在 opts（缺省 undefined → 透传给 provisioner
    // 时 `opts.worktreeExclusive === true` 判定为 false → 占用检查完全跳过，
    // 行为与今日逐字节一致，spec SC2）。
    ...(worktreeExclusive ? { worktreeExclusive: true } : {}),
    // live-graph-phase1 T1:账本 host 注入 hub。
    liveGraphLedger,
    // ADR-0113 T4: lite 槽在场才注入标题生成器（缺席 → 键不出现，hub 永不触发）。
    ...liteTitleGeneratorOptions({ envProvider: () => envLoader.get() }),
    ...opts?.hubOptions,
    // review-fix (M1 / H1) + T6:启动 bind root 透传 —— bash fence / identity
    // 与稳定 productRoot（MCP config）同源；rebind 不改 productRoot。
    workspaceRoot: productRoot,
    productRoot,
    // serve-workspace T4 (ADR-0023): recents/trust 名单落 home —— 显式
    // `--workspace-root` / `IKNOW_WORKSPACE_ROOT` 预绑时以 confirmTrust=true
    // 写入 `<homedir>/.iknow/workspaces.json`(规则 3:显式指定 = 显式信任)。
    // 缺席 → hub 保持 T2 语义(无 trust gate、不落 recents),见 hub.ts。
    recentsHome: homedir(),
    // SC6 / ADR-0094:env 源 — 改造前 serve 一次性 loadIknowEnv(); 改造后
    // EnvLoader.get() 透传每次 ensureDeps / reloadFromEnv,改 settings.json
    // 走白名单字段(model / apiKey / headers)→ 下一条 POST /messages 跟新 env。
    envProvider: () => envLoader.get(),
    // Prefer the full handle when provided so web can resolve asks; fall back
    // to the bare askUser (back-compat for callers that only wire `.ask`).
    ...(opts?.askHandle
      ? { askUser: opts.askHandle.ask, askHandle: opts.askHandle }
      : {}),
  });

  // SC6 / ADR-0094:订阅 EnvLoader —— settings 文件变化 → 自动 reload env →
  // 走 hub 的 adapter 热重建通路（不直接碰 build-engine）。reload 抛错
  // (坏 JSON / apiKey 缺失)→ EnvLoader 内部保留旧 env + onError 通知,
  // 这里 .catch 吞掉（与 TUI run.tsx:540-546 同款：reloadFromEnv 抛错
  // 时 cachedDeps 不动,静默保留旧 adapter —— 降级语义对齐)。
  envLoader.subscribe(() => {
    void hub.reloadFromEnv().catch((err) => {
      // reloadFromEnv 抛错（坏 JSON / apiKey 缺失）→ EnvLoader 内部保留旧 env
      // + onError 通知；这里 .catch 吞掉并打 stderr，与 TUI run.tsx:540-546
      // 同款（cachedDeps 不动，静默保留旧 adapter —— 降级语义对齐）。
      // eslint-disable-next-line no-console
      console.error("[serve] reloadFromEnv failed:", err);
    });
  });

  // serve-workspace T4 / T9a:启动即预绑到 productRoot（显式 flag/env 或
  // default workspace）。confirmTrust:true —— 显式指定 / hard-coded default
  // 均等同显式信任。
  await hub.bindWorkspace(productRoot, { confirmTrust: true });

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
    // ADR-0092 / SC13:fs isolation holder 给 http 层（/api/v1/fs-mode 端点）。
    fsMode: fsModeCtx,
    // ADR-0020: serve accepts --trace-out and mounts the READ side too —
    // `/api/v1/traces*` + `/trace` SPA live on this same server/port.
    ...(opts?.traceOut !== undefined
      ? { trace: { traceDir: path.resolve(opts.traceOut) } }
      : {}),
  });

  // SC6 / ADR-0094:EnvLoader.stop() 在 listening.close() 期间同步释放
  // (mirror TUI combinedShutdown) —— 长程 serve 进程退出前释放 fs watcher
  // 句柄。监听 close() 多次调用幂等(EnvLoader.stop() 内部幂等,wrapped close
  // 也只触发一次 EnvLoader.stop())。调用方按原 listening.close() 收口,无需
  // 感知 EnvLoader 存在。
  const originalClose = listening.close.bind(listening);
  const wrappedListening: ListeningServer = {
    ...listening,
    close: async () => {
      envLoader.stop();
      await originalClose();
    },
  };

  return { listening: wrappedListening, hub };
}
