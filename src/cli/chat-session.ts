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
import { wrapWithViolationHook } from "../harness/sandbox/violation-executor.js";
import {
  createViolationCounter,
  wireKillSessionNotification,
} from "../harness/sandbox/violation-handling.js";

/** Visual separator after a completed answer on TTY only. */
const TTY_ANSWER_SEP = "────────";

export type ChatSessionOpts = {
  deps: LoopEngineDeps;
  session: SessionContext;
  jsonMode: boolean;
  /**
   * Quiet pipe mode: no turn markers on stderr.
   * Default: true when `IKNOW_CHAT_QUIET=1`, else false.
   * Interactive TTY ignores this (still uses prompt + optional 思考中).
   */
  quiet?: boolean;
  /**
   * #152 T5:thinking 可见开关(env flag 落点)。默认 false。
   * 来源 `IKNOW_CHAT_SHOW_THINKING=on|off`(env.ts SSOT)。开启时人类投影
   * 在答案文本前展示 thinking;`projection.texts` / `finalText` / LoopTrace /
   * session-store 均不受影响。
   */
  showThinking?: boolean;
};

export type ChatLineContext = {
  deps: LoopEngineDeps;
  state: CliChatState;
  /** #152 T5:thinking 可见开关(与 ChatSessionOpts.showThinking 同源)。 */
  showThinking?: boolean;
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

export interface ProcessChatLineOpts {
  readonly line: string;
  readonly ctx: ChatLineContext;
}

/**
 * Pure-ish one-line handler for tests and both I/O paths.
 * Mutates ctx (state) as needed.
 */
export async function processChatLine(
  opts: ProcessChatLineOpts
): Promise<ProcessChatLineResult> {
  const { line, ctx } = opts;
  const parsedLine = parseChatLine(line);

  if (parsedLine.kind === "empty") {
    return { quit: false, output: "" };
  }

  if (parsedLine.kind === "slash") {
    return processSlash({
      command: parsedLine.command,
      args: parsedLine.args,
      ctx,
    });
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
    // owned by host replaces and freezes the shallow copy so history remains
    // append-only (harness returns ReadonlyArray).
    if (
      result.stopReason !== "protocolError" &&
      result.stopReason !== "emptyFinalResponse"
    ) {
      ctx.state.messages = Object.freeze([...result.messages]);
    }
    const output = ctx.state.jsonMode
      ? formatRunJson({ result, trace })
      : formatRunHuman({
          result,
          trace,
          showThinking: ctx.showThinking,
        });
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

async function processSlash(opts: {
  readonly command: string;
  readonly args: string[];
  readonly ctx: ChatLineContext;
}): Promise<ProcessChatLineResult> {
  const { command, args, ctx } = opts;
  const effect = applySlashCommand({
    command,
    args,
    ctx: { state: ctx.state },
  });

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
    messages: Object.freeze([]),
    jsonMode: opts.jsonMode,
    session: opts.session,
  };

  // T6: wrap the executor with the violation kill-session hook so tool
  // results get observed against the three-tier counter (#123 Q4). When the
  // counter escalates, wireKillSessionNotification writes the stderr line
  // and sets process.exitCode = 1; the REPL then closes after the current
  // turn (kill = exit the session, per spec §OQ4 "杀会话").
  const counter = createViolationCounter();
  const killRef: { fired: boolean } = { fired: false };
  const notify = wireKillSessionNotification({ sink: writeErr });
  const onKill = (reason: string): void => {
    killRef.fired = true;
    notify(reason);
  };
  const executor = wrapWithViolationHook({
    inner: opts.deps.executor,
    counter,
    onKill,
  });
  const wrappedDeps: LoopEngineDeps = { ...opts.deps, executor };

  const ctx: ChatLineContext = {
    deps: wrappedDeps,
    state,
    showThinking: opts.showThinking,
  };

  const interactive = isInteractive();

  if (interactive) {
    await runInteractive({ ctx, killRef });
  } else {
    await runPiped({ ctx, quiet: resolveQuiet(opts.quiet), killRef });
  }
}

function printBanner(): void {
  writeErr("iknow chat");
  writeErr("输入问题开始对话。/help 查看命令 · /quit 或 Ctrl+D 退出");
}

async function runInteractive(opts: {
  readonly ctx: ChatLineContext;
  /** T6: set when the violation counter escalates; the REPL closes after
   *  the current turn completes (one-shot notification already emitted). */
  readonly killRef?: { fired: boolean };
}): Promise<void> {
  const { ctx, killRef } = opts;
  printBanner();

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
        result = await processChatLine({ line, ctx });
      } catch (err) {
        if (showThinking) {
          clearErrLine();
        }
        writeErr(formatChatError(err));
        if (killRef?.fired === true) {
          closed = true;
          rl.close();
          return;
        }
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

      // T6: violation escalation fired mid-turn → kill the session after
      // this turn completes (notification already written by onKill).
      if (killRef?.fired === true) {
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

async function runPiped(opts: {
  readonly ctx: ChatLineContext;
  readonly quiet: boolean;
  /** T6: violation escalation closes the pipe loop after the current turn. */
  readonly killRef?: { fired: boolean };
}): Promise<void> {
  const { ctx, quiet, killRef } = opts;
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
    const result = await processChatLine({ line, ctx });

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
    // T6: violation escalation fired mid-turn → stop reading further lines.
    if (killRef?.fired === true) {
      break;
    }
  }
}
