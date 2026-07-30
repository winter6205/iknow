/**
 * Runtime bootstrap for CLI: env, store, harness engine.
 *
 * 020 决议收口后只剩 `buildHarnessEngine(bundle)` 一条 build 路径:
 * CLI ask/chat 产品路径,走 harness foundation(real Anthropic adapter +
 * demo tools + LoopEngine)。
 *
 * 旧 agent builder 服务于 Session API serve 路径,在 #51 把 serve 切到
 * harness 后于 022 归档(见 `docs/archive/022-retire-agent-loop/README.md`)。
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
import { loadIknowEnv, type IknowEnv } from "../config/env.js";
import type { CallerRole, SessionContext } from "../shared/schema.js";
import { createIknowRuntime } from "../runtime/create-runtime.js";
import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type { VectorIndex } from "../kb-retrieve/embedding/vector-index.js";

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
