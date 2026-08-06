# Plan: Session API 路径迁移到 harness foundation（022 / #51）

> **Spec**: `specs/022-session-api-migration.md`（ACR 5/5 PASS）
> **Tracker**: GitHub issues（`ready-for-agent` label）— gh CLI 可用
> **Issue map**:
> T1=#[78](https://github.com/winter6205/iknow/issues/78) [decision]
> T2=#[79](https://github.com/winter6205/iknow/issues/79) [implementation]
> T3=#[80](https://github.com/winter6205/iknow/issues/80) [implementation]
> T4=#[81](https://github.com/winter6205/iknow/issues/81) [implementation]
> T5=#[82](https://github.com/winter6205/iknow/issues/82) [implementation]
> T6=#[83](https://github.com/winter6205/iknow/issues/83) [implementation, parallel w/ T7]
> T7=#[84](https://github.com/winter6205/iknow/issues/84) [implementation, parallel w/ T6]
> T8=#[85](https://github.com/winter6205/iknow/issues/85) [implementation]
> T9=#[86](https://github.com/winter6205/iknow/issues/86) [implementation]
> T10=#[87](https://github.com/winter6205/iknow/issues/87) [implementation]
> T11=#[88](https://github.com/winter6205/iknow/issues/88) [implementation]
> **Frontier**: #78 + #79 (no blockers, ready to claim)
> **Blocking edges**: 15 native edges via GraphQL `addBlockedBy` (verified 2026-07-30)
> **Base branch**: `worktree-022-spec`（或合并后的 master）
> **Scope ref**: 取代 `plans/web-interaction-session-api.md`（G2 every turn + ConversationState + `/commands` 端点的老决策，已被 #51 推翻）。新 plan 物理迁移 session-api 路径到 harness foundation。
> **节奏**: expand→contract（spec 已声明是 wide mechanical refactor）。先扩（旧 wire + 新 wire 并行）→ 批量迁 call sites → 缩（删旧 wire + 归档 interaction）。

---

## Section 1 — Context-Loop Pre-Check

- `docs/CONTEXT.md` 已读：术语 = Loop Engine / append-only messages / LoopTrace / StopReason / in-flight closeout / ToolExecutionContext / required runtime layer / ConversationState (deprecated) / G2 (deprecated)。本 plan 不重定义，引用即可。
- `docs/adr/0001-9router-stack-as-code-defaults.md` 是 in-scope ADR。#51 范围不修改 `src/config/env.ts` 栈默认。**无 ADR 矛盾**。
- `plans/web-interaction-session-api.md`（老 plan）**与本 plan 决策冲突**（G2 every turn / ConversationState 复用 / `/commands` 端点齐全），是 #51 前置决策的反向引用：
  > Contradicts `plans/web-interaction-session-api.md` — but worth reopening because #51 Q1/Q3 决议整体退役 G2 envelope + slash 体系，018 refined 路线已取代该老 plan 的 host 层假设。本 plan 是其取代者，不重开其决策。

## Section 2 — ACR 5-Verdict Block（引自 spec）

```
bounded-context-guardian: yes — 模块级责任表锁定 Session API 消费 harness、web 不 import interaction；CR5 + Architectural Constraint 显式 gate `src/session-api/` 零 import `src/agent-loop/` + `src/interaction/`。
defensive-contract-validator: yes — 5 类边界 + 覆盖率 ≥80%/70% + 6 类 SessionStoreError 各 ≥1 test + 错误映射契约表每行 ≥1 test + harness cancelled/timeout 各 ≥1 test。
error-handling-enforcer: yes — typed `SessionStoreError` 6 类 + `ApiErrorBody` wire shape + 错误映射契约表 + Boundaries-Never 禁 bare throw / 禁 6 类坍缩。
complexity-anti-drift: yes — 阈值钉死 cyclomatic ≤10 / nesting ≤4 / 函数 ≤40（>60 hard split）/ 文件 ≤500 hard / 参数 ≤4 options-object hard；适用文件枚举 hub.ts / SessionStore / useSessionChat.ts / SessionSidebar.tsx。
minimal-change-verifier: yes — 1 logical task（Session API 路径迁 harness）+ Q1-Q5 内部 coherence；~22 文件是同一连贯迁移。
```

OVERALL: PASS。

## Section 3 — Tracer Bullets（依赖序）

---

### T1. `[decision]` SessionStore IO 错误契约与映射表最终敲定

