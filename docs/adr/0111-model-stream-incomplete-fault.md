# 0111. 上游流未完成 typed fault：ModelStreamIncompleteError 与 worker exit-code 语义成文化

Date: 2026-09-20
Status: accepted

Amends ADR-0094（transport cause 摘要面扩到带 cause 的模型流瞬断；viewport 纪律不变）。Amends ADR-0101 / ADR-0102 的父侧终态归因词汇（envelope reason 联合 4 值 → 5 值，见 Decision 2 对 SC9 冻结的显式修订）。成文化归档 spec 356-subagent-v1 assumption 16 / SC13 的 worker exit-code 语义，并裁决两处原文微差（见 Decision 3）。**修订 SC9「reason 枚举 V1 冻结四值」**：本 ADR 显式批准追加第五值 `modelTransient`（envelope-freeze.test.ts 期望随之更新，属契约变更而非断言削弱）。

## Context

上游 SSE 流结束但未产出完整 assistant message（空流 / 断流）时，SDK 抛裸 `Error`（`stream ended without producing a Message with role=assistant`）。fault 词汇表没有「上游流未完成」这一格，导致该瞬时故障在三处被系统性误分类为协议损坏：

1. `nonClockFaultOf` default 支压成 `protocol_error`（anthropic-adapter.ts:898-915，default :914）→ `classifyFault` default → `none`（fault-class.ts:159-160）→ 零重试；
2. 裸 Error 不进 loop-engine 收口支（:1949-1952 只认 `ProtocolError` / `TransportRetryExhaustedError`），穿出 `run()`；
3. worker 场景落到 cli.ts catch-all（:615-626）→ `[subagent-worker] fatal` + **exit 2** —— 冒用了 assumption 16 / SC13 保留给信封协议崩溃的专码，父侧（manager.ts:1512-1543 SC16）标 `crashed`，无法与「信封坏了」区分。

不新建重试机制：`withTransportRetry` 本体零改动（文件 diff 为空或仅注释，硬闸），重试预算 / 退避 / `retry-after` / `transport_retry` 流事件全部由既有机器承载（with-transport-retry.ts:125-156）。

## Decision

### 1. typed 错误类 = `ModelStreamIncompleteError`，extends `ProtocolError`

- 定义于 `src/harness/errors.ts`（typed 家族 :27-60），携 `readonly visible: boolean` + `readonly cause: unknown`（原 SDK 错误），仿 `TransportRetryExhaustedError`（:51-60）的 cause 形态。
- 继承 `ProtocolError` 复用 loop-engine :1949-1952 既有 `instanceof ProtocolError` 干净收口（先例：`PromptTooLongError extends ProtocolError`，errors.ts:43-45；loop :1912 分支顺序惯例——**子类支必须排在 `ProtocolError` 通用支之前**）。收口即 stopReason `protocolError` 干净回合失败，不裸抛、整 step 不提交（D8）。
- `visible` 语义复用 `clock_timeout` 先例（fault-class.ts:77-85 判据来自 race-timers.ts:50-55,112-118 的 `hadVisibleDelta`）：**不可见**（本次 attempt 无任何模型输出增量）→ 整 step 重试安全；**已出字** → 不自动重试，落 typed 失败。
- 产生点：adapter 流臂 `stepStreamArm` catch（anthropic-adapter.ts:561-565，现仅 `translatePromptTooLong` :516-525）识别该 SDK 形态后改抛本类。`visible` 由 stream arm 从 `wireStreamEvents` 的 measurement 取（:541-542 现有 `{start,end}` 计时对象扩展一位「见过非空可见增量」标志；置位点与 measurement 打点同址：text :620 / thinking :637 / input_json :646，空 delta 不置位——对齐既有 empty-delta 纪律）。
- SDK 裸 Error 无 typed 类可 instanceof → 按 message 形态匹配（`/stream ended without producing a Message/i` + 非 APIError + cause 链无网络错误）。映射测试同时是 **SDK 升级哨兵**（钉住当前 `@anthropic-ai/sdk` 形态，升级即 RED 人工复核）。

### 2. envelope reason 新值 = `modelTransient`（显式修订 SC9 冻结枚举）

