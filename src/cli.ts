#!/usr/bin/env node
/**
 * CLI: npx tsx src/cli.ts "query"
 * Optional: --role employee|manager|admin
 * Optional: --governance-timeout  (edge-006 degrade path)
 * Optional: --mode deterministic|llm  (llm uses LlmIknowAgent; needs API key)
 * Optional: --embeddings  (opt-in vector arm when embedding key is present)
 */
import { IknowAgent } from "./agent-loop/loop.js";
import {
  assertOfflineCompatible,
  assertToolProtocolSupported,
  loadIknowEnv,
} from "./config/env.js";
import {
  CALLER_ROLES,
  parseCallerRole,
  type CallerRole,
} from "./shared/schema.js";
import { createIknowRuntime } from "./runtime/create-runtime.js";
import { isIknowError } from "./shared/errors.js";

const AGENT_MODES = ["deterministic", "llm"] as const;
type AgentModeCli = (typeof AGENT_MODES)[number];

function parseAgentMode(value: unknown): AgentModeCli {
  if (
    typeof value === "string" &&
    (AGENT_MODES as readonly string[]).includes(value.toLowerCase())
  ) {
    return value.toLowerCase() as AgentModeCli;
  }
  throw new Error(
    `Invalid mode: ${JSON.stringify(value)}; expected one of: ${AGENT_MODES.join("|")}`,
  );
}

function parseArgs(argv: string[]): {
  query: string;
  role: CallerRole;
  degrade: boolean;
  mode: AgentModeCli;
  embeddings: boolean;
} {
  let role: CallerRole = "employee";
  let degrade = false;
  let mode: AgentModeCli = "deterministic";
  let embeddings = false;
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
      mode = parseAgentMode(raw);
    } else if (a === "--embeddings") {
      embeddings = true;
    } else {
      rest.push(a);
    }
  }
  return {
    query: rest.join(" ").trim() || "公司的退款政策是什么？",
    role,
    degrade,
    mode,
    embeddings,
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

async function main(): Promise<void> {
  const { query, role, degrade, mode, embeddings } = parseArgs(
    process.argv.slice(2),
  );

  // --embeddings forces API mode for this process so createIknowRuntime can
  // build a vector index when the key named by IKNOW_EMBEDDING_API_KEY_ENV exists.
  if (embeddings) {
    process.env.IKNOW_EMBEDDING_MODE = "api";
  }

  // CLI opt-in is authoritative: only true when --embeddings is passed.
  const env = loadIknowEnv();
  if (embeddings && !env.embedding.apiKey) {
    console.error(
      JSON.stringify({
        error: "embeddings_missing_api_key",
        message:
          "Set the env var named by IKNOW_EMBEDDING_API_KEY_ENV, or omit --embeddings.",
        apiKeyEnv: env.embedding.apiKeyEnv,
      }),
    );
    process.exitCode = 1;
    return;
  }

  // Seed store + optional vector index when enableEmbeddings and mode=api.
  // Network embed failures fall back to keyword-only inside createIknowRuntime.
  const { store, vectorIndex, env: runtimeEnv } = await createIknowRuntime({
    enableEmbeddings: embeddings,
    env,
  });

  const agentMode =
    mode === "llm" || runtimeEnv.agentMode === "llm" ? "llm" : "deterministic";

  // Re-check after CLI --mode may override env.agentMode (createIknowRuntime already checked env).
  assertOfflineCompatible(runtimeEnv, agentMode);

  const session = {
    caller_role: role,
    simulate_governance_timeout: degrade,
  };

  if (agentMode === "llm") {
    // M2 path: requires LLM client env; fails closed with a clear error if not configured.
    assertToolProtocolSupported(runtimeEnv.llm.toolProtocol);
    if (!runtimeEnv.llm.apiKey) {
      console.error(
        JSON.stringify({
          error: "llm_mode_missing_api_key",
          message:
            "Set the env var named by IKNOW_LLM_API_KEY_ENV, or use --mode deterministic.",
          apiKeyEnv: runtimeEnv.llm.apiKeyEnv,
        }),
      );
      process.exitCode = 1;
      return;
    }
    const { LlmIknowAgent } = await import("./agent-loop/llm-agent.js");
    const { OpenAiCompatibleLlmClient } = await import(
      "./agent-loop/llm-client.js"
    );
    const llm = new OpenAiCompatibleLlmClient({
      baseUrl: runtimeEnv.llm.baseUrl,
      apiKey: runtimeEnv.llm.apiKey,
      model: runtimeEnv.llm.model,
      timeoutMs: runtimeEnv.llm.timeoutMs,
      temperature: runtimeEnv.llm.temperature,
      maxTokens: runtimeEnv.llm.maxOutputTokens,
      contextWindowTokens: runtimeEnv.llm.contextWindowTokens,
    });
    const agent = new LlmIknowAgent({
      store,
      session,
      llm,
      vectorIndex,
      toolProtocol: runtimeEnv.llm.toolProtocol,
    });
    const answer = await agent.answer(query);
    console.log(JSON.stringify(answer, null, 2));
    return;
  }

  const agent = new IknowAgent({
    store,
    session,
    vectorIndex,
  });
  const answer = await agent.answer(query);
  console.log(JSON.stringify(answer, null, 2));
}

main().catch((err) => {
  printCliError(err);
  process.exit(1);
});
