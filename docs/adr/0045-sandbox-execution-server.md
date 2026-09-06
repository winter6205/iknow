# 0045. sandbox 执行面 server 化：同进程 router + 两型协议（短生命周期 / 长生命周期 task-handle）

Date: 2026-09-06
Status: accepted

> 本 ADR 承接 `plans/closed-world-bash-fence.md` T7 决策 ticket，落定 sandbox 执行面的边界形态与消息合同；T8 据此实施。本 ADR 只锁合同边界（消息形状、超时/中断、截断、fail-loud、IPC 故障分型），文件 / 模块 / 类型名留给实施 bullet。
>
> ADR-0022 / ADR-0037 §9 继续管辖 bash 围栏的**物理语义**（per-call network opt-in、闭世界白名单、fail-loud 分型）；本 ADR 只挪**执行面位置**（in-process 直调 → server 边界），不改 fence argv 形状、不动白名单、不动 `--unshare-net` 行为。

## Context

`sandbox/execution` 面今日为 in-process 直调：bash tool（`src/harness/aci/tools/bash.ts:218-224`）经 `runInSandbox` → `spawnWithStopSignal` 同步等子进程退出；background（`src/harness/background/manager.ts:239-291` 的 `defaultBackgroundSpawn`）绕过 `runInSandbox`，**直接** `nodeSpawn(fence.argv[0], …)` 起 detached 进程组，host 侧持 `child.pid` 落 `record.pgid`（`manager.ts:388`），`bash_stop` 在 host 侧经 `process.kill(-pid, …)` 升级（`manager.ts:587-624`）；verify（`src/harness/verify/sandbox-run.ts:60-77` 的 `makeDefaultRunVerify`）经 `runInSandbox` 同步等子进程退出。三处装配虽 fence argv 同源（`createBwrapFence` + `createClosedWorldFsPolicy`），但**执行体裸用 `node:child_process`**——bash 工具经 `runInSandbox`、background 经 `nodeSpawn`、verify 又经 `runInSandbox`，是三条不同的 `child_process.spawn` 接入点。

2026-09-06 `plans/closed-world-bash-fence.md` Round 2 ACR（bounded-context-guardian / defensive-contract-validator / error-handling-enforcer）开轨评审的 `unclear/no` 项指出三个缺口：

1. **缺统一执行面**——三处独立 spawn 入口，未来接新隔离 / 新资源限制 / 新 audit 钩子时三处同改，违反 `min-change-verifier`。
2. **缺 IPC 边界 5 类故障路径（empty / negative / overflow / concurrent / exception）的统一合同**——今日各自 catch `child.once("error")` 与 `truncateByCodePoint` 落点，`RangeError` / 空帧 / server-down mid-spawn 在 background 路径完全裸奔。
3. **缺失败合同（server 不可达 / signal abort）**——若直接退化为 in-process spawn，等于悄悄旁路 ADR-0037 §9 闭世界围栏物理合同，违反 `error-handling-enforcer` 的「fail-loud 不静默降级」纪律。

`BwrapFence` 本身已经是 `Object.freeze({argv, sealed: true})` 的纯数据 token（`bwrap.ts:172`）——**无 IPC 状态、无跨会话状态、无跨进程 mutable state**；现有 `session-api/http.ts:8787`（TCP 127.0.0.1 暴露给 SPA / 外部 CLI 客户端）和 `traceserver/serve.ts` 都是给**进程外**消费者用的 HTTP server。bash sandbox server 的三个消费方全部在**同一 Node 进程内**（harness CLI / chat / hub），引入跨进程 IPC 边界（Unix socket / fork / TCP loopback）对纯数据 token 形态是 over-engineering。

本 ADR 裁决：把执行面整理成 **同进程 router**（参考 `createTraceRouter` 的 mountable router 形态，`traceserver/serve.ts:51-83`），由 `runInSandbox` 等直调变成 router handler；不 fork 子进程、不起独立 daemon、不走 Unix socket；协议分两型（短生命周期 request/response、长生命周期 task-handle）覆盖前台 / verify / 后台三类调用方。

