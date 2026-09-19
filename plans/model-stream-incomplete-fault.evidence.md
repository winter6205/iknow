# Evidence: model-stream-incomplete typed fault（issue #1065）

生成日期：2026-09-19。行号以 branch `worktree-plan+stream-incomplete-fault`（worktree `/home/winner/projects/iknow/.qoder/worktrees/plan+stream-incomplete-fault`）为准，全部经 Read 核实。本文件是 `plans/model-stream-incomplete-fault.md` 的证据单一入口，不含产品代码改动。

---

## 1. Issue 全文

来源：`gh issue view 1065 --repo winter6205/iknow --json title,body`（取回于 2026-09-19）。

**Title:** worker 空流被误分类为协议层崩溃：stream ended without assistant message → exit 2，无重试

**Body（原样收录）：**

````markdown
## 现象

真实多子代理压测（单会话并行 5 worker、worker 内含并行 tool 波）期间，API 流不稳定窗口内 4/7 worker 以 exit 2 崩溃，主会话多个长回合报 `⚠ turn 未成功结束（protocolError）`。崩溃 worker 的 stderr 均为同一行：

```
[subagent-worker] fatal: Error: stream ended without producing a Message with role=assistant
    at _MessageStream_getFinalMessage (node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs:341)
    at stepStreamArm (src/harness/model-adapter/anthropic-adapter.ts:545)
```

崩溃 worker 的 transcript 状态完全健康（42/50/32/106 条消息、零重复 event id、链合法）——进程是被裸抛错误杀死的，不是状态损坏。

## 根因链

1. `src/harness/model-adapter/anthropic-adapter.ts:545` — `stream.finalMessage()`：SSE 流结束但未产出完整 assistant 消息（上游空流/断流，如 overloaded、代理断连）时，SDK 抛裸 `Error`。
2. `anthropic-adapter.ts:561-565` — catch 只翻译 `PromptTooLongError`，其余原样 rethrow：裸 SDK Error 出 adapter 边界，不在 harness typed 错误家族内。
3. loop engine 的 assistant turn step 只认 typed 家族（timeout / cancelled / prompt-too-long / commit 失败），裸错误穿出 `run()`。
4. `src/cli.ts:615-626` — worker 入口兜底 catch 把一切逃逸错误按协议层崩溃处理：`[subagent-worker] fatal` + `exit 2`。而 exit 2 的契约语义（cli.ts:612-614，assumption 16 / SC13）是信封解析失败/字段缺失等**协议错误**——上游瞬时故障冒用了该码。
5. 父侧见 exit 2 + `reason=crashed` → 标记崩溃、run 内无重试；ADR-0102 的 continue-after-complete 续跑通道未被触发（父侧无法区分"可续的瞬时故障"与"真协议损坏"）。
6. 主会话同族形态：回合边界 `protocolError`（同一裸错误在宿主侧的表现）。

## 为什么是缺陷

- 错误词汇表已有 typed 回合错误家族供 loop 优雅处理；瞬时上游故障（网络抖动类）应归入该族，而非裸抛。
- exit 2 被冒用破坏父侧归因与重试策略：分不清「信封坏了」与「API 抖了」。
- 并发度越高命中率越高（5 路并行压测 4/7 命中），多子代理产品路径上不可接受。

## 建议修法（三层，小改）

1. adapter catch 识别该 SDK 错误形态（含 529/overloaded 断流）→ 抛 typed `ModelStreamIncompleteError`。
2. loop engine 将其归入可重试回合错误（bounded retry，1–2 次 backoff），或至少干净回合失败而非裸抛。
3. worker 入口仅对真协议错误保留 exit 2；typed 模型流错误走结构化 envelope 错误，父侧可经 ADR-0102 通道续跑。
4. 测试：stub 断流（流结束无 final message）→ assert typed 错误 + 重试语义；worker 级 assert exit code ≠ 2。

## 证据指针

- 压测会话：`~/.iknow/projects/iknow-ddcb805367a0/b2fd8d1d-*/subagents/{d45bbfec,b0732b92,5ade63a9,21ddc5e2}-*/agent-*.jsonl`（subagent_stop status=error, exit_code=2, reason=crashed）。
- 与 worker transcript 并发竞态修复（PR #1061/#1062）无关：竞态形态为重复 event id → schema_invalid，本缺陷 transcript 零重复。
````

