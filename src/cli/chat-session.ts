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
    (process.env.IKNOW_EMBEDDING_MODE === "api" ? "embeddings=api" : "embeddings=off");

  if (interactive) {
    await runInteractive(ctx, emb);
  } else {
    await runPiped(ctx);
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

  let sigintCount = 0;
  const onSigint = (): void => {
    sigintCount += 1;
    if (sigintCount === 1) {
      writeErr("\n再次 Ctrl+C 退出，或输入 /quit");
      // re-show prompt after interrupt message
      rl.prompt(true);
      return;
    }
    writeErr("\n退出。");
    rl.close();
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  const prompt = (): void => {
    sigintCount = 0;
    rl.setPrompt("iknow> ");
    rl.prompt();
  };

  // Serialize turns: never start next line until previous finishes.
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  const handle = async (line: string): Promise<void> => {
    // Thinking indicator on stderr for agent queries only.
    const looksLikeQuery =
      line.trim().length > 0 && !line.trim().startsWith("/");
    if (looksLikeQuery) {
      process.stderr.write("思考中…");
    }

    const result = await processChatLine(line, ctx);

    if (looksLikeQuery) {
      clearErrLine();
      if (!process.stderr.isTTY) {
        // Non-clearable: end the thinking token with newline.
        process.stderr.write("\n");
      }
    }

    if (result.stderr) {
      writeErr(result.stderr);
    }
    if (result.output) {
      writeOut(result.output);
      writeOut(""); // blank line before next prompt
    }
    if (result.quit) {
      closed = true;
      rl.close();
      return;
    }
    if (!closed) {
      prompt();
    }
  };

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      chain = chain
        .then(() => handle(line))
        .catch((err) => {
          clearErrLine();
          writeErr(formatChatError(err));
          if (!closed) {
            prompt();
          }
        });
    });
    rl.on("close", () => {
      void chain.finally(() => {
        process.off("SIGINT", onSigint);
        if (!closed) {
          writeErr("再见。");
        } else {
          writeErr("再见。");
        }
        resolve();
      });
    });
    prompt();
  });
}

async function runPiped(ctx: ChatLineContext): Promise<void> {
  // Do not force terminal:true — avoids prompt garble on pipes.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
    crlfDelay: Infinity,
  });

  let turn = 0;
  for await (const line of rl) {
    turn += 1;
    writeErr(`# turn ${turn}`);

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
