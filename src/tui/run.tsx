/**
 * src/tui/run.tsx
 *
 * #146 TUI 进程入口（cli.ts runTui 动态 import 的唯一公共面）。
 * 装配链（与 serve 同款 α 直连 + buildHarnessEngine 同款 ACI deps）：
 *   prepareRuntime → buildTuiDeps（real adapter + ACI 6 工具 + askUser 桥接
 *   + postToolUse 事件）→ createTuiBridge（SessionStore + SessionHub）
 *   → ink render <TuiApp/>。
 *
 * trace：traceOut 传入 hub，postMessage 内按 conversation 建
 * JsonlTraceService（ADR-0003 D4 / #146 决策 5=10a，TUI 自动继承）。
 */
import { render } from "ink";
import { prepareRuntime, type RuntimeBundle } from "../cli/runtime.js";
import { resolveServeDataDir } from "../session-api/serve.js";
import { buildTuiDeps } from "./deps.js";
import { createTuiAskUserBridge } from "./ask-user.js";
import { createInflightRegistry, createTuiBridge } from "./hub-bridge.js";
import { TuiApp, createToolEventSink } from "./app.js";
import { attachSession } from "./session-state.js";
import { initIknowWorkspaceSafe } from "../harness/identity/index.js";
import {
  createPermissionModeContext,
  parsePermissionMode,
  type PermissionModeContext,
} from "../harness/permission/index.js";

export interface RunTuiOptions {
  /** `iknow tui <session-id>` resume；缺省 = draft 新会话（Q2=C）。 */
  readonly sessionId?: string;
  /** 会话池根目录（--data-dir）；缺省 ~/.iknow。 */
  readonly dataDir?: string;
  /** JSONL trace 输出路径（cli.ts resolveTracePath 产物）。 */
  readonly traceOut?: string;
}

export async function runTui(opts: RunTuiOptions): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error("iknow tui 需要 TTY（交互界面）；脚本场景用 iknow ask。");
  }
  // #196 IKNOW T5: eager + idempotent 初始化 ~/.iknow/(initIknowWorkspaceSafe
  // 内部 try/catch+warn,失败不阻塞装配 — tui 自有 buildTuiDeps 路径不走
  // build-engine,必须独立 init)。
  await initIknowWorkspaceSafe();
  const bundle: RuntimeBundle = await prepareRuntime();
  const dataDir = resolveServeDataDir(opts.dataDir);
  const cwd = process.cwd();

  const inflight = createInflightRegistry();
  const toolEventSink = createToolEventSink();
  const askBridge = createTuiAskUserBridge();
  // W2 扩展：TUI 也持可变 PermissionModeContext —— Shift+Tab 在 TUI/REPL
  // 就地翻 mode,引擎不重建。初始值走 env IKNOW_PERMISSION_MODE(可选),
  // 缺省 default。chat REPL 同源(cli.ts runChat)。
  const permissionMode: PermissionModeContext = createPermissionModeContext(
    parsePermissionMode(process.env.IKNOW_PERMISSION_MODE) ?? "default"
  );
  const deps = buildTuiDeps(bundle, {
    askUser: askBridge.ask,
    onToolEvent: (event) => toolEventSink.emit(event),
    soleInflightId: () => inflight.soleId(),
    permissionMode,
  });
  const bridge = createTuiBridge({
    dataDir: opts.dataDir,
    deps,
    traceOut: opts.traceOut,
    inflight,
    // T3: 透传上下文窗口容量（仅显示用，不启用压缩——本计划裁决 5）。
    contextWindow: bundle.env.compress.contextWindow,
  });

  let initialSession;
  if (opts.sessionId) {
    const file = await bridge.loadSessionFile(opts.sessionId);
    initialSession = attachSession(file);
  }

  const app = render(
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      initialSession={initialSession}
      cwd={cwd}
      dataDir={dataDir}
      permissionMode={permissionMode}
    />,
    { exitOnCtrlC: false, kittyKeyboard: { mode: "disabled" } } // Ctrl+C 语义自管：打断前台 turn（Q1a）；kittyKeyboard disabled 避免 ink 启动期 kitty probe 的 200ms 窗口吞 stdin data（实测真实 pty 下导致首个 Enter / 滚轮 SGR 事件丢失）
  );
  await app.waitUntilExit();
}
