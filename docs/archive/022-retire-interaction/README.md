# 022 — Archived: host-layer `src/interaction/` retired after harness cutover

> Archived under GitHub issue #86 (022) "迁移到 Session API: 把 host-layer
> `src/interaction/` 归档" on 2026-07-31.
> See wayfinder map #44 Decisions-so-far for the grilling record.

## What's here

### `src/interaction/` (5 files, archived in full)

The 020-predecessor host conversation layer (会话袋 / slash / 人读&JSON 投影).
#51 (Session API 迁移到 harness) 完成后,会话袋与投影职责全部落到
`src/session-api/`(hub / contract / http),slash 命令职责由
`src/cli/slash.ts` + `src/cli/chat-session.ts` 接管,`src/interaction/`
失去所有存活消费者。All files moved here:

- `index.ts` — barrel(导出 `createConversation` / `formatAnswerHuman` /
  `formatAnswerJson` / `recordTurn` / `resetConversation` / `ConversationState`
  / `parseChatLine` / `applySlashCommand` / `parseAgentModeCli` /
  `AgentModeCli` / `AGENT_MODES` / `HistoryTurn` / `ParsedChatLine` /
  `SlashContext` / `SlashEffect`)
- `types.ts` — `ConversationState` / `AgentAnswerResult` / re-exports
  `HistoryTurn` from `shared/schema.ts`
- `conversation.ts` — `createConversation` / `formatAnswerHuman` /
  `formatAnswerJson` / `recordTurn` / `resetConversation`;基于旧 `IknowAnswer`
  形态的会话袋与历史投影(已被 `src/session-api/store/session-store.ts` +
  `src/session-api/hub.ts::projectMessagesToTurns` 取代)
- `format.ts` — `formatAnswerHuman` / `formatAnswerJson`;G2 IknowAnswer 的
  人读 / JSON 投影(已被 `web/lib/format.ts` 的 `shortId` / `prettyJson` 取代)
- `slash.ts` — `parseChatLine` / `applySlashCommand` / `parseAgentModeCli` /
  `AGENT_MODES` / `AgentModeCli` / `ParsedChatLine` / `SlashContext` /
  `SlashEffect`;CLI TTY 的 slash 命令分派(职责由 `src/cli/slash.ts` +
  `src/cli/chat-session.ts` 接管)

## Why archived (not deleted)

Per #86 / #51 Resolution:在 #51 把 Session API 与 CLI 全部切到 harness 基础
后,`src/interaction/` 的所有符号都失去存活消费者,但归档非删除以保留
audit trail 与回滚路径。最终状态(归档前):5 文件,15+ 公开符号,被
`src/cli/runtime.ts` / `src/session-api/{contract,hub,http,serve}.ts` 消费,
T9 后上述引用全部清零。

## Cross-cutting context

- **#47 (020) CLI 路径切到 harness** — closed 2026-07-30。`buildHarnessEngine`
  成为 CLI 产品路径唯一入口,旧 `IknowAgent` / `LlmIknowAgent` builder 冻结
  保留到 #51 关闭。
- **#51 (Session API 迁移到 harness)** — closed 2026-07-31(`worktree-022-
session-api-impl`)。`src/session-api/{hub,contract,http,serve}.ts` 全部
  切到 `src/harness/` 基础,`buildAgent` / `AnswerAgent` / `IknowAgent` /
  `LlmIknowAgent` 一并退役(见 `docs/archive/022-retire-agent-loop/README.md`)。
- **`src/cli/runtime.ts::buildHarnessEngine`** 是 CLI ask/chat 产品路径的
  唯一构建入口,被 `cli.ts:94,129` 消费。
- **CLI slash 职责** — 由 `src/cli/slash.ts`(parseChatLine/applySlashCommand)
  - `src/cli/chat-session.ts` 接管,测试 `tests/cli/slash.test.ts` 覆盖。

## Out of scope of #51 / #54 follow-ups

- **`src/agent-loop/`** — 7 文件 + README 归档于
  `docs/archive/022-retire-agent-loop/`。本归档与 agent-loop 归档同波次(T9)
  发生,文件集不相交但语义关联。
- **web/** — `web/api/types.ts` 仍引用 `IknowAnswer`(pre-T9 web 形态);T8
  把 web 也切到 `TurnAnswerDto` 后,`IknowAnswer` 公开面归零(本归档同步
  删除 `src/shared/schema.ts` 的 `IknowAnswer` 定义)。

## Pointer for future readers

If you need to resurrect a host-layer conversation bag or slash dispatcher
(e.g. for a regression investigation), the source is here in
`docs/archive/022-retire-interaction/src/interaction/`. The live equivalents
live in `src/session-api/`(会话袋 + 投影)and `src/cli/slash.ts` +
`src/cli/chat-session.ts`(slash 分派)。
