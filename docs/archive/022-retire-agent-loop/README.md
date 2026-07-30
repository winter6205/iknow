# 022 — Archived: legacy `src/agent-loop/` retired after harness cutover

> Archived under GitHub issue #86 (022) "迁移到 Session API: 把 legacy
> `src/agent-loop/` 归档" on 2026-07-31.
> See wayfinder map #44 Decisions-so-far for the grilling record.

## What's here

### `src/agent-loop/` (7 files, archived in full)

The 020-predecessor agent loop (旧 `IknowAgent` / `LlmIknowAgent` →
`IknowAnswer` 形态). #51 (Session API 迁移到 harness) 完成后,agent 执行
职责全部落到 `src/harness/`(loop-engine / anthropic-adapter / executor /
registry),`src/agent-loop/` 失去所有存活消费者。All files moved here:

- `loop.ts` — `IknowAgent`(deterministic 模式主 agent,620 行);基于
  `shared/schema.ts` 的 `IknowAnswer` 返回形态,已被 `src/harness/loop-engine.ts`
  - `createLoopEngine` 取代
- `llm-agent.ts` — `LlmIknowAgent`(LLM 模式 agent,613 行);OpenAI-compatible
  LLM 调用 + tool-use 循环,已被 `src/harness/anthropic-adapter.ts` +
  `createRealAnthropicAdapter` 取代
- `llm-client.ts` — `OpenAiCompatibleLlmClient`(302 行);OpenAI-compatible
  HTTP 客户端,已被 `src/harness/anthropic-adapter.ts` 取代
- `session.ts` — `createSession`(45 行);旧会话工厂,已被
  `src/session-api/store/session-store.ts` 取代
- `priors.ts` — `buildPriors`(30 行);prior-chunks 构建辅助,已被
  `src/session-api/hub.ts::projectMessagesToTurns` 取代
- `tool-defs.ts` — 旧 tool 定义(166 行);已被 `src/harness/registry.ts` +
  `createRegistry` / `createEchoTool` / `createGetTimeTool` 取代
- `trace.ts` — `TraceCollector`(23 行);tool-call 轨迹收集,已被
  `src/harness/loop-engine.ts` 内建 trace 取代

## Why archived (not deleted)

Per #86 / #51 Objective "src/agent-loop/ 7 文件在 #51 完成后可安全归档":
在 #51 把 Session API 与 CLI 全部切到 harness 基础后,`src/agent-loop/` 的
所有符号都失去存活消费者,但归档非删除以保留 audit trail 与回滚路径。
最终状态(归档前):7 文件,`IknowAgent` / `LlmIknowAgent` /
`OpenAiCompatibleLlmClient` / `createSession` / `buildPriors` /
`TraceCollector` 等公开符号,被 `src/cli/runtime.ts::buildAgent`(唯一存活
消费者)消费,T9 删 `buildAgent` 后引用全部清零。

## Cross-cutting context

- **#47 (020) CLI 路径切到 harness** — closed 2026-07-30。`buildHarnessEngine`
  成为 CLI 产品路径唯一入口,旧 `IknowAgent` / `LlmIknowAgent` builder 冻结
  保留到 #51 关闭。
- **#51 (Session API 迁移到 harness)** — closed 2026-07-31(`worktree-022-
session-api-impl`)。`src/session-api/{hub,contract,http,serve}.ts` 全部
  切到 `src/harness/` 基础,`buildAgent` / `AnswerAgent` / `IknowAgent` /
  `LlmIknowAgent` 一并退役。
- **`src/cli/runtime.ts::buildHarnessEngine`** 是 CLI ask/chat 产品路径的
  唯一构建入口,被 `cli.ts:94,129` 消费。
- **`src/interaction/`** — 5 文件 + README 归档于
  `docs/archive/022-retire-interaction/`。本归档与 interaction 归档同波次(T9)
  发生,文件集不相交但语义关联。
- **`src/shared/schema.ts::IknowAnswer`** — 本归档同步删除(零存活引用);
  `SourceSpan` / `GovernanceStatus` 保留(harness 工具层依赖);
  `ToolCallLog` 一并删除(仅被 `IknowAnswer` 与归档 `trace.ts` 使用)。

## Out of scope of #51 / #54 follow-ups

- **`src/interaction/`** — 5 文件 + README 归档于
  `docs/archive/022-retire-interaction/`。
- **web/** — `web/api/types.ts` 仍引用 `IknowAnswer`(pre-T9 web 形态);T8
  把 web 也切到 `TurnAnswerDto` 后,`IknowAnswer` 公开面归零。

## Pointer for future readers

If you need to resurrect a legacy agent loop (e.g. for a regression
investigation), the source is here in
`docs/archive/022-retire-agent-loop/src/agent-loop/`. The live equivalents
live in `src/harness/`(loop-engine / anthropic-adapter / executor /
registry)and `src/session-api/`(会话袋 + 投影)。