---

## 2. 已核实根因链代码证据（逐环）

### 2.1 `src/harness/model-adapter/anthropic-adapter.ts`

**(a) `stepStreamArm` 的 `finalMessage()` 调用与 catch — :527-566。** `finalMessage()` 在 :545；catch 在 :561-565，只走 `translatePromptTooLong(e)`（:564），非 prompt-too-long 一律原样 rethrow（裸 SDK Error 逃逸 adapter 边界）：

```ts
543  // D8:断流 / abort → finalMessage() reject → 不构造 AssistantTurnResult。
544  try {
545    const final = await stream.finalMessage();
546    const result = interpretMessage(final);
...
560    return result;
561  } catch (e) {
562    // wireStreamEvents 已 emit 的部分不受影响 — D8 整回合不提交语义由 step
563    // reject 不构造 AssistantTurnResult 保证,翻译只是改变异常类。
564    translatePromptTooLong(e);
565  }
566 }
```

**(b) `translatePromptTooLong` — :516-525。** 唯一翻译点只认 `APIError && status===400 && /prompt.*length|too long/i`，其余 `throw e` 原样上抛：

```ts
516 function translatePromptTooLong(e: unknown): never {
517   if (
518     e instanceof APIError &&
519     e.status === 400 &&
520     /prompt.*length|too long/i.test(e.message)
521   ) {
522     throw new PromptTooLongError(e.message);
523   }
524   throw e;
525 }
```

**(c) `translateAnthropicTransportFault` — :862-873。** 时钟标记缺席即进 `nonClockFaultOf(err)`（:872）；SDK 裸 Error 不带 clock_abort signal.reason，必然落入非时钟判别：

```ts
862 export function translateAnthropicTransportFault(
863   err: unknown,
864   signal?: AbortSignal
865 ): FaultEvent {
866   const clock = clockAbortOf(signal);
867   if (clock !== undefined) {
868     return clock.visible
869       ? { kind: "timeout" }
870       : { kind: "clock_timeout", source: clock.source, visible: false };
871   }
872   return nonClockFaultOf(err);
873 }
```

**(d) `nonClockFaultOf` 判别顺序与 default 支 — :898-915。** 裸 Error（非 PromptTooLong / 非 abort / 无数值 status / cause 链无 cert / 无连接故障）逐支落空 → default :914 `{kind:"protocol_error"}` → classifyFault → none → 零重试（fault 翻译层的误分类点）：

```ts
898 function nonClockFaultOf(err: unknown): FaultEvent {
899   if (err instanceof PromptTooLongError) return { kind: "prompt_too_long" };
900   if (err instanceof APIUserAbortError || isAbortErrorShape(err)) {
901     return { kind: "user_cancel" };
902   }
903   if (err instanceof APIError && typeof err.status === "number") {
...
911   }
912   if (someCause(err, isCertFailure)) return { kind: "protocol_error" };
913   if (someCause(err, isConnectionFault)) return { kind: "llm_network" };
914   return { kind: "protocol_error" };
915 }
```

判别顺序契约见 :881-896 doc 注释（1 prompt_too_long → 2 abort → 3 llm_http → 4 cert → 5 llm_network）。

### 2.2 `src/harness/model-adapter/with-transport-retry.ts` — 重试循环 :125-156

`classifyFault` 消费点在 :135；两个非重试出口：:141 `throw err`（fault ≠ retry 时裸抛原错误——**若上游 fault 已是 `protocol_error`，裸 SDK Error 从此出口原样逃逸**）与 :139 `TransportRetryExhaustedError`（fault = retry 但预算耗尽）：

```ts
129       try {
130         return await adapter.step(state, request, signal);
131       } catch (err) {
132         lastErr = err;
133         if (isAbort(err, signal)) throw err;
134         const rawFault = translate(err, signal);
135         const fault = classifyFault(rawFault);
136         const canRetry = fault === "retry" && attempt < maxAttempts;
137         if (!canRetry) {
138           if (fault === "retry") {
139             throw new TransportRetryExhaustedError(attempt, err);
140           }
141           throw err;
142         }
```

