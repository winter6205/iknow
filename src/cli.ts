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
import { MaxTurnsExceeded } from "./harness/errors.js";
import { maxTurnsEnvelope } from "./cli/max-turns.js";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { buildViolationWiring } from "./harness/sandbox/violation-executor.js";
import { openBrowser } from "./cli/open-browser.js";
import type { TraceServeOptions } from "./traceserver/serve.js";

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

function printCliError(err: unknown): void {
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
    built = await buildHarnessEngine(bundle, {
      askUser: createFailClosedAskUser(),
      surface: "ask",
      memory: { enabled: false },
      permissionMode: createPermissionModeContext(
        (process.env.IKNOW_PERMISSION_MODE as PermissionMode | undefined) ??
          "default"
      ),
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("LLM mode needs")) {
      writeErr(
        JSON.stringify({
          error: "llm_mode_missing_api_key",
          message: err.message,
          apiKeyEnv: bundle.env.llm.apiKeyEnv,
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
    built = await buildHarnessEngine(bundle, {
      askUser: createTtyAskUser(),
      surface: "chat",
      memory: { enabled: true },
      permissionMode,
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
  await runChatSession({
    deps: chatDeps,
    session: bundle.session,
    jsonMode: parsed.json,
    // #152 T5:thinking 可见面(env flag → chat-session → format-run-human)。
    // env.ts SSOT;默认 off。
    showThinking: bundle.env.chat.showThinking,
    // W2: 传给 REPL host,host 的 /permissions 斜杠命令就地翻 mode。
    permissionMode,
    // #356 T7:host drain — chat 入口每轮 runHarness 前把 completed 子代理
    // 结果拼入 priorMessages。ask 入口无 manager(surface 门控),不传。
    subagentManager: built.subagentManager,
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
    const { listening } = await startSessionServe({
      host: parsed.host,
      port: parsed.port,
      json_mode: parsed.json,
      dataDir: parsed.dataDir,
      traceOut: tracePath,
      askHandle,
      hubOptions: {
        askUser: askHandle.ask,
        sessionGrants,
      },
    });
    writeErr(`iknow serve  http://${listening.host}:${listening.port}/`);
    if (parsed.traceOut) {
      writeErr(
        `Trace 写入 ${parsed.traceOut}；检测面板请另起 \`iknow trace --trace-out ${parsed.traceOut}\``
      );
    }
    writeErr("API: /api/v1/health  ·  UI: /  ·  Ctrl+C to stop");
    await new Promise<void>(() => {
      /* keep process alive until signal */
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
  }
}

async function runTrace(parsed: ParsedCli): Promise<void> {
  // T7: trace CLI 默认读 ./trace/ 目录（无需 --trace-out），并把该目录传给
  // startTraceServe（读侧 v2 目录语义）。--trace-out 显式提供时覆盖默认。
  // 注意：这里不复用写侧 resolveTracePath —— env IKNOW_TRACE_OUT 是写侧
  // (serve/chat/ask) 的，不是读侧；trace 只认 flag 或默认目录。
  const traceOut = parsed.traceOut ?? DEFAULT_TRACE_DIR;

  // SC-C 21 fail-fast：检测到旧单文件格式 trace → 提示迁移，不静默当目录读。
  // 两种情形：
  //   1) 显式 --trace-out 指向一个已存在的「文件」（旧单文件或误传单文件）。
  //   2) 用默认 ./trace/ 目录，但 CWD 里还留着未迁移的旧 ./trace.jsonl
  //      （默认目录与旧文件路径不冲突，但用户数据还没迁 → 面板会空，需提示）。
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
      "API: /api/v1/health  ·  /api/v1/sessions  ·  /api/v1/traces  ·  Ctrl+C to stop"
    );
    // SC-C 19: 默认自动打开浏览器；--no-open 关闭（CI/headless）。
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
