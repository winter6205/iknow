#!/usr/bin/env node
/**
 * CLI entry:
 *   iknow                         → chat (TTY) / usage (pipe)
 *   iknow chat [options]
 *   iknow serve [options]         → HTTP session API + web UI
 *   iknow tui [session-id]        → 终端多会话交互界面（#146）
 *   iknow ask "<query>" [options] → one-shot JSON
 *   iknow "<query>" [options]     → one-shot JSON
 */
import { parseArgs, type ParsedCli } from "./cli/parse-args.js";
import { runChatSession } from "./cli/chat-session.js";
// #356 subagent worker headless 重入: 子代理进程 main dispatch 早返回。
import { runSubagentWorker } from "./harness/subagent/worker.js";
import {
  buildHarnessEngine,
  prepareRuntime,
  registerShutdown,
  type RuntimeBundle,
} from "./cli/runtime.js";
import { isInteractive, writeErr } from "./cli/session-io.js";
import { getVersion, printUsage } from "./cli/usage.js";
import { formatRunJson } from "./cli/format.js";
import {
  run as runHarness,
  createJsonlTraceService,
  type LoopEngineDeps,
} from "./harness/index.js";
import {
  createTtyAskUser,
  createFailClosedAskUser,
  createServeAskUser,
  createPermissionModeContext,
} from "./harness/permission/index.js";
import type { PermissionMode } from "./harness/permission/modes.js";
import { isIknowError } from "./shared/errors.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  type WorkspaceRootError,
} from "./config/workspace-root.js";
import { MaxTurnsExceeded } from "./harness/errors.js";
import { maxTurnsEnvelope } from "./cli/max-turns.js";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { resolveSessionTodoDir } from "./harness/aci/tools/todo-write.js";
import { buildViolationWiring } from "./harness/sandbox/violation-executor.js";
import { openBrowser } from "./cli/open-browser.js";
import type { TraceServeOptions } from "./traceserver/serve.js";
import {
  loadIknowSettings,
  analyzePlaceholderSyntax,
} from "./config/settings.js";
// 共享装配 (cli / serve / tui 三入口共用, SSOT): settings.verify → VerifyConfig。
import { resolveVerifyConfig } from "./config/verify-config.js";

/**
 * T7: 写侧与读侧共用的默认 trace 目录 —— 每会话独立文件
 * （`<traceDir>/<convId>.jsonl`）。T2 后写侧语义即目录，默认值必须与读侧
 * 一致；旧单文件 `./trace.jsonl`（LEGACY_TRACE_FILE）只用于迁移 fail-fast 检测。
 */
const DEFAULT_TRACE_DIR = "./trace/";
/**
 * 旧单文件格式（v2 写侧升级前）。若存在 → runTrace fail-fast 提示迁移，
 * 不静默把它当目录读（SC-C 21）。
 */
const LEGACY_TRACE_FILE = "./trace.jsonl";

/**
 * Resolve trace output path: flag > IKNOW_TRACE_OUT env > default directory.
 * ADR-0003 D3: default is relative to CWD. T2 后语义为目录。
 */
function resolveTracePath(flag: string | undefined): string {
  return flag ?? process.env.IKNOW_TRACE_OUT ?? DEFAULT_TRACE_DIR;
}

/**
 * review-fix (M5): WorkspaceRootError type guard —— resolver 抛的是 plain
 * object（`satisfies WorkspaceRootError`,非 Error 实例）,必须按判别联合
 * `kind` 识别,不能用 `instanceof Error ? err.message : String(err)`
 * （后者打 plain object 会成 `[object Object]`,kind/path 全部不可见）。
 */
export function isWorkspaceRootError(err: unknown): err is WorkspaceRootError {
  if (err === null || typeof err !== "object") return false;
  const maybe = err as Record<string, unknown>;
  // kind is the discriminant; each variant then either has `path` (3 of 4)
  // or `varName` (empty_env). Type guard is intentionally narrow on `kind`
  // alone — full payload check belongs to the switch in
  // renderWorkspaceRootError, which is TS-narrowed per branch.
  return (
    typeof maybe.kind === "string" &&
    ["empty_explicit", "empty_env", "non_absolute", "not_found"].includes(
      maybe.kind
    )
  );
}