- **背景**: spec §SessionStore IO 错误契约定义了 6 类 `SessionStoreError` + `ApiErrorBody` + 错误映射契约表，但具体 error message 措辞、retryable 字段是否进 wire、`http.ts` 错误响应是否复用 020 已定义的 `ApiErrorBody` 形状 vs 引入新 DTO，spec 留了实施空间。
- **决策点**:
  - **D1.1**: `ApiErrorBody` 直接复用 020 `src/session-api/contract.ts` 已定义的 `ApiErrorBody` 类型，不引入新 DTO；新增 `error.kind` 字段（字符串 union：`not_found` / `parse_failed` / `schema_invalid` / `write_failed` / `concurrent_write` / `io_error` / `validation` / `internal`）。
  - **D1.2**: retryable 字段**不**进 wire（避免客户端硬编码 retry 策略）；hub 层在 HTTP status 上区分（5xx = retryable，4xx = not retryable）。
  - **D1.3**: SessionStoreError 类定义在 `src/session-api/store/errors.ts`，与 SessionStore class 同目录，不混入 hub.ts。
  - **D1.4**: hub 捕获 SessionStoreError 用 `try/catch` 映射到 HTTP status + ApiErrorBody；其他未知异常 → `internal` 500。
- **Affects**: 无代码变更（纯决策记录）
- **Acceptance**: 决策写入本 plan，T3-T10 实施时引用。□
- **Per-ticket loop**: N/A（decision-only）

---

### T2. `[implementation]` SessionStore 模块骨架 + JSON 文件读写 helper + 错误契约类型

- **背景**: T1 敲定的 `SessionStoreError` + 6 类契约需要落地为可单测模块。spec §SessionStore 文件 schema 约束定义了 `SessionFileV1` shape。
- **Affects**:
  - `src/session-api/store/errors.ts` — **新增**：export `SessionStoreError` 判别联合 + `ApiErrorBody` 扩展（按 T1 D1.1）
  - `src/session-api/store/session-store.ts` — **新增**：SessionStore class（含 `load` / `save` / `list` / `delete` methods；method 列表实施者定但必须覆盖这 4 个操作）；JSON 读写用 `fs/promises`
  - `src/session-api/store/schema.ts` — **新增**：`SessionFileV1` type + schemaVersion 校验 helper（ajv 015 strict 风格）
  - `src/session-api/store/index.ts` — **新增**：barrel re-export
  - `tests/session-api/store/session-store.test.ts` — **新增**：6 类 SessionStoreError 全覆盖测试（empty / 损坏 JSON / schemaVersion 不匹配 / 写入失败 / 并发 / 其他 IO）
- **Acceptance**:
  - `npm run typecheck` 退出码 0 □
  - `npm test -- tests/session-api/store` 退出码 0 □
  - 6 类 SessionStoreError 各 ≥1 test（assert 抛出的 SessionStoreError.kind 与契约一致）□
  - `SessionStore.load` 对损坏 JSON 抛 `{ kind: "parse_failed", reason: <excerpt> }`，**不**抛裸 Error □
  - `SessionStore.save` 用 `fs.writeFile` + `JSON.stringify` + 原子替换（写 `.tmp` 再 rename），避免半写入 □
  - 现有 `tests/` 19 suites 不回归 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- **实施要点**:
  - JSON schema 校验失败 = `schema_invalid`（区别于 `parse_failed` -- 前者是 JSON 合法但 shape 不对，后者是 JSON 都不合法）
  - `list` 读 `data/sessions/*.json` 目录（不递归），按 `updatedAt` 倒序；返回 metadata 元数据数组（含 `conversation_id` + `updatedAt` + 最近 finalText 摘要，不含 messages）
  - 并发串行化由 hub 层负责（spec A15），SessionStore 本身不维护 `Map<id, Promise>`，保持 stateless
  - 单 file ≤ 500 行；method 体 ≤ 40 行；方法参数 ≤ 4（超出用 options object）

---

### T3. `[implementation]` wire DTO 改写：TurnDto.answer 退役 IknowAnswer + SessionSummary 去 role

- **背景**: spec Q1 + Q2-G4 决议落地。spec §wire DTO 约束已给出 `TurnAnswerDto` / `TurnDto` / `SessionSummary` shape。
- **Affects**:
  - `src/session-api/contract.ts` — 改 `TurnDto.answer: IknowAnswer` → `TurnDto.answer: TurnAnswerDto`；新增 `TurnAnswerDto` 类型；`SessionSummary` 移除 `caller_role` 字段；保留 `mode` 字段（020 锁）；**保留** `ApiErrorBody` 类型（T1 D1.1 复用）
  - `src/shared/schema.ts` — 删 `interface IknowAnswer`（line 207-219）+ `interface SessionContext`（Q2-G4 决议）
  - `tests/session-api/contract.test.ts` — **新增**：TurnDto.answer shape 校验测试；SessionSummary 不含 caller_role 断言
