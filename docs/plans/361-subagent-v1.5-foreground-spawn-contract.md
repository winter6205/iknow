# #361 子代理 V1.5 前景 spawn 反转 · 契约文档（SSOT）

Status: active（ACR 5/5 维度判定：bounded-context ✓ / defensive-contract → 本条已补齐 / error-handling → 本条已补齐 / complexity ✓ / minimal-change ✓）
Scope: ADR-0014 V1.5，8 个源码文件 + spec + tests
Branch: `feature/v1.5-foreground-spawn`（worktree spec-356-subagent-v1）

## 5 项类型化契约（ACR no→yes 的凭据）

### C1. 并发上限 MAX_CONCURRENT_WORKERS = 4

- **常量位置**：`src/harness/subagent/manager.ts`，`export const MAX_CONCURRENT_WORKERS = 4`。
- **触发点**：`manager.spawn(def)` 入口。当前 `running + starting` 任务数 ≥ 4 时，**立即抛 `SubAgentCapacityError`**（manager.ts 内新增类，`extends Error`，字段 `{ status: "failed", reason: "capacity", active }`）。
- **handler 面**：`spawn-subagent-tool.ts` handler catch 后**重抛 `ToolExecutionError`**，消息含：`spawn_subagent: at capacity (4/4 concurrent workers). Retry after a worker completes or reduce parallelism.`
- **显式失败 > 静默排队**：不 queue、不 block。模型收到清晰错误可自行降并发重试。
- **测试**：第 5 个并发 spawn → handler 抛 `ToolExecutionError`（message 含 capacity）。

### C2. host-drain 异步阻塞轮询 + 超时守卫

- **签名**：`drainPendingSubagents(manager: SubAgentManager | undefined, opts?: { pollMs?: number; timeoutMs?: number }): Promise<string>`。
- **行为**：无 manager / 无任务 → 立即 `""`。任一 completed → **立即返回**拼接结果（不等其它 running）。仅 running → 每 `pollMs`（默认 100）轮询，至 **≥1 个任务到终态**返回，或 `timeoutMs`（默认 30_000）耗尽返回 `""`。
- **超时守卫语义**：超时**静默返 `""`**，不抛（异步臂不得砸掉下一轮）。
- **drain 永不抛**：任何内部 waitFor 拒绝（C3/C4）都被 catch 并视为终态 → 返回已完成的部分结果或 `""`。
- **drain 串行语义（review-fix S3 加注）**：drain 一次只等 `listActive()[0]`（首项活动任务）—— 串行逐个等。n 个并发任务同时到终态需 `(n-1) × pollMs` 才能全部收敛（每轮只收一个 completed，其余仍在 buffer 缓存；OQ5 buffer 永久缓存直到 shutdown）。`timeoutMs` 覆盖"等待首个终态"的总预算，不是"全部任务收敛"的预算。
- **调用点**：`chat-session.ts:156-170`、`hub.ts:550-557` 改 `await drainPendingSubagents(...)`（两处原同步调用升 async）。
- **测试**：空 manager→`""`；多 completed→拼接；仅 running 且 mock 后置终态→阻塞后返回；永不终态→`timeoutMs` 到→`""`。

### C3. waitFor abort-signal 类型化拒绝

- **签名**：`waitFor(taskId: string, timeoutMs?: number, signal?: AbortSignal): Promise<SubAgentEnvelope>`（第三参新增）。
- **abort 语义**：`signal` abort → **reject `SubAgentAbortError`**（manager.ts 新增类，`extends Error`，字段 `{ status: "failed", reason: "aborted", taskId }`），与 `SubAgentWaitTimeoutError` **类型区分**（abort ≠ timeout）。
- **监听生命周期**：abort listener 在 resolve/reject 后**清理**（防泄漏）；已终态首查路径同 waitFor 现逻辑（首查即终态 → 立即 resolve，不经 interval）。
- **测试**：`AbortController` 触发 → `assert.rejects(..., SubAgentAbortError)`；abort 前已终态 → 正常 resolve；resolve 后 abort 不报错。

### C4. drain 中途 waitFor 拒绝的错误路径

- **契约**：阻塞轮询期间 worker 失败（abort/timeout/crash）→ **视为终态**：停止轮询、返回已完成部分结果、**永不 throw**。
- **实现约束**：drain 优先用 `drainCompleted()`/`queryBuffer()` 取结果；仅当需等待时走 `waitFor` 并以 try/catch 包住——拒绝即终态。
- **单任务终态拒绝 → drain 立即返 partial（review-fix S9 加注）**：任一活动任务终态（含 waitFor 拒绝视为终态）→ drain **立即返回**当前已完成的部分结果，**其余 running 任务的结果留待下次 drain**（本轮不再继续等）。下一次 `run()` 边界再调 drain 时收敛。这是 C2 串行语义的自然推论 —— drain 不等"全部任务收敛"，只等"≥1 终态"。
- **测试**：mock 一个 waitFor 拒绝 + 另一个已完成 → drain 返回已完成项、不抛。

### C5. spawn_subagent handler EXIT 文档（abort vs timeout 归因）

| 场景                                                              | EXIT                                                                                                                                    |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| wait:true + 正常完成                                              | `{ kind: "ok", payload: envelope }`（executor 20000 截断，天然复用）                                                                    |
| wait:true + worker 失败（crashed/protocolError/per-task timeout） | **成功 tool_result**，payload = `status:"failed"` 的 envelope（失败是数据，非异常；模型读 summary/reason——in-flight closeout 语义不变） |
| wait:true + 调用侧 abort（`ctx.signal`）                          | handler 抛 `ToolExecutionError` → executor 返 `execution_failed: "cancelled"`（归因 **abort = 调用侧取消**）                            |
| wait:true + per-task timeout                                      | worker 终态 envelope `reason:"timeout"`（归因 **timeout = worker 侧数据失败**）                                                         |
| wait:false                                                        | 立即 `{ task_id }`（异步臂，无等待）                                                                                                    |
| 并发超限                                                          | `ToolExecutionError`（C1）                                                                                                              |

