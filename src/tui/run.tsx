/** @jsxImportSource @opentui/react */
/**
 * src/tui/run.tsx
 *
 * #343 T6-C：OpenTUI 渲染入口扩展（端到端装配）。T1 阶段仅做 root.render
 * + E1/E2 单一 catch；本步完成 product 路径的全量接线：
 *  - prepareRuntime → buildTuiDeps（real adapter + ACI 10 工具 + askUser
 *    桥接 + postToolUse 事件）；
 *  - createInflightRegistry + createTuiBridge（SessionStore + SessionHub
 *    + 单会话归因 soleInflightId + contextWindow 透传）；
 *  - createToolEventSink + createTuiAskUserBridge；
 *  - resolvePermissionMode（`--auto-mode` / IKNOW_PERMISSION_MODE 初始值） +
 *    createSessionGrants（#279 项3 always 落点）+ 注入 deps 与 TuiApp；
 *  - sessionId resume：`iknow tui <id>` → loadSessionFile → attachSession
 *    → initialSession prop；
 *  - `<TuiApp bridge askBridge toolEventSink cwd dataDir permissionMode
 *    sessionGrants info initialSession onQuit/>`，onQuit 触发 renderer.destroy。
 *
 * 错误路径（specs/321 Error Paths E1/E2）：渲染器构造 / 运行抛错 → 类型化
 * stderr 消息 + 退出码 1。runTui 有且仅有一个 catch 点，全部清理（终端
 * teardown + destroy 渲染器）收口于该点。createRenderer 注入口保留供测试诱导。
 * 另有第三条错误路径（catch 之外）：非 TTY fail-fast —— 生产路径（未注入
 * createRenderer）且 stdin/stdout 非交互终端时，装配前直接类型化 stderr +
 * 退出码 1（新版 OpenTUI 非 TTY 可建 renderer，无此守卫会挂死）。
 *
 * T2 顺序不变式（2026-09-14 事故）：渲染器工厂在**装配之后**才调用 —— 装配
 * 链（prepareRuntime / workspaceRoot / permissionMode / buildTuiDeps）会抛
 * typed plain object（provider_api_key_missing / WorkspaceRootError），此前
 * 建渲染器等于先探测终端（OSC 10/11 能力查询 + alternate screen），抛错后
 * 终端残留能力应答。非 TTY fail-fast 仍在任何装配与渲染器之前。
 * 错误体渲染走 cli.ts 同款判别联合（`isLlmProviderConfigError` /
 * `isWorkspaceRootError`），绝不 `String(plain object)` → `[object Object]`。
 *
 * T6 终端收口：catch / /quit / 正常退出三路都经 `teardownTerminal` 闭包调
 * 同一个 `teardownTuiTerminal` —— 关鼠标追踪（raw mode 仍开，OpenTUI
 * #904 类：先恢复 cooked mode 会把在途鼠标报告回显到 shell prompt）→
 * destroy（内部恢复 cooked mode）→ 丢弃 stdin 缓冲的能力应答（OSC 10/11
 * `rgb:` / DECRQM `$y`）→ raw mode 兜底。顺序理由见该函数头注。
 */
import {
  CliRenderEvents,
  createCliRenderer,
  type CliRenderer,
  type CliRendererConfig,
} from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  prepareRuntime,
  registerShutdown,
  type RuntimeBundle,
} from "../cli/runtime.js";
import { resolveServeDataDir } from "../session-api/serve.js";
import {
  buildTuiDeps,
  type BuildTuiDepsOptions,
  type TuiExtensions,
} from "./deps.js";
import { createTuiAskUserBridge } from "./ask-user.js";
import { createInflightRegistry, createTuiBridge } from "./hub-bridge.js";
import { resolveTraceRoot } from "../cli/trace-root.js";
import { createToolEventSink, TuiApp, type TuiAppProps } from "./app.js";
import { attachSession, type TuiSessionState } from "./session-state.js";
import { createSessionGrants } from "../harness/permission/session-grants.js";
import { initIknowWorkspaceSafe } from "../harness/identity/index.js";
import { deriveProjectIdentityRoot } from "../harness/session-roots.js";
import { resolvePermissionMode } from "../cli/runtime.js";
import {
  createGraphModeContext,
  resolveGraphMode,
} from "../harness/graph/mode.js";
import { createLiveGraphLedgerHost } from "../harness/graph/ledger.js";
import {
  loadIknowSettings,
  resolveFsIsolationMode,
  resolveWorktreeExclusive,
} from "../config/settings.js";
import { createFsModeContext } from "../harness/sandbox/fs-mode.js";
import { createTuiWorktreeIsolationHost } from "./worktree-host.js";
import { resolveVerifyConfig } from "../session-api/serve.js";
import { createEnvLoader, type EnvLoader } from "../config/env-loader.js";
import type { IknowEnv } from "../config/env.js";
import {
  formatLlmProviderConfigError,
  isLlmProviderConfigError,
} from "../config/env.js";
import { persistModelFailure } from "./persist-model-failure.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  isWorkspaceRootError,
  renderWorkspaceRootError,
  resolveWorkspaceRoot,
} from "../config/workspace-root.js";
import {
  persistFsModeChanges,
  persistMemoryChanges,
  persistModelChanges,
  persistThinkingChanges,
  resolveThinkingSettingsPath,
} from "../config/persist-settings.js";
import { homedir } from "node:os";
import { shutdownDefaultLspPool } from "../harness/lsp/client.js";

/** E1/E2 类型化错误前缀（specs/321 SC 11：错误消息常量化，禁 magic string）。 */
export const TUI_RENDERER_ERROR_PREFIX = "TUI 渲染后端初始化失败";