- 不复用 `protocolError` + cause 字段：父侧归因需要显式区分「上游瞬时可续」vs「真协议损坏」；cause 藏在字符串里不构成判定面。
- 落点三处同步：`SubAgentEnvelope.reason` TS union（envelope.ts:167-168）、`PARENT_SCHEMA.properties.reason.enum`（:316-318）、manager 消费联合（manager.ts:67、:1466-1478 两处 cast）。
- **冲突记录（基准 → 修正）**：envelope.ts:173-176 与 `tests/subagent/envelope-freeze.test.ts:72-76` 把 reason 枚举钉为「V1 冻结四值」（SC9 判定面，enum 外值拒收 :156-163）。追加第五值与本 ADR 基准（裁决 2）正面冲突。按最小改动原则裁决：**本 ADR 即 SC9 冻结的显式修订授权**，freeze 测试期望更新为 5 值（断言仍是封闭枚举校验，非削弱）。跨版本退化：旧父收新 worker 的 `modelTransient` 信封 → ajv 拒 → 父侧按现状归 `crashed`（不比今日差）；单仓 CLI 父子同 version，属理论态。
- 发射点（本裁决同时钉住映射机制，见 Decision 5 可达性事实）：
  (a) `runWorkerOnce` 正常返回派生支 worker.ts:1229-1241（`stopReason === "protocolError" || "emptyFinalResponse"` → `toFailedEnvelope("protocolError", ...)`）内按 **`RunResult.apiError` 在场**分流：在场 → `modelTransient`；缺席 → 维持 `protocolError`。该判据的既有不变式：全仓唯一给 stopReason=protocolError 挂 apiError 的点就是 loop :1961 `transportApiErrorOf(err)`，且 :1953-1955 注释明言「仅 TransportRetryExhaustedError 携带 cause → 挂」；RunResult.apiError 定义见 loop-engine.ts:2273-2275。
  (b) run() 逃逸 catch（worker.ts:1285-1293）：`instanceof ModelStreamIncompleteError` 支**排在 :1289 `instanceof ProtocolError` 之前**（子类顺序惯例同 loop :1912），→ `toFailedEnvelope("modelTransient")`。经 Decision 5 核实：经 step 的正常路径被 loop 收口、不达此支；本支服务 step 收口面之外的逃逸（如 loop 内 epilogue/收尾调用面抛出的本类错误）。
  (c) 配套微扩：`transportApiErrorOf`（errors.ts:391-395）对本类直抛（visible=true 不重试路径）也提炼 `{message}` 摘要（cause 原文经 `summarizeTransportCause` :368-384），使不变式成为「apiError 在场 ⇔ 带 cause 的瞬时模型流/传输失败」。效果：宿主 viewport 按 ADR-0094 画「API error」原文（引用写法见 Decision 3 末段），TUI 既有不变式（protocolError+apiError → 专用文案；protocolError 无 apiError → 通用文案，tests/tui/error-stop-notice.test.tsx）不破。

### 3. ADR 载体 = 本 ADR（0111）；两条不变式成文化

**不变式 (a)：fault 词汇表含 `stream_incomplete`（visible 纪律）。**
`FaultEvent` union（fault-class.ts:71-99）追加 `| { readonly kind: "stream_incomplete"; readonly visible: boolean }`；`classifyFault`（:146-162）照 `clock_timeout` 格（:155-156）加同判据支：`visible ? "none" : "retry"`。default 支 `{kind:"protocol_error"}` **不删除、只收窄**：精确判据（含本类 instanceof 支）插在其前（nonClockFaultOf 判别顺序契约见 anthropic-adapter.ts:881-896 doc），default 只剩真·未知形态。

**不变式 (b)：worker exit-code 语义。**

- **exit 2 = 仅信封协议错误**：`parseWorkerEnvelope` 抛 `ProtocolError`（stdin JSON parse 失败 / WorkerEnvelope 字段缺失）→ 无信封可写 → `[subagent-worker] fatal` + exit 2（cli.ts:615-626 现状即此语义，本 ADR 成文化并收窄 catch 面）。
- **run 阶段逃逸错误 → best-effort failed envelope（stdout）+ exit 1**：不再冒用 2。结构化 typed 逃逸按 reason 映射（Decision 2(b)）；**非结构化逃逸**（装配/收尾等 loop 收口面之外的 unknown 错误）→ best-effort envelope reason=`crashed`（进程以错误结束 = 本 ADR 收窄后的「进程级异常死亡」词汇）+ exit 1——与父侧 SC16「exit≠0 无信封 → crashed」分层不矛盾：有信封按信封 reason。
- exit 0 + failed 信封 = run() 派生的结构化失败（reason ∈ 5 值枚举），父侧按信封归因。
- **SC13 / assumption 16 微差裁决**：两处原文都只钉「exit ≠ 0」，**未钉死码值 2**；微差在父侧标记——SC13 说父管理标 `crashed`，assumption 16 说 `reason=protocolError`。实现现状采 assumption 16 侧的**信封派生面**（worker.ts:1141-1148 doc + :1289：run() 抛 ProtocolError → 信封 reason=protocolError），父侧对 **exit≠0 无信封** 的崩溃标 `crashed`（manager.ts:1512-1543 SC16 + :1205-1214 settleCrash，即 SC13 侧）——二者不矛盾，分层成立：_协议层崩溃（无信封）→ 父侧 crashed；有信封 → 按信封 reason_。本 ADR 把该分层定为契约正文；「exit 2 归还」的准确表述是「归还 assumption 16 的协议层崩溃**专码**」，`crashed` 语义收窄回「进程级异常死亡（非 0 无信封 / 信号杀）」。
- **ADR-0094 引用写法**（钉清 evidence §5.2 漂移）：ADR-0094 正文无字面 SC4/SC5 编号（单段 Decision，docs/adr/0094-…md:6）。代码注释「ADR-0094 SC4-SC5」所指为其中两句：「供应商/API 失败对人画在对话流（薄外壳 `API error (status):` + 原文），不追加进 session transcript；`StopReason` / `protocolError` 不当 UX 文案」。字面 SC4/SC5 编号的出处是活跃 spec `specs/transport-continue-persist.md:43-44`（回合落盘 + sticky notice，另一面）。新文档/注释引用时写「ADR-0094 viewport API error 段（对应 `specs/transport-continue-persist.md` SC4/SC5）」，不再裸写「ADR-0094 SC4-SC5」。

