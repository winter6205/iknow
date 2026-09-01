# Plan: Ctrl+C 打断链路修复（ctrl-c interrupt）

**Goal:** turn 运行中按 Ctrl+C 一定有确定的、可解释的结果——要么打断，要么明确告诉用户为什么打不断；不存在「按了完全没反应」这一态。
**Approach:** 本轮**没有可复现的失败用例**，只有若干各自独立成立的缺陷。因此第一个 bullet 是让 Ctrl+C 的处置路径变得可观测（把不可证伪的 bug 变成可诊断的），随后各 bullet 各修一个**已确认**的缺陷——它们无论是否解释了操作员遇到的那次症状，都独立成立。最后一个 bullet 用 T1 的证据回头确认原始症状是否消失；不消失就回到调查，不许算完。
**Spec link:** none — 来源是操作员报障（2026-08-31）+ 两轮只读调查。
**Tracker:** 本计划不创建、不嵌入 GitHub issue 边表（操作员指定 fallback，用本地 markdown）。
**ACR:** PASS（2026-08-31，verdict block 见下文「ACR」节）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

> 与 `plans/subagent-isolation-gate.md` 是两件独立的逻辑任务，不合并提交。

## 证据分级

**已由本人复核（代码事实）**

- **graph 焦点吞 Ctrl+C。** `src/tui/app.tsx:2130-2148` graph view 打开且有 snapshot 时，处理完 graph 键位直接 `return`；`:2150-2171` `graphChromeFocus === "graph"` 分支以无条件 `return` 收尾。两处都在 Ctrl+C 分支（`:2193`）**之前**，按键根本到不了。
- **`AskUser` 接口没有 signal。** `src/harness/permission/types.ts:97-101` 的入参只有 `{ tool, input, summaryHint, ... }`。权限等待中 abort 无法把它解开。
- **`read_mcp_resource` 丢弃 signal，且这是显式决议不是疏漏。** `src/harness/aci/tools/read-mcp-resource.ts:71-82`：handler 形参写作 `_ctx`，注释记为「M3 决议边界：abort 走状态机失败路径，handler 不透传 signal」。
- **wake 分支是好的。** 调查曾报「`runTurnOnce(..., "wake")` 不传 controller」，**该结论错误**：`src/tui/app.tsx:1642-1645` 创建了 `AbortController`、注册进 `aborters`、并作为实参传入。wake turn 走普通 Ctrl+C 路径可被打断，不列入本计划。
- **trace 侧无信息丢失。** 某次会话 10 个 turn 全部为 `completed`/`timeout`，无一 `cancelled`。`cancelled` 是 LoopEngine 支持并会写入 trace 的 decision，所以「没有 cancelled」意味着 abort 未走到那条路径，而不是记录丢了。

**来自调查、未经本人复核（实施前需各自坐实）**

- LoopEngine 工具阶段要等 `executeAll` 全部结束后才检查 signal（`loop-engine.ts:1299-1329`）。
- ACI executor 对 `cancel` tier 只 race tier timeout，不直接 race caller signal（`aci-executor.ts:297-380`）；`block` tier 故意排除 caller signal。
- `aborters` 清理竞态：`runTurnOnce` 的 `finally` 先删 controller、后置回 `idle`（`app.tsx:1513-1518` vs `:1559-1577`），窄窗口内 `canInterrupt` 为真但 `get(id)` 为空。
- Anthropic adapter 已把 signal 交给 SDK；前台 bash `SIGTERM`→2s→`SIGKILL`；两者判为完好。
- TUI 每轮模型前的 env snapshot 含两次各 5 秒上限的 git 调用且不接 signal。

## 非目标（本计划显式不做）

- LoopEngine 循环内检查点密度的整体重排——需要先有 T1 的证据，不凭推断动主循环。
- MCP server 自身不响应取消（第三方行为，只能靠 tier timeout 兜底）。
- HTTP `/messages` 未从 request close 派生 signal（`session-api/http.ts:515-528`）——真实缺陷，但 `npm run dev:tui` 是同进程路径，不经过它；另轨。
- 停掉 `block` tier 对 caller signal 的排除——那是既有语义决定，要改需单独立项。
- 子代理隔离门禁（见 `plans/subagent-isolation-gate.md`）。

## ACR