- **Acceptance**:
  - `npm run typecheck` 退出码 0（任何引用 `IknowAnswer`/`SessionContext` 的代码会编译报错，必须在 T5-T8 同步改）□
  - `npm test -- tests/session-api/contract` 退出码 0 □
  - `grep -r "IknowAnswer\|SessionContext" src/` 返回零命中（除 `contract.ts` 的 `ApiErrorBody` 复用说明外）□
  - `TurnDto.answer` 字段 = `{ finalText, stopReason, turnCount }`，**不**含 `messages` / `trace` / `snapshot_id` 等旧字段 □
  - `SessionSummary` 不含 `caller_role` 字段（grep 验证）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T2]`（store 错误契约先定，wire DTO 才能引用 SessionStoreError）

---

### T4. `[implementation]` hub.ts 改造：loadSessionFile → run(opts.priorMessages) → saveSessionFile 串联

- **背景**: spec §hub.ts 调用形态约束已给出 4 步路径（load → run → save → wire 投影）。spec §SessionStore IO 错误契约要求 hub 用 typed SessionStoreError → HTTP status 映射，不抛裸异常。
- **Affects**:
  - `src/session-api/hub.ts` — 重写 `postMessage` 路径：
    - 旧 `buildAgent` + `IknowAgent.answer` + `LlmIknowAgent.answer` 全部退役
    - 新 `run(userText, deps, undefined, { priorMessages: session.messages })` 调 harness
    - `SessionStore.load(conversation_id)` → 拿 `SessionFileV1`
    - `run()` 返回 `{ result, trace }`，`trace` 立即 GC（不引用）
    - cancelled (stopReason === "cancelled") → `saveSessionFile` no-op（messages 不变）
    - timeout (`stopReason === "timeout"` 或正常完成) → `saveSessionFile` 写入 result.messages + turnCount 累加
    - 错误路径：SessionStoreError → HTTP status 映射（按 T1 错误映射契约表）；harness 抛 typed error → 转 stopReason 进 TurnAnswerDto
  - `src/session-api/hub.ts` — `createSession` / `getSession` / `resetSession` / `listSessions` 跟随 Q2-G1 + Q5 决议：基于 SessionStore 实现，不再依赖 ConversationState / buildAgent
  - `tests/session-api/hub.test.ts` — **新增**：5 类边界测试（empty / negative / overflow / exception / concurrent）+ 错误映射契约表每行测试
- **Acceptance**:
  - `npm run typecheck` 退出码 0 □
  - `npm test -- tests/session-api/hub` 退出码 0 □
  - `grep -r "buildAgent\|IknowAgent\|LlmIknowAgent\|ConversationState\|processChatLine" src/session-api/` 返回零命中 □
  - postMessage 路径：load → run → save → wire 投影四步；cancelled no-op / timeout 写入 / 其他错误抛 typed SessionStoreError □
  - 错误映射契约表 6 行（not_found → 404 / parse_failed → 422 / schema_invalid → 422 / write_failed → 500 / concurrent_write → 409 / io_error → 500）每行 ≥1 test（assert HTTP status + ApiErrorBody.kind + retryable via 5xx/4xx）□
  - harness cancelled/timeout → TurnAnswerDto.stopReason 正确映射（assert TurnDto.answer.stopReason === "cancelled" | "timeout"）□
  - 同 id 并发 POST /messages 串行化（用 vitest Promise.all + 断言串行效果）□
  - 现有 session-api 测试不回归（注意：020 后 vitest 套件可能不存 session-api 测试，需写新测试）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T2, T3]`

**实施要点**:

- 复刻 020 `src/cli/chat-session.ts:74-89` 写法（spec A16）
- turnCount 累加：`session.turnCount + result.turnCount`（020 决议每条 message run() 从 0 起 → 累加）
- `run()` 期间 messages 单源是文件（hub 不持有副本）
- hub 函数体 ≤ 40 行（超则拆 helper）；cyclomatic ≤ 10
- LiveSession 是 hub 内部 cache（最近访问时间 / lazy 加载标志），不持有 messages 副本

---

### T5. `[implementation]` http.ts 路由表：删 commands + 新增 GET /sessions 列表