## Decision

### 1. server 形态：同进程 router（mountable，模块边界）

新模块 `src/harness/sandbox/server/` 暴露 `createSandboxServer(opts)`，返回一个 in-process router（`(req: SandboxRequest) => Promise<SandboxResponse>` 或对长生命周期 task-handle 的 `AsyncIterable<SandboxTaskEvent>`）。形态镜像 `createTraceRouter`（`traceserver/serve.ts:61`）——纯工厂、无 server、无共享 mutable state；调用方在 harness 装配期持一份 router 引用，三处消费方（bash tool / background manager / verify）共用。

**不**做的事（明确否决于 §3 Alternatives）：

- **不 fork 子进程跑 server**——fence 是纯数据 token，fork 把无状态 token 装进独立进程，引入与主进程无关的 state，违反「fence 是纯数据 frozen argv token」的最小化。
- **不起独立 daemon / TCP server**——三个消费方全部在同一 Node 进程内，daemon 强制跨 IPC 边界给同进程消费增加延迟、复杂度、端口冲突、生命周期治理（supervisor / reaper / heartbeat）新成本。
- **不走 Unix socket / `child_process.fork` 的 IPC channel**——仓库无 Unix socket 或 fork 先例（grep `child_process.fork` / `net.createServer` / `unix:` 均为零命中），引入全新基建面；同进程 router 用函数调用即可，不需要 IPC channel。

`runInSandbox` 在迁移期内**降级为 router handler 的薄包装**——直接 `router(req) → response`，不做 `child_process.spawn` 直调。**降级 = 不删**（兼容既有 30+ 测试 fixture），但其 spawn 调用点经 server 边界表达；T8 验收 (a) 写「in-process 直调路径删除或降级为 server 内部实现」，本 ADR 选「降级」，删除由后续 ticket 在所有 fixture 迁完后裁决。

### 2. 运行时合同：两型协议（短生命周期 / 长生命周期 task-handle）

#### 2.1 短生命周期 request/response（前台 + verify）

适用：bash tool 前台（`bash.ts:218-224` `await runInSandbox(...)`）、verify（`sandbox-run.ts:71-77` `await runVerify(...)`）。调用语义 = 等子进程退出、取一次性结果。

消息形状（合同边界，具体类型名留给 T8）：

```
request:
  kind: "exec"
  fence: BwrapFence          # 纯数据 frozen argv token, 不变
  cwd: string                # 来自 waveRoot(ADR-0037 §7.2 batch 快照)
  env: NodeJS.ProcessEnv     # 已 envIsolation.filter() 的 fenceEnv
  signal?: AbortSignal       # ctx.signal
  maxOutputCodePoints?: number   # 缺省 = DEFAULT_MAX_OUTPUT_CODE_POINTS (12_000)
  killGraceMs?: number       # 缺省 = 2_000 (沿 runner.ts:18)

response:
  exitCode: number           # null → signalExitCode(signal)
  stdout: string             # 已按 maxOutputCodePoints 截断
  stderr: string             # 同上
```

**截断沿用** `DEFAULT_MAX_OUTPUT_CODE_POINTS = 12_000`（`runner.ts:16`）的 **code-point** 截断，`truncateByCodePoint` 契约（`runner.ts:84-89`）不在 server 形态下改变。`SIGNAL_EXIT_CODES` 映射（`runner.ts:21-54`）不变。

#### 2.2 长生命周期 task-handle（后台）

适用：bash tool 后台（`bash.ts:160-167` → `manager.spawn` → `defaultBackgroundSpawn`）。调用语义 = fire-and-forget spawn + log stream + stop control。

消息形状：

