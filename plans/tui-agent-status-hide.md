# Plan: TUI agent_status 隐藏 + todo footer 冷启动恢复

**Goal:** `<agent_status>` 注入消息不出现在对话气泡；todo/`last_tool` 现势只在 ContextBar 下方 footer 展示；会话 resume 后 footer 与 transcript 末栏一致，无需等新 turn。
**Approach:** PR #649 T3 已实现流事件 → `AgentStatusPanel`，但漏了 transcript 隐藏与冷启动回填。先补 hide + turn 边界排除，再从 messages 末栏 hydrate `agentStatuses`。
**Spec link:** ADR-0028 + `plans/agent-status-bar.md` T3（follow-up）
**Tracker:** GitHub fallback — 本 follow-up 合单 PR
**ACR:**

```
bounded-context-guardian: yes — hide 归 TUI 展示层；parse 归 harness agent-status SSOT；不读 todos.md
defensive-contract-validator: yes — 无 agent_status 消息 → hydrate null；畸形栏 → null 不 crash
error-handling-enforcer: yes — parse 失败静默 null，不 throw 进 UI
complexity-anti-drift: yes — 复用 isAgentStatusText / OPEN_PREFIX，不第二份 parse
minimal-change-verifier: yes — 2 bullet = 2 commit
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入（persist 段）

（空）

## Tasks (ordered by dependency)

1. **T4a 隐藏 agent_status 注入气泡 + turn 边界排除** — tag: `[implementation]`
   - **Inherits:** ADR-0028：栏进 transcript 给模型看，UI 只读流事件/footer；host 注入不得渲染为 `❯` 用户气泡（同 drain/verify 纪律）。
   - **Surface:** `src/tui`（session-state 隐藏分类）；`src/session-api`（isTurnQuery SSOT）。
   - **Acceptance:** ① `isTuiHiddenUserMessage` 识别 `<agent_status>` 文本。② `chat-view` / `message-blocks` 不出现 `❯ <agent_status>`。③ `isTurnQuery` 排除 agent_status，rewind picker 无栏锚点。④ `message-blocks.test.tsx` + `turn-projection.test.ts` 负例全绿。
   - Status: [ ] pending

2. **T4b Resume 冷启动 hydrate todo footer** — tag: `[implementation]`
   - **Inherits:** ADR-0028：UI 只读最新一份现势，不另建账本；不读 `todos.md` 文件。
   - **Surface:** `src/harness`（parse 末栏纯函数）；`src/tui`（attach / openSessionAt hydrate `agentStatuses`）。
   - **Acceptance:** ① 含 agent_status 历史的 session attach 后，未发新 turn 即见 `◇ last_tool` + `□` todo 行。② 无栏历史 → footer 空。③ 仍不读 todos.md（grep 守卫保持）。④ `app.test.tsx` 或 panel 测试覆盖 resume。
   - [blocks: T4a]
   - Status: [ ] pending

## Out of scope

- 写入口硬顶 #648
- idle 时完全隐藏 `last_tool` 行（T3 AC 要求仍显示）

## Code review phase

两 bullet 落地后整轮 code-review → MCP aiterm TUI 冒烟 → push PR。