**归因判据**：abort 由 `aci-executor.ts:185-209` effectiveSignal（callerSignal ∪ tierAbort）在 handler 层触发 → `ToolExecutionError → execution_failed:cancelled`；worker 超时由 manager per-task timer 触发 → `envelope.reason:"timeout"` 作 ok 数据返回。二者类型互斥，EXIT 可断言。

**C5 加注（review-fix S2，默认 timeout 语义收口）**：默认 `timeoutMs`（缺省 = `PER_TASK_TIMEOUT_MS` 300s）是**纯安全网** —— manager 内部 per-task 计时器与前台 waitFor 同窗 300s 收敛：worker 在墙钟内完成则此路径不触发；缺省路径由前台 `waitFor` 收口 —— waitFor 到点（300s）reject `SubAgentWaitTimeoutError`，到点前若 worker 已终态（completed/failed）则 waitFor 把 failed envelope 作 ok 数据返回。**只有显式 `timeoutMs < 300s`** 且 worker 到点未完成时，才走本表 `per-task timeout` EXIT 行（manager per-task timer 先 SIGTERM → waitFor 看到 failed → failed envelope 作 ok 数据返回；显式 < 300s 让 per-task timer 严格先于 waitFor deadline）。

## 附带强制项（ACR 证据 #d）

- **`spawn-subagent.test.ts`「handler 同步 ≤50ms 返回 `{task_id}`」断言已重写为前景契约**（review-fix S10 描述引用同步 —— 旧描述 ≤50ms 同步 arm 关联到了旧 sync handler 设计；新版工具 description 已切到前景 proactive 文案）：handler 返回 Promise，fake manager 的 `waitFor` 立即 resolve → 断言 handler 解析为 envelope；≤50ms 同步断言已删（与 `wait:true` 默认互斥）。工具 description（`spawn-subagent-tool.ts:54`）同步为前景 proactive 文案 —— "Use proactively for multi-step exploration, independent verification, or parallelizable work. The call blocks until the sub-agent finishes and returns its full result directly — just call it like any other tool." `background:true → ToolExecutionError` 测试保留。

## 引导层（T8）硬约束

- 加性段置于 assemble.ts 5 段 LOCKED 之后、skills 段之后（`projectPathSegment` 先例，零字节扰动、KV 缓存稳定）。
- **仅 `subagentManager` 存在时注入**：build-engine.ts 经 `createIknowSystemResolver` opts 传入 coordinator 文本，条件 = subagentManager 装配（与 registry 条件同源）。
- **文案必须含验收6 关键词**：`proactive` / `parallelizable` / `blocks until finished`（model 实际可见）。内容覆盖：两工具是谁 / 何时派 / 前景默认"阻塞等待结果" / 一回合多 spawn 并行 / 结果处置。
- **`IKNOW_ASSEMBLY_ORDER` 五段 LOCKED 顺序不碰**；`toolList` 缝（build-engine 未注入）互不影响。

## 测试冲突清单（T11 必须覆盖）

1. C1：第 5 个并发 spawn → capacity ToolExecutionError
2. C2：drain 空/多/阻塞后置终态/超时守卫
3. C3：waitFor abort → SubAgentAbortError；已终态 abort 无副作用
4. C4：drain 中途 waitFor 拒绝 → 返回部分、不抛
5. C5：wait:true 失败 envelope 作 ok 返回；abort → execution_failed:cancelled
6. T13：per-task 默认 5min（`PER_TASK_TIMEOUT_MS=300_000`）对齐（修复注释 vs 实际 30s 不一致）
   - **T13 加注（review-fix S2）**：默认 `timeoutMs=PER_TASK_TIMEOUT_MS` 是纯安全网 —— 缺省路径由前台 `waitFor` 收口（waitFor 到点 reject `SubAgentWaitTimeoutError`，到点前 worker 终态则 failed envelope 作 ok 数据返回）；**只有显式 `timeoutMs < 300s`** 才走 `reason:"timeout"` EXIT 行（per-task timer 严格先于 waitFor deadline）。见 C5 加注。
7. T12：messages_captured 三处（loop-engine.ts:427/948/970）置 true + coordinator 段 proactive 断言

## 保留不变（ADR 明言不推翻）

manager 状态机/buffer、worker 独立进程、envelope 结构、25 件工具面 append-only（`background` 参数保留）、嵌套 spawn 双层禁令、20000 截断。

## ACR Verdict（architecture-change-reviewer · 5-verdict gate · V1.5 收口）

bounded-context-guardian: yes — subagent 层改动限于 src/harness/subagent/ 与 registry/executor 契约面，未跨模块反向依赖
defensive-contract-validator: yes — C1-C5 五类边界测试已列于「测试冲突清单」，六类覆盖（正常/失败/边界/权限/空非法/并发）
error-handling-enforcer: yes — C5 EXIT 归因表类型化（abort=调用侧取消 / timeout=worker 侧数据失败），drain 永不抛
complexity-anti-drift: yes — 改动为常量+参数扩展，无新增循环/嵌套/克隆
minimal-change-verifier: yes — 1 逻辑任务（#361 V1.5 前景契约反转），1 commit 落地
