# Spec: 会话 JSONL 续跑（对齐 Claude Code 账本）

> 来源：#615 grilling（2026-08-22）。第一轮整份 JSON + rewind 截断是脚手架，不是与 Claude 分叉。
> UX 合同仍见 `checkpoint-rewind.md`（picker / 双 Esc / 用户消息锚点）；本 spec 换的是**存盘与 rewind 语义**。
> 推翻 `specs/120-session-persistence.md` Q1「本期不迁 JSONL」（当时无 ADR 文件；本决策落 ADR-0027）。

## Problem

`run()` 返回前 `state.messages` 只在内存；落盘是整份 `SessionFileV1` 覆盖。turn 内崩溃等于该 turn 没发生。`checkpoints[]` 是打断/rewind **下标书签**，不存事件。rewind 截断盘上历史，退回去的分支不可恢复。崩溃后续跑、fork 留分支、边跑边写，都做不到。

## Solution

会话权威历史改为 **单文件 append-only JSONL**（每条事件有 id 与 parent）。进程内工作副本跟当前 **rewind head**（落盘的头指针）。模型完成后立刻 append assistant；每个工具结束后立刻 append 该条 tool_result。load/resume 时未配对 `tool_use` 用现有 `encodeToolResults` 补洞，再发给模型。rewind 改当前头，旧链留在文件里。

## Implementation Decisions

1. **单文件 JSONL** 为会话权威；`messages[]` 不再是第二份真相。trace JSONL 仍是观测，不是会话。
2. `goal` / `cwd` / `title` / schema 元数据做 JSONL **头记录**（或文件内等价 session 记录），不另开 `meta.json`。
3. `checkpoints[]` 改为指向事件 id 的锚点，不再用 `messagesCount` 当下标 SSOT。
4. Loop Engine **零 IO**：host（hub / chat-session）注入 commit 钩子；harness 不出现 checkpoint 落盘。
5. 补洞三分，走现有 `execution_failed` encoder：
   - 用户 Ctrl+C → `cancelled` + system `Interrupted by user.`（现有）
   - 超时 → `timeout`，不加那句 system（现有）
   - 进程没了 → `process`（`InterruptReason` 已预留），**不加** `Interrupted by user.`
6. mutating 工具（`bash` / `edit_file` / `write_file`）的 `process` 文案须指示模型：**先检查副作用是否已生效，未生效再重跑**。只读工具不必。
7. 旧 `SessionFileV1` JSON：load 不炸；下一次 save 迁成 JSONL。#120 Q6（任何入口读同一份盘）仍成立。Save 不再写 `.json` 兼容镜像（#629 已落）—— 单文件 JSONL 是唯一权威形态；`load` 仍保留 `.json` fallback 作为迁移窗口的读入口。
8. 温度缺省省略、不 fallback 0：正交，**不在本 spec**。

## Testing Decisions

- empty：无事件 / 空会话 rewind 空态仍 `"Nothing to rewind to yet."`
- negative：`process` 补洞不得附带 `Interrupted by user.`；只读工具 `process` 文案不含「先检查再重跑」
- overflow：超长 tool_result 仍走既有 executor 截断权威，JSONL 写已截断后的块
- concurrent：同一会话 serialize 队列仍防 `concurrent_write`；commit 钩子不得绕开该队列
- exception：磁盘上半截 JSONL 末行损坏 → load 丢掉坏行并仍能组出 API 合法历史（或命名 EXIT：拒绝 load 并报 typed error，二选一由实现定，测试锁一种）
- 跨入口：TUI save → serve load 同一 JSONL，head 与可见 transcript 一致

## Out of Scope

- 长期记忆（`memory_save` / `memory_recall` / ADR-0009）
- 文件系统 checkpoint（还原工作区；Claude 另开的能力）
- claim-before-execute / 占坑表（不消灭「写盘成功、JSONL 尚未 append」窗口）
- resume 强制 `temperature=0`；`IKNOW_LLM_TEMPERATURE` fallback 改省略（另票）
- 把崩溃续跑写进 `CheckpointRecord.messagesDelta`
- 改 compact 触发 / 任务摘录 / goal

## Objective

chat / TUI / serve 的会话在崩溃或 rewind 后，从 JSONL 当前头继续，且 API 请求不含未配对 `tool_use`。成功 = 边跑边写可测、半截 turn 补 `process`、rewind 留分支且重启仍停在退到的头。

## Boundaries

- **Does:** 上列 Implementation Decisions 1–7。
- **Out of this spec:** 上列 Out of Scope。
- **Inherits:** `checkpoint-rewind.md` 的 picker UX（L3 / L0 空态文案 / 无消息级删除 / 确认 gate）。截断落盘与 `messagesCount` 书签 SSOT **不再 inherit**。
- **Harness:** `src/harness/` 仍禁词 `checkpoint`（Gate B）；commit 钩子用既有 deps 注入，不把 session-api 类型拖进 loop-engine。

## Success Criteria

```bash
npm run typecheck
npx vitest run tests/session-api tests/cli tests/harness/loop-engine.test.ts tests/harness/loop-engine-commit.test.ts
bun test tests/tui/rewind.test.ts tests/tui/hub-bridge.test.ts
```

每条 yes/no：

- 新会话落盘为 JSONL；事件含 id 与 parent；存在可持久化的 rewind head。
- 旧 v5 JSON 会话 load 不炸；随后 save 为 JSONL，重建出的当前头 transcript 与迁之前 messages 在 API 合法前缀上等价。
- stub 两工具串行：第一个 tool_result 已 commit 后中断 → 盘上有第一条结果、没有第二条；resume 补第二条为 `process`。
- 未配对 `tool_use` 不得出现在发给 adapter 的 messages 里。
- `process` 补洞：无 `Interrupted by user.`；mutating 工具结果文本含先检查再重跑之意；`cancelled` 路径仍有那句 system。
- rewind 到更早用户锚点后 reload：head 仍是该锚点；被跳过的链仍在同一 JSONL。
- hub 与 chat-session 经同一 store 读同一文件（#120 Q6）。
- `npm run typecheck` 与上列 vitest 路径 exit 0。

## Open Questions

(none)

## architecture-change-reviewer

```
bounded-context-guardian: yes — JSONL 与 rewind 头在 session-api/store；loop-engine 只吃 commit 钩子、零 IO；trace JSONL 仍 traceserver/harness/trace；记忆层不碰
defensive-contract-validator: yes — Testing Decisions 覆盖 empty / negative / overflow / concurrent / exception；Success Criteria 可测
error-handling-enforcer: yes — 半截 tool_use 的 EXIT 是 process closeout（typed execution_failed），不是丢历史或当 cancelled；坏末行 load 有命名 EXIT
complexity-anti-drift: yes — 事件 log 与 rewind 投影分开；补洞复用 encodeToolResults，不新编码器；不把 compact/memory 拉进同一模块
minimal-change-verifier: yes — 1 个逻辑任务（会话账本对齐 Claude Code）；温度/记忆/占坑表/文件 checkpoint 排除
```
