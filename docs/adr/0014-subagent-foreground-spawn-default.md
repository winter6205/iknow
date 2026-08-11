# 0014. Subagent spawn 语义：前景同步为默认契约，异步臂降级为显式选项

Date: 2026-08-11
Status: accepted

## Context

#356 子代理 V1（PR #359 draft）落地后，#361 真链路 e2e（真 LLM + chat pipe，
trace 为 ground truth）实测发现两个叠加问题：

1. **引导层缺失**：`spawn-subagent-tool.ts` description 只写机制不写时机，
   system prompt 无 coordinator 段；4 次 e2e trace 全部 0 个 spawn 调用，
   主代理用 bash/read 直接干活，最终回答中编造"子代理状态 ok"（幻觉）。
2. **收尾层死锁**：V1 唯一契约是"spawn 立即返回 task_id，结果由 host drain
   在下一轮 run() 边界注入 priorMessages"。该契约隐含"一定存在下一轮"假设，
   但 chat pipe 每行 stdin = 一次 run()，轮结束且无后续输入时 drain 永不触发
   → worker 结果永久滞留 buffer，主代理收不到。

异步 fire-and-forget 要求模型具备"spawn 后继续编排、记得回来取结果"的高阶
能力，实测证明当前模型不可靠掌握。参考系：Claude Code Agent 工具与 opencode
task 均以**前景同步**为默认；openharness 的异步 drain 是阻塞轮询到终态而非
被动挂下一轮。

## Decision

产品形态选定**形态 2（模型自动派）**，契约反转 + 引导层补齐，分阶段：

1. **默认契约 = 前景同步**：`spawn_subagent` 增加 `wait` 参数，默认 `true` →
   handler 内 `await manager.waitFor(taskId, { timeoutMs })`，worker envelope
   直接作为 tool_result 返回，当回合闭环。"下一轮"假设从结构上删除。
2. **异步臂保留为显式选项**（`wait:false`）：过渡期 drain 仿 openharness 加
   阻塞轮询（至至少一个 worker 到终态），修 pipe 模式结果丢失；终态是 V2
   **事件驱动唤醒**——host watcher 监测 worker，到终态后 host 自发起 run()
   注入结果唤醒主模型，不依赖用户输入。
3. **引导层必做**：description 仿 opencode 写时机（"Use proactively for
   multi-step exploration, independent verification, or parallelizable work"）+
   前景语义（"call blocks until finished; issue multiple calls in one turn to
   parallelize"）；system prompt 经 `identity/assemble.ts` 流水线加 ~30 行
   coordinator 独立 slot。措辞用"默认阻塞等待"为 V2 追加异步纪律段留空间。
4. **代价收口**：`aci.timeoutTier` 由 `fast` 升长时层；signal abort 传播终止
   worker（in-flight closeout 语义不变）；前景结果作为 tool_result 走契约 X
   executor 截断（ADR-0006 20000 封顶）；并发 worker 上限设常量（建议 4）。
5. **spec 修订**：#356 spec "立即返回 task_id" 承诺改为"默认前景同步，
   `wait:false` 为异步选项"。
6. **验收纪律**：真链路 e2e 断言 trace 出现 spawn_subagent tool_call；
   `messages_captured` 断言模型实际看到的 system prompt 含 proactive 关键词。

## Considered Options

- **形态 1（仅用户显式触发）**：只修 drain 死锁。改动最小但子代理能力等于
  白做，模型永不主动用。被否。
- **形态 3（env gate 混合，openharness 风格）**：`IKNOW_COORDINATOR_MODE=1`
  才注入 coordinator prompt + 激活工具。prompt/测试矩阵翻倍，而"无 manager
  不装配工具"已是可见性 gate。被否。
- **坚持异步默认 + 直接实现事件驱动唤醒**：唤醒需要三入口 host 自发起 run()
  通道 + 静默纪律引导 + 唤醒消息语义区分，机械量大；引导失败时退化形态比
  前景更糟（前景失败是慢，唤醒失败回到幻觉）。列为 V2 而非第一步。被否（暂缓）。
- **砍掉异步臂只留前景**：并行多任务场景（一回合多 spawn 已覆盖 worker 并行，
  但主代理"派完活干别的"编排能力）仍需异步路径。保留为显式选项。被否。

## Consequences

- (+) drain 死锁、轮询反模式、幻觉动机一并被结构消灭：结果当回合返回，
  不存在"等下一轮"。
- (+) 引导层补齐后能力真正被用起来；验收断言防 prompt/语义漂移。
- (+) V1 零件（manager / worker / envelope / drain）全部保留，只反转默认契约，
  非推翻重来。
- (−) 主代理等待 worker 期间不能干别的；UI 阻塞秒到分钟级，需展示 worker
  进度（turn 数 / 当前工具）缓解。
- (−) 违背 V1 spec 原承诺，需修订 spec 与工具描述。
- (−) proactive 引导增加 spawn 频率与 token 成本，靠 maxTurns/timeoutMs 默认值
  与并发上限收口。
- 回退 = `wait` 默认值反转回异步 + 恢复 drain 被动注入；引导层与验收断言
  独立于该回退。

## Evidence pointers

- issue #361 — 实测证据（4 次 e2e trace 0 spawn、幻觉报告）与根因分析。
- issue #356 / PR #359 (draft) — V1 实现（worktree `spec-356-subagent-v1`：
  `src/harness/subagent/` spawn-subagent-tool / host-drain / manager / worker）。
- `src/cli/chat-session.ts` — drain 调用点（run() 边界注入 priorMessages）。
- opencode `packages/opencode/src/tool/task.ts` + `task.txt` — "Use proactively"
  引导范式。
- `upstream-openharness/src/openharness/ui/coordinator_drain.py:62-86` —
  阻塞轮询到终态的异步 drain 参照（只读）。
- `docs/CONTEXT.md` — 术语「host drain」「前景 spawn / 后景 spawn」。
