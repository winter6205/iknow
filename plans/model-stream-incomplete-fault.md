# Plan: model-stream-incomplete typed fault（issue #1065）

来源：issue #1065（worker 空流被误分类为协议层崩溃 → exit 2，无重试）。
根因链已用代码证据逐环核实（证据单一入口：`plans/model-stream-incomplete-fault.evidence.md`——issue 全文 + 16 个 file:line 锚点摘录 + 10 个既有测试名册 + ADR/spec 指针 + §5 偏差记录）。

实施纪律：每个 bullet 先 RED 测试后产品码（`test-driven-development`）；全部 bullet 落地后跑收尾 `code-review`（GATE: BLOCKED → `review-report-repair`）。验收矩阵：`npm test` + `npm run test:real-llm`（触及 adapter/loop 契约）+ `npm run probe:*`（子代理路径）。

## 病灶（一句话）

错误词汇表存在缺口——「上游流未完成」（瞬时、可重试、非协议损坏）没有 typed 形态，在三处被系统性误分类为「协议错误」：fault 翻译层（`nonClockFaultOf` default → none 不重试）、adapter 边界（裸 Error 逃逸）、worker 出口（exit 2 冒用）。

## 收割：settled vs open

**Settled（操作员已确认 + 代码证据支撑）：**

- `nonClockFaultOf` 的 default `{kind:"protocol_error"}` **不删除，只收窄**：精确判据插在它之前，default 只剩真·未知形态，且加可观测性（不再静默压平）。
- 不新建重试机制：`withTransportRetry` 本体**零改动**，只改 `classifyFault` 补格；重试预算/退避/`retry-after`/`transport_retry` 流事件全部既有机器接管。
- SDK 裸 Error 无 typed 类可 instanceof → 按 message 形态匹配（`/stream ended without producing a Message/i` + 非 APIError + cause 链无网络错误），映射测试同时是 **SDK 升级哨兵**（钉住当前 `@anthropic-ai/sdk` 版本形态）。
- visible 纪律复用 `clock_timeout` 先例（`fault-class.ts:78-84`）：不可见 → 整 step 重试安全（D8 整回合不提交）；已出字 → 不自动重试，落 typed 失败。visible 由 stream arm 从 `wireStreamEvents` 的 measurement 取，随 typed 错误携带。
- 重试耗尽自然落 `TransportRetryExhaustedError` → `loop-engine.ts:1951` 既有分支命中 → stopReason `protocolError` 干净收尾。
- exit 2 **归还** SC13 契约语义（`cli.ts:612-614`）：仅信封解析失败/字段缺失；run 阶段逃逸错误 → best-effort failed envelope + exit 1。
- 父侧归因走 ADR-0102 既有续跑闸（Decision 1：failed + transcript 即可续），不新开机制；`crashed` 语义收窄回「进程级异常死亡」。
- adapter 边界 catch-all **不强制新 typed 类**（操作员裁决：降级为 rethrow 原样 + 记录，避免掩盖新 SDK 形态）。

**Open（T1 decision bullet 裁决）：**

- typed 错误类命名（候选 `ModelStreamIncompleteError`）。
- envelope reason enum 新值措辞（候选 `modelTransient` vs 复用 `protocolError` + cause 字段）。
- ADR 载体：新 ADR vs 修订既有。⚠ 证据核实（evidence §5）：SC13 / assumption 16 出处在**归档** spec（`docs/archive/025-retire-completed-specs-and-plans/specs/356-subagent-v1.md` :361 / :34），且契约原文只钉「exit ≠ 0」**未钉死码值 2**；SC13 说父侧标 `crashed` 而 assumption 16 说 reason=`protocolError`，两处原文自相微差——T1 的 ADR 必须**成文化** exit-code 语义并裁决该微差，不能只写「归还 SC13」。
- default 支可观测性的具体形态（FaultEvent 侧信号 vs log/trace 事件）。
- ⚠ T4 可达性（evidence §5）：`TransportRetryExhaustedError` 已被 loop-engine `:1949-1963` 收口为 stopReason `protocolError`（**不裸抛**）→ worker 既有路径可能已把它派生成 failed envelope（reason=protocolError），不会走到 cli.ts exit 2 兜底。若属实，T4 范围收窄为：cli.ts catch-all 收窄 + envelope 附 cause 字段区分「上游瞬时」vs「真协议错误」；「typed 模型流错误 → envelope」一格可能已天然成立，只需测试钉住。T1 裁决时确认。