/** review-fix (M5): 4-kind 文本渲染（discriminated union,顺序与
 *  WorkspaceRootError 定义对齐）。 */
export function renderWorkspaceRootError(err: WorkspaceRootError): string {
  switch (err.kind) {
    case "empty_explicit":
      return `[workspace_root]: empty_explicit`;
    case "empty_env":
      return `[workspace_root]: empty_env ${WORKSPACE_ROOT_ENV_KEY}=<empty>`;
    case "non_absolute":
      return `[workspace_root]: non_absolute path=${err.path}`;
    case "not_found":
      return `[workspace_root]: not_found path=${err.path}`;
  }
}

function printCliError(err: unknown): void {
  if (isWorkspaceRootError(err)) {
    writeErr(
      JSON.stringify({
        error: "workspace_root",
        code: err.kind,
        message: renderWorkspaceRootError(err),
      })
    );
    return;
  }
  if (isIknowError(err)) {
    writeErr(
      JSON.stringify({
        error: err.code.toLowerCase(),
        name: err.name,
        message: err.message,
        details: err.details,
      })
    );
    return;
  }
  if (err instanceof Error) {
    writeErr(
      JSON.stringify({
        error: "error",
        message: err.message,
      })
    );
    return;
  }
  writeErr(
    JSON.stringify({
      error: "error",
      message: String(err),
    })
  );
}

function printChatError(err: unknown): void {
  if (isWorkspaceRootError(err)) {
    writeErr(`错误 ${renderWorkspaceRootError(err)}`);
    return;
  }
  if (isIknowError(err)) {
    writeErr(`错误 [${err.code}]: ${err.message}`);
    return;
  }
  if (err instanceof Error) {
    writeErr(`错误: ${err.message}`);
    return;
  }
  writeErr(`错误: ${String(err)}`);
}