```
spawn request:
  kind: "spawn"
  fence: BwrapFence          # 同 2.1
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal       # ctx.signal
  killGraceMs?: number       # 沿 2.1
  recordCommand?: string     # 占位符形态( #406 roundtrip)
  conversationId?: string    # ctx.conversationId

spawn response (一次性, 同步 resolve):
  task_id: string            # "bg-" + 12 hex, 沿 ADR-0021 D1.7
  log_path: string

task event stream (AsyncIterable, 长生命周期):
  kind: "stdout" | "stderr" | "exit" | "stopped"
  chunk?: string             # stdout/stderr
  exit_code?: number         # exit 事件
  signal?: NodeJS.Signals

stop control message:
  kind: "stop"
  task_id: string
  graceMs?: number           # 缺省 2_000
```

`bash_stop` 仍经 host 侧 `process.kill(-pgid, …)` 升级（`manager.ts:587-624`），**不绕过 host 直接发信号**——task-handle 协议把"kill 升级的中间状态"封装进 server router，client 只发 `stop` control message，不直接 import `node:child_process`。pid 物理所有权**仍在 host**（`child.pid` 落 `record.pgid`），与 `bash_stop` 经 server 转发 `kill(-pgid)` 是**协议层抽象**，与「pid 在哪个进程内持有」正交——同进程 router 形态下二者天然重合（host = server），独立 daemon 形态下二者才会分裂；本 ADR 选同进程 router，`pid ownership transfer` 不在本 ADR 范围。

#### 2.3 超时与中断

- `ctx.signal` abort → **client 侧**：发 `stop` control message（task-handle 协议）或取消 await（短生命周期协议）。**不只丢 client promise**——server router 收到 abort 必须把信号传到 fence 子进程（task-handle 走 `kill(-pgid)`、短生命周期走 `spawnWithStopSignal` 的 abort listener，`runner.ts:131-132`）。
- timeout（`maxOutputCodePoints` / `killGraceMs`）在 spawn 端按既有 `spawnWithStopSignal` 升级路径处理，不在 router 层加额外 timer。

### 3. violation-handling 归属：留 client 侧

`violation-executor.ts`（后置 hook，executor 层 wrap）是**应用层观察者**，观察 `tool_result` 文本前缀（`VIOLATION_PREFIXES`），与 sandbox 内部完全解耦。裁决：留 client 侧（`executor` 仍 wrap），不进 server。

理由：

1. **violation 分类依赖 tool 层语义**（permission_denied / dangerous / sensitive path / escape attempt），这些语义都在 client 侧（bash tool handler 的 `isDangerousCommand` / `commandContainsSensitivePath`），server 看到的是已 spawn 的 fence 子进程的 stdout/stderr/exit_code，**没有 tool 层语义可分类**。
2. **kill-session 钩子是会话级语义**（counter 累计 → session-level escalation），不是 sandbox 子进程级语义；放 server 侧会跨边界泄漏会话状态。
3. **server 跨进程化后（未来如果发生），violation hook 走 IPC 观察 server 回执是反向耦合**——server 是被观察对象，不是观察者。

后置 hook 在 server 化后**消费面不变**：client 拿到 `response` 或 `task event` 后仍走 `wrapWithViolationHook`，按既有 prefix 匹配分型。

### 4. IPC 边界 4 类故障路径（合同分型）

server 形态下，IPC 边界（router 调用本身——同进程下为函数调用，跨进程下为 IPC message）须覆盖 4 类故障(overflow 已并入 §2.1 truncateByCodePoint 契约)。

