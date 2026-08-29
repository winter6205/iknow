# Plan: trace-agent-readability

**Goal:** worker crash 后磁盘必有「error 字段 + stderr 指针 + 尾部 summary」三件套，agent 有了投影式 `query_trace` 工具与补齐的读侧过滤，trace 目录有 rotation 与 opt-in blob 去重——trace 对 LLM agent 与崩溃取证真正可用。

**Approach:** 三个 commit 组（ACR minimal-change 序列）：A = P0 crash 取证（T1→T2→T3 串行，crash 分支 → 落盘指针 → 入口无条件装配）；B = P1 写侧止血（T4、T5→T6，rotation 与 mask 缓存先立、blob 模式依赖 mask 缓存）；C = P1 读侧动线（T7、T8、T9、T10 基本并行，T9 复用 T7 定案的白名单）。每 bullet = 1 commit，commit 组 = review 颗粒。

**Spec link:** `specs/trace-agent-readability.md`
**ACR:** all-yes（5/5，2026-08-28）

```
bounded-context-guardian: yes — trace 域新增 rotation.ts 自包含于 src/harness/trace/；manager 经 diagnosticsDir DI 参数消费、不 import trace 内部（接口面只经 TraceService，与 358 同型）；query_trace 走 ADR-0004 registry SSOT 单点注册；traceserver 白名单/fields/parse 链自包含（ADR-0020 拓扑零改动）；session-api health 只读计数器。无跨域 import、无反向依赖。
defensive-contract-validator: yes — Testing Strategy 六类表覆盖 5 boundary classes：empty（空 stderrBuf 保裸 base——manager.test.ts:272 既有锁定、query_trace 未知 record_type typed 错误）；overflow（.log 1MiB cap、64KB burst 竞态专项、rotation 双帽边界、blob 目录不可写降级 full）；concurrent（多 worker crash .log 按 taskId 隔离、rotation mtime 保护活跃文件）；exception（写失败 never-throw + 计数器、safeTrace 同形态包裹 tee）；权限（query_trace 只读、三载体 mask grep 断言）。
error-handling-enforcer: yes — 每条失败路径 typed 且不静默：blob 写失败显式降级 full 行（不丢捕获语义）；trace 写失败 warn-once + health 计数（D13 契约不破）；crash 路径 error.type 非空为验收断言；错误枚举全复用 TraceStatus / reason 闭集，零新 magic code；竞态修复用有界 race 而非裸换事件（消除 close-never 挂起这类新失败模式）。
complexity-anti-drift: yes — 声明结构每函数单一抽象层：rotation 独立新文件（jsonl.ts 不再膨胀——jsonl.ts 只收 mask 缓存 + messages 一个 map 分支）；query-trace.ts 投影纯函数 + reader 直调，无新状态机；manager crash 分支局部收口在一个 race helper；写侧模式枚举刻意止步于 full|blob 两值（delta/off 被 Never 排除，防模式蔓延）；无深嵌套/复制意图。
minimal-change-verifier: yes — 1 个逻辑任务簇「trace 对 agent 可读」，非 scope creep（P2 五项显式排除）；内部按 P0 crash 取证 → P1 写侧止血 → P1 读侧动线 3 个 commit 组序列化（358 先例同型：解耦项单独 commit），组内每 bullet 仍 1 commit。
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch
**End of round:** 全部 bullet 落地后跑一轮整段 code-review（针对 A 组 + B 组 + C 组累计 diff），再 verification-before-completion 收尾。
**待写入:** 无——术语与 ADR 已于 spec 阶段 persist（ADR-0035 / ADR-0036 / CONTEXT.md 三词条）。

## Tasks (ordered by dependency)

### 组 A — P0 crash 取证

1. **crash summary 竞态修复 + error 字段填充** — tag: `[implementation]`
   - **Inherits:** spec C2——「exit 保终态 emit 不动 + stderr 流 end/close 有界 race（≤500ms）后构建 summary；不裸换 close」；`SubagentStopRecord.error`/`SubagentStateChangeRecord.error` 补填（Postel 留位已在 types.ts:289/308）；manager.test.ts:272「空 stderrBuf 保裸 base」锁定不破；envelope wire schema 零 diff。
   - **Surface:** `src/harness/subagent/`（manager crash 分支 + child.on("error") 同修）、`src/harness/trace/`（两 record 的 error 填充通道）。
   - **Acceptance:** >64KB stderr burst 后立即 `exit(2)` 的子进程，crash summary 含最后一条 stderr 行（竞态专项测试）；stop/state_change 行 `error.type` 非空；timeout 语义不被 crashed 覆盖（manager.ts:643 既有 guard 测试全绿）。Check: `npx vitest run tests/subagent`。
   - Status: [ ] pending
   - [blocks: T2]

2. **stderr 指针落盘 + diagnosticsDir DI 缝** — tag: `[implementation]`
   - **Inherits:** spec C1——`<traceDir>/stderr/<taskId>.log`、过 `createOutputMask` 后落盘、1MiB cap；`subagent_stop` 增 `stderr_path`/`stderr_bytes` Postel 可选字段；crashedSummary（父可见信封、模型面）同过 mask——修既有裸奔洞。
   - **Surface:** `src/harness/subagent/`（manager 工厂增 `diagnosticsDir?` 参数 + tee）、`src/harness/trace/`（stop record 两可选字段）。
   - **Acceptance:** 真实 OS pipe 必崩 worker（`stderr.write('boom'); exit(2)`）→ `.log` 存在且含 boom；注入 fake secret 后 `.log` 与信封 summary 均无明文；.log 恰在 1MiB cap 截断；多 worker 同时 crash 的 .log 按 taskId 互不覆盖。Check: tests/subagent 集成 + grep 断言。
   - Status: [ ] pending
   - [blocks: T3]

3. **crash 取证无条件装配 + worker trace 目录锚定** — tag: `[implementation]`
   - **Inherits:** ADR-0035（生命周期事件所有入口无条件；content trace 仍守 ADR-0003 D10 不进 chat REPL）；spec C3——worker trace 默认目录从 CWD 相对改 workspaceRoot 锚定；spawn env 透传 `IKNOW_TRACE_OUT=<resolved traceDir>`。
   - **Surface:** `src/cli.ts`（chat 入口 subagent 生命周期 trace 无条件装配）、`src/harness/build-engine.ts`（diagnosticsDir 透传）、`src/harness/subagent/`（spawn.ts / worker.ts）。
   - **Acceptance:** chat REPL（pipe、未配 traceOut）跑一次 spawn_subagent → `trace/subagent.jsonl` 出现三类生命周期事件；worker run 的 trace 文件落在锚定目录而非任意 CWD。Check: integration test。
   - Status: [ ] pending

### 组 B — P1 写侧止血

4. **trace 目录 rotation 双帽 + 价值分层驱逐** — tag: `[implementation]`
   - **Inherits:** spec C3（operator 复审修正 2026-08-29）——>500MB 或 >100 文件触发、env 可关、活跃文件（mtime < 5min）保护；驱逐序机械零 LLM（memory_gc 先例）：先删「无 error 记录且体量最小」（打招呼/调设置类会话的机械代理，同大小取更旧），再按 mtime 删最旧；error 扫描对候选惰性执行（从小文件起，成本有界）；crash stderr 日志与 `subagent.jsonl` 聚合文件不删；blobs/ 回收按 mtime orphans 规则起步（spec Open Questions 首版裁决）。
   - **Surface:** `src/harness/trace/`（新 rotation 模块 + jsonl 工厂接线，帽值检查在工厂创建时）。
   - **Acceptance:** 夹具目录超任一帽 → 无 error 且最小的夹具先被删、含 error 的夹具在帽内存活、总数 ≤ 帽；env=off 不删；rotation 与并发写竞争时不删活跃文件与受保护文件。Check: rotation 单测。
   - Status: [ ] pending
   - [parallel]

5. **maskJsonLine 工厂缓存** — tag: `[implementation]`
   - **Inherits:** spec C5——兑现 jsonl.ts:76 注释承诺（mask built once per factory call），行为不变。
   - **Surface:** `src/harness/trace/`（jsonl.ts mask 生命周期）。
   - **Acceptance:** 既有 #406 secret-roundtrip 测试全绿；新断言 mask 构造每工厂实例 1 次。Check: 既有 mask 测试 + 新单测。
   - Status: [ ] pending
   - [parallel]
   - [blocks: T6]

6. **blob 引用模式 opt-in** — tag: `[implementation]`
   - **Inherits:** ADR-0036——`IKNOW_TRACE_MESSAGES=full|blob`（默认 full，byte-shape 兼容）；blob 模式 messages 元素→`{sha, bytes}`、正文 mask 后写 `<traceDir>/blobs/<sha>` write-if-missing；`messages_captured` 语义不变；`tests/e2e/subagent-foreground-trace.test.ts:164` 断言路径零改动；blob 写失败显式降级 full 行。
   - **Surface:** `src/harness/trace/`（jsonl.ts recordLlmCall 序列化分支 + blobs 写入）。
   - **Acceptance:** 默认 full 下 e2e 全绿；`IKNOW_TRACE_MESSAGES=blob` 下行内为 sha 引用、`blobs/<sha>` 命中且内容无 secret 明文；blob 目录不可写时降级 full 不丢记录。Check: 两模式单测 + e2e 回归。
   - Status: [ ] pending

### 组 C — P1 读侧动线

7. **traceserver 白名单漂移修复 + turn_id 过滤** — tag: `[implementation]`
   - **Inherits:** spec C4——`TRACE_RECORD_TYPES` + verification/goal、fields 列映射、`?turn_id=` 精确过滤；不加聚合端点（`status=error` + 降序 + `limit=1` 已覆盖「最新错误」）；ADR-0020 拓扑零改动。
   - **Surface:** `src/traceserver/`（types / http / reader / fields）。
   - **Acceptance:** `?record_type=verification`（与 goal）返回 200 且 fields 含列；`?turn_id=` 命中；既有 traceserver 测试全绿。Check: `npx vitest run tests/traceserver`。
   - Status: [ ] pending
   - [parallel]
   - [blocks: T9]

8. **grep 超长命中行截断** — tag: `[implementation]`
   - **Inherits:** ADR-0006 工具级参数域（工具级管「读多少」语义单位）——rg 路径 `--max-columns=2000`、Node fallback 在 scanLines visit 处截单行 + 截断标记；executor 20k 兜底不变（契约 X）。
   - **Surface:** `src/harness/aci/tools/`（grep）。
   - **Acceptance:** 命中 1MB 单行时该条 ≤2000 chars + 标记，同查询其余命中不被挤出。Check: grep 单测。
   - Status: [ ] pending
   - [parallel]

9. **query_trace ACI 工具** — tag: `[implementation]`
   - **Inherits:** spec 裁决 4——进 `createDefaultAciRegistry` SSOT（第 11 工具、permission read-only + fast timeout tier）；投影模式：llm_call 默认返回 `messages_count` + 首/末条预览 + error、`record_id` 精确下钻；返回体自限 ≤4000 chars；record_type 校验镜像 traceserver 白名单（消费 T7 定案集合）；进程内直调 `createJsonlTraceReader`。
   - **Surface:** `src/harness/aci/tools/`（新 query-trace 工具 + registry 注册）。
   - **Acceptance:** registry 工具数 SSOT 断言更新；`status=error` 命中错误行且返回不含 messages 全文；`record_id` 下钻取到单条详情；未知 record_type → typed 错误；单次返回 ≤4000 chars。Check: tests/aci 单测。
   - Status: [ ] pending
   - [blocks: T7]

10. **trace 写失败计数经 health 暴露** — tag: `[implementation]`

- **Inherits:** spec C6——维持 ADR-0003 D13 never-throw + warn-once，追加实例级失败计数，`GET /api/v1/health` 暴露 `traceWriteFailures`。
- **Surface:** `src/harness/trace/`（jsonl/noop 实例计数）、`src/session-api/`（health 只读消费）。
- **Acceptance:** 模拟写盘失败 → health `traceWriteFailures` ≥1 且 loop 不 crash。Check: session-api 单测。
- Status: [ ] pending
- [parallel]

## Tracker

**Fallback（local markdown）— operator 裁定（2026-08-29）：实现改走直接 PR 流程，不经 issue 跟踪。** 曾按主路径建过 spec issue #790 + T1–T10（#791–#800），已全部关闭（not planned，留关闭 comment 指回本文件）。依赖序、Acceptance、commit 颗粒以本文件为 SSOT。

**实现流程（直接 PR）：**

1. 从 master 切 feature 分支（如 `trace-agent-readability`）。
2. 按 T1→…→T10 依赖序实现，**1 bullet = 1 commit**（Conventional Commits）；每 bullet 循环：tdd → typecheck+tests → （整段收尾统一）code-review → verification-before-completion。
3. 全部 bullet 落地后跑一轮整段 code-review（A/B/C 组累计 diff）+ verification-before-completion，然后推分支开 PR（master），PR body 引用本计划与 `specs/trace-agent-readability.md`。
4. PR review 意见逐 commit 修正；merge 前不重复跑 per-commit code-review（AGENTS.md 收尾纪律：针对整轮改动一次）。

**Acceptance checklist（writing-plans binary，2026-08-29 核验）:** 计划文件在场 ✅；10 bullet 各恰一 tag（全 `[implementation]`，decision 已于 spec/ADR 阶段定案）✅；每 bullet Inherits + 可观测 Acceptance ✅；headroom 成立 ✅；每 bullet 垂直携带测试 ✅；依赖序与 [parallel]/[blocks:] 一致 ✅；ACR 5-verdict 在同文件 ✅。**待写入清单空 → persist skip。**
