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
import { run as runHarness, type LoopEngineDeps } from "./harness/index.js";
import { isIknowError } from "./shared/errors.js";

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

  let bundle: RuntimeBundle;
  try {
    bundle = await prepareRuntime({
      role: parsed.role,
      degrade: parsed.degrade,
      embeddings: parsed.embeddings,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("embeddings requested")) {
      writeErr(
        JSON.stringify({
          error: "embeddings_missing_api_key",
          message: err.message,
        })
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  let built: { deps: LoopEngineDeps };
  try {
    built = await buildHarnessEngine(bundle);
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
  const { result, trace } = await runHarness(parsed.query, built.deps);
  process.stdout.write(`${formatRunJson(result, trace)}\n`);
}

async function runChat(parsed: ParsedCli): Promise<void> {
  let bundle: RuntimeBundle;
  try {
    bundle = await prepareRuntime({
      role: parsed.role,
      degrade: parsed.degrade,
      embeddings: parsed.embeddings,
    });
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
    return;
  }

  let built: { deps: LoopEngineDeps };
  try {
    built = await buildHarnessEngine(bundle);
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
    return;
  }

  const embeddingsNote =
    parsed.embeddings || bundle.env.embedding.mode === "api"
      ? "embeddings=api"
      : "embeddings=off";

  await runChatSession({
    deps: built.deps,
    session: bundle.session,
    jsonMode: parsed.json,
    embeddingsNote,
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), {
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
  const { startSessionServe } = await import("./session-api/serve.js");
  try {
    const { listening } = await startSessionServe({
      host: parsed.host,
      port: parsed.port,
      embeddings: parsed.embeddings,
      json_mode: parsed.json,
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

main().catch((err) => {
  printCliError(err);
  process.exit(1);
});