| 边界类         | 触发条件                                                                    | 合同                                                                                                                                                                                 | 测试面                             |
| -------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| **empty**      | request 帧缺失 `command`（spawn）/ `fence`（exec）字段 / `task_id` 字段     | typed fail-loud（`ToolExecutionError` 系），**不 spawn**、不返回 fake response                                                                                                       | T8 (e) 配套测试                    |
| **negative**   | `maxOutputCodePoints <= 0` / `killGraceMs < 0`                              | `RangeError`，沿 `runner.ts:84-86` `truncateByCodePoint` 契约不丢失                                                                                                                  | T8 (e)                             |
| **overflow**   | 子进程 stdout/stderr > `maxOutputCodePoints`                                | router handler 按 `truncateByCodePoint` 截断后再下发，**不**抛 typed error(`SandboxServerError` 联合不含 overflow kind,§2.1 语义已如此)                                              | T8 (e)                             |
| **concurrent** | 多个 request 并行（同一 router 实例）                                       | fence 无共享 mutable state（fence argv 冻结、fsPolicy 工厂期 / per-call rebuild 各自独立、`createBwrapFence` 返回 frozen token），并行允许，决策**显式记录**                         | T8 (e) 配套测试覆盖并发 fence 构造 |
| **exception**  | server 不可达（未来跨进程场景）/ accept 后子进程退出未回执（orphan 进程组） | typed fail-loud + **orphan 进程组 reap 纪律**——router 必须在子进程退出但 frame 解析失败时显式 `process.kill(-pgid, SIGKILL)`，参考 `background/stale-reap.ts:184`（pgid-reuse 加固） | T8 (e)                             |

同进程 router 形态下「server 不可达」物理上不发生（函数调用 stack trace 自然冒泡），但合同仍写明 typed fail-loud 语义——为未来跨进程化留接口稳定，**不**为「反正同进程不会失败」省略测试覆盖（违反 `min-change-verifier` 的契约稳定性）。

### 5. 失败合同（fail-loud 不降级）

- **server 不可达** = typed fail-loud（`ToolExecutionError` + 明确 `kind: "server_unreachable"`），**不静默降级**到 in-process spawn。理由：降级 = 旁路 ADR-0037 §9 闭世界围栏物理合同统一（围栏由 server 构造 → server 不可达 → 直调等于绕过白名单构造、绕过 fail-loud 分型），违反 `error-handling-enforcer` 的「fail-loud 不静默降级」。
- **`ctx.signal` abort** = server 端 control message 取消（task-handle 协议发 `stop`、短生命周期协议在 handler 内把 signal 透传到 `spawnWithStopSignal`），**不只丢 client promise**。理由：只丢 promise = orphan 进程组继续在 bwrap 内跑，host 没拿到信号、kill 升级不会发生，违反 ADR-0037 §9.4 的「配置故障型 fail-loud」纪律（orphan = 闭世界围栏外的不可观察执行面）。
- **client 端 `Promise.reject`** = server handler 内 `try/catch` 包住 `child.once("error")`（`runner.ts:135-140` 既有契约），typed error 冒泡。

## Alternatives considered

### (a) 同进程 Unix socket 单例（fork 子进程跑 server，主进程经 Unix socket 通信）

否决。证据三件：

1. `BwrapFence` 是 `Object.freeze({argv, sealed: true})` 的纯数据 token（`bwrap.ts:172`）——fork 把无状态 token 装进独立进程，**没有 IPC 状态需要跨进程承载**；fork 的 state（server 内部计数器、registry、reaper）都是 server 自身的，不是 fence 的。
2. Unix socket 在 Node 同进程内可通过 `child_process.fork` 的 IPC channel 直接走，**不需要显式 socket**——但 fork 本身是 overkill，同进程 router 用函数调用即可。
3. 仓库**无 Unix socket 或 fork 先例**（`child_process.fork` / `net.createServer` / `unix:` 零命中），引入全新基建面；与既有 `createTraceRouter`（mountable router、`traceserver/serve.ts:61`）的同进程形态正交。

### (b) 独立 daemon（外部进程，TCP 127.0.0.1 或 Unix socket）

否决。证据三件：

