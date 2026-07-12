/**
 * Product chat session: TTY REPL + non-interactive pipe path.
 * Core line handling is exported for unit tests (no real TTY required).
 */
import * as readline from "node:readline";
import {
  createConversation,
  formatAnswerHuman,
  formatAnswerJson,
  recordTurn,
  type ConversationState,
} from "../interaction/index.js";
import {
  applySlashCommand,
  parseChatLine,
  type AgentModeCli,
} from "../interaction/slash.js";
import type { SessionContext } from "../shared/schema.js";
import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import { isIknowError } from "../shared/errors.js";
import type { AnswerAgent } from "./runtime.js";
import {
  clearErrLine,
  isInteractive,
  writeErr,
  writeOut,
} from "./session-io.js";

/** Visual separator after a completed answer on TTY only. */
const TTY_ANSWER_SEP = "────────";

export type ChatSessionOpts = {
  agent: AnswerAgent;
  store: InMemoryKnowledgeStore;
  session: SessionContext;
  initialMode: AgentModeCli;
  jsonMode: boolean;
  /** Rebuild agent when /mode changes. */
  buildAgent: (mode: AgentModeCli) => Promise<AnswerAgent>;
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
  agent: AnswerAgent;
  store: InMemoryKnowledgeStore;
  state: ConversationState;
  mode: AgentModeCli;
  buildAgent: (mode: AgentModeCli) => Promise<AnswerAgent>;
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
 * Mutates ctx (state, agent, mode) as needed.
 */
export async function processChatLine(
  line: string,
  ctx: ChatLineContext,
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
    const answer = await ctx.agent.answer(query, {
      prior_chunks: ctx.state.last_priors.length
        ? ctx.state.last_priors
        : undefined,
      history: ctx.state.history_finals.length
        ? ctx.state.history_finals
        : undefined,
    });
    recordTurn(ctx.state, query, answer, ctx.store);
    const output = ctx.state.json_mode
      ? formatAnswerJson(answer)
      : formatAnswerHuman(answer);
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
  ctx: ChatLineContext,
): Promise<ProcessChatLineResult> {
  const effect = applySlashCommand(command, args, {
    state: ctx.state,
    mode: ctx.mode,
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

    case "mode_change": {
      try {
        const nextAgent = await ctx.buildAgent(effect.mode);
        ctx.agent = nextAgent;
        ctx.mode = effect.mode;
        return { quit: false, output: effect.message };
      } catch (err) {
        return {
          quit: false,
          output: "",
          stderr: `${formatChatError(err)}\n(mode stays ${ctx.mode})`,
        };
      }
    }
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
  const state = createConversation(opts.session, {
    json_mode: opts.jsonMode,
  });

  const ctx: ChatLineContext = {
    agent: opts.agent,
    store: opts.store,
    state,
    mode: opts.initialMode,
    buildAgent: opts.buildAgent,
  };

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

function printBanner(mode: AgentModeCli, state: ConversationState, emb: string): void {
  writeErr(
    `iknow chat  mode=${mode}  role=${state.session.caller_role}  ${emb}`,
  );
  writeErr("输入问题开始对话。/help 查看命令 · /quit 或 Ctrl+D 退出");
}

async function runInteractive(
  ctx: ChatLineContext,
  emb: string,
): Promise<void> {
  printBanner(ctx.mode, ctx.state, emb);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let closed = false;
  let busy = false;
  let farewellPrinted = false;
  let exitCode: number | undefined;
  const sayGoodbye = (): void => {
    if (farewellPrinted) {
      return;
    }
    farewellPrinted = true;
    writeErr("再见。");
  };

  let sigintCount = 0;
  let lastSigintAt = 0;
  const onSigint = (): void => {
    // One physical Ctrl+C can hit both process and readline; debounce dual delivery.
    const now = Date.now();
    if (now - lastSigintAt < 80) {
      return;
    }
    lastSigintAt = now;

    sigintCount += 1;
    if (sigintCount === 1) {
      writeErr("\n再次 Ctrl+C 退出，或输入 /quit");
      // Re-show prompt only when idle (never stack prompts mid-turn).
      if (!closed && !busy) {
        rl.prompt(true);
      }
      return;
    }
    // Second SIGINT: exit without also printing 再见
    farewellPrinted = true;
    writeErr("\n退出。");
    closed = true;
    exitCode = 130;
    rl.close();
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
    // Pause input so the next prompt cannot appear mid-turn.
    rl.pause();

    const looksLikeQuery =
      line.trim().length > 0 && !line.trim().startsWith("/");
    // 思考中 only when stderr is a TTY (never spam pipes / redirected logs).
    const showThinking = looksLikeQuery && Boolean(process.stderr.isTTY);

    if (showThinking) {
      process.stderr.write("思考中…");
    }

    try {
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
    } finally {
      busy = false;
    }
  };

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      if (closed) {
        return;
      }
      chain = chain.then(() => handle(line));
    });
    rl.on("close", () => {
      void chain.finally(() => {
        process.off("SIGINT", onSigint);
        rl.removeListener("SIGINT", onSigint);
        sayGoodbye();
        if (exitCode !== undefined) {
          process.exitCode = exitCode;
        }
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