## ACR verdict block

`architecture-change-reviewer-agent` 已审（2026-09-19，计划所引锚点逐一对照真实代码核实）。**OVERALL: PASS**。

- bounded-context-guardian: **yes** — 4 个 Surface 全是既有目录，依赖方向 adapter→fault-class→worker→manager→cli 与现状一致，无反向/循环依赖，loop-engine 仅验证不改。
- input-contract-tests: **yes** — 5 类边界各有对应（空流 T2 / 非法形态 T4 回归护栏 / 溢出 T3 有界预算 / 异常 T3 干净收尾 / 并发以 issue 证据显式排除），trace 双轨 assert 满足 test.md 契约。
- error-handling-enforcer: **yes** — typed 类携 visible、哨兵测试钉 SDK 版本、default 支收窄+强制观测信号不造空 catch、exit 1/2 语义显式 EXIT 文档化、catch-all = rethrow+记录非吞。
- complexity-anti-drift: **yes** — 每处改动是既有判据链/union/分流表各加一格，无合并逻辑进单函数，重试/续跑全复用既有机器。
- minimal-change-verifier: **yes** — 单故障链沿 T2→T5 串行传递，无夹带重构，withTransportRetry 零改动有硬验收闸门（T3 Completion = 文件 diff 为空）。

> 非阻塞备注（ACR 原文）：Open 四项由 T1 [decision] 裁决并 Blocks T2–T5，本 verdict 仅 gate 结构；T1 落地后若引入新模块或改判据顺序需复议。

## Tracer bullets

### T1 [decision] — ADR + 词汇表裁决

- **Tag**: [decision]
- **Inherits**: settled 全列表（上节）；SC13 / assumption 16（归档 spec `356-subagent-v1.md`，见 Open 第 3 条 ⚠）；ADR-0094（apiError viewport 段；「SC4-SC5」编号实际出处为 `specs/transport-continue-persist.md:43-44`，引用时以准确出处为准）；ADR-0102 Decision 1（续跑闸）。
- **Surface**: `docs/adr/`、`docs/CONTEXT.md`。
- **Acceptance**: 一份 ADR 记录两条不变式——「fault 词汇表含 stream_incomplete（visible 纪律）」「worker exit-code 语义成文化：exit 2 = 仅信封协议错误」（含 SC13/assumption 16 微差裁决 + Open 第 5 条 T4 可达性确认）；Open 五项全部裁决并写入；CONTEXT.md 词条 delta 落盘（待写入清单 flush）。
- **Completion**: 第二个实现者读 ADR 后对 T2–T5 的类名/reason 措辞/观测形态不再有异议空间。
- **Blocks**: T2, T3, T4, T5。

### T2 [implementation] — adapter：typed 错误 + 形态识别 + default 收窄

- **Tag**: [implementation] [blocks: T1]
- **Inherits**: T1 裁决的类名与观测形态；settled 的形态判据 + visible 携带 + default 收窄不删除。
- **Surface**: `src/harness/model-adapter`（含 `src/harness/errors.ts`）。
- **Acceptance**:
  - RED→GREEN：stub `finalMessage()` reject 该形态 → 出 adapter 的是 typed 错误（携 visible），非裸 Error；
  - `nonClockFaultOf`：typed 错误 → `stream_incomplete` fault；default 支只接真·未知形态且产生观测信号；
  - SDK 哨兵测试钉住当前版本错误文本形态（升级即 RED）；
  - 既有 `anthropic-adapter-stream` / prompt-too-long 翻译用例全绿（`npm test` 窄集）。
- **Completion**: 两个实现者可用不同判据写法/文件组织，只要 Acceptance 四条全过。

### T3 [implementation] — classifyFault 补格 + 重试复用接通