1. 三处消费方（bash tool / background manager / verify）**全部在同一 Node 进程内**（harness CLI / chat / hub），daemon 强制跨 IPC 边界给同进程消费增加延迟（Unix domain socket ≈ 10µs、TCP loopback ≈ 50µs，与 `runInSandbox` 同进程函数调用 < 1µs 相比是 10~50× 退化）、增加端口冲突 / 生命周期治理（supervisor / reaper / heartbeat）新成本。
2. `session-api/http.ts:8787`（TCP 127.0.0.1 暴露给 SPA / 外部 CLI 客户端）和 `traceserver/serve.ts` 都是给**进程外**消费者用的 server；bash sandbox server 的消费者**全部进程内**，与既有 server pattern **作用域不同**，复用该 pattern 是范畴错配。
3. 启动 / 监督 / 端口冲突 / lifecycle 是新成本——daemon 需要 SIGTERM 优雅退出、stale socket 清理、port-already-in-use 治理、host 进程崩溃后 socket 孤儿清理；同进程 router 全部由 host 进程 lifecycle 承担，零新增。

### (c) MCP 面（`@modelcontextprotocol/sdk`）

否决。证据三件：

1. MCP 是**给模型看的工具面协议**（schema 暴露给 LLM 客户端，spinning JSON-RPC over stdio / SSE），bash sandbox server 的三个消费方是**应用代码内**（harness / background manager / verify），不是 LLM 客户端。
2. MCP 协议层（`tools/list` / `tools/call` / `initialize` handshake / capability negotiation）是为跨进程 LLM 工具发现设计的，**与 sandbox 内部执行面边界错位**——把 `runInSandbox` 装进 MCP 等于把内部库函数包成跨进程工具，violate least astonishment。
3. ADR-0043 已经锁定 MCP 工具面的披露分层（首轮定稿、`lazy: true` 收编）；sandbox server 不该混入 MCP 工具面通道，避免工具面 schema 抖动波及内部执行体。

## Consequences

### Positive

- 三处 spawn 入口（bash 前台 / verify / background）收敛到一个 router，未来接新隔离 / 新资源限制 / 新 audit 钩子时**只改一处**。
- IPC 边界 5 类故障路径（empty / negative / overflow / concurrent / exception）**集中一处**测试覆盖，违反 `defensive-contract-validator` 的边界覆盖缺口闭合。
- 失败合同（server 不可达 typed fail-loud、`ctx.signal` abort 经 control message 取消）经 ADR 锁定，**不静默降级**到 in-process spawn，围栏物理合同统一保持。
- 同进程 router 形态 = 零新基建（无 socket / 无 fork / 无 daemon），与既有 `createTraceRouter` mountable router 形态同构，review 友好。

### Negative / Trade-offs

- router 模块引入新的工厂函数 + 两型协议（request/response + task-handle）类型面，T8 实施成本非零——但这是**整理**成本，不重复计到现有 fixture（既有测试 fixture 走 `runInSandbox` / `defaultBackgroundSpawn` 薄包装，行为对外 observable 不变）。
- 同进程 router 形态下「server 不可达」物理上不发生——但合同仍写明 typed fail-loud 语义并保留测试覆盖，为未来跨进程化留接口稳定（契约稳定性优先于当下实现简洁）。
- task-handle 协议把「kill 升级的中间状态」封装进 router（`stop` control message），但 pid 物理所有权仍在 host——两个层（协议层 / 物理层）的语义正交，未来若 server 跨进程化需要明确二者如何分裂，再立 ADR。

### Reversibility

- 同进程 router → 独立 daemon 的迁移：保留 router 函数签名与两型协议形态，把 router 内部 `runInSandbox` / `defaultBackgroundSpawn` 直调换成 IPC client 调用即可，**不**需要 consumer 三处迁移（消费面已是 router 调用，不绑内部实现）。
- 协议变更：消息形状 §2 是合同边界，变更需新 ADR（合同即「实现是这次、契约是更久」）；改形状 = 改合同，不是改实现。

## Evidence

