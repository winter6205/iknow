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
} from "./config/env.js";
import {
  CALLER_ROLES,
  parseCallerRole,
  type CallerRole,
} from "./shared/schema.js";
import { createIknowRuntime } from "./runtime/create-runtime.js";

function parseArgs(argv: string[]): {
  query: string;
  role: CallerRole;
  degrade: boolean;
  mode: "deterministic" | "llm";
  embeddings: boolean;
} {
  let role: CallerRole = "employee";
  let degrade = false;
  let mode: "deterministic" | "llm" = "deterministic";
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
      const raw = (argv[++i] ?? "").toLowerCase();
      mode = raw === "llm" ? "llm" : "deterministic";
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

async function main(): Promise<void> {
  const { query, role, degrade, mode, embeddings } = parseArgs(
    process.argv.slice(2),
  );

  // --embeddings forces API mode for this process so createIknowRuntime can
  // build a vector index when the key named by IKNOW_EMBEDDING_API_KEY_ENV exists.
  // Without a key, loadIknowEnv keeps mode off and retrieve stays keyword-only.
  if (embeddings) {
    process.env.IKNOW_EMBEDDING_MODE = "api";
  }

  // Seed store + optional vector index when IKNOW_EMBEDDING_MODE=api and key present.
  // Index failures are swallowed inside createIknowRuntime (keyword-only fallback).
  const { store, vectorIndex, env } = await createIknowRuntime({
    enableEmbeddings: embeddings ? true : undefined,
  });

  const agentMode =
    mode === "llm" || env.agentMode === "llm" ? "llm" : "deterministic";

  // Re-check after CLI --mode may override env.agentMode (createIknowRuntime already checked env).
  assertOfflineCompatible(env, agentMode);

  const session = {
    caller_role: role,
    simulate_governance_timeout: degrade,
  };

  if (agentMode === "llm") {
    // M2 path: requires LLM client env; fails closed with a clear error if not configured.
    assertToolProtocolSupported(env.llm.toolProtocol);
    if (!env.llm.apiKey) {
      console.error(
        JSON.stringify({
          error: "llm_mode_missing_api_key",
          message:
            "Set the env var named by IKNOW_LLM_API_KEY_ENV, or use --mode deterministic.",
          apiKeyEnv: env.llm.apiKeyEnv,
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
      baseUrl: env.llm.baseUrl,
      apiKey: env.llm.apiKey,
      model: env.llm.model,
      timeoutMs: env.llm.timeoutMs,
      temperature: env.llm.temperature,
      maxTokens: env.llm.maxOutputTokens,
      contextWindowTokens: env.llm.contextWindowTokens,
    });
    const agent = new LlmIknowAgent({
      store,
      session,
      llm,
      vectorIndex,
      toolProtocol: env.llm.toolProtocol,
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
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
