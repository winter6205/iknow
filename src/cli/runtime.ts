/**
 * Runtime bootstrap for CLI: env, store, harness engine.
 *
 * 020 决议收口后只剩 `buildHarnessEngine(bundle)` 一条 build 路径:
 * CLI ask/chat 产品路径,走 harness foundation(real Anthropic adapter +
 * LoopEngine)。#141-T11 把 ACI 装饰层工具集从 5 件 PROTOTYPE 切到 6 件业界通用名
 * (bash / read_file / grep / glob / edit_file / write_file)，与 permission
 * policy byName 键 `bash` 对齐（ADR-0004 / ADR-0006）；后续追加 Web 类
 * web_fetch / web_search（harness-report p04 ACI 映射），合计 8 件。
 *
 * 工具装配本身已下沉到 `src/harness/build-engine.ts`（SSOT）：CLI 与 serve
 * 共享同一份 8 件工具集,本模块只做 bundle 装配(store/env/session)并转发。
 * 旧 agent builder 服务于 Session API serve 路径,在 #51 把 serve 切到
 * harness 后于 022 归档(见 `docs/archive/022-retire-agent-loop/README.md`)。
 */
import {
  buildHarnessEngine as buildCoreEngine,
  type BuiltEngine,
} from "../harness/build-engine.js";
import { initIknowWorkspaceSafe } from "../harness/identity/index.js";
import type { AskUser } from "../harness/permission/types.js";
import { loadIknowEnv, type IknowEnv } from "../config/env.js";
import type { SessionContext } from "../shared/schema.js";
import { createIknowRuntime } from "../runtime/create-runtime.js";
import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";

export type RuntimeBundle = {
  store: InMemoryKnowledgeStore;
  env: IknowEnv;
  session: SessionContext;
};

export async function prepareRuntime(): Promise<RuntimeBundle> {
  const env = loadIknowEnv();
  const { store, env: runtimeEnv } = await createIknowRuntime({ env });

  const session: SessionContext = {};

  return { store, env: runtimeEnv, session };
}

// Re-export BuiltEngine so existing callers (`cli.ts` / `chat-session.ts` /
// tests) keep importing it from this module unchanged.
export type { BuiltEngine } from "../harness/build-engine.js";

/**
 * CLI ask/chat 产品路径的 harness 装配(020 新主路径)。
 *
 * Thin wrapper around `buildHarnessEngine` in `src/harness/build-engine.ts`:
 * pulls `env` from the CLI runtime bundle and forwards. Tool assembly
 * itself (ACI 8 件 + Anthropic adapter + permission middleware) is the
 * harness layer's responsibility so CLI and serve cannot drift.
 *
 * #162 三入口装配 askUser：`askUser: AskUser` 是必传参数；缺则启动 throw
 * `ask_inlet_missing`（在 `buildHarnessEngine` 内部抛）。
 */
export async function buildHarnessEngine(
  bundle: RuntimeBundle,
  opts: { askUser: AskUser; surface?: "chat" | "tui" | "ask" | "serve" }
): Promise<BuiltEngine> {
  // #196 IKNOW T5: eager + idempotent 初始化 ~/.iknow/(initIknowWorkspaceSafe
  // 内部 try/catch+warn,失败不阻塞装配 — 幂等备份,build-engine 内还有一次)。
  await initIknowWorkspaceSafe();
  // surface 透传到 buildCoreEngine,build-engine 据此判定 BOOTSTRAP 段是否激活
  return buildCoreEngine({
    env: bundle.env,
    askUser: opts.askUser,
    surface: opts.surface ?? "chat",
  });
}