async function runOneShot(parsed: ParsedCli): Promise<void> {
  if (parsed.missingQuery) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const bundle: RuntimeBundle = await prepareRuntime();

  let built: { deps: LoopEngineDeps };
  try {
    // ask oneshot: no interactive user → fail-closed askUser (always deny).
    // #196 A12:ask 跳过 BOOTSTRAP 段(surface="ask" → bootstrapActive=false)。
    // #194 T6 (SC15):ask 显式 memory:{enabled:false} — registry 剥离 memory
    // 工具(8 件) + memory_layer 段不装配;identity 其他 4 段照常(deps.system
    // 仍挂 createIknowSystemResolver)。
    // W2: ask 入口从 env IKNOW_PERMISSION_MODE 读静态 mode;oneshot 不暴露
    // 切换(context 不会被 set,等同于静态)。
    // ADR-0019 (T2):`--workspace-root` flag 透传,ask 也是 per-root 状态消费方。
    built = await buildHarnessEngine(bundle, {
      askUser: createFailClosedAskUser(),
      surface: "ask",
      memory: { enabled: false },
      permissionMode: createPermissionModeContext(
        (process.env.IKNOW_PERMISSION_MODE as PermissionMode | undefined) ??
          "default"
      ),
      // review-fix (M1/M5): 用 `!== undefined` 而非 truthy 守门 —— 空字符串
      // 必须显式传到 buildHarnessEngine 才能触发 resolver 的 empty_explicit。
      // truthy 守门会把 `""` 当作「未设」吞掉,用户从 CLI 看到的就不是
      // typed error 而是 REPL 静默回 cwd fallback —— 与 DELIVERABLE 不符。
      ...(parsed.workspaceRoot !== undefined
        ? { workspaceRoot: parsed.workspaceRoot }
        : {}),
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("LLM mode needs")) {
      // settings-model-extension：ask 错误 envelope 不再承载 env 变量名（apiKeyEnv
      // 字段已退役）；改成 `apiKey` 携带 settings.llm.apiKey 的原始形态（None 或
      // 占位符字符串如 "${ANTHROPIC_AUTH_TOKEN}"），便于上游告诉调用方原因。
      // L5: `apiKey_placeholder` 标记让消费方识别 `apiKey: "${VAR}"` 是占位符非真值
      // （true=占位符 / false=字面 / undefined 时字段省略）。
      const rawApiKey = loadIknowSettings().llm?.apiKey;
      const apiKeyIsPlaceholder =
        rawApiKey !== undefined &&
        analyzePlaceholderSyntax(rawApiKey.trim()).placeholders.length > 0;
      writeErr(
        JSON.stringify({
          error: "llm_mode_missing_api_key",
          message: err.message,
          apiKey: rawApiKey === undefined ? "None" : rawApiKey,
          ...(rawApiKey !== undefined
            ? { apiKey_placeholder: apiKeyIsPlaceholder }
            : {}),
        })
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  // ask path: each invocation gets its own conversation_id (ADR-0003 D4).
  const tracePath = resolveTracePath(parsed.traceOut);
  const conversationId = randomUUID();
  const traceService = createJsonlTraceService({
    filePath: tracePath,
    conversationId,
  });
  // T6: wrap the executor with the violation kill-session hook so the ask
  // entry point surfaces violation escalations on stderr + exits with code 1.
  const { executor } = buildViolationWiring(built.deps.executor);
  // plan T6:--max-turns flag 优先,未设时回退装配层 env 值(undefined = 无限)。
  // SC-W 6/7 (v2 spec):agentVersion 由 CLI 侧注入 getVersion() 值,run 末尾才会
  // 落 session L1 根记录。Loop Engine 不 import cli/usage.ts(C2 决议:注入而非
  // harness 层 import,避免写侧←cli 反向依赖)。
  const askDeps: LoopEngineDeps = {
    ...built.deps,
    executor,
    trace: traceService,
    agentVersion: getVersion(),
    maxTurns: parsed.maxTurns ?? built.deps.maxTurns,
  };
  let stopSummary: string | undefined;
  const onStream = (
    event: import("./harness/index.js").HarnessStreamEvent
  ): void => {
    if (event.type === "stop_summary") stopSummary = event.text;
  };
  // runHarness returns LoopTrace as `trace`; rename to loopTrace to avoid
  // shadowing the TraceService injected into deps.
  let result: import("./harness/index.js").RunResult;
  let loopTrace: import("./harness/index.js").LoopTrace;
  try {
    const out = await runHarness(parsed.query, askDeps, undefined, {
      onStream,
    });
    result = out.result;
    loopTrace = out.trace;
  } catch (err) {
    if (err instanceof MaxTurnsExceeded) {
      // plan T3 + T6 / ADR-0011:maxTurns 超限 → JSON envelope(stderr) +
      // exitCode=1。stopSummary 由上面的 onStream wrapper 捕获(loop-engine 在
      // 重抛前 emit stop_summary;摘要轮不计 maxTurns)。
      writeErr(maxTurnsEnvelope(err, stopSummary));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  process.stdout.write(`${formatRunJson({ result, trace: loopTrace })}\n`);
}

async function runChat(parsed: ParsedCli): Promise<void> {
  let bundle: RuntimeBundle;
  try {
    bundle = await prepareRuntime();
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
    return;
  }

  // review-fix (Fix 1): subagent 生命周期事件落盘（spec SC1 生产装配）——
  // chat 入口当前不写 loop-engine trace（chat-session 内无 createJsonlTraceService，
  // 见 chat-session.ts:289 注释），但 subagent manager 必须有 trace 才能让三类事件
  // (subagent_spawn / subagent_state_change / subagent_stop) 落 JSONL。仅当 traceOut
  // 显式配置（flag 或 env）时构造 subagent JsonlTraceService —— 否则 manager 走
  // build-engine 默认 NoopTraceService，零副作用（byte-stable）。单 hub 实例共享一
  // 个 manager 时所有会话的 subagent 事件聚合到 <traceOut>/subagent.jsonl
  // (conversationId="subagent")；reader 侧按 per-record task_id 过滤（spec SC1
  // v1 选择 — per-session 隔离需 per-session manager，超出本 review-fix 范围，
  // 已在 build-engine.ts:307-320 注释里说明）。
  const tracePath = resolveTracePath(parsed.traceOut);
  const subagentTraceConfigured =
    parsed.traceOut !== undefined || process.env.IKNOW_TRACE_OUT !== undefined;
  const subagentTraceService = subagentTraceConfigured
    ? createJsonlTraceService({
        filePath: tracePath,
        conversationId: "subagent",
      })
    : undefined;

  let built: import("./harness/build-engine.js").BuiltEngine;
  // W2: chat REPL 持一个可变 PermissionModeContext —— /permissions 命令在
  // REPL 里就地翻转它,引擎不重建。初始值走 env IKNOW_PERMISSION_MODE(可
  // 选),缺省 default。
  const permissionMode = createPermissionModeContext(
    (process.env.IKNOW_PERMISSION_MODE as PermissionMode | undefined) ??
      "default"
  );
  try {
    // chat TTY REPL: interactive y/N prompt via stdin/stdout.
    // #196 A12:chat 激活 BOOTSTRAP(surface="chat" → bootstrapActive=true)。
    // #194 T6:chat 显式 memory:{enabled:true} — 10 件工具 + memory_layer 装配。
    // #440 T1-fix:chat 入口注入 todoDir 让 todo_write 在主 loop 在场
    // (per-conversationId resolution 是后续 ticket,见 todo-write.ts resolveSessionTodoDir 注释)。
    // ADR-0019 (T2):`--workspace-root` flag 透传到 per-root identity / memory seam。
    built = await buildHarnessEngine(bundle, {
      askUser: createTtyAskUser(),
      surface: "chat",
      memory: { enabled: true },
      permissionMode,
      todoDir: resolveSessionTodoDir({ surface: "chat" }),
      // review-fix (Fix 1): subagent trace 生产装配 —— 仅显式配置 traceOut/env 时
      // 注入 <traceOut>/subagent.jsonl (conversationId="subagent", 聚合所有会话)。
      ...(subagentTraceService !== undefined
        ? { subagentTrace: subagentTraceService }
        : {}),
      // review-fix (M1/M5): `!== undefined` 守门 — 空字符串透传触 empty_explicit。
      ...(parsed.workspaceRoot !== undefined
        ? { workspaceRoot: parsed.workspaceRoot }
        : {}),
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
    return;
  }

  // plan T6:--max-turns flag 优先,未设时回退装配层 env 值(undefined = 无限)。
  // SC-W 6/7 (v2 spec):chat 路径同样注入 agentVersion,与 ask/serve 一致,
  // 使 chat 会话文件也产出 session 根记录。
  const chatDeps: LoopEngineDeps = {
    ...built.deps,
    agentVersion: getVersion(),
    maxTurns: parsed.maxTurns ?? built.deps.maxTurns,
  };
  // #356 High#4 (SC12/SC3):chat REPL 是长程入口 —— SIGINT/SIGTERM 前必须
  // 触发 built.shutdown(组合句柄:mcpManager first → subagentManager second),
  // 否则父死子继,subagent 子进程不被 SIGTERM 清理(SC11/SC16)。chat-session
  // 自身的二次 SIGINT process.exit(130) 保留(用户强杀语义):首次信号走本钩子
  // dispose,二次直接 exit。
  registerShutdown(built);
  await runChatSession({
    deps: chatDeps,
    session: bundle.session,
    jsonMode: parsed.json,
    // #152 T5:thinking 可见面(env flag → chat-session → format-run-human)。
    // env.ts SSOT;默认 off。
    showThinking: bundle.env.chat.showThinking,
    // W2: 传给 REPL host,host 的 /permissions 斜杠命令就地翻 mode。
    permissionMode,
    // T4: `--resume <id>` 续跑锚点。仅 chat 消费;ask/serve/tui 入口
    // 不传(解析虽 command-agnostic,host 各自决策)。undefined = 新开会话。
    resumeId: parsed.resumeId,
    // #356 T7:host drain — chat 入口每轮 runHarness 前把 completed 子代理
    // 结果拼入 priorMessages。ask 入口无 manager(surface 门控),不传。
    subagentManager: built.subagentManager,
    // #128 T8:settings.verify 段 → 闭环配置。command 缺失 (含 verify 段缺失)
    // → { command: "" }, subagentManager 在场 (chat) 时 runClassifier 接管
    // 分类器判官 (spec #128 Objective); ask 形态无 manager → verify-loop
    // 透明关闭向后兼容 (SC7)。其余字段随行透传。
    verifyConfig: resolveVerifyConfig(loadIknowSettings().verify),
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    argv: process.argv.slice(2),
    interactive: isInteractive(),
  });

  // #356 subagent worker: 子代理进程 headless 重入 —— stdin 信封 → run() →
  // stdout envelope。早于产品形态 dispatch (chat/ask/serve/tui/oneshot)，
  // 该命令只由父代理 child_process.spawn 触发,operator 不直调。
  //
  // 协议层崩溃 → exit 2 (assumption 16 / SC13: JSON parse 失败 / 信封字段
  // 缺失, reason=protocolError at 父代理)。模块级 main().catch 兜所有产品
  // 形态错误 → exit 1, worker 必须自己 exit 2 区分协议错误与产品错误。
  if (parsed.command === "__subagent_worker__") {
    try {
      await runSubagentWorker();
    } catch (err) {
      const msg =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`[subagent-worker] fatal: ${msg}\n`);
      process.exit(2);
    }
    return;
  }

  if (parsed.versionOnly) {
    process.stdout.write(`${getVersion()}\n`);
    return;
  }

  if (parsed.command === "help") {
    printUsage();
    return;
  }

  if (parsed.command === "chat") {
    await runChat(parsed);
    return;
  }

  if (parsed.command === "serve") {
    await runServe(parsed);
    return;
  }

  if (parsed.command === "trace") {
    await runTrace(parsed);
    return;
  }

  if (parsed.command === "tui") {
    await runTui(parsed);
    return;
  }

  // ask | oneshot
  await runOneShot(parsed);
}

async function runTui(parsed: ParsedCli): Promise<void> {
  // 动态 import：与 serve 同款 lazy 路径，chat/ask 不背 opentui 依赖树。
  // #343 T1：OpenTUI 渲染入口；runTui 返回退出码（E1/E2 类型化错误在
  // tui/run.tsx 单一 catch 点收口，这里不再包 try/catch）。
  // 运行时守卫：OpenTUI 0.5.1 仅在 Bun（~/.bun/bin/bun）下可用；Node 无
  // node:ffi（Node 26 才有），tsx+Node 跑 tui 必然 FFI 失败。提前拦截并
  // 指引 npm run dev:tui，避免绕 FFI 报错（#321 实测）。
  if (process.versions.bun === undefined) {
    process.stderr.write(
      `TUI 需用 Bun 运行（OpenTUI 原生 FFI 仅 Bun 支持，Node 22 无 node:ffi）。\n` +
        `请改用：npm run dev:tui\n`
    );
    process.exitCode = 1;
    return;
  }
  const { runTui: startTui } = await import("./tui/run.js");
  const exitCode = await startTui({
    sessionId: parsed.sessionId,
    dataDir: parsed.dataDir,
    // ADR-0019 (T2):`--workspace-root` flag 透传到 TUI 装配层。
    // review-fix (M1/M5): `!== undefined` 守门 — 空字符串透传触 empty_explicit。
    ...(parsed.workspaceRoot !== undefined
      ? { workspaceRoot: parsed.workspaceRoot }
      : {}),
    traceOut: resolveTracePath(parsed.traceOut),
  });
  process.exitCode = exitCode;
}

async function runServe(parsed: ParsedCli): Promise<void> {
  const tracePath = resolveTracePath(parsed.traceOut);
  const { startSessionServe } = await import("./session-api/serve.js");
  const { createSessionGrants } =
    await import("./harness/permission/session-grants.js");
  // Single shared handle — `.ask` is what the harness consumes; the full
  // handle is also passed so the SPA can list + resolve pending requests
  // and the hub can accumulate "always-allow" rules.
  const askHandle = createServeAskUser();
  const sessionGrants = createSessionGrants();
  try {
    const { listening, hub } = await startSessionServe({
      host: parsed.host,
      port: parsed.port,
      json_mode: parsed.json,
      dataDir: parsed.dataDir,
      // ADR-0019 (T2):`--workspace-root` flag 透传到 serve 入口 — init /
      // resolveServeDataDir 消费(详见 session-api/serve.ts)。
      // review-fix (M1/M5): `!== undefined` 守门 — 空字符串透传触 empty_explicit。
      ...(parsed.workspaceRoot !== undefined
        ? { workspaceRoot: parsed.workspaceRoot }
        : {}),
      traceOut: tracePath,
      askHandle,
      hubOptions: {
        askUser: askHandle.ask,
        sessionGrants,
      },
    });
    writeErr(`iknow serve  http://${listening.host}:${listening.port}/`);
    // ADR-0020: 读侧同进程挂载 —— 面板直接在本端口 /trace，无需另起进程。
    writeErr(
      `Trace 面板: http://${listening.host}:${listening.port}/trace` +
        (parsed.traceOut ? `（写目录 ${parsed.traceOut}）` : "")
    );
    writeErr("API: /api/v1/health  ·  UI: /  ·  Ctrl+C to stop");
    // #356 High#4 (SC12/SC3):serve 是长程入口 —— hub.ensureDeps 内
    // buildHarnessEngine 自建 MCP + subagent manager,built.shutdown 缓存在
    // hub 上(SC12 顺序 mcpManager first → subagentManager second)。进程退出前
    // 挂 registerShutdown(hub) → 触发同一组合清理,不留下 stdio 子进程。
    registerShutdown(hub);
    await new Promise<void>(() => {
      /* keep process alive until signal */
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
  }
}

async function runTrace(parsed: ParsedCli): Promise<void> {
  // T7: trace CLI 默认读 ./trace/ 目录（无需 --trace-out）。--trace-out 显式
  // 提供时覆盖默认。注意：这里不复用写侧 resolveTracePath —— env
  // IKNOW_TRACE_OUT 是写侧 (serve/chat/ask) 的，不是读侧。
  const traceOut = parsed.traceOut ?? DEFAULT_TRACE_DIR;

  // SC-C 21 fail-fast（ADR-0020 D2.3：两种模式都先于探测执行——都依赖迁移后
  // 的目录语义）。检测到旧单文件格式 trace → 提示迁移，不静默当目录读。
  const legacyConflict = detectLegacyTrace(
    traceOut,
    parsed.traceOut === undefined
  );
  if (legacyConflict) {
    writeErr(
      `错误: 检测到旧单文件格式的 trace。请先运行迁移脚本：\n` +
        `  npx tsx scripts/trace-migrate.ts\n` +
        `(把 ${LEGACY_TRACE_FILE} 转成 ${DEFAULT_TRACE_DIR}<convId>.jsonl 目录；` +
        `干净迁移完成后脚本会自动删除旧文件)`
    );
    process.exitCode = 1;
    return;
  }

  // ADR-0020 D2.1 默认模式：不起进程，探测 iknow serve health 后指向同进程
  // /trace 面板。探测目标 host/port 来自 --host/--port（缺省 127.0.0.1:8787）。
  if (!parsed.separate) {
    const host = parsed.host;
    const port = parsed.port;
    if (await probeServeHealth(host, port)) {
      const url = `http://${host}:${port}/trace`;
      writeErr(`iknow trace  ${url}`);
      writeErr("Trace 检测面板（与 iknow serve 同进程，ADR-0020）");
      // SC-C 19: 默认自动打开浏览器；--no-open 关闭（CI/headless）。
      if (!parsed.noOpen) {
        openBrowser(url);
      }
      return;
    }
    writeErr(
      `未检测到 iknow serve（http://${host}:${port}/api/v1/health 不可达）`
    );
    writeErr(
      "请先运行 `iknow serve`，或用 `iknow trace --separate` 起独立检测进程"
    );
    process.exitCode = 1;
    return;
  }

  // ADR-0020 D2.2 --separate escape hatch：保留 #183 独立进程模式。
  const { startTraceServe } = await import("./traceserver/serve.js");
  const serveOpts: TraceServeOptions = {
    traceOut,
    host: parsed.host,
    port: parsed.port,
    ...(parsed.maxBytes !== undefined ? { maxBytes: parsed.maxBytes } : {}),
  };
  try {
    const listening = await startTraceServe(serveOpts);
    const url = `http://${listening.host}:${listening.port}/`;
    writeErr(`iknow trace  ${url}`);
    writeErr(`Trace 检测面板：${traceOut}`);
    writeErr(
      "API: /api/v1/health  ·  /api/v1/traces/sessions  ·  /api/v1/traces  ·  Ctrl+C to stop"
    );
    if (!parsed.noOpen) {
      openBrowser(url);
    }
    await new Promise<void>(() => {
      /* keep process alive until signal */
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
  }
}

/**
 * ADR-0020 D2.1: probe `iknow serve` health on host:port. 2s timeout；
 * 任何网络/解析失败都按「未检测到」处理（探测不是错误路径，是分支信号）。
 */
async function probeServeHealth(host: string, port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`http://${host}:${port}/api/v1/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 检测旧单文件 trace（SC-C 21）：
 *   - traceOut 已存在但不是目录（文件）→ 冲突（单文件无法按目录读）。
 *   - 用默认目录且 CWD 下旧 ./trace.jsonl 存在 → 冲突（数据未迁移）。
 * stat 失败（目标不存在）→ 不算冲突，按「目录尚未创建」正常启动。
 */
function detectLegacyTrace(
  traceOut: string,
  usingDefaultDir: boolean
): boolean {
  const resolvedDir = resolve(traceOut);
  if (existsSync(resolvedDir) && !isDirectoryPath(resolvedDir)) {
    return true;
  }
  if (usingDefaultDir && existsSync(resolve(LEGACY_TRACE_FILE))) {
    return true;
  }
  return false;
}

/**
 * 判断路径是否指向「目录」。用 stat isDirectory 区分 ./trace.jsonl（文件）
 * 与 ./trace/（目录）—— 两者共存不冲突（SC-C 21）。stat 失败（目标不存在）
 * 按目录处理：后续 startTraceServe 的 readdir 会自然返回空列表。
 */
function isDirectoryPath(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return true;
  }
}

// Re-export for tests / external tooling
export { parseArgs } from "./cli/parse-args.js";
export type { ParsedCli, CliCommand } from "./cli/parse-args.js";
export { processChatLine, runChatSession } from "./cli/chat-session.js";
export { isInteractive } from "./cli/session-io.js";
export { printUsage, getVersion, usageText } from "./cli/usage.js";
export {
  createTtyAskUser,
  createFailClosedAskUser,
  createNoAskUser,
  createServeAskUser,
} from "./harness/permission/index.js";
export type { AskUser } from "./harness/permission/types.js";

main().catch((err) => {
  printCliError(err);
  process.exit(1);
});