```
bounded-context-guardian: yes — 键位分派修复留在 tui；权限等待的 signal 面留在 harness/permission 并由各 host 的 askUser 实现跟进；工具取消留在 harness/aci 与 harness/mcp；三处互不跨界，可观测性经既有 trace 通道落地，不新造第二条记录协议。
defensive-contract-validator: yes — 五类边界：空（无前台 turn 时 Ctrl+C 仍给确定反馈）、负向（abort 后到达的用户批准必须不生效，不得反向复活已取消的调用）、溢出（连按多次 Ctrl+C 不得产生重复 abort 副作用）、并发（abort 与 turn 自然结束竞态时结果唯一，不得双写 stopReason）、异常（askUser 实现抛错时权限判定仍 fail-closed 为拒绝）。
error-handling-enforcer: yes — 取消是 typed 的既有 `cancelled` stopReason，不新增魔法字符串；权限等待被 abort 解开时按拒绝语义收口（fail-closed 不变）；read_mcp_resource 若恢复 signal 透传，其失败仍走既有 ToolExecutionError 出口；不可取消的等待必须显式记录 EXIT 理由，不静默吞。
complexity-anti-drift: yes — T2 是把两处无条件 return 改成有条件放行，不增嵌套层级；T4/T5 是沿既有 signal 参数链补一段透传，不引入新抽象层；T1 的记录点是既有 trace 的加字段，不新建子系统。
minimal-change-verifier: yes — 每个 bullet 一个独立缺陷、一个 commit；T3 是决议不含代码；非目标清单把主循环重排、MCP 第三方行为、HTTP 面显式排除，无 scope creep。
OVERALL: yes — 全 5 项通过，可进入 T1 实施；各 bullet 仍受 per-ticket loop 约束。
```

## Tasks (ordered by dependency)

1. **Ctrl+C 处置路径可观测** — tag: `[implementation]`
   - **Inherits:** `cancelled` 是 LoopEngine 既有 stopReason 且会写入 trace decision（已核实）——本 bullet 不新造记录协议，只补按键侧的缺口。
   - **Surface:** `tui`（键位分派处）、既有 trace 通道。
   - **Acceptance:**
     - 按一次 Ctrl+C，事后可从记录中读出它走了哪条处置路径：被前置分支吞掉 / `canInterrupt` 为假 / 已发出 abort / 应发出但 controller 缺席。
     - 「已发出 abort」与「abort 被下游消化并结束了 turn」是两条可分辨的记录，能区分信号没发出与信号发了没人理。
     - 无前台 turn 时的既有提示行为不变。
   - Status: [x] complete — commit `106480fe` (`fix(tui): expose Ctrl+C disposition paths`)

2. **graph 焦点不再吞掉 Ctrl+C** — tag: `[implementation]`
   - **Inherits:** 已核实的两处无条件 `return`（`app.tsx:2130-2148`、`:2150-2171`）位于 Ctrl+C 分支之前。
   - **Surface:** `tui`（全局键位分派）。
   - **Acceptance:**
     - graph view 打开时、以及 graph chrome 获得焦点时，按 Ctrl+C 的结果与普通状态一致：有前台 turn 则打断，无则给出同一条提示。
     - graph 自身的键位（选择 / 展开详情 / 关闭 / 切焦点）行为不变。
     - 回归用例覆盖「graph 状态下 Ctrl+C」这一此前无人测过的组合。
   - [parallel]
   - Status: [x] complete — commit `ee2f311d` (`fix(tui): let graph focus handle Ctrl+C`)

3. **不可取消等待的口径定案** — tag: `[decision]`
   - **Inherits:** `read_mcp_resource` 的现状是 M3 的**显式决议**（handler 不透传 signal），不是疏漏——要改必须记录重开理由，不得静默推翻。
   - **Surface:** `docs/adr/`（重开或维持 M3）、`docs/CONTEXT.md`（如引入新词）。
   - **Acceptance:** 产出一份口径，回答三问：哪些等待允许不可被 abort 解开；不可解开时必须给用户什么反馈（不能是「没反应」）；`block` tier 排除 caller signal 的既有语义维持还是收窄。对 M3 的结论（维持 / 重开）写入 ADR。
   - [blocks: T4, T5]
   - Status: [x] complete — commit `9f28ae07` (`docs(adr): settle non-cancellable wait semantics`)

4. **权限等待可被 abort 解开** — tag: `[implementation]`
   - **Inherits:** T3 定案的口径；`AskUser` 现无 signal 入参（已核实）；权限判定 fail-closed 为拒绝是既有不变量。
   - **Surface:** `harness/permission` 及各 host 的 askUser 实现（`tui` / `cli`）。
   - **Acceptance:**
     - 权限等待中按 Ctrl+C，turn 立即以取消收口，不需等到 TUI 的 60 秒上限、也不需在 TTY 场景等用户输入。
     - abort 之后到达的用户批准不生效——被取消的调用不得因迟到的「同意」而复活。
     - askUser 实现抛错时权限判定仍为拒绝（fail-closed 不变）。
   - [blocks: T3]
   - Status: [x] complete — commit `1c51ae43` (`fix(permission): cancel pending prompts on abort`)

