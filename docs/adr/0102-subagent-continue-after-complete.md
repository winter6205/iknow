# 0102. 子代理续跑：进程已死则再拉起，不往正在跑的 loop 里塞

Date: 2026-09-18
Status: accepted

Amends ADR-0101（补寿命；不改同轮并行与 `subagent_stop`）。不改 ADR-0014 的 `wait` 默认。不改 ADR-0040 双重 `conversationId` 分工。

## Context

工人 loop 今天只落 per-agent **trace**（`subagents/agent-<taskId>.jsonl`）。主会话续跑吃的是 **session transcript**。两份故意不等（ADR-0071）。父若要同一段工人对话再干一截，再 `spawn_subagent` 会得到失忆工人。

Resume 的含义是：工人**不在跑了**，用它的 transcript 再拉起。还在干活的没有 resume 这回事（那是中途塞话）。失败、崩、超时、被停，与成功交差后再跟一句，机械上同一条路径。闸不能用 TUI 有没有 `✓ Done`。

## Decision

1. **闸 = 进程已死 + 本切片之后写下的工人 transcript。** `subagent_continue` 入参为本会话 `task_id` + 下一句。`running` 拒。`completed` / `failed` / `aborted` 只要有 transcript 均可续。切片之前只有 trace、没有 transcript 的拒，不从 trace 倒灌。
2. **再拉起，不保活。** 新 worker 进程；`load` 工人 transcript 的 rewind head，追加下一句 user，再 `run()`。不是给旧 pid 投递。
3. **工人 transcript：** 形状与主会话同一套 append-only JSONL（SessionFileV1 读路径能吃）。落点在父会话文件夹 `subagents/` 下、**不得覆盖** `agent-<taskId>.jsonl`。键 `(父 conversationId, task_id)`。解析复用 store load/save；`listSessions` 不收录。本切片起每次 spawn 由工人 loop **边跑边 append**。现有 per-agent trace 不动、不当 continue 源。不在项目池另开一棵会话叶子，也不在全局再放一份工人 trace。
4. **对外句柄仍是 `task_id`。** 查 / 停 / 续跑都认它。
5. **等待契约跟普通 spawn。** 省略 `wait` 仍前景；`wait:false` 仍后景 + mailbox。
6. **不做中途注入。** 纠偏 running：停，或等它死后 continue。

## Why not

**Why not 只接 completed：** 失败/崩才是续跑主因。  
**Why not 没画 ✓ Done 就能 continue：** 卡片不是寿命；running 会被误当成 resume。  
**Why not 从 trace 给旧工人造 transcript：** 所见 ≠ 会话历史。  
**Why not 工人占一棵会话叶子：** ADR-0071 已否平级子代理会话。  
**Why not 终态才 dump 一份：** 父只有短信封，拼不出对话链。

## Consequences

- (+) 失败后可带着上下文再试；成功后再跟一句走同一工具。
- (−) worker 必须会写嵌套 transcript；SessionStore 要能按嵌套键 load，不能假定一个 id = 池里一棵叶子。
- (−) 把 `subagent_continue` 扩到 running 必须另改本 ADR。

## Evidence

- ADR-0071 Decision 6 / CONTEXT **session transcript** vs **模型实际所见**。
- `subagents/agent-<taskId>.jsonl` 是 per-agent trace（ADR-0035 / ADR-0071）。
- ADR-0101：`task_id` 是父侧派出句柄。
