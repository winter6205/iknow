#!/usr/bin/env node
/**
 * CLI:
 *   npx tsx src/cli.ts chat [--mode …] [--embeddings] [--role …] [--json] [--governance-timeout]
 *   npx tsx src/cli.ts ask "query" …
 *   npx tsx src/cli.ts "query"           # one-shot JSON (scripts / backward compat)
 */
import * as readline from "node:readline";
import { IknowAgent } from "./agent-loop/loop.js";
import {
  assertOfflineCompatible,
  assertToolProtocolSupported,
  loadIknowEnv,
  type IknowEnv,
} from "./config/env.js";
import {
  CALLER_ROLES,
  parseCallerRole,
  type AgentAnswerOpts,
  type CallerRole,
  type IknowAnswer,
  type SessionContext,
} from "./shared/schema.js";
import { createIknowRuntime } from "./runtime/create-runtime.js";
import { isIknowError } from "./shared/errors.js";
import type { InMemoryKnowledgeStore } from "./knowledge-store/memory-store.js";
import type { VectorIndex } from "./kb-retrieve/embedding/vector-index.js";
import {
  createConversation,
  formatAnswerHuman,
  formatAnswerJson,
  recordTurn,
  type ConversationState,
} from "./interaction/index.js";
import {
  AGENT_MODES,
  applySlashCommand,
  parseAgentModeCli,
  parseChatLine,
  type AgentModeCli,
} from "./interaction/slash.js";

type CliCommand = "chat" | "ask" | "oneshot";

type ParsedCli = {
  command: CliCommand;
  query: string;
  role: CallerRole;
  degrade: boolean;
  mode: AgentModeCli;
  embeddings: boolean;
  json: boolean;
};

type AnswerAgent = {
  answer(query: string, opts?: AgentAnswerOpts): Promise<IknowAnswer>;
};

function parseArgs(argv: string[]): ParsedCli {
  let role: CallerRole = "employee";
  let degrade = false;
  let mode: AgentModeCli = "deterministic";
  let embeddings = false;
  let json = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--role") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error(
          `Missing value for --role; expected one of: ${CALLER_ROLES.join("|")}`,
        );
      }
      role = parseCallerRole(raw);
    } else if (a === "--governance-timeout") {
      degrade = true;
    } else if (a === "--mode") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error(
          `Missing value for --mode; expected one of: ${AGENT_MODES.join("|")}`,
        );
      }
      mode = parseAgentModeCli(raw);
    } else if (a === "--embeddings") {
      embeddings = true;
    } else if (a === "--json") {
      json = true;
    } else {
      rest.push(a);
    }
  }

  const head = rest[0];
  if (head === "chat") {
    return {
      command: "chat",
      query: "",
      role,
      degrade,
      mode,
      embeddings,
      json,
    };
  }
  if (head === "ask") {
    return {
      command: "ask",
      query: rest.slice(1).join(" ").trim() || "公司的退款政策是什么？",
      role,
      degrade,
      mode,
      embeddings,
      json,
    };
  }
  return {
    command: "oneshot",
    query: rest.join(" ").trim() || "公司的退款政策是什么？",
    role,
    degrade,
    mode,
    embeddings,
    json,
  };
}

function printCliError(err: unknown): void {
  if (isIknowError(err)) {
    console.error(
      JSON.stringify({
        error: err.code.toLowerCase(),
        name: err.name,
        message: err.message,
        details: err.details,
      }),
    );
    return;
  }
  if (err instanceof Error) {
    console.error(
      JSON.stringify({
        error: "error",
        message: err.message,
      }),
    );
    return;
  }
  console.error(
    JSON.stringify({
      error: "error",
      message: String(err),
    }),
  );
}

function printChatError(err: unknown): void {
  if (isIknowError(err)) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    return;
  }
  if (err instanceof Error) {
    console.error(`错误: ${err.message}`);
    return;
  }
  console.error(`错误: ${String(err)}`);
}

type RuntimeBundle = {
  store: InMemoryKnowledgeStore;
  vectorIndex: VectorIndex | undefined;
  env: IknowEnv;
  session: SessionContext;
};

async function prepareRuntime(opts: {
  role: CallerRole;
  degrade: boolean;
  embeddings: boolean;
}): Promise<RuntimeBundle> {
  if (opts.embeddings) {
    process.env.IKNOW_EMBEDDING_MODE = "api";
  }

  const env = loadIknowEnv();
  if (opts.embeddings && !env.embedding.apiKey) {
    throw new Error(
      `embeddings requested but env var named by IKNOW_EMBEDDING_API_KEY_ENV (${env.embedding.apiKeyEnv}) is unset; omit --embeddings or set the key.`,
    );
  }

  const { store, vectorIndex, env: runtimeEnv } = await createIknowRuntime({
    enableEmbeddings: opts.embeddings,
    env,
  });

  const session: SessionContext = {
    caller_role: opts.role,
    simulate_governance_timeout: opts.degrade,
  };

  return { store, vectorIndex, env: runtimeEnv, session };
}

/**
 * Build agent for an explicit mode (authoritative for /mode and --mode).
 * Caller merges env default before first build when appropriate.
 */
