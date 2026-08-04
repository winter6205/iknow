#!/usr/bin/env node
/**
 * CLI entry:
 *   iknow                         → chat (TTY) / usage (pipe)
 *   iknow chat [options]
 *   iknow serve [options]         → HTTP session API + web UI
 *   iknow ask "<query>" [options] → one-shot JSON
 *   iknow "<query>" [options]     → one-shot JSON
 */
import { parseArgs, type ParsedCli } from "./cli/parse-args.js";
import { runChatSession } from "./cli/chat-session.js";
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
} from "./harness/permission/index.js";
import { isIknowError } from "./shared/errors.js";
import { randomUUID } from "node:crypto";

const DEFAULT_TRACE_PATH = "./trace.jsonl";

/**
 * Resolve trace output path: flag > IKNOW_TRACE_OUT env > default.
 * ADR-0003 D3: default is relative to CWD.
 */
function resolveTracePath(flag: string | undefined): string {
  return flag ?? process.env.IKNOW_TRACE_OUT ?? DEFAULT_TRACE_PATH;
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
    built = await buildHarnessEngine(bundle, {
      askUser: createFailClosedAskUser(),
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
  // runHarness returns LoopTrace as `trace`; rename to loopTrace to avoid
  // shadowing the TraceService injected into deps.
  const { result, trace: loopTrace } = await runHarness(parsed.query, {
    ...built.deps,
    trace: traceService,
  });
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

  let built: { deps: LoopEngineDeps };
  try {
    // chat TTY REPL: interactive y/N prompt via stdin/stdout.
    built = await buildHarnessEngine(bundle, {
      askUser: createTtyAskUser(),
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
    return;
  }

  await runChatSession({
    deps: built.deps,
    session: bundle.session,
    jsonMode: parsed.json,
    // #152 T5:thinking 可见面(env flag → chat-session → format-run-human)。
    // env.ts SSOT;默认 off。
    showThinking: bundle.env.chat.showThinking,
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    argv: process.argv.slice(2),
    interactive: isInteractive(),
  });

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

  // ask | oneshot
  await runOneShot(parsed);
}

async function runServe(parsed: ParsedCli): Promise<void> {
  const tracePath = resolveTracePath(parsed.traceOut);
  const { startSessionServe } = await import("./session-api/serve.js");
  try {
    const { listening } = await startSessionServe({
      host: parsed.host,
      port: parsed.port,
      json_mode: parsed.json,
      dataDir: parsed.dataDir,
      traceOut: tracePath,
      hubOptions: { askUser: createServeAskUser().ask },
    });
    writeErr(`iknow serve  http://${listening.host}:${listening.port}/`);
    writeErr("API: /api/v1/health  ·  UI: /  ·  Ctrl+C to stop");
    await new Promise<void>(() => {
      /* keep process alive until signal */
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
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