- **Tag**: [implementation] [blocks: T2]
- **Inherits**: settled 的「withTransportRetry 本体零改动」+ visible 纪律（`clock_timeout` 先例）。
- **Surface**: `src/harness`（fault-class）、`src/harness/loop-engine`（仅验证既有分支命中，预期近零改动）。
- **Acceptance**:
  - `classifyFault`：`stream_incomplete` 不可见 → `retry`；可见 → `none`；
  - stub 断流集成：有界重试（退避表既有）→ 耗尽落 `TransportRetryExhaustedError` → loop-engine `:1951` 既有分支 → stopReason `protocolError` 干净回合失败（不裸抛、不进历史）；
  - trace 双轨 assert（`createJsonlTraceService` 事件序列 + NoopTraceService deepEqual 基线，test.md 契约）；
  - `npm run test:real-llm` 不回归（缺 key 则 Not run 记录）。
- **Completion**: 重试语义全部由既有机器承载的証拠 = withTransportRetry 文件 diff 为空或仅注释。

### T4 [implementation] — worker 出口：exit 2 归还

- **Tag**: [implementation] [blocks: T3]
- **Inherits**: T1 裁决的 reason 措辞；settled 的「exit 2 仅 parseWorkerEnvelope ProtocolError」；SC6 reason enum（`worker.ts:918`）。
- **Surface**: `src/harness/subagent`（worker）、`src/cli.ts`。
- **Acceptance**:
  - `runWorkerOnce`：typed 模型流错误 / `TransportRetryExhaustedError` → failed envelope（reason 格按 T1 裁决），不逃逸。⚠ 先按 T1 的可达性确认走：若 loop-engine 收口使其天然成立，本条降级为**测试钉住既有行为**，不改产品码；
  - 进程级测试：stub 断流 worker → **exit code ≠ 2**，stderr 无 `[subagent-worker] fatal` 误报；真信封损坏 → 仍 exit 2（SC13 回归护栏）；
  - cli.ts 逃逸兜底收窄：仅 parseWorkerEnvelope ProtocolError → exit 2；run 阶段逃逸错误 → best-effort failed envelope + exit 1。
- **Completion**: exit-code 语义可 demo：两种故障（信封坏 vs API 抖）产出不同 exit code + 不同 reason。

### T5 [implementation] — 父侧归因 + ADR-0102 续跑接通

- **Tag**: [implementation] [blocks: T4]
- **Inherits**: ADR-0102 Decision 1（failed + transcript 可续）；settled 的「crashed 收窄回进程级异常死亡」。
- **Surface**: `src/harness/subagent`（manager、envelope 消费处）。
- **Acceptance**:
  - manager 收到新 reason envelope → failed 态 + 可续标记；`subagent_continue` 闸放行（ADR-0102 通道实测走通）；
  - 父侧提示语区分「上游瞬时故障，可 continue 续跑」vs「真崩溃」；
  - 既有 crashed / timeout / maxTurnsExceeded 用例全绿（语义收窄不破坏）；
  - TUI 面：`tests/tui/error-stop-notice.test.tsx` 不变式（protocolError + apiError → 专用文案；protocolError 无 apiError → 通用文案）不破。
- **Completion**: 端到端 demo：stub 断流 → worker failed envelope（非 exit 2）→ 父侧 continue → 工人带 transcript 续跑成功。

## 依赖图

```
T1 [decision] ──> T2 ──> T3 ──> T4 ──> T5
（无 [parallel]：单链，每步消费前步的 typed 形态/reason 语义）
```

## 待写入（persist）

由 **T1 decision bullet** 承担 flush（ADR + CONTEXT.md 一并落）：

- `docs/CONTEXT.md`：`stream_incomplete`（fault kind，visible 纪律）；typed 流未完成错误（类名以 T1 裁决为准）；envelope reason 新格（措辞以 T1 裁决为准）；exit-2 语义归还（SC13 重申，非新语义）。
- ADR：载体以 T1 裁决为准；若与既有 ADR（0094/0102/SC13 出处 spec）冲突，按 `> Contradicts ADR-NNNN` 格式在 T1 内登记 reopen。

## 风险

- 重试放大 API 用量（断流 × 5 attempts）：visible 纪律 + 既有 attempt 预算约束，`transport_retry` 流事件对用户可见。
- message-text 判据脆弱：SDK 哨兵测试即护栏（升级即 RED，人工复核形态）。
- 与 PR #1061/#1062（transcript 并发竞态）无关已由 issue 证据排除（本缺陷 transcript 零重复 event id）。