async function buildAgent(
  bundle: RuntimeBundle,
  mode: AgentModeCli,
): Promise<{ agent: AnswerAgent; mode: AgentModeCli }> {
  assertOfflineCompatible(bundle.env, mode);

  if (mode === "llm") {
    assertToolProtocolSupported(bundle.env.llm.toolProtocol);
    if (!bundle.env.llm.apiKey) {
      throw new Error(
        `LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${bundle.env.llm.apiKeyEnv}); use --mode deterministic or set the key.`,
      );
    }
    const { LlmIknowAgent } = await import("./agent-loop/llm-agent.js");
    const { OpenAiCompatibleLlmClient } = await import(
      "./agent-loop/llm-client.js"
    );
    const llm = new OpenAiCompatibleLlmClient({
      baseUrl: bundle.env.llm.baseUrl,
      apiKey: bundle.env.llm.apiKey,
      model: bundle.env.llm.model,
      timeoutMs: bundle.env.llm.timeoutMs,
      temperature: bundle.env.llm.temperature,
      maxTokens: bundle.env.llm.maxOutputTokens,
      contextWindowTokens: bundle.env.llm.contextWindowTokens,
    });
    const agent = new LlmIknowAgent({
      store: bundle.store,
      session: bundle.session,
      llm,
      vectorIndex: bundle.vectorIndex,
      toolProtocol: bundle.env.llm.toolProtocol,
      contextWindowTokens: bundle.env.llm.contextWindowTokens,
    });
    return { agent, mode: "llm" };
  }

  const agent = new IknowAgent({
    store: bundle.store,
    session: bundle.session,
    vectorIndex: bundle.vectorIndex,
  });
  return { agent, mode: "deterministic" };
}

/** CLI default: explicit --mode llm, or env IKNOW_AGENT_MODE=llm. */
function resolveStartupMode(
  cliMode: AgentModeCli,
  env: IknowEnv,
): AgentModeCli {
  if (cliMode === "llm" || env.agentMode === "llm") {
    return "llm";
  }
  return "deterministic";
}

function printAnswer(answer: IknowAnswer, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(formatAnswerJson(answer));
  } else {
    console.log(formatAnswerHuman(answer));
  }
}

async function runOneShot(parsed: ParsedCli): Promise<void> {
  let bundle: RuntimeBundle;
  try {
    bundle = await prepareRuntime({
      role: parsed.role,
      degrade: parsed.degrade,
      embeddings: parsed.embeddings,
    });
  } catch (err) {
    // Keep script-friendly JSON errors for one-shot.
    if (err instanceof Error && err.message.includes("embeddings requested")) {
      console.error(
        JSON.stringify({
          error: "embeddings_missing_api_key",
          message: err.message,
        }),
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const startupMode = resolveStartupMode(parsed.mode, bundle.env);
  let built: { agent: AnswerAgent; mode: AgentModeCli };
  try {
    built = await buildAgent(bundle, startupMode);
  } catch (err) {
    if (err instanceof Error && err.message.includes("LLM mode needs")) {
      console.error(
        JSON.stringify({
          error: "llm_mode_missing_api_key",
          message: err.message,
          apiKeyEnv: bundle.env.llm.apiKeyEnv,
        }),
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const answer = await built.agent.answer(parsed.query);
  // One-shot stays JSON for scripts/CI (design §4.1).
  console.log(formatAnswerJson(answer));
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

  // Startup: honor --mode or env; later /mode is authoritative (no env re-merge).
  let mode: AgentModeCli = resolveStartupMode(parsed.mode, bundle.env);
  let agent: AnswerAgent;
  try {
    const built = await buildAgent(bundle, mode);
    agent = built.agent;
    mode = built.mode;
  } catch (err) {
    printChatError(err);
    process.exitCode = 1;
    return;
  }

  const state: ConversationState = createConversation(bundle.session, {
    json_mode: parsed.json,
  });

  console.error(
    `iknow chat  mode=${mode}  role=${state.session.caller_role}  json=${state.json_mode ? "on" : "off"}`,
  );
  console.error("Type /help for commands. Ctrl+D or /quit to exit.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  const prompt = (): void => {
    rl.setPrompt("iknow> ");
    rl.prompt();
  };

  const handleLine = async (line: string): Promise<void> => {
    const parsedLine = parseChatLine(line);

    if (parsedLine.kind === "empty") {
      prompt();
      return;
    }

    if (parsedLine.kind === "slash") {
      const effect = applySlashCommand(parsedLine.command, parsedLine.args, {
        state,
        mode,
      });

      switch (effect.type) {
        case "quit":
          rl.close();
          return;
        case "help":
        case "info":
        case "error":
          console.log(effect.text);
          prompt();
          return;
        case "reset":
          console.log(effect.message);
          prompt();
          return;
        case "mode_change": {
          try {
            const built = await buildAgent(bundle, effect.mode);
            agent = built.agent;
            mode = built.mode;
            console.log(effect.message);
          } catch (err) {
            printChatError(err);
            console.error(`(mode stays ${mode})`);
          }
          prompt();
          return;
        }
      }
    }

    // query
    const query = parsedLine.kind === "query" ? parsedLine.text : "";
    if (!query) {
      prompt();
      return;
    }

    try {
      const answer = await agent.answer(query, {
        prior_chunks: state.last_priors.length
          ? state.last_priors
          : undefined,
        history: state.history_finals.length
          ? state.history_finals
          : undefined,
      });
      recordTurn(state, query, answer, bundle.store);
      printAnswer(answer, state.json_mode);
    } catch (err) {
      printChatError(err);
    }
    prompt();
  };

  // Serialize async line handlers so paste/burst input cannot interleave turns.
  let chain: Promise<void> = Promise.resolve();
  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      chain = chain
        .then(() => handleLine(line))
        .catch((err) => {
          printChatError(err);
          prompt();
        });
    });
    rl.on("close", () => {
      void chain.finally(() => resolve());
    });
    prompt();
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "chat") {
    await runChat(parsed);
    return;
  }
  await runOneShot(parsed);
}

main().catch((err) => {
  printCliError(err);
  process.exit(1);
});