5. **工具阶段的取消抢占** — tag: `[implementation]`
   - **Inherits:** T3 定案的口径。实施前须先各自坐实两条调查结论：ACI executor 对 `cancel` tier 是否只 race tier timeout；LoopEngine 工具阶段的 signal 检查点位置。坐实结果与调查不符时以代码为准并回到 T3。
   - **Surface:** `harness/aci`（executor 与 `read_mcp_resource`）、`harness/mcp`。
   - **Acceptance:**
     - 声明为可取消的工具，在 caller abort 时不必等到自己的 tier timeout 才结束。
     - `read_mcp_resource` 的取消行为与 T3 口径一致（透传 signal，或维持现状但按 T3 要求给出可见反馈）。
     - 已 in-flight 的底层操作若无法真正中止，其「界面已停但后台仍在跑」的事实对调用方可见，不伪装成已停止。
   - [blocks: T3]
   - Status: [x] complete — commits `31a7e900` (`fix(harness): preempt cancellable tool waits on caller abort`) and `5d757c00` (`fix(harness): wire caller abort through ACI permission gate`)

6. **回到原始症状确认** — tag: `[decision]`
   - **Inherits:** systematic-debugging 的收口纪律——没有失败用例转绿，不许声称修好。
   - **Surface:** 本计划文件（结论落盘）。
   - **Acceptance:** 用 T1 的记录复现操作员的原始场景，判定其 Ctrl+C 走的是哪条路径，并回答该路径是否已被 T2/T4/T5 覆盖。未覆盖则记录新的候选并回到调查阶段，**不得**以「已修若干缺陷」结案。
   - [blocks: T1, T2, T4, T5]
   - Status: [ ] failed (T6 未通过) — 2026-09-01 回查未能复现原始前台 turn，返回调查阶段；详见下文

## T6 回到原始症状确认（2026-09-01）— 未通过

### 回查依据与原始症状边界

本回查的依据是本计划 T6 的 Acceptance，以及操作员 2026-08-31 的原始描述：
「并且我还意识到运行中CTRLC无法打断，不知道是哪里的问题」。
该描述没有给出入口（TUI / HTTP / serve / web）、当时的 turn 阶段（model /
permission / tool）、graph 焦点状态、T1 记录或进程退出行为。因此不能把
“运行中”自行等同于某一条实现路径。

### 实际复现与记录

1. 先运行仓库现有的 `npm run probe:interrupt-transcript`。该探针直接装配
   harness `LoopEngine`，用 `AbortController` 在 model 请求开始后约 50ms
   abort；它不启动 TUI，也不发真实 Ctrl+C，不会产生 T1 的 `ctrl_c` stderr
   记录。实际输出为：

   ```text
   result=pass key_env=undefined model=minimax-cn/MiniMax-M3 turns=0 stop_reason=cancelled system_appended=true wire_system_count=0 durationMs=56
   ```

   这证明 harness 的 caller abort / `cancelled` transcript 链路可用，但**不是**
   操作员原始场景的复现。探针产物写入 `docs/handoff/392-smoke/`。

2. 再通过真实伪终端启动 `npm run dev:tui:auto-mode`，输入
   `Please run bash sleep 10 and then report the result.`，发送 Enter，再发送
   Ctrl+C。TUI 成功启动，但该环境下输入没有提交成消息，文字仍停留在输入框；
   因而当时没有前台 turn。T1 记录实际为：

   ```text
   {"event":"ctrl_c","disposition":"can_interrupt_false"}
   ```

   同时显示既有提示：`Ctrl+C：无前台运行中的 turn；/quit 退出。`。这是真实
   TUI 的 idle 分支复现，不是原始“运行中无法打断”复现；不能用它推断原始
   turn 的 disposition。

3. 用 Bun 只筛选 Ctrl+C 相关的 TUI 回归用例：

   ```text
   $HOME/.bun/bin/bun test --test-name-pattern 'Ctrl\+C|ctrl\+c' tests/tui/continue.test.tsx tests/tui/keyboard.test.tsx tests/tui/graph-mode.test.tsx
   7 pass
   0 fail
   Ran 7 tests across 3 files. [12.20s]
   ```

   这些测试覆盖了 `can_interrupt_false`、`controller_missing`、graph
   view/chrome 分支和 in-flight turn 的 abort；它们是 mockInput / stub
   harness 的合成场景，不能替代第 2 步的真人交互或操作员原始会话。