（:143-152 为 `transport_retry` 流事件 emit + 退避 sleep；:155 循环兜底 `throw new TransportRetryExhaustedError(maxAttempts, lastErr)`。）

### 2.3 `src/harness/fault-class.ts`

**(a) `FaultEvent` union — :71-99。** 现有 11 格：`llm_http` / `clock_timeout` / `llm_network` / `prompt_too_long` / `permission_deny` / `verify_fail` / `user_cancel` / `timeout` / `execution_failed` / `compact_failed` / `protocol_error` / `empty_final_response`。无任何「上游流未完成」格：

```ts
71 export type FaultEvent =
72   | {
73       readonly kind: "llm_http";
74       readonly status: number;
75       readonly retryAfterMs?: number;
76     }
...
81   | {
82       readonly kind: "clock_timeout";
83       readonly source: ClockAbortSource;
84       readonly visible: boolean;
85     }
86   | { readonly kind: "llm_network" }
```

**(b) `clock_timeout` visible 纪律先例 — :77-85（doc）+ :155-156（策略）：**

```ts
146 export function classifyFault(
147   event: FaultEvent | null | undefined
148 ): FaultClass {
149   if (event == null) return "none";
150   switch (event.kind) {
151     case "llm_http":
152       return isTransientHttpStatus(event.status) ? "retry" : "none";
153     case "llm_network":
154       return "retry";
155     case "clock_timeout":
156       return event.visible ? "none" : "retry";
```

:77-80 doc：「可见 = 已出字,不得自动重试;不可见 = 本次 attempt 无任何模型输出,属可重试的传输失败（spec inv 1–2）」。

**(c) `default: return "none"` — :159-160。** `protocol_error` 落 default → none → 不重试（误分类终点）。

### 2.4 `src/harness/loop-engine.ts` — 耗尽错误的回合收口 :1949-1963

`TransportRetryExhaustedError` catch 实际在 :1949-1952（与 `ProtocolError` 同支），映射 stopReason `protocolError`（:1956-1962）；`transportApiErrorOf(err)` 只对本族错误挂 apiError（ADR-0094 引用注释在 :1953-1955）：

```ts
1949     if (
1950       err instanceof ProtocolError ||
1951       err instanceof TransportRetryExhaustedError
1952     ) {
1953       // ADR-0094 SC4-SC5: 仅 TransportRetryExhaustedError 携带 cause,挂到
1954       // RunResult.apiError,供 chat-flow viewport 渲染「API error (status):
1955       // message」类提示; ProtocolError 直抛无 cause → 不挂,保留通用 notice。
1956       return modelStop({
1957         state: opts.state,
1958         started: opts.started,
1959         reason: "protocolError",
1960         cancelKind: "none",
1961         apiError: transportApiErrorOf(err),
1962       });
1963     }
```

对照：**裸 SDK Error 不进此支**（非 ProtocolError / 非 TransportRetryExhaustedError），穿出 `run()` → worker 场景即落到 cli 兜底。

### 2.5 `src/cli.ts` — worker 入口 catch-all :608-627（含 SC13 契约注释）

```ts
608   // #356 subagent worker: 子代理进程 headless 重入 —— stdin 信封 → run() →
609   // stdout envelope。早于产品形态 dispatch (chat/ask/serve/tui/oneshot)，
610   // 该命令只由父代理 child_process.spawn 触发,operator 不直调。
611   //
612   // 协议层崩溃 → exit 2 (assumption 16 / SC13: JSON parse 失败 / 信封字段
613   // 缺失, reason=protocolError at 父代理)。模块级 main().catch 兜所有产品
614   // 形态错误 → exit 1, worker 必须自己 exit 2 区分协议错误与产品错误。
615   if (parsed.command === "__subagent_worker__") {
616     try {
...
619       await runSubagentWorker(storeWorkerTranscriptIo);
620     } catch (err) {
621       const msg =
622         err instanceof Error ? (err.stack ?? err.message) : String(err);
623       process.stderr.write(`[subagent-worker] fatal: ${msg}\n`);
624       process.exit(2);
625     }
626     return;
627   }
```

### 2.6 `src/harness/subagent/worker.ts` — 失败路径与 envelope 派生

**(a) `runWorkerOnce` 失败路径 doc — :1134-1148（关键 :1141-1148）：**

