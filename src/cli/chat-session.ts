/**
 * Product chat session: TTY REPL + non-interactive pipe path.
 * Core line handling is exported for unit tests (no real TTY required).
 */
import * as readline from "node:readline";
import { run as runHarness, type LoopEngineDeps } from "../harness/index.js";
import { formatRunHuman, formatRunJson } from "./format.js";
import {
  applySlashCommand,
  parseChatLine,
  type CliChatState,
} from "./slash.js";
import type { SessionContext } from "../shared/schema.js";
import { isIknowError } from "../shared/errors.js";
import {
  clearErrLine,
  isInteractive,
  writeErr,
  writeOut,
} from "./session-io.js";

/** Visual separator after a completed answer on TTY only. */
const TTY_ANSWER_SEP = "────────";

export type ChatSessionOpts = {
  deps: LoopEngineDeps;
  session: SessionContext;
  jsonMode: boolean;
  /** Optional note for banner (e.g. embeddings on/off). */
  embeddingsNote?: string;
  /**
   * Quiet pipe mode: no turn markers on stderr.
   * Default: true when `IKNOW_CHAT_QUIET=1`, else false.
   * Interactive TTY ignores this (still uses prompt + optional 思考中).
   */
  quiet?: boolean;
};

export type ChatLineContext = {
  deps: LoopEngineDeps;
  state: CliChatState;
};

export type ProcessChatLineResult = {
  quit: boolean;
  /** Material for stdout (answers, slash info/help/reset). */
  output: string;
  /** Material for stderr (errors). */
  stderr?: string;
  /** True when this line was a user query that ran the agent. */
  ranQuery?: boolean;
};

/**
 * Pure-ish one-line handler for tests and both I/O paths.
 * Mutates ctx (state) as needed.
 */
export async function processChatLine(
  line: string,
  ctx: ChatLineContext
): Promise<ProcessChatLineResult> {
  const parsedLine = parseChatLine(line);

  if (parsedLine.kind === "empty") {
    return { quit: false, output: "" };
  }

  if (parsedLine.kind === "slash") {
    return processSlash(parsedLine.command, parsedLine.args, ctx);
  }

  const query = parsedLine.text;
  try {
    const { result, trace } = await runHarness(query, ctx.deps, undefined, {
      priorMessages: ctx.state.messages,
    });
    // Continue the conversation next turn even on maxTurns/cancelled/timeout/
    // nonSuccessStop (all append an assistant message). protocolError and
    // emptyFinalResponse return finalState with NO assistant message appended,
    // so continuing on them would feed a dangling user message to the model
    // next turn and poison the loop — drop context on those two. CliChatState
    // owned by host keeps a mutable copy, so a defensive shallow clone is
    // required before assignment (harness returns ReadonlyArray).
    if (
      result.stopReason !== "protocolError" &&
      result.stopReason !== "emptyFinalResponse"
    ) {
      ctx.state.messages = [...result.messages];
    }
    const output = ctx.state.jsonMode
      ? formatRunJson(result, trace)
      : formatRunHuman(result, trace);
    return { quit: false, output, ranQuery: true };
  } catch (err) {
    return {
      quit: false,
      output: "",
      stderr: formatChatError(err),
      ranQuery: true,
    };
  }
}

async function processSlash(
  command: string,
  args: string[],
  ctx: ChatLineContext
): Promise<ProcessChatLineResult> {
  const effect = applySlashCommand(command, args, { state: ctx.state });

  switch (effect.type) {
    case "quit":
      return { quit: true, output: "" };

    case "help":
    case "info":
      return { quit: false, output: effect.text };

    case "error":
      return { quit: false, output: "", stderr: effect.text };

    case "reset":
      return { quit: false, output: effect.message };
  }
}

function formatChatError(err: unknown): string {
  if (isIknowError(err)) {
    return `错误 [${err.code}]: ${err.message}`;
  }
  if (err instanceof Error) {
    return `错误: ${err.message}`;
  }
  return `错误: ${String(err)}`;
}

function resolveQuiet(optsQuiet: boolean | undefined): boolean {
  if (typeof optsQuiet === "boolean") {
    return optsQuiet;
  }
  return process.env.IKNOW_CHAT_QUIET === "1";
}

/**
 * Run a product chat session (TTY REPL or non-interactive pipe).
 */
export async function runChatSession(opts: ChatSessionOpts): Promise<void> {
  const state: CliChatState = {
    messages: [],
    jsonMode: opts.jsonMode,
    session: opts.session,
  };

  const ctx: ChatLineContext = { deps: opts.deps, state };

  const interactive = isInteractive();
  const emb =
    opts.embeddingsNote ??
    (process.env.IKNOW_EMBEDDING_MODE === "api"
      ? "embeddings=api"
      : "embeddings=off");

  if (interactive) {
    await runInteractive(ctx, emb);
  } else {
    await runPiped(ctx, resolveQuiet(opts.quiet));
  }
}

function printBanner(state: CliChatState, emb: string): void {
  writeErr(`iknow chat  role=${state.session.caller_role}  ${emb}`);
  writeErr("输入问题开始对话。/help 查看命令 · /quit 或 Ctrl+D 退出");
}

