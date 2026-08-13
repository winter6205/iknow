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
import { createToolEventSink, TuiApp } from "./app.js";
import { attachSession, type TuiSessionState } from "./session-state.js";
import { createSessionGrants } from "../harness/permission/session-grants.js";
import { initIknowWorkspaceSafe } from "../harness/identity/index.js";
import {
  createPermissionModeContext,
  parsePermissionMode,
} from "../harness/permission/index.js";
import { createEnvLoader, type EnvLoader } from "../config/env-loader.js";
import type { IknowEnv } from "../config/env.js";
import { homedir } from "node:os";

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
  // settings-hot-reload（T4）:EnvLoader 提升到 try 外层 —— 三条退出路径
  // （/quit onQuitBridge / 信号 registerShutdown / catch 错误路径）都必须释放
  // fs watcher 句柄，否则事件循环不空 → 进程 /quit 后挂死（reviewer blocker）。
  // 声明延后到装配成功后赋值；stop() 幂等，未初始化（装配前抛错）时 no-op。
  let envLoader: EnvLoader | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdownExtensions = (): Promise<void> => {
    if (shutdownPromise === undefined) {
      shutdownPromise = (async () => {
        // watcher 先释放（不再有 reload 事件），再关 MCP/subagent。
        envLoader?.stop();
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
    const runtime = await prepareRuntime();
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
    // T2 返回平铺的 LoopEngineDeps & { subagentManager?, shutdown? }(非嵌套
    // { deps, ... }),rest 解构剥离两个句柄后 deps 即 LoopEngineDeps。
    const { subagentManager, shutdown, ...deps } = await buildTuiDeps(
      bundle,
      depsOpts
    );
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
    const combinedShutdown = async (): Promise<void> => {
      envLoader?.stop();
      if (shutdown) await shutdown();
    };
    registerShutdown({ shutdown: combinedShutdown });
    const bridge = createTuiBridge({
      dataDir: options.dataDir,
      deps,
      subagentManager,
      traceOut: options.traceOut,
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
    });
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
          sessionGrants={sessionGrants}
          // #337 Phase C：TuiApp 消费 skillCatalog（slash 候选 + /skill 加载发送）。
          // onExtensions 在 buildTuiDeps 装配期同步注入（Phase B seam）；此处
          // 可选缺省 = 空清单（测试 / 装配异常路径安全降级）。
          skillCatalog={tuiExtensions?.skillCatalog}
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
          onQuit={onQuitBridge!.destroy}
        />
      );
    };
    rerenderApp();
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