export interface RunTuiOptions {
  /** `iknow tui <session-id>` resume；缺省 = 新会话（Q2=C）。 */
  readonly sessionId?: string;
  /** 会话池根目录（--data-dir）；缺省 ~/.iknow（ADR-0087）。 */
  readonly dataDir?: string;
  /**
   * ADR-0019: per-root state anchor — CLI `--workspace-root` flag 透传。
   * 装配期 resolve 一次并透传到 build-engine。Persona seed 走
   * userHome/.iknow,不跟 workspaceRoot。会话池不跟它分片（ADR-0087）。
   */
  readonly workspaceRoot?: string;
  /** JSONL trace 输出路径。缺省(经 resolveTraceRoot)落本入口写侧 dataDir ——
   *  与 hub 写 trace 的会话文件夹同池,读侧工具/面板扫描根不与写侧分叉。 */
  readonly traceOut?: string;
  /**
   * `iknow tui --auto-mode`：显式初始权限模式。优先于 IKNOW_PERMISSION_MODE。
   * 缺省 undefined → 走 env → default。
   */
  readonly permissionMode?: string;
  /** 测试注入口：覆盖渲染器工厂（诱导 E1/E2）；生产缺省 createCliRenderer。 */
  readonly createRenderer?: (config: CliRendererConfig) => Promise<CliRenderer>;
}

/** Ctrl+C 语义自管：打断前台 turn 而非退出（#146 Q1a）。
 *  alternate-screen：scrollback 收口（#321 问题 1）。
 *  不 freeze：OpenTUI 0.5.1 的 CliRenderer 构造器在 Linux 下会写
 *  config.useThread 默认值，冻结对象抛 "not extensible"（实测）。 */
const RENDERER_CONFIG: CliRendererConfig = {
  exitOnCtrlC: false,
  screenMode: "alternate-screen",
};

/**
 * T2 / code-quality.md typed-error catch 契约：启动失败的错误体渲染。
 *
 * LLM provider / workspace-root 是 typed **plain object**（`satisfies` 形态，
 * 非 Error 实例）—— 此前 catch 的 `String(err)` 把它打成 `[object Object]`，
 * kind / providerId / apiKeyEnv 全不可见（2026-09-14 事故的 TUI 侧症状）。
 * 分支顺序对齐 cli.ts `printCliError`：判别联合优先，Error 次之，其余对象
 * 走 JSON（非有损；循环引用退构造器名），**绝不**产出 `[object Object]`。
 */
export function describeTuiStartError(err: unknown): string {
  if (isLlmProviderConfigError(err)) return formatLlmProviderConfigError(err);
  if (isWorkspaceRootError(err)) return renderWorkspaceRootError(err);
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      // 循环引用 / BigInt 无法 JSON 化：退构造器名，仍不产生 [object Object]。
      return `[${err.constructor?.name ?? "object"}]`;
    }
  }
  return String(err);
}

/** 终端收口所需的最小 stdin 面（结构类型：测试注入 fake，生产 = process.stdin）。 */
export interface TuiTerminalStdin {
  readonly isRaw?: boolean;
  read: () => unknown;
  setRawMode?: (mode: boolean) => unknown;
}

/** 丢弃 stdin 里已到达但未消费的字节（能力查询应答）。
 *
 *  `read()` 循环与 OpenTUI `resume()` 的清缓冲同款：渲染器写出的 OSC 10/11
 *  `rgb:` / DECRQM `$y` 应答在退出窗口内到达时，若留在缓冲里，进程退出后
 *  shell 会把它当键盘输入回显到下一个 prompt（2026-09-14 事故的残留形态，
 *  同族还有鼠标追踪的 `M` 报告）。这里主动消费掉；流已 close / 不可读时
 *  read 抛错按无可清理处理。
 *
 *  只消费**已进入用户态缓冲**的字节（同 OpenTUI resume() 的同步 drain），
 *  仍在内核 tty 队列里的字节本函数看不到 —— 见 teardownTuiTerminal 头注。 */
function drainTuiStdin(stdin: TuiTerminalStdin): void {
  for (;;) {
    let chunk: unknown;
    try {
      chunk = stdin.read();
    } catch {
      // EXIT: 流已 close / 不可读 —— 没有可丢弃的缓冲，收口继续。
      return;
    }
    // EXIT: 缓冲已空（null = EOF，undefined = 无更多数据）。
    if (chunk === null || chunk === undefined) return;
    // discard：这些字节是本进程发出查询的应答，不属于任何调用方。
  }
}

/**
 * T6 终端收口唯一实现（catch / `/quit` / 正常退出三路共用）。
 *
 * 顺序即契约，四步各自补 OpenTUI 0.5.1 `renderer.destroy()` **不覆盖**的面：
 *  1. `useMouse = false`（raw mode 仍开时先发鼠标关闭序列）。destroy 内部先
 *     恢复 cooked mode、鼠标关闭序列由原生层在后面才发 —— 中间窗口里在途
 *     鼠标报告会被 shell 回显成 `35;83;40M` 类垃圾（OpenTUI #904 类）。
 *  2. `destroy()`：恢复 cooked mode / 退出 alternate screen / 移除 stdin
 *     监听 / 释放 native 指针。这些交给 OpenTUI，本函数不重复实现。
 *  3. `drainTuiStdin`：丢弃缓冲里的能力应答。放在 destroy **之后** ——
 *     收下 destroy 窗口期到达的字节；此刻 OpenTUI 的 stdin 监听已摘除、
 *     流已 pause，本函数读取不与解析器抢数据。仍在内核 tty 队列、尚未被
 *     用户态读到的字节省略（同步 API 不可见；那条腿靠 T2 顺序不变式
 *     —— 装配失败时根本不发查询，从源头不产生应答）。
 *  4. raw mode 兜底：destroy 抛错 / 未曾跑成（外部已 destroy 但 raw 仍开）时
 *     恢复 cooked。`isRaw === true` 才调，正常路径下是 no-op。
 *
 * 幂等：已 destroy 的 renderer 跳过 1–2，3–4 仍执行 —— `/quit` 上 app.tsx
 * 的 `if (!renderer.isDestroyed)` 守卫与 whenDestroyed 收口路径都会二次进入。
 * 失败一律不上抛：收口异常不能覆盖调用方正在呈现的原始错误。
 */