4. 风险 B 的进程级用例在本轮起点 `66469c0b` 的基线中确实失败，失败信息是：
   `AssertionError: child stderr: stage: ready`。本轮重新运行
   `npx vitest run tests/cli/register-shutdown.test.ts` 得到：

   ```text
   Test Files  1 passed (1)
   Tests  7 passed (7)
   ```

   这次通过不能证明该相邻失败已修复：本轮 T1/T2/T4/T5 没有修改进程级
   `registerShutdown` 语义，且该用例在基线已红、当前又通过，表现为环境/时序
   敏感。它与 TUI 内按键取消当前 turn 不是同一测试语义。

### Ctrl+C 路径与 T2 / T4 / T5 覆盖

- 本轮真实伪终端**实际走到**的是 `can_interrupt_false`，原因是消息没有提交，
  不存在前台 turn；T1 只记录了该事实并保持既有 notice。它没有提供原始
  running turn 的路径证据。
- 合成 in-flight TUI 测试验证了 `abort_dispatched`，并由既有
  `turn.decision === "cancelled"` 区分“发出了 abort”和“下游完成取消收口”。
  T2 覆盖 graph view / graph chrome 之前吞键的路径；T4 覆盖 AskUser
  permission wait；T5 覆盖 `cancel` tier 工具抢占以及
  `read_mcp_resource` 的 signal 透传。
- 因为原始会话没有拿到 T1 的 running-turn 记录，不能判定它是否走
  `preempted`、`can_interrupt_false`、`controller_missing`、
  `abort_dispatched`、权限等待、cancel 工具、block 工具或第三方 MCP。
  所以不能逐条声称 T2/T4/T5 已覆盖原始路径。

### 风险 A：未处理路径不能排除

- **HTTP `/messages`**：TUI 的 `createTuiBridge.postMessage` 是同进程直接调用
  `hub.postMessage` 并透传 signal；但 `src/session-api/http.ts:515-528` 的
  HTTP 路由没有从 request close 派生 signal。若操作员实际使用的是
  HTTP / web / serve 面，这条缺口可能正是症状来源；当前原始描述没有足够
  入口证据排除它。
- **第三方 MCP 不响应取消**：T5 只能把 caller signal 传到协议链路；第三方
  server 不遵守取消时仍只能靠 tier timeout。若原始 turn 正在等待此类 MCP，
  仍可能表现为迟迟不结束。
- **`block` tier**：按 ADR-0039，handler 自身继续排除 caller signal 并自然
  收尾。若原始 turn 正在 block handler，T5 不会让底层立即停止；还需要确认
  调用方是否给出了“界面已停止、后台仍在收尾”的可见反馈。

以上三条均无法由当前复现排除；因此风险 A 直接阻止 T6 判定为“已覆盖”。

### 风险 B：进程级 SIGINT 与本计划语义分离但仍未修

操作员原话只说“运行中 Ctrl+C 无法打断”，没有说进程退出、退出码、第二次
信号或 `stage: ready`。现有 TUI 明确配置 `exitOnCtrlC: false`，且本计划
讨论的是 TUI 内取消前台 turn；因此现有文字**更像** turn 级症状，而不是
`registerShutdown` 的进程级 SIGINT 挂死。但这只是基于语义的倾向，不是原始
现场证据。若操作员实际指的是进程级 SIGINT，本轮完全没有覆盖该问题；基线
红而本次重跑偶尔通过也不能结案。

### 新候选与返回调查条件

T6 未通过，返回调查阶段。下一轮必须先取得操作员实际入口与同一会话的 T1
记录，再决定是否修代码。当前候选如下：

1. `controller_missing`：`canInterrupt` 为真但 `aborters` 中没有 controller；
   若操作员原始记录命中此值，T2/T4/T5 均未修复该竞态。
2. `preempted` 的非 graph 前置分支（例如 compaction 或 selection copy）：
   T2 只放行 graph Ctrl+C；若原始会话命中其他有意让行分支，需要单独确认
   是否存在“记录有了但用户看不到反馈”的缺陷。
3. `block` handler 或不响应取消的第三方 MCP：界面可能已停止等待但底层仍
   在运行；需实测其 host 可见反馈是否符合 ADR-0039，不能只看最终 timeout。
4. HTTP `/messages` request-close 未接 signal：仅当原始入口是 HTTP/web/serve
   时成立，不能凭 TUI 测试排除。
5. 进程级 `registerShutdown` 的真实 SIGINT 时序失败：若操作员说的是进程
   不退出/挂死，则这是另一条未修轨道，必须单独调查。

### T6 判定

**T6：未通过（返回调查阶段）。** 依据是：没有真实复现操作员的运行中前台
turn；没有取得该次 Ctrl+C 的 T1 running-turn disposition；风险 A 的三条
未处理路径均不能排除；风险 B 的进程级失败也未被本轮修复。T1-T5 已有各自
独立证据和提交，不等于原始症状已被覆盖；本计划不得以“已修若干缺陷”结案。