```
1141  * 失败路径 (spec SC6 / assumption 16):
1142  *   - parseWorkerEnvelope 抛 ProtocolError → 不在这里处理 (调用方
1143  *     runSubagentWorker 捕获, exit 2 —— "协议层崩溃 → 父管理 reason:protocolError");
1144  *   - run() 抛 MaxTurnsExceeded → status:failed, reason:maxTurnsExceeded
1145  *     (plan T3 / ADR-0011: maxTurns 超限 = throw, worker emit failed envelope);
1146  *   - run() 抛 ProtocolError → status:failed, reason:protocolError
1147  *     (harness 模型协议错误, 不是 envelope 协议 —— 区别于 exit 2 路径);
1148  *   - 其他 run() 错误 → 抛出 (runSubagentWorker 兜底 → exit 2 → crashed)。
```

对应实码 catch 在 :1285-1293：`MaxTurnsExceeded` → failed envelope（:1286-1287）；`instanceof ProtocolError` → failed envelope（:1289-1291）；**其余 `throw err`（:1293）逃逸 → cli 兜底 exit 2**。注意 `TransportRetryExhaustedError extends Error`（非 ProtocolError 子类），若未来裸到 worker 层也走 :1293。文件头 :14-16 亦声明「未捕获错误 → exit 2 (协议层崩溃, 由 cli.ts 顶层 catch 兜底)」。

**(b) reason enum — `toFailedEnvelope` doc :918-926 + 类型定义 `src/harness/subagent/envelope.ts:168`：**

```ts
918  /** 失败路径 envelope (SC6 reason enum: crashed/maxTurnsExceeded/timeout/protocolError)。
```

```ts
// envelope.ts
168      "crashed" | "maxTurnsExceeded" | "timeout" | "protocolError";
```

（envelope.ts:318 是 JSON schema 的 `enum: ["crashed", "maxTurnsExceeded", "timeout", "protocolError"]` 同步格。）

### 2.7 `src/harness/subagent/manager.ts` — exit 非 0 → `reason:"crashed"` 归因

**(a) SC16 判定支 — :1512-1543（非 0 退出码 / 信号死 → settleCrash）：**

```ts
1512       // SC16:非 0 退出码 / 被信号杀死 → crashed,覆盖先前 envelope(即使已 completed)。
...
1516       const timedOut =
1517         task.state === "failed" && task.envelope?.reason === "timeout";
1518       if (!timedOut && (code !== 0 || signal !== null)) {
1519         const reason: "crashed" | "timeout" =
1520           task.state === "failed" && task.envelope?.reason === "timeout"
1521             ? "timeout"
1522             : "crashed";
...
1525         if (reason === "crashed") {
1526           void settleCrash({
1527             task,
...
1531             exitCode: code,
```

**(b) `settleCrash` 落 failed envelope + stop 事件 — :1205-1214（envelope/stateChange）与 :1232-1248（emitStop，带 exitCode/signal）：**

```ts
1205     task.envelope = locateEnvelope(task, {
1206       status: "failed",
1207       reason: "crashed",
1208       summary,
1209       result: "",
1210     });
1211     emitStateChange(task, "failed", {
1212       reason: "crashed",
1213       error,
1214     });
```

**(c) spawn 工厂抛错路径 — :1313-1318 + :1337-1339：**

```ts
1313       task.envelope = locateEnvelope(task, {
1314         status: "failed",
1315         reason: "crashed",
1316         summary: `subagent spawn failed: ${errMsg}`,
1317         result: "",
1318       });
```

（`crashedSummary` 拼「worker exit code=N signal=S」在 :534-539；queryBuffer 侧 `reason ?? "crashed"` 兜底在 :1754、:1760。）

### 2.8 `src/harness/errors.ts` — typed 错误家族 :27-60

```ts
27 export class ProtocolError extends Error {
28   // `: string` 显式注解:让子类可 override name 为其它字面量
30   override readonly name: string = "ProtocolError";
31 }
...
43 export class PromptTooLongError extends ProtocolError {
44   override readonly name = "PromptTooLongError";
45 }
...
51 export class TransportRetryExhaustedError extends Error {
52   override readonly name = "TransportRetryExhaustedError";
53   readonly attempts: number;
54   readonly cause: unknown;
55   constructor(attempts: number, cause: unknown) {
56     super(`transport retry exhausted after ${attempts} attempt(s)`);
```