async function runInteractive(
  ctx: ChatLineContext,
  emb: string
): Promise<void> {
  printBanner(ctx.state, emb);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let closed = false;
  let busy = false;
  let farewellPrinted = false;
  const sayGoodbye = (): void => {
    if (farewellPrinted) {
      return;
    }
    farewellPrinted = true;
    writeErr("再见。");
  };

  let sigintCount = 0;
  /** Coalesce same-tick dual delivery (process + readline) without timed debounce. */
  let sigintCoalesce = false;
  const onSigint = (): void => {
    if (sigintCoalesce) {
      return;
    }
    sigintCoalesce = true;
    queueMicrotask(() => {
      sigintCoalesce = false;
    });

    sigintCount += 1;
    if (sigintCount === 1) {
      writeErr("\n再次 Ctrl+C 退出，或输入 /quit");
      // Re-show prompt only when idle (never stack prompts mid-turn).
      if (!closed && !busy) {
        rl.prompt(true);
      }
      return;
    }
    // Second SIGINT: leave immediately even if a turn is mid-flight.
    farewellPrinted = true;
    writeErr("\n退出。");
    closed = true;
    process.off("SIGINT", onSigint);
    rl.removeListener("SIGINT", onSigint);
    try {
      rl.close();
    } catch {
      // EXIT: interface may already be closed
    }
    process.exit(130);
  };
  // Node may deliver Ctrl+C to process and/or readline depending on platform.
  process.on("SIGINT", onSigint);
  rl.on("SIGINT", onSigint);

  const prompt = (): void => {
    if (closed) {
      return;
    }
    sigintCount = 0;
    rl.setPrompt("iknow> ");
    rl.prompt();
  };

  // Serialize turns: never start next line / prompt until previous finishes.
  let chain: Promise<void> = Promise.resolve();

  const handle = async (line: string): Promise<void> => {
    busy = true;
    let showThinking = false;
    try {
      // Pause input so the next prompt cannot appear mid-turn.
      rl.pause();

      const looksLikeQuery =
        line.trim().length > 0 && !line.trim().startsWith("/");
      // 思考中 only when stderr is a TTY (never spam pipes / redirected logs).
      showThinking = looksLikeQuery && Boolean(process.stderr.isTTY);

      if (showThinking) {
        process.stderr.write("思考中…");
      }

      let result: ProcessChatLineResult;
      try {
        result = await processChatLine(line, ctx);
      } catch (err) {
        if (showThinking) {
          clearErrLine();
        }
        writeErr(formatChatError(err));
        if (!closed) {
          prompt();
          rl.resume();
        }
        return;
      }

      if (showThinking) {
        clearErrLine();
      }

      if (result.stderr) {
        writeErr(result.stderr);
      }
      if (result.output) {
        writeOut(result.output);
        // Separator after agent answers only (TTY path).
        if (result.ranQuery) {
          writeOut(TTY_ANSWER_SEP);
        } else {
          writeOut("");
        }
      }

      if (result.quit) {
        closed = true;
        rl.close();
        return;
      }

      // Prompt only after the full turn is done.
      if (!closed) {
        prompt();
        rl.resume();
      }
    } catch (err) {
      // EXIT: protect chain from rejections before/around processChatLine
      if (showThinking) {
        clearErrLine();
      }
      writeErr(formatChatError(err));
      if (!closed) {
        try {
          prompt();
          rl.resume();
        } catch {
          // EXIT: readline may already be closed
        }
      }
    } finally {
      busy = false;
    }
  };

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      if (closed) {
        return;
      }
      chain = chain
        .then(() => handle(line))
        .catch((err) => {
          // EXIT: last-resort so unhandled rejections never kill the process
          writeErr(formatChatError(err));
          busy = false;
          if (!closed) {
            try {
              prompt();
              rl.resume();
            } catch {
              // EXIT: readline closed
            }
          }
        });
    });
    rl.on("close", () => {
      process.off("SIGINT", onSigint);
      rl.removeListener("SIGINT", onSigint);
      // Normal /quit or EOF: wait for in-flight turn then farewell.
      // Forced second Ctrl+C uses process.exit(130) and never reaches here.
      void chain.finally(() => {
        sayGoodbye();
        resolve();
      });
    });
    prompt();
  });
}

async function runPiped(ctx: ChatLineContext, quiet: boolean): Promise<void> {
  // Do not force terminal:true — avoids prompt garble on pipes.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
    crlfDelay: Infinity,
  });

  let turn = 0;
  for await (const line of rl) {
    // Empty lines: skip (no turn marker, no agent call).
    if (line.trim().length === 0) {
      continue;
    }

    turn += 1;
    if (!quiet) {
      writeErr(`── turn ${turn} ──`);
    }

    // Never print 思考中 on pipe (quiet product / script friendly).
    const result = await processChatLine(line, ctx);

    if (result.stderr) {
      writeErr(result.stderr);
    }
    if (result.output) {
      writeOut(result.output);
      writeOut("");
    }
    if (result.quit) {
      break;
    }
  }
}