export function teardownTuiTerminal(
  renderer?: CliRenderer,
  stdin: TuiTerminalStdin = process.stdin
): void {
  // EXIT: 从未创建 renderer（T2 顺序不变式下的装配失败）= 从未探测终端，
  // 无需收口。
  if (renderer === undefined) return;
  if (!renderer.isDestroyed) {
    try {
      renderer.useMouse = false;
    } catch {
      // EXIT: 渲染循环已坏（native 已释放等）—— 本步放弃，但 destroy / drain
      // 仍然必须继续，收口不能半途而废。
    }
    try {
      renderer.destroy();
    } catch {
      // EXIT: destroy 失败不得上抛（覆盖调用方原始错误）；raw mode 由下方兜底。
    }
  }
  drainTuiStdin(stdin);
  if (stdin.isRaw === true && typeof stdin.setRawMode === "function") {
    try {
      stdin.setRawMode(false);
    } catch {
      // EXIT: 流已 close —— 终端随进程退出复位，无进一步动作。
    }
  }
}

/**
 * 启动 TUI 渲染循环，返回进程退出码（0 = 正常退出，1 = E1/E2 类型化失败）。
 * cli.ts 将返回值落为 process.exitCode。
 */
export async function runTui(options: RunTuiOptions = {}): Promise<number> {
  // 非 TTY fail-fast：OpenTUI 新版在非 TTY 下也能成功创建 renderer（不再
  // 抛错），不拦截会一路装配到 whenDestroyed 永久挂死（管道 / 重定向场景
  // 实测挂起）。此处在任何装配与渲染器创建前拦截，无资源需清理，故不进
  // 下方单一 catch。注入 createRenderer 的测试路径（E1/E2）跳过本检查 —
  // 它们诱导的是渲染器错误路径，与 TTY 探测无关。
  if (
    options.createRenderer === undefined &&
    (!process.stdin.isTTY || !process.stdout.isTTY)
  ) {
    process.stderr.write(
      `${TUI_RENDERER_ERROR_PREFIX}：未检测到交互终端（TTY），TUI 需在交互终端中运行（管道/重定向场景请用非交互子命令）\n`
    );
    return 1;
  }
  const factory = options.createRenderer ?? createCliRenderer;
  let renderer: CliRenderer | undefined;
  let onQuitBridge: { destroy: (conversationId?: string) => void } | undefined;
  // /quit 时活跃会话的 conversationId（app.tsx quit() 经 onQuit 传入）。
  // whenDestroyed + shutdownExtensions 收口后（终端已恢复到主屏）打印
  // resume 提示；draft 未建档（undefined）则不打印。
  let quitResumeConversationId: string | undefined;
  // #337 Phase B:TUI 扩展面透出(skillCatalog / mcp.status / mcp.reload / shutdown),
  // 由 buildTuiDeps 的 onExtensions 回调同步注入。退出路径调用 shutdownExtensions()
  // 关闭 MCP manager(避免 stdio 子进程泄漏);幂等封装保证 onQuit 与 whenDestroyed
  // 兜底路径共享同一 shutdown promise,不会重复关闭产生 spurious warn。
  let tuiExtensions: TuiExtensions | undefined;
  // settings-hot-reload（T4）:EnvLoader 提升到 try 外层 —— 三条退出路径
  // （/quit onQuitBridge / 信号 registerShutdown / catch 错误路径）都必须释放
  // fs watcher 句柄，否则事件循环不空 → 进程 /quit 后挂死（reviewer blocker）。
  // 声明延后到装配成功后赋值；stop() 幂等，未初始化（装配前抛错）时 no-op。
  let envLoader: EnvLoader | undefined;
  let shutdownPromise: Promise<void> | undefined;
  // 收敛修复 (2026-08-29 第二轮 review):late-bound hub 引用盒 —— 定义在
  // shutdownExtensions 之前(该闭包在 try 外,拿不到 try 内的 bridgeRef)。
  // /quit 路径经 shutdownExtensions 也必须收口 per-root 重建引擎;信号路径
  // 由 combinedShutdown 兜底(hub.shutdown 幂等,双路径重复调用无害)。
  const hubRef: { current?: { shutdown: () => Promise<void> } } = {};
  const shutdownExtensions = (): Promise<void> => {
    if (shutdownPromise === undefined) {
      shutdownPromise = (async () => {
        // watcher 先释放（不再有 reload 事件），再关 MCP/subagent。
        envLoader?.stop();
        // 进程级 LSP 池终止（/quit 挂死根因收口）：warmup / lsp_* spawn 的
        // language server 子进程 stdio 管道不释放,事件循环排不空。放在任何
        // early-return 之前 —— 装配早期失败（onExtensions 注入前）路径下
        // warmup 子进程也必须收口;幂等 + latch,未 spawn 时为 no-op。引擎
        // shutdown 不负责此项（rebind 中途会调用,不得 latch 共享池）。
        await shutdownDefaultLspPool();
        const ext = tuiExtensions;
        if (!ext) return;
        try {
          await ext.shutdown();
        } catch (err) {
          process.stderr.write(
            `[tui] MCP shutdown failed: ${
              err instanceof Error ? err.message : String(err)
            }\n`
          );
        }
        // 收敛修复:ext.shutdown() 只关初始引擎;tuiExtensions 未注入
        // (装配早期退出)时上一行已 return —— hub.shutdown 兜底收口
        // per-root 重建引擎(hub 持 engineByRoot 全量句柄)。
        try {
          await hubRef.current?.shutdown();
        } catch (err) {
          process.stderr.write(
            `[tui] hub shutdown failed: ${
              err instanceof Error ? err.message : String(err)
            }\n`
          );
        }
      })();
    }
    return shutdownPromise;
  };
  // T6：三条退出路径（catch / /quit onQuitBridge / whenDestroyed 正常收口）
  // 共用唯一终端收口闭包 —— 顺序契约见 teardownTuiTerminal。renderer 未创建
  // （T2 顺序不变式下的装配期抛错）时为 no-op。
  const teardownTerminal = (): void => teardownTuiTerminal(renderer);
  try {
    const runtime = await prepareRuntime();
    // T1: resolve the root before any lazy session create. The resolver's
    // final cwd fallback is an entry-level binding, never a SessionHub
    // create-time cwd backfill.
    const envWsRoot = runtime.env.workspaceRoot;
    const cwd = process.cwd();
    const workspaceRoot = resolveWorkspaceRoot({
      explicit: options.workspaceRoot,
      cwd,
      env: { [WORKSPACE_ROOT_ENV_KEY]: envWsRoot },
    });
    // 装配链：runtime → deps → bridge/ask/tool 桥接 → TuiApp
    // issue #584: persona seed 永远 `<homedir>/.iknow`,不跟 workspaceRoot。
    await initIknowWorkspaceSafe();
    // settings-hot-reload（T4）:EnvLoader 作为 env 源。初次 get() = lazy load
    // 拿初始 env，后续 watcher 触发自动 reload。初始 env 用它（而非 bundle.env）
    // 保证「初始 adapter + envProvider 首次快照」同源一致（生产两值相同）。
    // envLoader 在 try 外层声明（三条退出路径都要 stop）；装配成功后本函数内
    // 一定非空，取局部 const 供后续闭包使用（TS 无法对 `let` 字段窄化）。
    envLoader = createEnvLoader({
      cwd: process.cwd(),
      home: homedir(),
    });
    const activeEnvLoader = envLoader;
    let currentEnv: IknowEnv = activeEnvLoader.get();
    // envVersion 递增 counter：驱动 TuiApp 显示层刷新（[envVersion] useEffect）。
    let envVersion = 0;
    // 渲染函数（env reload 后重渲染用）；在 bridge.onEnvChange 闭包中引用，
    // 定义延后到 initialSession / onQuitBridge 就绪（env 变化只发生在装配完成后）。
    let rerenderApp: () => void = () => {};
    const bundle: RuntimeBundle = { env: currentEnv, session: runtime.session };
    // ADR-0087: 会话池 = 显式 dataDir 否则 ~/.iknow，不跟 workspaceRoot 分片。
    const dataDir = resolveServeDataDir(options.dataDir);
    // trace 读侧扫描根(ACI 三工具 + 面板)缺省 = 本入口写侧 dataDir —— 同一
    // 解析结果,读侧不与写侧分叉(flag > IKNOW_TRACE_OUT env > dataDir)。
    const traceOut = resolveTraceRoot(options.traceOut, dataDir);
    // settings 双向持久化（T4）：/thinking /effort 面板 Esc → 写回 settings.json。
    // ADR-0084 写回落对层：thinking / memory 是**用户层键**（llm / memory 段），
    // 项目文件不再采纳这两段（项目允许名单 = hooks / verify / secrets /
    // permissions），故写回目标恒为 <home>/.iknow/settings.json，与「项目文件
    // 是否存在」解耦（旧 ADR-0019 D1.3 的 project 优先档会把用户层键写进不再被
    // 读取的项目文件）。写回后登记 self-write 哨兵
    // （activeEnvLoader.markSelfWrite）→ 自身 fs.watch 不回环。失败 → 返回
    // { ok:false, reason } 由 app 以 notice 呈现，不 crash TUI（in-memory
    // override 保留）。persistThinkingChanges 内部原子写（tmp + rename），
    // 写回不重建 adapter（哨兵吞 reload，当前 env / adapter 不动）。
    const persistThinking: NonNullable<
      TuiAppProps["onPersistThinking"]
    > = async (patch) => {
      try {
        // home 与 EnvLoader / loadIknowSettings 同源（本入口 line 216 同一
        // homedir()），读侧写侧不落两层。
        const path = resolveThinkingSettingsPath({
          home: homedir(),
        });
        const { bytes } = await persistThinkingChanges(path, patch);
        activeEnvLoader.markSelfWrite(path, bytes);
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const persistMemory: NonNullable<TuiAppProps["onPersistMemory"]> = async (
      patch
    ) => {
      try {
        // 同 persistThinking：memory 亦用户层键 → 恒写 <home>/.iknow/settings.json。
        const path = resolveThinkingSettingsPath({
          home: homedir(),
        });
        const { bytes } = await persistMemoryChanges(path, patch);
        activeEnvLoader.markSelfWrite(path, bytes);
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    };

    const persistFsMode: NonNullable<TuiAppProps["onPersistFsMode"]> = async (
      mode
    ) => {
      try {
        // 同 persistThinking：fsMode 亦用户层键（isolation 段，ADR-0084
        // 允许名单外） → 恒写 <home>/.iknow/settings.json。
        const path = resolveThinkingSettingsPath({
          home: homedir(),
        });
        const { bytes } = await persistFsModeChanges(path, { fsMode: mode });
        activeEnvLoader.markSelfWrite(path, bytes);
      } catch (err) {
        // app.tsx 的 onPersistFsMode 契约是 Promise<void>（失败由调用方
        // 以 notice 呈现）；这里把错误重新抛出，让 app 的 catch 兜底。
        throw err instanceof Error ? err : new Error(String(err));
      }
    };

    // /model 面板 Enter 的持久化（ADR-0093 / spec SC5 + SC10）。与 thinking /
    // memory 的差异：**必须显式刷新 env 并重建 adapter** —— 模型是下一轮
    // 装配参数，写文件本身不会让 adapter 换模型。链路：
    //   1) persistModelChanges 原子写 <home>/.iknow/settings.json；
    //   2) markSelfWrite 登记内容哈希 → 自身写回触发的 watcher 事件被吞
    //      （否则会和下面的显式 reload 抢一次 reload）；
    //   3) activeEnvLoader.reload()：EnvLoader.get() 有缓存，`get()` 拿到的
    //      仍是旧 env —— 显式 reload 才把新 model 读进缓存；
    //   4) bridge.hub.reloadFromEnv()：hub 经 envProvider = () => get() 取这份
    //      新 env 重建 adapter（T4 既有通路），并在成功后触发 onEnvChange →
    //      envVersion++ → TUI 显示层同步（ContextBar / /info 的 Model 行）。
    // 任一步失败 → { ok:false, reason }，由 app 以 notice 呈现，不 crash TUI。
    const persistModel: NonNullable<TuiAppProps["onPersistModel"]> = async (
      patch
    ) => {
      let wrote = false;
      try {
        // 同 persistThinking：model 亦用户层键 → 恒写 <home>/.iknow/settings.json。
        const path = resolveThinkingSettingsPath({
          home: homedir(),
        });
        const { bytes } = await persistModelChanges(path, patch);
        wrote = true;
        activeEnvLoader.markSelfWrite(path, bytes);
        activeEnvLoader.reload();
        await bridge.hub.reloadFromEnv();
        return { ok: true as const };
      } catch (err) {
        // typed **plain object**（provider_api_key_missing）不是 Error：
        // persistModelFailure 先按判别联合识别（code-quality.md typed-error）。
        return persistModelFailure(wrote, err);
      }
    };

    const inflight = createInflightRegistry();
    const toolEventSink = createToolEventSink();
    const askBridge = createTuiAskUserBridge();
    // T5 (ADR-0090):启动 mode 种子优先级 `--auto-mode`(explicit) >
    // IKNOW_PERMISSION_MODE > 项目 permissions.defaultMode > "default"。
    // 项目 settings 读根 = projectIdentityRoot(不是 cwd):rebind 后 cwd 是
    // 没有 `.iknow` 的裸 task worktree。fail-loud(legacy / full_auto)经
    // resolvePermissionMode 原路上抛,由本函数的错误路径呈现。
    const permissionMode = resolvePermissionMode(options.permissionMode, {
      cwd: deriveProjectIdentityRoot({ cwd: workspaceRoot }),
    });
    const sessionGrants = createSessionGrants();
    // D-α V1 / ADR-0030:graph overlay 的会话 holder —— 初值走 settings
    // （默认关），运行中由 Shift+Tab 与 `/graph` 就地翻，引擎不重建。
    // Review High-2 (2026-08-29 / 硬要求 9):settings 只在启动加载点读一次，
    // 同一对象驱动 graph / verify / depsOpts.settings —— rebind 后 per-root
    // 重建的引擎复用它，worktree 内 `.iknow/` 缺席也绝不隐式重载 settings。
    const startupSettings = loadIknowSettings();
    const graphMode = createGraphModeContext(
      resolveGraphMode({ settings: startupSettings.graph })
    );
    // ADR-0092 / SC13:filesystem isolation 档 holder —— 初值走 settings
    // （缺省 global），运行中由 `/config` 就地翻；holder 同时给引擎
    // （buildTuiDeps → BuildEngineOpts.fsMode → bash 工厂 per-call 读）与
    // TuiApp（命令面）。与 permissionMode / graphMode 正交 —— Shift+Tab
    // 不动它。settings 只在启动加载点读一次（review High-2 / 硬要求 9）。
    const fsMode = createFsModeContext(resolveFsIsolationMode(startupSettings));
    // live-graph-phase1 T1 / ADR-0051:活图账本 host —— TUI 单例,跨多会话
    // (web 多面板 / 切换会话)按 conversationId 解析;resetSession /
    // hub.shutdown 销毁。
    const liveGraphLedger = createLiveGraphLedgerHost();

    // The initial TUI engine is built before createTuiBridge, so bind this
    // host seam late to the Hub that owns dirty-root persistence. Mutates
    // cannot reach the seam until the bridge has been created below.
    const bridgeRef: { hub?: ReturnType<typeof createTuiBridge>["hub"] } = {};
    // worktree-host.ts 工厂装配（PR #869 name 透传修复点的 TUI 缝版本；
    // 可单测）。手工解构在 WorktreeProvisionContext 新增字段时会静默丢
    // 字段且编译仍绿——TUI 缝 2026-09-05 trace 实测复现了 CLI 缝同款退化
    // （name=ai-news-archive-2026-09-05 被丢，建出 UUID-only 叶子）。
    // hub 缺席的 fail-closed 属于本文件桥接逻辑（bridgeRef 只有这里知道）。
    const worktreeIsolation = createTuiWorktreeIsolationHost({
      provisionWorktree: (ctx) =>
        bridgeRef.hub?.provisionWorktree(ctx) ??
        Promise.reject(
          new Error("TUI Hub is not ready for worktree provision")
        ),
    });

    const depsOpts: BuildTuiDepsOptions = {
      askUser: askBridge.ask,
      onToolEvent: (event) => toolEventSink.emit(event),
      soleInflightId: () => inflight.soleId(),
      permissionMode,
      graphMode,
      // ADR-0092 / SC13:fs isolation holder 给引擎(build-engine →
      // BuildEngineOpts.fsMode → bash 工厂 per-call 读)。
      fsMode,
      liveGraphLedger,
      sessionGrants,
      // ADR-0019 (T2): workspaceRoot 透传到 build-engine identity /
      // memory / skill seam。
      // T6:启动 workspace 即稳定 productRoot —— rebuild 只换 workspaceRoot。
      ...(workspaceRoot ? { workspaceRoot, productRoot: workspaceRoot } : {}),
      // #950 T2 / session-folder-consolidation:已 resolve 的 dataDir 透传给
      // deps 层,让 todo 会话文件夹根与 bridge 的 SessionStore 落同一个
      // projects/<slug>/(resolveServeDataDir 在上游只算一次)。
      ...(dataDir !== undefined ? { dataDir } : {}),
      // Review High-2 / High-1 (2026-08-29):启动 settings 对象 + isolation
      // host 缝透传（build-engine 据此装配 mutate 门禁）。
      settings: startupSettings,
      worktreeIsolation,
      // 观测性地板:与下方 createTuiBridge 的 traceOut 同一个值 —— hub 写会话
      // 的 turn / tool 记录,deps 层的工厂让子代理三事件落同一个
      // `<traceOut>/<conversationId>.jsonl`。
      traceOut,
      onExtensions: (ext) => {
        tuiExtensions = ext;
      },
    };
    // T2 返回平铺的 LoopEngineDeps & { subagentManager?, shutdown? }(非嵌套
    // { deps, ... }),rest 解构剥离两个句柄后 deps 即 LoopEngineDeps。
    const {
      subagentManager,
      shutdown,
      graphAssembly,
      autoMemory,
      overlayMemoryPrefetch,
      memoryFlags,
      invalidateMemorySystem,
      ...deps
    } = await buildTuiDeps(bundle, depsOpts);
    // #365 T4:挂 MCP + subagent 组合 shutdown 到进程信号(runtime.ts 语义,
    // 与 chat/serve 一致)。T4 起 registerShutdown 参数放宽为结构
    // `{ shutdown?: }`(DRIFT-1),TUI 只透 shutdown 句柄 — deps / engine /
    // subagentManager 形态与钩子无关,不再用 undefined as never 占位。
    // shutdown 缺席(防御,ask 形态不可能) → registerShutdown 内部 no-op。
    // TUI exitOnCtrlC=false 是 renderer 层打断前台 turn,SIGINT 到 Node
    // 进程层 handler 仍响应。
    // settings-hot-reload（T4）:envLoader.stop() 也必须接到 shutdown —— 长程
    // 进程退出前释放 fs watcher 句柄（计划风险清单：避免 serve 类进程泄漏）。
    // 信号路径（registerShutdown）不经过 onQuitBridge，需在此释放 watcher；
    // /quit 路径由 shutdownExtensions 兜底释放（幂等，重复 stop 无害）。
    // Review High-1:late-bound hub 引用 —— combinedShutdown 在 bridge 创建前
    // 注册，重建引擎的 shutdown 收口经 bridgeRef 转发。
    const combinedShutdown = async (): Promise<void> => {
      envLoader?.stop();
      if (shutdown) await shutdown();
      // Review High-1:per-root 重建引擎（rebind 后经 buildEngine 缝新建）
      // 的组合 shutdown 由 hub 收口（初始引擎不在 engineByRoot，不重复关）。
      if (bridgeRef.hub) await bridgeRef.hub.shutdown();
      // 信号路径与 /quit 同根因：LSP 子进程 stdio 管道不释放事件循环排不空。
      await shutdownDefaultLspPool();
    };
    registerShutdown({ shutdown: combinedShutdown });
    const bridge = createTuiBridge({
      // review-fix (M4): 传已 resolve 的 dataDir —— 先前把 raw options.dataDir
      // 交给 bridge,而 TuiApp 已用 resolveServeDataDir 的值,导致 bridge 内部
      // SessionStore 落点与展示层漂移(显式 workspaceRoot 时尤甚)。
      dataDir,
      workspaceRoot,
      // T6:稳定 productRoot = 启动 workspace；bridge 单向透传给 hub。
      ...(workspaceRoot ? { productRoot: workspaceRoot } : {}),
      deps,
      subagentManager,
      // live-graph-phase1 T1:账本 host 注入 bridge —— hub 按 conversationId 解析。
      liveGraphLedger,
      // Review High-1 (2026-08-29):注入 deps 的启动根 + per-root 重建缝。
      // rebind 后会话根离开启动根 → ensureDeps 经此缝以同一 depsOpts（同一
      // 启动 settings + 稳定 productRoot,硬要求 9 / T6）在新根重跑
      // buildTuiDeps,下一回合跑在 worktree 根引擎上。onExtensions 回调同步
      // 覆盖 tuiExtensions —— 展示面跟随活跃引擎。
      engineRoot: workspaceRoot,
      buildEngine: async (root) => {
        // buildTuiDeps 透出平铺 deps（与 initial 构建同型）；hub 的
        // buildEngine 缝要求 { deps, ...句柄 } 形态 —— 在此重新收拢。
        // T6:productRoot 经 depsOpts 保留；只覆盖 cwd / workspaceRoot。
        const {
          subagentManager: sm,
          shutdown: sd,
          graphAssembly: ga,
          autoMemory: am,
          overlayMemoryPrefetch: om,
          ...flatDeps
        } = await buildTuiDeps(bundle, {
          ...depsOpts,
          cwd: root,
          workspaceRoot: root,
        });
        return {
          deps: flatDeps,
          ...(sd ? { shutdown: sd } : {}),
          ...(sm ? { subagentManager: sm } : {}),
          ...(ga ? { graphAssembly: ga } : {}),
          ...(am ? { autoMemory: am } : {}),
          ...(om ? { overlayMemoryPrefetch: om } : {}),
        };
      },
      // auto-memory T4:钩子由 build-engine 按 settings.memory.autoExtract
      // 装配；缺席（默认 OFF）→ hub 不调，行为逐字节不变。
      autoMemory,
      overlayMemoryPrefetch,
      traceOut,
      // #128 T8: settings.verify 段 → 闭环配置 (经 hub-bridge 透传 SessionHub)。
      // command 缺失 (含 verify 段缺失) → { command: "" }, hub 装配
      // subagentManager 时 runClassifier 接管 (spec #128 Objective)。与 serve
      // 共用 resolveVerifyConfig 装配。
      // Review High-2:同一启动装配 settings 对象（不重读 settings 文件）。
      verifyConfig: resolveVerifyConfig(startupSettings.verify),
      // D-α T5:graph 装配快照交给 hub —— 每条 postMessage 拍一次
      // （`/graph on` 之后的**下一条**消息才装 run_graph）。
      ...(graphAssembly ? { graphAssembly } : {}),
      inflight,
      contextWindow: currentEnv.compress.contextWindow,
      // T2: 把启动期校验过的 env 透到 hub 的 override 路径 —— override 重建
      // adapter 时用这份 env，不回退 process.env（reviewer blocker fix）。
      overrideEnv: { llm: currentEnv.llm },
      // settings-hot-reload（T3/T4）:env 源透传给 hub —— ensureDeps /
      // reloadFromEnv 用 activeEnvLoader.get() 拿最新 env（T2 EnvLoader.get 天然实现）。
      envProvider: () => activeEnvLoader.get(),
      // env 变化（reloadFromEnv 成功后）→ 驱动 TUI 显示层刷新 + envVersion 递增。
      onEnvChange: (env) => {
        currentEnv = env;
        envVersion++;
        rerenderApp();
      },
      // T3 / plans/worktree-exclusive-lock.md / ADR-0070: enter 占用锁档
      // 一次性透传 —— 启动加载点解析后冻结（ADR-0037 §5 硬要求 9），
      // bridge → hub → provisioner 闭包贯穿。OFF（缺席 / 非 true）→
      // 完全跳过占用检查（SC2 零回归）。
      worktreeExclusive: resolveWorktreeExclusive(startupSettings),
      // ADR-0092 / SC13:同一 fs holder 透传给 bridge → hub —— TUI 的 verify
      // 命令面与 bash 工具面同档（verify 调用点 per-call 现读 holder，`/config`
      // 翻档下一次调用生效，与 bash 侧同一实例）。serve 已按同款接线。
      fsMode,
    });
    // Review High-1:bridge 就绪后回填 late-bound hub 引用（见上方 bridgeRef）。
    bridgeRef.hub = bridge.hub;
    // 收敛修复 (2026-08-29):同一回填点供 shutdownExtensions（/quit 路径）读。
    hubRef.current = bridge.hub;
    // settings-hot-reload（T4）:订阅 EnvLoader —— settings 文件变化 → 自动
    // reload env（成功）→ 走 hub 的 adapter 热重建通路（不直接碰 build-engine）。
    // reload 失败（坏 JSON 等）→ EnvLoader 内部保留旧 env + onError 通知，
    // 这里不上报（默认已写 stderr）；adapter 保持旧引用。
    activeEnvLoader.subscribe(() => {
      void bridge.hub.reloadFromEnv().catch(() => {
        // reloadFromEnv 抛错（envProvider 已成功 reload，此处几乎不会到；
        // apiKey 缺失降级时 .catch 吞掉 → cachedDeps 不动，静默保留旧 adapter）。
      });
    });

    let initialSession: TuiSessionState | undefined;
    if (options.sessionId) {
      const file = await bridge.loadSessionFile(options.sessionId);
      initialSession = attachSession(file);
    }

    onQuitBridge = {
      destroy: (conversationId?: string): void => {
        // #337 Phase B:/quit 二次确认 → 等 in-flight 落盘 → onQuit 触发。
        // shutdown 收口 MCP(关闭 client + 取消 in-flight + SIGTERM stdio),
        // 完成后 destroy 渲染器。fire-and-forget:app 接着自己 destroy(见
        // app.tsx quit() 末尾),不会挂起;whenDestroyed 兜底 await 同一 shutdown。
        quitResumeConversationId = conversationId;
        // T6：唯一收口必须在 app.tsx quit() 同 tick 的 renderer.destroy()
        // **之前**跑完「关鼠标 + drain」（顺序契约见 teardownTuiTerminal）；
        // 本函数自己 destroy 后，app.tsx 的 `if (!renderer.isDestroyed)` 守卫
        // 自然跳过（幂等，不重复释放 native）。
        teardownTerminal();
        void shutdownExtensions();
      },
    };

    // T2 顺序不变式：渲染器工厂在**装配链之后**才调用 —— 上面 prepareRuntime
    // / resolveWorkspaceRoot / resolvePermissionMode / buildTuiDeps 会抛 typed
    // plain object（provider_api_key_missing 等）；此前建渲染器等于先探测终端
    // （OSC 10/11 能力查询 + alternate screen），抛错后终端残留能力应答。
    renderer = await factory(RENDERER_CONFIG);

    const root = createRoot(renderer);
    // settings-hot-reload（T4）:envVersion 变化时重渲染 —— currentEnv / envVersion
    // 每次 env reload 后更新，React reconciliation 仅更新 model / defaultThinking /
    // envVersion 三个 prop，组件内部状态（thinkingEnabled 等）由 app.tsx 的
    // [envVersion] useEffect 跟随新基线刷新（不清用户会话状态）。
    rerenderApp = (): void => {
      root.render(
        <TuiApp
          bridge={bridge}
          askBridge={askBridge}
          toolEventSink={toolEventSink}
          initialSession={initialSession}
          cwd={cwd}
          dataDir={dataDir}
          permissionMode={permissionMode}
          graphMode={graphMode}
          // ADR-0092 / SC13:fs isolation holder + 落盘回调给命令面
          //（引擎那侧的 holder 经 depsOpts.fsMode 走）。
          fsMode={fsMode}
          onPersistFsMode={persistFsMode}
          sessionGrants={sessionGrants}
          // #337 Phase C：TuiApp 消费 skillCatalog（slash 候选 + /skill 加载发送）。
          // onExtensions 在 buildTuiDeps 装配期同步注入（Phase B seam）；此处
          // 可选缺省 = 空清单（测试 / 装配异常路径安全降级）。
          skillCatalog={tuiExtensions?.skillCatalog}
          // specs/skill-load-write-root.md：slash 装配 skill 正文时读活
          // taskRoot 快照（TuiExtensions 透传；缺省 = undefined → 无 trailer）。
          liveTaskRoot={tuiExtensions?.liveTaskRoot}
          // T6 (write-situation-disclosure)：slash 装配双参形态需要
          // `isolationOn` 与 liveTaskRoot 配对算 writeSituation。缺省 →
          // undefined → app.tsx 内 fail-closed 走等价于旧形态的
          // writable_main，与改造前 byte-equal。
          isolationOn={tuiExtensions?.isolationOn}
          // #361 Phase D：TuiApp 消费 MCP 看板扩展面（status / reload /
          // listMcpTools），缺省 = undefined → /mcp 提示「MCP 未装配」。
          mcp={
            tuiExtensions
              ? {
                  status: tuiExtensions.mcp.status,
                  reload: tuiExtensions.mcp.reload,
                  listMcpTools: tuiExtensions.listMcpTools,
                }
              : undefined
          }
          // thinking 初始基线 = env（adapter 已走 buildThinkingParams，这里只给
          // app 知道初始状态；用户 /thinking /effort 改动后经 bridge.postMessage
          // 的 thinking override 透传）。settings-hot-reload 后随 currentEnv 更新。
          defaultThinking={{
            mode: currentEnv.llm.thinking,
            effort: currentEnv.llm.thinkingEffort,
          }}
          // 当前模型名 → ContextBar 前置展示（env.llm.model SSOT）。
          model={currentEnv.llm.model}
          // envVersion 递增 counter：app.tsx [envVersion] useEffect 驱动显示层刷新
          // （ContextBar model / thinking 基线跟随热更新）。
          envVersion={envVersion}
          // settings 双向持久化（T4）：面板 Esc → persistThinking 闭包写回
          // settings.json（失败以 notice 呈现，不 crash TUI）。
          onPersistThinking={persistThinking}
          onPersistMemory={persistMemory}
          // /model 面板（ADR-0093 / spec SC8）：providers 取**同一启动 settings
          // 对象**（不重读 settings 文件，与 graph / verify 同纪律）；注册表
          // 为空 → app 层 /model 走 notice 不打开面板。
          providers={startupSettings.llm?.providers ?? []}
          onPersistModel={persistModel}
          defaultMemory={loadIknowSettings().memory}
          memoryFlags={memoryFlags}
          invalidateMemorySystem={invalidateMemorySystem}
          onQuit={onQuitBridge!.destroy}
        />
      );
    };
    rerenderApp();
    await whenDestroyed(renderer);
    // T6：正常退出（信号收口 / E4 直接 destroy 后本 await 返回）也在返回前
    // 补收口 —— app.tsx /quit 已提前 destroy（renderer 不再重复 destroy），
    // 此处只补 drain + raw mode 兜底。
    teardownTerminal();
    // #337 Phase B:兜底 —— onQuit 未接管的退出路径(信号 / E4 直接 destroy),
    // shutdownExtensions 已启动则 no-op,未启动则确保 MCP 关闭在 runTui 返回
    // 前完成,避免 stdio 子孙泄漏。
    await shutdownExtensions();
    // /quit 建档会话 → 终端恢复后打印 resume 提示（draft 无 id 不打印）。
    if (quitResumeConversationId) {
      process.stdout.write(
        `Resume this session with:\niknow --resume ${quitResumeConversationId}\n`
      );
    }
    return 0;
  } catch (err) {
    // 唯一 catch 点（E1/E2）：类型化消息写 stderr，终端收口于此。
    // describeTuiStartError：判别联合优先（provider / workspace-root 是
    // plain object，`String(err)` 会打成 [object Object]，见 code-quality.md）。
    const cause = describeTuiStartError(err);
    process.stderr.write(
      `${TUI_RENDERER_ERROR_PREFIX}：${cause}。请重新安装依赖（npm ci）后重试\n`
    );
    teardownTerminal();
    // #337 Phase B:错误路径也尽力收口 MCP(若 buildTuiDeps 完成后才抛错,
    // tuiExtensions 已注入;若 buildTuiDeps 自身抛错则 no-op)。不阻塞退出码。
    await shutdownExtensions();
    void onQuitBridge;
    return 1;
  }
}

/** 渲染器 destroy 事件 = TUI 生命周期终点（/quit / 信号 / E4）。 */
function whenDestroyed(renderer: CliRenderer): Promise<void> {
  if (renderer.isDestroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => resolve());
  });
}