要点：`PromptTooLongError extends ProtocolError`（:43）故 loop-engine :1950 与 worker.ts :1289 的 `instanceof ProtocolError` 都能命中；`TransportRetryExhaustedError extends Error`（:51，非 ProtocolError 子类），loop 侧靠 :1951 独立 instanceof 收口。`transportApiErrorOf` 在 :391。

---

## 3. 既有相关测试名册

1. `tests/tui/error-stop-notice.test.tsx` — 钉 TUI 异常 stopReason notice 映射：protocolError + apiError → 专用文案「API error (status): message」；protocolError 无 apiError → 通用「turn 未成功结束」文案（文件头 :6-18 记 Bug 2026-09-07 与 ADR-0094 SC4-SC5 引用）。
2. `tests/harness/model-adapter/anthropic-adapter-stream.test.ts` — 流式臂验收（#176/#147 D1/D3/D5/D8）：emit 序列、finalMessage→interpretMessage 与非流式同形、断流 reject 不构造 AssistantTurnResult。
3. `tests/harness/model-adapter/anthropic-adapter-prompt-too-long.test.ts` — 钉 `translatePromptTooLong` 唯一翻译判据（400+正则 → PromptTooLongError，其余原样 rethrow）。
4. `tests/harness/model-adapter/anthropic-adapter-clock-abort.test.ts` — 钉时钟 abort ≠ user_cancel（transport-continue-persist SC2）：`translateAnthropicTransportFault` 的 signal.reason 判据分流。
5. `tests/harness/model-adapter/anthropic-adapter.test.ts` — 非流式臂离线验收（contract 014 七类），断流缺陷不直接落此文件但同属 adapter 边界回归面。
6. `tests/harness/model-adapter/transport-retry.test.ts` — #672 T2 重试装饰器：退避表、retry-after、max attempts → `TransportRetryExhaustedError`、非 retry 类裸抛。
7. `tests/harness/fault-class.test.ts` — #672 T1 `classifyFault` G2 策略表（retry/fuse/none 各格 + clock_timeout visible 纪律）。
8. `tests/subagent/worker.test.ts` — `toOkEnvelope`（SC2/SC10）、`toFailedEnvelope` SC6 reason 四值（:156 describe）、`runWorkerOnce` stub 端到端（:187）、`parseWorkerEnvelope` 失败 → ProtocolError 上抛 SC13（:366）。
9. `tests/integration/subagent-chain.test.ts` — 进程级 manager↔worker 协议：fake 二进制 exit 2 无 envelope → queryBuffer `crashed`（:120）、stderr+exit 2 → crashed summary 携带 stderr（:135）。**这是 exit 2 冒用现状被钉为契约的测试面**（T4 改造时须同步更新语义而非删断言）。
10. `tests/subagent/manager.test.ts` — 终态归因名册：`SubAgentManager spawn → crashed`（:504 describe：exit code=1、信号杀、spawn 工厂抛错、ENOENT 各支）、timeout 已标 failed 后 SIGTERM 退出不被 crashed 覆盖（:747 注释支）。

---

## 4. ADR / spec 指针

### 4.1 ADR-0102 续跑闸（`docs/adr/0102-subagent-continue-after-complete.md`）

Decision 1（:16）原文：

> **闸 = 进程已死 + 本切片之后写下的工人 transcript。** `subagent_continue` 入参为本会话 `task_id` + 下一句。`running` 拒。`completed` / `failed` / `aborted` 只要有 transcript 均可续。切片之前只有 trace、没有 transcript 的拒，不从 trace 倒灌。

配套：Decision 2（:17）「再拉起，不保活。新 worker 进程；`load` 工人 transcript 的 rewind head，追加下一句 user，再 `run()`」；Why not（:25）「**Why not 只接 completed：** 失败/崩才是续跑主因」。→ 本缺陷修好后 failed envelope 天然可走此闸，无需新机制。

### 4.2 ADR-0094（`docs/adr/0094-llm-runtime-wire-model-and-viewport-api-error.md`）