- `src/harness/sandbox/bwrap.ts:172`：`BwrapFence = Object.freeze({argv, sealed: true})` —— 纯数据 frozen argv token 证据。
- `src/harness/sandbox/runner.ts:16-54, 84-89, 96-150`：默认截断上限 12_000、code-point 截断契约、`spawnWithStopSignal` 升级路径、`SIGNAL_EXIT_CODES` 映射。
- `src/harness/aci/tools/bash.ts:160-167, 218-224`：bash 工具前后台两条入口；前台 `await runInSandbox`、后台 `manager.spawn`。
- `src/harness/background/manager.ts:239-291, 587-624`：`defaultBackgroundSpawn` 绕过 `runInSandbox` 直接 `nodeSpawn(fence.argv[0], …)`；`bash_stop` 经 host 侧 `process.kill(-pgid, …)` 升级。
- `src/harness/verify/sandbox-run.ts:60-77`：`makeDefaultRunVerify` 走 `runInSandbox`。
- `src/harness/sandbox/violation-executor.ts, violation-handling.ts`：后置 hook 基于 `tool_result` 文本前缀（`VIOLATION_PREFIXES`），与 sandbox 内部解耦——violation 留 client 侧证据。
- `src/session-api/http.ts:130-157` + `src/traceserver/serve.ts:61-83`：既有 TCP server / mountable router 形态——同进程 router 形态镜像 `createTraceRouter` 的 mountable router 模式证据。
- `src/harness/background/stale-reap.ts:184`：orphan 进程组 reap 纪律参考（`process.kill(-pgid, SIGKILL)` + starttime pgid-reuse 加固）。
- ADR-0022：per-call `network: true` 的 fence 物理合同边界（被本 ADR 继承、不修改）。
- ADR-0037 §7.2 / §9：batch 快照语义（前台 / 后台 / verify 同波消费同一 fence token）、闭世界围栏白名单裁决——server 化不修改这些物理合同。
- ADR-0037 §9.4：白名单 miss 的 fail-loud 分型（配置故障型 / 运行时可观察型）——server 化的失败合同承接「typed fail-loud 不静默降级」纪律。
- ADR-0021 D1.7：`bg-` + 12 hex task_id 命名合同（被本 ADR §2.2 继承）。
- `plans/closed-world-bash-fence.md` T7：决策 ticket 上下文与 Round 2 ACR 评审（2026-09-06）。

## T7 acceptance 自查清单

| Acceptance 项                  | 本 ADR 落点                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) server 形态选型            | §1 同进程 router（mountable 工厂），理由 + 否决 Unix socket / 独立 daemon / MCP 面于 §3 Alternatives                                                                       |
| (b) 运行时合同                 | §2.1 短生命周期 request/response + §2.2 长生命周期 task-handle + §2.3 超时/中断；截断沿用 12_000 code-point，SIGNAL_EXIT_CODES 不变                                        |
| (c) 消费方迁移路径与兼容期策略 | §1 「降级为 router handler 薄包装，不删」——保留兼容既有 30+ fixture；§2 两型协议覆盖 bash 前台 / verify / background 三处消费方                                            |
| (d) violation-handling 归属    | §3 留 client 侧，理由三条（语义依赖 / 会话级语义 / 未来跨进程化反向耦合）                                                                                                  |
| (e) 两型协议 + pid 所有权      | §2.1 / §2.2 两型分型；§2.2 末段说明 pid 物理所有权仍在 host，task-handle 协议是「kill 升级的中间状态封装」（同进程 router 形态下二者天然重合，独立 daemon 形态下才会分裂） |
| (f) IPC 边界 5 类故障路径      | §4 表格：empty / negative / overflow / concurrent / exception 逐条合同 + 测试面                                                                                            |
| (g) 失败合同                   | §5：server 不可达 typed fail-loud 不静默降级；ctx.signal abort 走 control message 取消不只丢 promise；理由（围栏物理合同统一 / orphan 进程组 reap 纪律）逐条说明           |
