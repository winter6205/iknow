# Session Handoff — issue #888 save-fork 根因修复 (2026-09-05)

## 当前 live 状态

- **任务**: 修复 issue #888「worktree rebind 后 run 从根部重新执行整轮」——根因已定位并实证，失败测试已写好（2 红 1 待解释），待实施最小修复并红转绿。
- **为什么重要**: 任意 run 的收尾 save 会 fork 出错误分支，孤儿化真实历史，使后续 run 丢失上下文从 query 重放——token 与延迟双倍，且**与 rebind 无关、系统性存在**。
- **operator 显式指令**: 「你作为架构专家，读取issue888，并创建worktree做完整修复」（systematic-debugging skill 驱动）；本次中断时追加「把你检测到的成果交接到下一个会话继续探索修复」。

## 已固化工件（引用，不复制 inline）

| 类型                               | 路径 / URL                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| issue                              | https://github.com/winter6205/iknow/issues/888                                       |
| 故障 session JSONL（ground truth） | `~/.iknow/sessions/iknow-ddcb805367a0/0c379686-fcdf-496b-95b4-6df560b1bcef.jsonl`    |
| 故障 trace（仅 run 1，turn 0–9）   | `/home/winner/projects/iknow/trace/0c379686-fcdf-496b-95b4-6df560b1bcef.jsonl`       |
| 既有第二个 fork 实证（67cb114c）   | `~/.iknow/sessions/iknow-ddcb805367a0/67cb114c-62c1-4b84-bc70-a07860d1157e.jsonl`    |
| commit 纪律先例                    | `tests/harness/loop-engine-commit.test.ts`（#620 T3）                                |
| 栏注入缝                           | `tests/harness/agent-status-bar.test.ts` + `tests/harness/_agent-status-fixtures.ts` |

## 根因（一句话）

loop-engine 在每次调模型前注入内存权威历史的消息（`<agent_status>` 状态栏，loop-engine.ts:1711 `appendAgentStatusBar`）**从不经过 `commitMessages` 落 JSONL 链**；run 结束后 host save（hub `conditionalSave` / chat `persistChatSessionCheckpoint`）把含注入消息的内存投影与纯 commit 链做 LCP 对齐，在第一条注入消息处（index 1）判为 divergent → `planSessionSave`（session-store.ts:808）fork 出 `parent=e0` 的新分支，e1–e18 孤儿化。

## 证据链（四重独立信号，勿重查）

1. 分支 2 的 tool_use id 与分支 1 **逐字节相同**（`call_01a06daa45197eb0812d0ed9` 等 5 处）——API 生成的 id 不可能重放重现 → 分支 2 是**拷贝不是模型重放**；
2. 分支 2 事件全部**无 createdAt**（`appendEvents` 必带；save-fork 的 `buildEventRecords` 不带）；
3. 分支 2 事件间无独立 head 记录、尾部一个 head —— save-fork 特征；
4. trace 只有**一个 run**（消息数 2,5,8…29 线性增长），turn 9 请求已含 29 条全上下文 —— 模型没有第二遍 LLM 请求。

⚠️ issue #888 的「第二遍 thinking/bash 逐字相同 = run 从根部重新执行」是误读；trace turn 8 的 create-task-worktree 回执后模型仍**冗余再次调用**了它（上下文完整仍误读回执，模型行为问题，非本票范围）。

## 本 session 变更

| 变更（文件路径）                                    | 一行效果                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/harness/loop-engine-injected-commit.test.ts` | 新增失败测试套件（worktree `issue-888-save-fork`，未 commit）：2 红（completed/cancelled 的 commit 流缺注入消息）+ 1 绿待解释（e2e，见下方首个 next step） |

## 已验证状态

```
npx vitest run tests/harness/loop-engine-injected-commit.test.ts
=> exit 1: Tests 2 failed | 1 passed (3)；失败断言 flat([]) vs tail(含 bar/system)
   —— 红即预期（commit 流缺注入消息 = 根因直接观测）
```

## Open blockers + next steps

**[NEXT] 解释 e2e 用例为何绿**：`tests/harness/loop-engine-injected-commit.test.ts` 的「end-to-end」用例在 2 红同文件下**绿了**，与根因推理矛盾（预期 fork → orphans>0 → deepEqual 失败）。动作：在 e2e 用例里临时 `console.log(JSON.stringify(log, null, 2))` 或 `cat` 持久化后的 JSONL，核对 (a) chain 实际事件 (b) `planSessionSave` 走了哪个分支（identical/extension/prefix/fork）。可能性：run("x") 的 commit 流不含 query（chat 懒提交纪律），链=[assistant,tr] 2 条 vs 投影 6 条 LCP=0 → fork parent=null，投影仍 deepEqual 成立但 orphans 应=4≠0——若 orphans 断言也绿，说明 e2e 的 abort 时序（50ms setTimeout vs 200ms 模型延迟）导致 cancelled 发生在首次 commit 前，链为空、无 fork。核对后修正用例时序（abort 打在第一次 tool_result commit 之后，如 S12 用 `controller.abort()` 在 adapter.step 内回调），再进入修复。

- **修复形态（根因最小改动，仅 `src/harness/loop-engine.ts`）**：注入消息累积进 pending 缓冲；assistant commit 批改为 `[...pending, assistant]`、tool_result commit 批改为 `[...pending, tool_result]`（flush 即清空）；cancelled 停止路径在 `appendSystemInterrupt` 前把 pending + system interrupt 一起 flush；protocolError / emptyFinalResponse 丢弃 pending（维持 #120 裁决）。先例：loop-detected envelope 已走 commit（loop-engine.ts:2094）。
- **注意 `queryCommitPrefix` 对齐**：hub 的懒提交 query 前缀（hub.ts:1413–1424）与 chat 的 `buildUserCommit` 前缀必须与 pending flush 后的批序保持字节一致（LCP 对齐契约），否则修好一处又在 save 处 fork。
- **顺带核实**：graph 切换注入（`appendGraphModeChange`）、MCP 重连注入（`appendMcpReconnect`）、loop envelope 与 reactive-compact 重试路径的注入是否同样需要 pending（应同一缓冲覆盖全部注入点）。
- 修复完成后：跑 `npm test` 全量 → `arthurpower:code-review` → `arthurpower:verification-before-completion` → commit（Conventional Commits，1 commit = 1 logical task）。

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:systematic-debugging` — 延续 Phase 4（FIX）：失败测试已在手、根因已一句话锁定，直接进最小修复。
- `arthurpower:code-review` — 修复落地后的收尾审查。

## 脱敏

- 无 API key / token / password / credential 值出现
- 无凭据涉及