- **背景**: spec §Project Structure 锁定 http.ts 改动 = 删 `POST /sessions/:id/commands` + 新增 `GET /sessions` 列表 + 改其他 4 个端点 wire 形态。
- **Affects**:
  - `src/session-api/http.ts` — 删 `POST /api/v1/sessions/:id/commands` 路由 handler；新增 `GET /api/v1/sessions` 列表路由；改 4 个现有路由（createSession / getSession / postMessage / resetSession）的 wire 投影从 IknowAnswer → TurnAnswerDto
  - `src/session-api/http.ts` — 错误响应统一用 `ApiErrorBody`（T1 D1.1 复用），SessionStoreError → HTTP status + ApiErrorBody 映射在 http 层完成
  - `tests/session-api/http.test.ts` — **新增**：7 个端点（health + 5 + list）的 HTTP 集成测试（含 4 个端点 wire 形态改后 + 1 新端点 + 1 删端点 + health 保留）；错误响应 shape 测试
- **Acceptance**:
  - `npm run typecheck` 退出码 0 □
  - `npm test -- tests/session-api/http` 退出码 0 □
  - `POST /api/v1/sessions/:id/commands` 路由 handler 物理删除（grep `commands` http.ts 无命中）□
  - `GET /api/v1/sessions` 路由存在（curl + grep http.ts）□
  - 4 个现有路由（create / get / postMessage / reset）的 wire 响应符合 TurnAnswerDto / SessionSummary 新 shape □
  - 错误响应统一 `{ error: { kind, message, conversation_id? } }` 形态（curl 验证）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T3, T4]`

---

### T6. `[implementation]` web/types.ts + web/client.ts + web/api/types.ts wire DTO 同步改写

- **背景**: spec §Project Structure 锁定 web 端 API 层改动 = types.ts 删 IknowAnswer + 加 SessionListItem DTO + 改 TurnDto；client.ts 删 postCommand + 加 listSessions + 可能加 GET history helper。
- **Affects**:
  - `web/src/api/types.ts` — 删 `IknowAnswer` type；新增 `SessionListItem` type（包含 `conversation_id` / `updatedAt` / finalText 摘要 / 不含 messages）；改 `TurnDto.answer: TurnAnswerDto`；`SessionSummary` 同步去 `caller_role` 字段
  - `web/src/api/client.ts` — 删 `postCommand` helper；新增 `listSessions()` 调 `GET /api/v1/sessions`；新增 `getSessionHistory(id)` 调 `GET /api/v1/sessions/:id`（实施期定具体 history DTO 形态）
  - `web/src/api/types.test.ts` — **新增**（vitest 跑 web 类型测试；或 web-only tsc --noEmit 检查）
- **Acceptance**:
  - `cd web && npx tsc --noEmit` 退出码 0（types 引用一致性）□
  - `npm test` 退出码 0（web 类型测试如已存在）□
  - `web/src/api/types.ts` grep `IknowAnswer\|caller_role` 零命中 □
  - `web/src/api/client.ts` grep `postCommand` 零命中 □
  - `listSessions()` + `getSessionHistory()` helper 物理存在且 tsc 通过 □
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[parallel]` 与 T7
- `[blocks: T5]`

---

### T7. `[implementation]` web 组件改造：删 G2Panel + 改 MessageBubble + 改 ChatHeader + useSessionChat 状态机

- **背景**: spec Q5 决议 web 端不保留 G2Panel / Mode select / Role select；改 useSessionChat 状态机跟新 wire；保留 Reset / New Session header 按钮（不通过 commands 端点）。
- **Affects**:
  - `web/src/components/G2Panel.tsx` — **删**：物理删除
  - `web/src/components/MessageBubble.tsx` — 改读 `message.answer.finalText` / `stopReason` / `turnCount`（替代 `answer.text` / `source_spans` / `snapshot_id` / `governance_status` / `hops_used`）；删 IknowAnswer 字段渲染
  - `web/src/components/ChatHeader.tsx` — 删 Mode select；删 Role select；保留 Reset / New Session 按钮（复用 `resetSession` / 新建会话 API）
  - `web/src/hooks/useSessionChat.ts` — 删 `setMode` / `setRole` / `postCommand`；改 `sendMessage` 读 `res.turn.answer.finalText` + `stopReason` + `turnCount`；加 `localStorage` 缓存 `conversation_id`；加刷新页面拉 history 逻辑（call `getSessionHistory`）
  - `web/src/components/{MessageList,AppShell,Composer}.tsx` — 跟随改（MessageBubble 改读后，MessageList 自动跟上；AppShell 为 T8 侧栏挂载预留；Composer 不动）
  - `web/src/lib/format.ts` — 可能微调 `shortId` 等 helper（看实施期需要）
  - `web/src/components/ErrorBoundary.tsx` — 不动