### 4. default 支可观测性 = `nonClockFaultOf` default 内 console.warn 诊断

核实：`nonClockFaultOf` / `translateAnthropicTransportFault` 均为纯函数（无注入 log/trace 通道，anthropic-adapter.ts:862-873、:898-915）；唯一消费点 `withTransportRetry` :134 与 rethrow :141 受**本体零改动**硬闸约束，「由消费点记录」不可行；`classifyFault` 亦纯且 default→none 语义不改。裁决取侵入最小形态：**default 支 return 前 `console.warn` 一条诊断**（`err.name` + `errorMessage(err)`，其中 message 截断 ≤200 字符、name 不计入预算，不打 stack / 不打请求体），分类结果不变（仍 `protocol_error`）。先例：harness 诊断走 console.warn（trace/jsonl.ts:239、memory/prefetch.ts:184）；worker stdout 是信封协议面、warn 走 stderr 不污染，父侧 stderr 只在 exit≠0 取证时读（CONTEXT「stderr 指针」）。测试以 spy 捕获，不新增机制、不加 injectable 旋钮。

### 5. 可达性确认（代码核实结论）

evidence §5.5 属实且已扩全：

- **`TransportRetryExhaustedError`（不可见断流耗尽）**：with-transport-retry :139 抛出 → loop :1951 收口 → stopReason `protocolError` + apiError（cause 摘要）→ runWorkerOnce :1229-1241 派生 failed 信封 → **exit 0**。不裸抛、不达 worker catch、不达 cli exit 2。worker 侧适配器同构（worker.ts:533-544 装配 `withTransportRetry({ translate: translateAnthropicTransportFault })`）。
- **`ModelStreamIncompleteError`（visible=true 直抛）**：:141 rethrow → loop :1950 `instanceof ProtocolError` 命中（extends 关系保证）→ 同一收口支 → stopReason `protocolError`（apiError 按 Decision 2(c) 挂上）。
- **既有派生路径**：run() 正常返回 stopReason=protocolError 时，envelope 由 worker.ts:1229-1241 派生（`toFailedEnvelope("protocolError", "", observabilityFields(result, …))`，stop_reason 观测字段带 `protocolError`）。**即落地后 exit 2 冒用即自然消灭**（裸 Error 变 typed 即被 loop 收口）。

**范围结论**：不是纯「测试钉住既有行为」——「钉住既有行为」只保证 reason=protocolError；而 Decision 2 要求父侧拿到 `modelTransient`，故 worker 产品码需小改（Decision 2(a) 分流 + 2(b) 防御排序支），外加 cli.ts catch-all 收窄（Decision 3 不变式 b）。loop-engine 零改动（:1949-1963 原样），withTransportRetry 零改动。

## Consequences

- (+) 「API 抖了」与「信封坏了」在 exit code（0/1 vs 2）、envelope reason（modelTransient vs protocolError vs crashed）两个面上都可分辨；ADR-0102 Decision 1 续跑闸（failed + transcript 即可续，docs/adr/0102-…md:16）无需新机制即承接，「Why not 只接 completed：失败/崩才是续跑主因」（:25）正是本故障的出路。
- (+) default 支不再静默压平未知形态；SDK 升级换形态 → 哨兵测试 RED + 线上有诊断信号。
- (−) reason 枚举 4→5 是对 SC9 冻结判定面的显式 loosening，依赖旧父严格四值假设的三方消费（若有）需同步；单仓 CLI 内以本 ADR 为准。
- (−) 重试放大 API 用量（断流 × ≤5 attempts）：visible 纪律 + 既有 attempt 预算约束，`transport_retry` 事件（with-transport-retry.ts:146-151）对用户可见。
- (−) message-text 判据脆弱：哨兵测试即护栏。

## Evidence

- errors.ts:27-31 / :43-45 / :51-60 / :368-395；anthropic-adapter.ts:516-525 / :541-542 / :561-565 / :584-674 / :862-873 / :881-896 / :898-915；fault-class.ts:71-99 / :146-162；with-transport-retry.ts:125-156；loop-engine.ts:1912-1963 / :2273-2275；worker.ts:533-544 / :1134-1148 / :1219-1241 / :1285-1293；envelope.ts:160-215 / :308-319；manager.ts:67 / :1205-1214 / :1466-1478 / :1512-1543；cli.ts:608-627；race-timers.ts:50-55 / :112-118；tests/subagent/envelope-freeze.test.ts:72-76 / :156-163；tests/tui/error-stop-notice.test.tsx；specs/transport-continue-persist.md:43-44。
