/**
 * Runtime bootstrap for CLI: env, store, agent build.
 *
 * 两条 build 路径并存(020 决议收口):
 * - `buildHarnessEngine(bundle)`:CLI ask/chat 产品路径,走 harness foundation
 *   (real Anthropic adapter + demo tools + LoopEngine)。020 的新主路径。
 * - `buildAgent(bundle, mode)`:旧 `IknowAgent`/`LlmIknowAgent` → `IknowAnswer`
 *   形态。**仅供 Session API `src/session-api/hub.ts` 消费**(serve 路径),
 *   020 一字不动 hub.ts(D3-CLI 守门),故旧 builder 必须原地保留到 #51 把
 *   serve 也切到 harness 后才能退役。CLI 路径已不再调用它。
 *
 * 这是 plan Q4 逐符号表的遗漏:Q4 只盘点了 `src/interaction/` 的符号被谁消费,
 * 没盘点 `cli/runtime.ts:buildAgent` 也被 hub.ts 消费。保留旧 builder 是在
 * {typecheck 绿} + {session-api 零改动} + {CLI 路径退役旧 agent} 三个硬约束下
 * 唯一可行的收口(详见 #47 实施记录)。
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  createEchoTool,
  createGetTimeTool,
  createRealAnthropicAdapter,
  createRegistry,
  createExecutor,
  createLoopEngine,
  type LoopEngineDeps,
} from "../harness/index.js";
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
import { IknowAgent } from "../agent-loop/loop.js";
import type { AgentModeCli } from "../interaction/slash.js";

export type RuntimeBundle = {
  store: InMemoryKnowledgeStore;
  vectorIndex: VectorIndex | undefined;
  env: IknowEnv;
  session: SessionContext;
};

/**
 * 旧 agent 形态(serve 路径 / Session API 消费)。CLI 路径已切到 BuiltEngine。
 */
export type AnswerAgent = {
  answer(query: string, opts?: AgentAnswerOpts): Promise<IknowAnswer>;
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
      `embeddings requested but env var named by IKNOW_EMBEDDING_API_KEY_ENV (${env.embedding.apiKeyEnv}) is unset; omit --embeddings or set the key.`
    );
  }

  const {
    store,
    vectorIndex,
    env: runtimeEnv,
  } = await createIknowRuntime({
    enableEmbeddings: opts.embeddings,
    env,
  });

  const session: SessionContext = {
    caller_role: opts.role,
    simulate_governance_timeout: opts.degrade,
  };

  return { store, vectorIndex, env: runtimeEnv, session };
}

export type BuiltEngine = {
  deps: LoopEngineDeps;
  engine: ReturnType<typeof createLoopEngine>;
};

/**
 * CLI ask/chat 产品路径的 harness 装配(020 新主路径)。
 *
 * 只构造 deps + engine,不在此调 run();调用方(cli.ts / chat-session.ts)决定
 * 何时跑、是否续传 priorMessages。maxTurns 硬编码 6(loadIknowEnv 无 maxTurns
 * 字段,对齐 019 i9 smoke 惯例)。缺 apiKey 抛错,message 含 "LLM mode needs"
 * 子串(cli.ts runOneShot 按此匹配发 llm_mode_missing_api_key 信封)。
 */
export async function buildHarnessEngine(
  bundle: RuntimeBundle
): Promise<BuiltEngine> {
  const { env } = bundle;
  if (!env.llm.apiKey) {
    throw new Error(
      `CLI LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${env.llm.apiKeyEnv}); set the key.`
    );
  }
  const client = new Anthropic({
    apiKey: env.llm.apiKey,
    baseURL: env.llm.baseUrl,
  });
  const adapter = createRealAnthropicAdapter({
    client,
    model: env.llm.model,
    maxTokens: env.llm.maxOutputTokens,
  });
  const registry = createRegistry([createEchoTool(), createGetTimeTool()]);
  const executor = createExecutor(registry);
  const deps: LoopEngineDeps = {
    adapter,
    executor,
    registry,
    maxTurns: 6,
    timeoutMs: env.llm.timeoutMs,
  };
  return { deps, engine: createLoopEngine(deps) };
}

/**
 * 旧 agent builder(serve 路径 / Session API hub.ts 专用)。
 *
 * 020 不动 hub.ts,故本函数签名与返回形态(`{ agent, mode }`)冻结保留;
 * CLI 路径已不再调用。#51 把 serve 切到 harness 后,本函数与 AnswerAgent /
 * IknowAgent / LlmIknowAgent 一并退役。
 */
export async function buildAgent(
  bundle: RuntimeBundle,
  mode: AgentModeCli
): Promise<{ agent: AnswerAgent; mode: AgentModeCli }> {
  assertOfflineCompatible(bundle.env, mode);

  if (mode === "llm") {
    assertToolProtocolSupported(bundle.env.llm.toolProtocol);
    if (!bundle.env.llm.apiKey) {
      throw new Error(
        `LLM mode needs the env var named by IKNOW_LLM_API_KEY_ENV (${bundle.env.llm.apiKeyEnv}); use --mode deterministic or set the key.`
      );
    }
    const { LlmIknowAgent } = await import("../agent-loop/llm-agent.js");
    const { OpenAiCompatibleLlmClient } =
      await import("../agent-loop/llm-client.js");
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