- **Acceptance**:
  - `cd web && npm run build` 退出码 0 □
  - `cd web && npx tsc --noEmit` 退出码 0 □
  - `web/src/components/G2Panel.tsx` 物理不存在（ls 验证）□
  - `web/src/components/ChatHeader.tsx` grep `Mode select\|Role select\|onModeChange\|onRoleChange` 零命中 □
  - `web/src/hooks/useSessionChat.ts` grep `postCommand\|setMode\|setRole\|IknowAnswer` 零命中 □
  - `MessageBubble.tsx` grep `answer\.source_spans\|answer\.snapshot_id\|answer\.hops_used\|answer\.governance_status` 零命中（只读 finalText/stopReason/turnCount）□
  - `localStorage` 存 `conversation_id`（grep 验证）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[parallel]` 与 T6
- `[blocks: T5]`

---

### T8. `[implementation]` web 新增 SessionSidebar 组件 + AppShell 挂载

- **背景**: spec Q5 决议 = 本期做会话历史侧栏，数据源 JSON 文件存储，新端点 `GET /api/v1/sessions`（T5 已建）。
- **Affects**:
  - `web/src/components/SessionSidebar.tsx` — **新增**：会话列表组件，调 `listSessions()` 拉元数据；点击切换调 `getSessionHistory()` + `useSessionChat.setConversation(id)`；当前会话高亮；空状态 / 加载态 / 错误态
  - `web/src/components/AppShell.tsx` — 挂载 SessionSidebar（侧栏布局）
  - `web/src/hooks/useSessionChat.ts` — 加 `setConversation(id)` action；切换会话时清 messages + 拉 history 填回
  - `web/src/components/SessionSidebar.test.tsx` — **新增**（vitest + React Testing Library；如项目未引入 RT 则用 vitest 单元测试 pure helpers）
- **Acceptance**:
  - `cd web && npm run build` 退出码 0 □
  - `cd web && npx tsc --noEmit` 退出码 0 □
  - `web/src/components/SessionSidebar.tsx` 物理存在 + import 进 AppShell □
  - `npm test -- tests/web/SessionSidebar` 退出码 0 □
  - SessionSidebar 调 `api.listSessions()` 拉列表 + 调 `api.getSessionHistory(id)` 切换会话（grep 验证）□
  - 空状态（无会话）/ 加载态（spinner 或 skeleton）/ 错误态（提示重试）三态完整（assert DOM）□
  - 当前会话高亮（assert DOM className 含 `active` 或 `current`）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T6, T7]`

---

### T9. `[implementation]` 归档 src/interaction/ + 删 tests/interaction.test.ts + 删 buildAgent

- **背景**: spec Q4 决议 = `src/interaction/` 整目录归档到 `docs/archive/022-retire-interaction/`；`tests/interaction.test.ts` 物理删除（其测试对象已归档）；`src/cli/runtime.ts` 的 `buildAgent` 退役（hub 不再 import）。
- **Affects**:
  - `docs/archive/022-retire-interaction/` — **新增**：5 文件归档（`index.ts` / `types.ts` / `conversation.ts` / `format.ts` / `slash.ts`）+ `README.md`（对齐 021 归档模式）
  - `docs/archive/022-retire-interaction/README.md` — 记录退役理由 + 归档内容清单 + Cross-references（spec PR + #51 Resolution）
  - `src/interaction/` — **删**：物理删除（5 文件已归档）
  - `tests/interaction.test.ts` — **删**：物理删除
  - `src/cli/runtime.ts` — 删 `buildAgent` 函数 + `AnswerAgent` type + 相关 import；保留 `buildHarnessEngine`（CLI 用）
  - `src/index.ts` — 确认无 `IknowAnswer` / `SessionContext` re-export（T3 schema.ts 删后这里也必须清）
  - `docs/archive/022-retire-interaction/` 下的 `index.ts` 是归档副本，barrel re-export 保留（让归档结构自洽）
