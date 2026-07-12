/**
 * Runtime bootstrap for CLI: env, store, agent build.
 */
import { IknowAgent } from "../agent-loop/loop.js";
import {
  assertOfflineCompatible,
  assertToolProtocolSupported,
  loadIknowEnv,
  type IknowEnv,
} from "../config/env.js";
import type {
  AgentAnswerOpts,
  CallerRole,
  IknowAnswer,
  SessionContext,
} from "../shared/schema.js";
import { createIknowRuntime } from "../runtime/create-runtime.js";
import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type { VectorIndex } from "../kb-retrieve/embedding/vector-index.js";
import type { AgentModeCli } from "../interaction/slash.js";

export type AnswerAgent = {
  answer(query: string, opts?: AgentAnswerOpts): Promise<IknowAnswer>;
};

export type RuntimeBundle = {
  store: InMemoryKnowledgeStore;
  vectorIndex: VectorIndex | undefined;
  env: IknowEnv;
  session: SessionContext;
};

export async function prepareRuntime(opts: {
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
export async function buildAgent(
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
    const { LlmIknowAgent } = await import("../agent-loop/llm-agent.js");
    const { OpenAiCompatibleLlmClient } = await import(
      "../agent-loop/llm-client.js"
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

/**
 * Resolve agent mode for process startup.
 * Explicit `--mode` on argv always wins; otherwise env `IKNOW_AGENT_MODE=llm`
 * upgrades the default (deterministic) to llm.
 */
export function resolveStartupMode(
  cliMode: AgentModeCli,
  env: IknowEnv,
  modeExplicit = false,
): AgentModeCli {
  if (modeExplicit) {
    return cliMode;
  }
  if (env.agentMode === "llm") {
    return "llm";
  }
  return cliMode;
}
