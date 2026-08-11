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
 *  - createPermissionModeContext（env IKNOW_PERMISSION_MODE 初始值） +
 *    createSessionGrants（#279 项3 always 落点）+ 注入 deps 与 TuiApp；
 *  - sessionId resume：`iknow tui <id>` → loadSessionFile → attachSession
 *    → initialSession prop；
 *  - `<TuiApp bridge askBridge toolEventSink cwd dataDir permissionMode
 *    sessionGrants info initialSession onQuit/>`，onQuit 触发 renderer.destroy。
 *
 * 错误路径（specs/321 Error Paths E1/E2）：渲染器构造 / 运行抛错 → 类型化
 * stderr 消息 + 退出码 1。runTui 有且仅有一个 catch 点，全部清理（destroy
 * 渲染器）收口于该点。createRenderer 注入口保留供测试诱导。
 */
import {
  CliRenderEvents,
  createCliRenderer,
  type CliRenderer,
  type CliRendererConfig,
} from "@opentui/core";
import { createRoot } from "@opentui/react";
import { prepareRuntime, type RuntimeBundle } from "../cli/runtime.js";
import { resolveServeDataDir } from "../session-api/serve.js";
import {
  buildTuiDeps,
  type BuildTuiDepsOptions,
  type TuiExtensions,
} from "./deps.js";
import { createTuiAskUserBridge } from "./ask-user.js";
import { createInflightRegistry, createTuiBridge } from "./hub-bridge.js";
import { createToolEventSink, TuiApp } from "./app.js";
import { attachSession } from "./session-state.js";
import { createSessionGrants } from "../harness/permission/session-grants.js";
import { initIknowWorkspaceSafe } from "../harness/identity/index.js";
import {
  createPermissionModeContext,
  parsePermissionMode,
} from "../harness/permission/index.js";

/** E1/E2 类型化错误前缀（specs/321 SC 11：错误消息常量化，禁 magic string）。 */
export const TUI_RENDERER_ERROR_PREFIX = "TUI 渲染后端初始化失败";

export interface RunTuiOptions {
  /** `iknow tui <session-id>` resume；缺省 = 新会话（Q2=C）。 */
  readonly sessionId?: string;
  /** 会话池根目录（--data-dir）；缺省 ~/.iknow。 */
  readonly dataDir?: string;
  /** JSONL trace 输出路径。 */
  readonly traceOut?: string;
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
 * 启动 TUI 渲染循环，返回进程退出码（0 = 正常退出，1 = E1/E2 类型化失败）。
 * cli.ts 将返回值落为 process.exitCode。
 */
export async function runTui(options: RunTuiOptions = {}): Promise<number> {
  const factory = options.createRenderer ?? createCliRenderer;
  let renderer: CliRenderer | undefined;
  let onQuitBridge: { destroy: () => void } | undefined;
  // #337 Phase B:TUI 扩展面透出(skillCatalog / mcp.status / mcp.reload / shutdown),
  // 由 buildTuiDeps 的 onExtensions 回调同步注入。退出路径调用 shutdownExtensions()
  // 关闭 MCP manager(避免 stdio 子进程泄漏);幂等封装保证 onQuit 与 whenDestroyed
  // 兜底路径共享同一 shutdown promise,不会重复关闭产生 spurious warn。
  let tuiExtensions: TuiExtensions | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdownExtensions = (): Promise<void> => {
    if (shutdownPromise === undefined) {
      shutdownPromise = (async () => {
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
      })();
    }
    return shutdownPromise;
  };
  try {
    renderer = await factory(RENDERER_CONFIG);
    // 装配链：runtime → deps → bridge/ask/tool 桥接 → TuiApp
    await initIknowWorkspaceSafe();
    const bundle: RuntimeBundle = await prepareRuntime();
    const dataDir = resolveServeDataDir(options.dataDir);
    const cwd = process.cwd();

    const inflight = createInflightRegistry();
    const toolEventSink = createToolEventSink();
    const askBridge = createTuiAskUserBridge();
    const permissionMode = createPermissionModeContext(
      parsePermissionMode(process.env.IKNOW_PERMISSION_MODE) ?? "default"
    );
    const sessionGrants = createSessionGrants();

    const depsOpts: BuildTuiDepsOptions = {
      askUser: askBridge.ask,
      onToolEvent: (event) => toolEventSink.emit(event),
      soleInflightId: () => inflight.soleId(),
      permissionMode,
      sessionGrants,
      onExtensions: (ext) => {
        tuiExtensions = ext;
      },
    };
    const deps = await buildTuiDeps(bundle, depsOpts);
    const bridge = createTuiBridge({
      dataDir: options.dataDir,
      deps,
      traceOut: options.traceOut,
      inflight,
      contextWindow: bundle.env.compress.contextWindow,
    });

    let initialSession;
    if (options.sessionId) {
      const file = await bridge.loadSessionFile(options.sessionId);
      initialSession = attachSession(file);
    }

    onQuitBridge = {
      destroy: (): void => {
        // #337 Phase B:/quit 二次确认 → 等 in-flight 落盘 → onQuit 触发。
        // shutdown 收口 MCP(关闭 client + 取消 in-flight + SIGTERM stdio),
        // 完成后 destroy 渲染器。fire-and-forget:app 接着自己 destroy(见
        // app.tsx quit() 末尾),不会挂起;whenDestroyed 兜底 await 同一 shutdown。
        void shutdownExtensions().finally(() => {
          if (!renderer!.isDestroyed) renderer!.destroy();
        });
      },
    };

    const root = createRoot(renderer);
    root.render(
      <TuiApp
        bridge={bridge}
        askBridge={askBridge}
        toolEventSink={toolEventSink}
        initialSession={initialSession}
        cwd={cwd}
        dataDir={dataDir}
        permissionMode={permissionMode}
        sessionGrants={sessionGrants}
        onQuit={onQuitBridge.destroy}
      />
    );
    await whenDestroyed(renderer);
    // #337 Phase B:兜底 —— onQuit 未接管的退出路径(信号 / E4 直接 destroy),
    // shutdownExtensions 已启动则 no-op,未启动则确保 MCP 关闭在 runTui 返回
    // 前完成,避免 stdio 子孙泄漏。
    await shutdownExtensions();
    return 0;
  } catch (err) {
    // 唯一 catch 点（E1/E2）：类型化消息写 stderr，destroy 收口于此。
    const cause = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${TUI_RENDERER_ERROR_PREFIX}：${cause}。请重新安装依赖（npm ci）后重试\n`
    );
    if (renderer && !renderer.isDestroyed) {
      renderer.destroy();
    }
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