- **Acceptance**:
  - `npm run typecheck` 退出码 0 □
  - `npm test` 退出码 0（含 interaction.test.ts 删除后剩余 18 suites 全绿）□
  - `ls src/interaction/` 报 No such file or directory □
  - `ls docs/archive/022-retire-interaction/` 含 5 个 .ts 文件 + README.md □
  - `ls tests/interaction.test.ts` 报 No such file or directory □
  - `src/cli/runtime.ts` grep `buildAgent\|IknowAgent\|LlmIknowAgent` 零命中（保留 `buildHarnessEngine`）□
  - `src/session-api/` grep `from "../agent-loop/\|from "../interaction/` 仍零命中（T4 已保；本步再验）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T4, T5, T7]`

**实施要点**:

- 归档用 `git mv` 保留 history（不是 copy + delete）
- README 包含：原 `src/interaction/` 职责总结 + 退役理由（Q1/Q2-G4/Q3 决议）+ 归档 commit SHA + #51 Resolution 链接 + 后续影响（021-Q2 已记录）

---

### T10. `[implementation]` `data/sessions/` 目录创建 + `.gitignore` 更新 + CHANGELOG Breaking 条目 + i11 smoke 脚本

- **背景**: spec A11/A12/A13 决议 = 数据目录 .gitignore 排除 + CHANGELOG 加 Breaking 条目（对齐 021 格式）；实施期手动 smoke 脚本对齐 i9/i10 惯例。
- **Affects**:
  - `data/` — **新增**目录（含 `.gitkeep` 占位，让目录在 git 里存在）
  - `.gitignore` — 加 `data/sessions/` 或 `data/`（项目惯例判断；保守加 `data/sessions/*` 不加 `data/` 因为 README/CHANGELOG 也可能在 data/）
  - `CHANGELOG.md` — 加 `### Breaking (internal, pre-release)` 条目，记录本次变更（spec A13 格式对齐 021）
  - `scripts/i11-session-api-harness-smoke.ts` — **新增**：对齐 i9/i10 惯例，6 条断言（completed / stopReason / turnCount ≥ 2 / 多 step / finalText 非空 / cancelled/timeout 各一）
  - `package.json` scripts — 不新增（spec A8）；i11 脚本通过 `npx tsx scripts/i11-...` 调用
- **Acceptance**:
  - `ls data/.gitkeep` 存在 □
  - `.gitignore` 含 `data/sessions/*` 或等价项 □
  - `git status` 不显示 `data/sessions/<id>.json`（验证 .gitignore 生效）□
  - `CHANGELOG.md` grep `### Breaking (internal, pre-release)` 含本次变更条目 □
  - `npx tsx scripts/i11-session-api-harness-smoke.ts` 退出码 0 + 6 条断言全过（需 9router key；缺失时 skip + 打印 "key missing, smoke skipped"）□
  - 冒烟证据归档 `docs/handoff/<date>-i11-smoke/`（对齐 i4/i9/i10 模式）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T8, T9]`

**实施要点**:

- CHANGELOG 条目格式严格对齐 021：`### Breaking (internal, pre-release)` + bullet 列出 IknowAnswer 退役 / SessionContext 退役 / slash 端点删 / src/interaction/ 归档 / src/agent-loop/ 7 文件全归档（spec 写的是「在 #51 完成后全归档」，但本 plan 没单列归档 agent-loop 的 tracer bullet，可在 T9 同步做或开 T10.1 单独做；实施期定）
- i11 smoke 不进 `npm test`（对齐 i9/i10 惯例；项目 I4 已归档三模式 + HTTP 冒烟）
- 截图存 handoff（spec A10）放在 `docs/handoff/<date>-web-adapt/`（web 适配证据），不混入 smoke handoff

---

### T11. `[implementation]` web 手动冒烟 4 场景 + 截图归档 + 全量验收

- **背景**: spec A10 决议 web 端完成证据 = typecheck + build + vitest + 手动冒烟 4 场景 + 截图。这是最后一个 tracer bullet，把所有变更走完 ground truth。
- **Affects**:
  - `docs/handoff/<date>-web-adapt/` — **新增**：截图归档（实施期手动产）
  - `CHANGELOG.md` — 可能追加 §web-adapt 引用（指向 handoff 截图）
- **Acceptance**:
  - 浏览器 4 场景手动冒烟通过：
    1. 发消息（输入文本 → 看到消息卡片显示 finalText）
    2. 刷新页面恢复（localStorage conversation_id + GET history → messages 恢复显示）
    3. 新建会话（New Session 按钮 → conversation_id 更新 + messages 清空）
    4. 切换历史会话（侧栏点旧会话 → GET history → 旧消息恢复）
  - 4 张截图存 `docs/handoff/<date>-web-adapt/` □
  - `npm run typecheck` + `npm test` + `cd web && npm run build` 全 exit 0 □
  - vitest 覆盖率 ≥ 80% line / ≥ 70% branch for `src/session-api/{hub,contract,http,serve}.ts` + `store/**`（spec SC21）□
  - SC5 / SC6 / SC7 / SC8 / SC9 / SC10 / SC11 / SC12 / SC13 / SC14 / SC15 / SC17 / SC18 / SC19 / SC20 / SC22 / SC23 / SC24 二元判据全过 □
  - `code review` 确认不破坏 019/020/021 成果（CLI 路径不回归 / src/eval/ 归档不回归 / 公开面 BREAKING 范围不扩大）□
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
- `[blocks: T10]`

**实施要点**:

- 截图用浏览器 DevTools 截（4 个场景各 1 张）
- 截图 markdown 嵌入 `docs/handoff/<date>-web-adapt/README.md` 含 4 张图 + 4 场景说明 + 验收结论
- 这一步是 ground truth 闭环：所有 spec Success Criteria 1-24 跑一遍 binary 勾选
- 不通过 → 回对应 tracer bullet 修（spec 反馈回路）

---

## Dependency Graph

```
T1 [decision] ── SessionStore 错误契约最终敲定
 │
 ▼
T2 [implementation] ── SessionStore 模块骨架 + 错误契约类型
 │
 ├──► T3 [implementation] ── wire DTO 改写（TurnDto + SessionSummary 去 role）
 │    │
 │    ├──► T4 [implementation] ── hub.ts 改造（load→run→save 串联）
 │    │    │
 │    │    ▼
 │    └──► T5 [implementation] ── http.ts 路由（删 commands + 新增 list）
 │         │
 │         ├──► T6 [implementation] ── web/types + client + api/types
 │         │    [parallel with T7]
 │         │
 │         └──► T7 [implementation] ── web 组件改造（G2Panel 删 + MessageBubble 改 + ChatHeader 改 + useSessionChat）
 │              [parallel with T6]
 │              │
 │              ▼
 │         T8 [implementation] ── SessionSidebar 新增 + AppShell 挂载
 │         [blocks: T6, T7]
 │         │
 │         ▼
T9 [implementation] ── 归档 src/interaction/ + 删 tests/interaction + 删 buildAgent
[blocks: T4, T5, T7]
 │
 ▼
T10 [implementation] ── data/ + .gitignore + CHANGELOG + i11 smoke
[blocks: T8, T9]
 │
 ▼
T11 [implementation] ── web 手动冒烟 4 场景 + 截图 + 全量验收
[blocks: T10]
```

## Section 4 — Out-of-scope（不归本 plan，留后续票）

- **engine-timeout HTTP 未取消修法** = #54（独立子票，不阻塞 #51）
- **trace B 层字段 / 条件式修复层** = 017 deferred（自动重试 / token-cost 护栏 / OTel-span-metric 树），本 plan 不引入
- **MCP 故事 / 新工具协议 / 外置记忆** = #33 GraphRAG map 范围
- **多代理 / 动态工作流 / 生产认证 / 多租户** = map #44 Out of scope
- **会话历史侧栏 UI 视觉细化**（宽度 / 折叠态 / 动画）= spec A18 留 implementation
- **前端自动化测试框架引入**（playwright / cypress）= spec A10 决议不引
- **数据库 / 文件锁 / 跨进程 IPC** = spec A14/A15 决议不引
- **`src/agent-loop/` 7 文件归档**：spec Objective 提到「#51 完成后可安全归档/删除」。本 plan T9 可同步做或开 T9.1 单独做。**实施期判断**：如果 src/agent-loop/ 7 文件已被 src/session-api/ 完全不引用 + src/cli/runtime.ts 已删 buildAgent（T9 涵盖），则用 `git rm -r src/agent-loop/` 一次归档即可；如果仍被 buildHarnessEngine 或测试间接引用，则单独 T9.1 处理。**默认假设可同步归档**。

## Section 5 — Verification Checklist

- [ ] Plan has ≥ 3 tracer bullets → **11 bullets**
- [ ] Each bullet has 1+ binary acceptance criterion → yes（每条 ≥1 个 □ binary）
- [ ] Each bullet maps to exactly 1 commit → yes（spec 锁定 1 commit = 1 logical task）
- [ ] Bullets ordered by dependency → yes（T1 → T2 → T3 → T4-T5 → T6-T7 parallel → T8 → T9 → T10 → T11）
- [ ] Plan lives in `plans/022-session-api-migration.md` → yes
- [ ] ACR 5-verdict block present in Section 2 → yes
- [ ] Context-loop pre-check in Section 1 → yes（含老 plan 冲突标注）
- [ ] expand-contract 节奏显式声明 → yes（plan header + T9 归档是 contract 节点）
- [ ] Per-ticket loop 嵌入每个 `[implementation]` bullet → yes（T2-T11 都有 Per-ticket loop 行）
- [ ] `[parallel]` 标注 → yes（T6/T7 互 parallel）
- [ ] `[blocks: ...]` 标注 → yes（T3/T4/T5/T6/T7/T8/T9/T10/T11 都有）
- [ ] Implementation 空间保留 → yes（spec A17/A18 + 本 plan 实施要点段明确「method 列表 / UI 视觉 / helper 函数命名留给实施者」）

---

## Cross-references

- **Spec**: `specs/022-session-api-migration.md`（ACR 5/5 PASS）
- **ACR verdict**: yes per all 5 Core Skills（见 Section 2）
- **Affected S1-S6 skills**:
  - **S1 Bounded Context**: yes（hub/store 子目录化 + 归档 interaction）
  - **S2 Defensive Contract**: yes（5 类边界 + 覆盖率 ≥80/70 + SessionStoreError 6 类全覆盖）
  - **S3 Error Handling**: yes（typed SessionStoreError + ApiErrorBody + 错误映射契约表 + Boundaries-Never bare throw 禁）
  - **S4 Foundation Layered**: yes（hub/store 上层 + harness 下层无 reverse dep）
  - **S5 Anti-Drift**: yes（阈值 cyclomatic ≤10 / 函数 ≤40 / 文件 ≤500 hard）
  - **S6 Minimal Change**: yes（11 bullets，每个 1 commit，expand-contract 节奏）
- **Spec Critical Boundary**:
  - 不引入新 runtime/dev 依赖（spec A8）
  - 不引入数据库 / 文件锁 / 跨进程 IPC（spec A14/A15）
  - 不引入前端自动化测试框架（spec A10）
  - 不复活 src/interaction/ slash 体系（spec Q3）
  - 不动 src/config/env.ts 栈默认（spec A5）
- **Predecessor plan**: `plans/web-interaction-session-api.md`（已弃用；与本 plan 决策冲突，#51 Q1/Q3 决议取代其 host 层假设）
- **Predecessor spec**: `specs/loop-hardening-for-migration.md`（017）— Loop Engine signal/timeout/trace 契约，本 plan T4 hub.ts 消费
- **Domain SSOT**: `docs/CONTEXT.md`（Loop Engine / append-only messages / LoopTrace / StopReason / in-flight closeout / required runtime layer / ConversationState deprecated / G2 deprecated）
- **Architecture SSOT**: `docs/architecture.md` Capability modules 表
- **In-scope ADR**: `docs/adr/0001-9router-stack-as-code-defaults.md`

## Parallelization Surface

- **真正可 parallel**: T6 (web/types + client) 与 T7 (web 组件改造) — 互不依赖，改不同文件 + 不同 reviewer focus
- **看似可 parallel 但有依赖**: T2 → T3 → T4（store 错误契约 → wire DTO → hub 串联）严格依赖
- **看似 parallel 但有依赖**: T5 (http 路由) 是 T3+T4 的下游 → T6/T7 才是 T5 下游
- **不可 parallel**: T1 (decision) 是闸门；T8/T9/T10/T11 是序列化收尾

## Risk + Mitigation

| Risk                                                                                   | Mitigation                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| T4 hub 重写风险大（5 类边界 + 错误映射契约 + 累计 turnCount + cancelled/timeout 收尾） | T1 先敲错误契约决策 → T4 per-ticket loop 走完 tdd + code-review + verification-before-completion 三道闸                         |
| T7 web 组件改造面广（4 组件 + 1 hook）                                                 | 分两 commit：先 T7 改既有组件（G2Panel 删 + MessageBubble + ChatHeader + useSessionChat），再 T8 新增 SessionSidebar + AppShell |
| T9 归档 src/interaction/ 可能 break 旧 import 链                                       | T9 前 T4/T5/T7 必须先完成（src/session-api/ + web 已不依赖 src/interaction/），否则编译断                                       |
| T11 web 手动冒烟需要 9router key                                                       | 实施期如果 key 缺失，i11 smoke 脚本允许 skip（spec A10），但 web 冒烟必须有真实模型（chat 用例）                                |
| `src/agent-loop/` 7 文件归档时机                                                       | 默认 T9 同步做（前提：T4+T9 已确认 src/session-api/ + src/cli/runtime.ts 完全不依赖）。如仍有依赖则拆 T9.1 单独处理             |
| CHANGELOG 措辞与 021 不齐                                                              | T10 实施时直接复制 021 条目结构 + 替换内容，不创新格式                                                                          |
| 覆盖率 ≥80/70 难以达到                                                                 | T11 实施时跑 `vitest --coverage`，未达标模块补测试直到达标；这是 SC21 的硬 binary                                               |