**注意：ADR 正文为单段 Decision（:6），文件内没有字面 "SC4"/"SC5" 编号。** 代码与测试注释中的「ADR-0094 SC4-SC5」引用（loop-engine.ts:1953、error-stop-notice.test.tsx:14）对应的是该段原文这两句：

> 供应商/API 失败对人画在对话流（薄外壳 `API error (status):` + 原文），不追加进 session transcript（#120）；`StopReason` / `protocolError` 不当 UX 文案。

而字面 SC4/SC5 编号目前只存在于活跃 spec `specs/transport-continue-persist.md:43-44`（语义相关但属另一面——回合落盘与 sticky notice）：

> - SC4: protocolError after a user query leaves that user message on disk and no failed assistant.
> - SC5: Sticky abnormal-stop notice remains until user dismisses or starts a deliberate next action (no TTL auto-hide).

（该 spec 的 Settled invariant 1/4（:16-19 附近）另钉 visible 纪律与 retry-after/429/5xx/网络退避预算，即本 plan「复用既有重试机器」的契约出处。）

### 4.3 SC13 / assumption 16 出处

出处 = **已归档** spec `docs/archive/025-retire-completed-specs-and-plans/specs/356-subagent-v1.md`（#356 subagent-v1；非 `specs/` 活跃面）。

- SC13（:361）原文：

  > SC13 信封 schema 严校验：缺必填字段 / wrong type / 不是对象 → throw → 子代理 worker exit code ≠ 0 → 父管理标 `crashed`（envelope schema 校验失败等价于协议错误）。

- assumption 16（:34）原文：

  > **退出码约定**：子代理 worker 进程 0 = 收尾完整（即便 status=ok 也按 envelope 退出语义正常）；非 0 = 父代理 drain 走 `{status: "failed", reason: "crashed"}` 而非 exit code。**HOST 仅在协议层崩溃（JSON parse 失败 / 信封字段缺失）才走 exit ≠ 0**，并把 reason = `protocolError`。→ **自审通过**

- 旁证 assumption 14（:32）：`crashed` = 进程非 0 退出码或被信号杀死——即今天 exit 2 冒用后父侧必然落 crashed 的规则出处。

### 4.4 PR #1061/#1062 排除依据

见第 1 节 issue body「证据指针」末条：并发竞态形态为**重复 event id → schema_invalid**，而本缺陷崩溃 worker 的 transcript「零重复 event id、链合法」（现象节），二者形态互斥，排除同源。不另找代码证据。

---

## 5. 核实中发现的偏差（供实现者注意）

1. **manager「exit 非 0 → crashed」核心判定不在任务预估的 :1207-1339 区间**：区间内是 `settleCrash` 收口（:1205-1248）与 spawn 工厂抛错支（:1313-1339）；真正的 SC16 非 0 退出码判定在 :1512-1543。
2. **ADR-0094 无字面 SC4-SC5 编号**（见 4.2）：引用惯例与归档文档实际形态有漂移；T1 ADR 载体裁决时建议一并钉清引用写法。
3. **SC13 与 assumption 16 原文自身有微差**：SC13 说协议错误父侧标 `crashed`，assumption 16 说 reason=`protocolError`；实现（cli.ts:612-614 注释、worker.ts:1141-1148）采 assumption 16 侧。且两处都只写「exit ≠ 0」，**契约原文并未钉死 "2" 这个具体码值**——「exit 2 归还 SC13」表述上宜写「归还 assumption 16 的协议层崩溃专码」。
4. 任务给出的其余约数行号（adapter 527-566 / 516-525 / 898-915 / 862-873、with-transport-retry 125-156、fault-class 71-162、loop-engine ~1951（实为 1949-1963）、cli 608-627、worker 1134-1180 + 918、errors 27-60）均与当前 worktree 实际一致。
5. `TransportRetryExhaustedError` 在 loop 层已被 :1949-1952 收口为干净 protocolError 回合失败，**不会**裸抛到 worker/cli 层；worker.ts catch（:1285-1293）实际逃逸的是 loop 不认识的裸错误（本缺陷即 SDK 裸 Error）。T4 验收里「`TransportRetryExhaustedError` → failed envelope（新 reason 格）」若要成立，需先确认该错误在 worker 场景是否真会到达 :1293（当前代码路径下 loop 已消化，可能恒不逃逸——属 T1/T4 需裁决的实现细节）。
