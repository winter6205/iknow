# Plan: 358 — 子进程运行时观察（trace 三类事件 + settings 通道 + timeout 优雅收尾 + Web 实时状态）

**Goal:** 让子代理「跑得怎么样」可观察、可配置、可交代：trace 三类生命周期事件落 JSONL；per-call / per-task 两个 timeout 经 settings 通道分离配置（修 D8 混用 bug）；timeout 触发时优雅收尾留下 summary 交代；Web 端实时看见子代理状态（TUI 搁置，主攻 Web）。

**Architecture:** 写侧 SSOT 全触碰点一次补齐（trace 五文件同形态扩展）；settings 双字段镜像 maxTurns 六处改动模式；worker SIGTERM → abort → in-flight closeout → ADR-0011 epilogue → timeout 信封，全部复用既有机制不建新基础设施；Session API 只加只读路由（manager 已在 hub.ts 透传，不动装配链）；Web 轮询起步（2–3s），不建 SSE/websocket。

**Tech Stack:** TypeScript + Node（ESM，tsc strict）+ Web 侧 React/Vite（既有栈）。无新依赖。

**Spec link:** `specs/358-subagent-runtime-observability.md`（ACR Round 1 5/5 PASS）

**前置依赖:** 无。与 `plans/357-subagent-process-tools-surface.md` 互不依赖，可并行；operator 定序先 357 后 358。

**Tracker:** GitHub（label `ready-for-agent`，native blocking via addBlockedBy；票创建留待 operator 放行——沿用 #468 先例）。创建命令与 blocking 边见文末。

---

## Architecture Change Reviewer verdict

引自 spec（Round 1 PASS，2026-08-18）：

```
bounded-context-guardian: yes — trace 域按 ADR-0003 文件头以字面联合自描述，不引入跨域 import；
  manager.ts 仅 safeTrace 包裹 + 同文件埋点；settings/env 新段镜像 maxTurns 各自封闭；traceserver
  新增白名单字段 + union 派生无外部依赖；session-api/web 仅消费现有 manager；worker SIGTERM handler 局部。
defensive-contract-validator: yes — Testing Strategy 表六类齐全；并发（前景/异步两臂事件时序，reader
  sortByTimeDesc 还原）；异常（safeTrace、epilogue 失败不阻塞）；D8 专项断言；边界（7200s 链、maxTurns
  undefined = 无限、sibling 配对）；空/非法（drop-not-throw、向后兼容）；权限（只读端点 + taskPreview 截断）。
error-handling-enforcer: yes — 埋点全走 safeTrace（ADR-0003 #13）；epilogueSummary best-effort 不抛不阻塞；
  manager 显式保留 timeout reason 不被 crashed 覆盖；envelope reason/status 枚举冻结；无静默吞错。
complexity-anti-drift: yes — C9 两 timeout 命名/语义/消费点全程分离；3 record 镜像 VerificationRecord
  形态，Postel 可选字段仅存在时落盘；stop 事件 parent-only emit 单点；settings 镜像六处改动模板；
  web 轮询有界。无 god-function/重复逻辑意图。
minimal-change-verifier: yes — 1 个逻辑任务簇（子代理「看得见 + 可配 + 死得交代」）；operator 在 D9/D9b
  显式扩展至 Web 实时状态最小面并 TUI 搁置，非静默 scope creep。
```

ACR 补充观察（已消化进 bullets）：① #371 真实缺口 = 只读 GET 端点，不动 hub 装配链（manager 已透传）；② PER_TASK_TIMEOUT_MS 上调与 trace 主 commit 解耦（本 plan 落 timeout 专项 bullet）；③ in-flight closeout 复用既有 `run(..., signal)` 接口，无需扩接口——SIGTERM handler 经 worker 自有 AbortController 串联（缝已确认存在，不留未决决策项）。

---

## Tracer bullets

> Per-ticket loop（ADR-0012）强制：每个 `[implementation]` bullet 的 `Per-ticket loop` 行不可省略。
> 编号约定：bullet 在本文件内编号 T1–T9；tracker 票名带 `#358` 前缀防撞名。
> 实施自由度：Implementation notes 是指向性线索，不是硬编码指令——文件内具体行号、变量名、测试组织方式由实施 ticket 自定；验收标准（Acceptance）才是契约。

### T1. `[implementation]` settings 双字段通道（per-call + per-task）

- **Affects**: `src/config/settings.ts`（llm.timeoutMs + subagent 新段 taskTimeoutMs）；`src/config/env.ts`（env > settings 回退，镜像 maxTurns 模式）；`tests/config/`（parse/merge/env 回退/drop-not-throw）。
- **Acceptance**:
  1. spec SC4 通道面：`npx vitest run tests/config` exit 0——两字段 parse/merge/env 回退用例全绿。
  2. 非法输入 drop-not-throw：taskTimeoutMs 非正整数 → 丢弃不抛（spec Testing Strategy 空/非法行）。
  3. `npm run typecheck` → exit 0。
- **Implementation notes**（非验收命令，实施可调整）:
  - 严格镜像 maxTurns 六处改动模板（interface / validate / parse / merge / env 回退 / 消费点）；消费点一面在 T2 落地，本 bullet 收口前五处。
  - per-task 缺省值语义在 env 层留空位（回退链末端的常量归 T2 的 manager 消费点），避免缺省值两处声明。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` D8 修复 + per-task 消费链（缺省上调独立落地） `[blocks: T1]`

- **Affects**: `src/harness/subagent/worker.ts`（删 envelope.timeoutMs → deps.timeoutMs 的 spread）；`src/harness/subagent/manager.ts`（SIGTERM timer 消费链：def.timeoutMs ?? env 值 ?? 常量；常量上调至 spec 定案值）；`src/harness/build-engine.ts`（env.subagent.taskTimeoutMs 注入透传 manager 中段）；`src/harness/subagent/spawn-subagent-tool.ts`（drop PER_TASK_TIMEOUT_MS 默认填充, 走三层链）；`tests/subagent/`（D8 专项 + 缺省链用例）。
- **Acceptance**:
  1. spec SC5：D8 专项测试绿——worker `deps.timeoutMs` 恒为 env 值，不随 spawn timeoutMs 变化。
  2. spec SC4 消费点面：`grep -n "7200" src/harness/subagent/manager.ts` 命中（缺省 7200s 落消费点，spec Assumptions 1）。
  3. 缺省链三层断言：显式 def 值 > settings/env 值 > 常量（用例覆盖三层）。
  4. `npx vitest run tests/subagent` exit 0；`npm run typecheck` → exit 0。
- **Implementation notes**:
  - D8 语义：`deps.timeoutMs` = per-call 竞速；任务寿命只归父 manager SIGTERM，worker 内无 per-task 消费者（spec Code Style 理由段）。
  - 常量上调单独成 commit 的理由（ACR 观察 2）= 与 trace 主 commit 解耦；本 bullet 同时承载 D8 修复与消费链，二者同属「timeout 消费语义」一个逻辑任务。
  - `timeoutMs` schema `minimum: 1` 不动（D7：模型不可关寿命上限）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` timeout 优雅收尾（SIGTERM → epilogue → timeout 信封） `[blocks: T2]`

- **Affects**: `src/harness/subagent/worker.ts`（SIGTERM handler：abort → closeout → epilogue 摘要 → timeout 信封 → 干净退出）；`src/harness/subagent/manager.ts`（SIGTERM 后优雅收尾宽限窗口，SIGKILL 降级兜底）；`tests/subagent/`（优雅收尾专项）。
- **Acceptance**:
  1. spec SC6：优雅收尾专项测试绿——timeout 触发 → worker 退出码 0 + envelope `{status:"failed", reason:"timeout", summary 非空}`。
  2. epilogue 失败不阻塞：摘要轮失败 → 跳过、信封仍写出（ADR-0011 D3 语义）。
  3. envelope wire 零 diff：`git diff -- src/harness/subagent/envelope.ts` 为空（reason/status 枚举不扩，Q4 契约）。
- **Implementation notes**:
  - 复用链：worker 自有 AbortController → 既有 `run(..., signal)` → in-flight closeout（016/017 既有语义）→ catch 侧跑 epilogueSummary 一轮（ADR-0011 机制复用，固定 1 次、不计预算）。
  - signal 优先于 timeout（CONTEXT.md in-flight closeout 条）。
  - manager 侧保留 timeout reason 不被 crashed 覆盖（manager 既有显式保护路径，ACR error-handling 条）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` trace 三类事件写侧（subagent_spawn / stop / state_change）

- **Affects**: `src/harness/trace/types.ts`（3 record 类型 + SubagentState 联合 + TraceService 接口 +3 方法）；`src/harness/trace/jsonl.ts`（3 record 实现，同形态 toSnakeCaseRecord + warnOnce）；`src/harness/trace/noop.ts`（3 空实现）；`src/harness/trace/observability-bridge.ts`（_record 联合追加）；`src/harness/trace/index.ts`（barrel）；`src/harness/subagent/manager.ts`（spawn / 状态变更 / 终止三处埋点，safeTrace 包裹）；`src/harness/build-engine.ts`（subagentTrace 注入缝 + NoopTraceService 缺省 —— 生产装配点, 与 T2 的 taskTimeoutMs 注入同文件）；`tests/`（double-track：trace assert + no-trace deepEqual 基线）。
- **Acceptance**:
  1. spec SC1：集成测试断言三类事件落盘，spawn 与 stop 按 task_id 配对；`grep -c "subagent_" <trace.jsonl>` ≥ 3。
  2. double-track 基线：NoopTraceService / 无 trace 场景 deepEqual 不破（项目测试规范「Trace as assert surface」）。
  3. safeTrace 契约：trace 写盘失败不 crash（用例注入写失败）。
  4. sibling 配对：同一 turn 多 spawn 全部有配对 stop。
- **Implementation notes**:
  - record 形态镜像 VerificationRecord；Postel——可选字段仅有可填来源时落盘（spec Code Style）。
  - 时间戳 ISO 字符串（reader sortByTimeDesc 依赖字典序，禁 Date.now() 数值）。
  - stop 事件 parent-only emit（v1 状态机全在父 manager，spec 理由段）；origin 字段留位 v1 恒 "parent"。
  - manager.ts 与 T2/T3 有文件交集——建议 T2→T3→T4 顺序执行避免 merge 冲突（非技术依赖）。
  - worker 不开独立 trace 文件（单 conversationId 单 JSONL，reader 还原时序）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` traceserver 读侧（白名单 + 过滤 + 列定义） `[blocks: T4]`

- **Affects**: `src/traceserver/types.ts`（TraceRecordType + TRACE_RECORD_TYPES +3；TraceQuery + taskId/parentTurnId）；`src/traceserver/http.ts`（parseTraceQuery 两字段解析）；`src/traceserver/reader.ts`（applyFilter 精确匹配）；`src/traceserver/fields.ts`（subagent 列定义）；`tests/traceserver/`。
- **Acceptance**:
  1. spec SC2：`TRACE_RECORD_TYPES` 含三类；`?taskId=` / `?parentTurnId=` 过滤命中用例绿——`npx vitest run tests/traceserver` exit 0。
  2. 向后兼容：TraceQuery 无新字段 → 行为不变（spec Testing Strategy 空/非法行）。
- **Implementation notes**:
  - 白名单派生 union，无硬编码 record 名单（对齐 TraceFilterBar 联动既有形态）。
  - 时间窗查询（startedAt/before/after）本轮不做（spec Open Questions 1，taskId/parentTurnId 下钻覆盖核心场景）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T6. `[implementation]` Web trace 面板 subagent 站 `[blocks: T5]`

- **Affects**: `web/src/api/types.ts`（TraceRecordType / TraceFieldDef 镜像同步）；`web/src/lib/flowTree.ts`（StationId + "subagent" 站 + 映射五件套）；`web/src/components/TraceFilterBar.tsx`（联动 union 扩展）；web 侧 flowTree 单测。
- **Acceptance**:
  1. spec SC3：`StationId` 含 `"subagent"`；flowTree 映射三类 record；fields 列定义就位。
  2. `cd web && npm run build` exit 0 + flowTree 单测绿。
- **Implementation notes**:
  - 站映射五件套对齐既有站形态（stationOf / statusOf / labelOf / STRUCTURAL_KEYS / recordsToEvents）。
  - TUI 零改动（A2 搁置——本 bullet 的 diff 不得触碰 `src/tui/`）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T7. `[implementation]` Session API 只读端点（#371 并入） `[parallel]`

- **Affects**: `src/session-api/hub.ts`（+ `GET /sessions/:id/subagents` 路由，消费已透传的 manager listActive/queryBuffer）；`tests/session-api/`（端点用例）。
- **Acceptance**:
  1. spec SC7：`npx vitest run tests/session-api` 端点用例绿——返回在场子代理状态列表（taskId/state/taskPreview/startedAt/endedAt?/summary?/reason?）。
  2. 无会话 → typed 404/空列表（失败路径不裸抛）。
  3. 只读：端点无写路径；taskPreview 截断不落 task 全文（权限行）。
  4. 装配链零 diff：不动 hub 装配链（manager 已透传，ACR 实证）——diff 限于路由 + 测试。
- **Implementation notes**:
  - 返回形状实施可微调，但 URL 与字段集变更属 spec「Ask first」面。
  - 端点数据源 = manager 在场状态 + queryBuffer（completed 历史），两者拼出「在跑 + 跑完」两态。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T8. `[implementation]` Web 子代理状态栏（轮询起步） `[blocks: T7]`

- **Affects**: `web/src/components/`（新状态栏组件）；web chat 页面接线（挂载 + 轮询）；web 侧组件测试。
- **Acceptance**:
  1. spec SC8：组件测试绿 + `cd web && npm run build` exit 0。
  2. 轮询端点消费 T7 契约（running/完成/失败徽标 + summary 展示）。
  3. 手工冒烟记录（web:dev + 真实 spawn）作为证据附验证报告——自动化断言不覆盖视觉层。
- **Implementation notes**:
  - 轮询间隔 2–3s（spec Tech Stack；调整属 Ask first）。
  - 不建 SSE/websocket 推送通道（spec Boundaries Never）。
  - 状态徽标语义对齐 SubagentState 四态（T4 落地的联合类型经 API 投影）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T9. `[implementation]` 契约冻结收口（SC9 + SC10 显式断言） `[blocks: T1, T2, T3, T4, T5, T6, T7, T8]`

- **Affects**: `tests/`（冻结断言用例，无生产代码改动）。
- **Acceptance**:
  1. spec SC9：`git diff --stat -- src/harness/subagent/envelope.ts src/tui/` 为空（相对 plan 起点 commit）；envelope wire schema 快照断言（status/reason 枚举 + minimum:1）。
  2. spec SC10：maxTurns undefined = 无限用例绿（ADR-0012 对齐）+ 既有 subagent maxTurns 测试全绿。
  3. `npm test` 全量 exit 0（unit + harness + integration 总闸）。
- **Implementation notes**:
  - 本 bullet 是全 plan 回归闸：前面 8 个 bullet 各自的定向测试之外，这里做一次全量 + 冻结面显式断言，防止分散实施中契约漂移。
  - 若发现漂移 → 回对应 bullet 修，不在本 bullet 打补丁。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Cross-references

### SC ↔ T 覆盖矩阵

| SC   | 验收句（摘要）                                | 主覆盖                                       |
| ---- | --------------------------------------------- | -------------------------------------------- |
| SC1  | 三类事件落盘（spawn/stop 配对）               | T4 acceptance 1                              |
| SC2  | traceserver 查询（白名单 + 两过滤）           | T5 acceptance 1                              |
| SC3  | Web trace 面板 subagent 站                    | T6 acceptance 1-2                            |
| SC4  | settings 双字段六处模式（缺省 7200s）         | T1 acceptance 1-2 + T2 acceptance 2          |
| SC5  | D8 修复（deps.timeoutMs 恒 env 值）           | T2 acceptance 1                              |
| SC6  | 优雅收尾（exit 0 + reason timeout + summary） | T3 acceptance 1                              |
| SC7  | Session API 端点                              | T7 acceptance 1                              |
| SC8  | Web 状态栏                                    | T8 acceptance 1-3                            |
| SC9  | 契约不破（envelope 零 diff + TUI 零 diff）    | T3 acceptance 3（envelope）+ T9 acceptance 1 |
| SC10 | maxTurns 语义对齐（undefined = 无限）         | T9 acceptance 2                              |

### 并行面

- 三条独立起点：T1（settings 通道）/ T4（trace 写侧）/ T7（Session API 端点）`[parallel]`——触碰文件集不相交。
- 链 1：T1 → T2 → T3（timeout 消费链 → 优雅收尾；T2 消费 T1 的 env 字段，T3 复用 T2 的 timer 语义）。
- 链 2：T4 → T5 → T6（trace 写侧 → 读侧 → Web 面板）。
- 链 3：T7 → T8（端点 → 状态栏）。
- T9 blocked by 全部——收口闸。
- merge 冲突提示：T2/T3/T4 同触 `manager.ts`，建议按编号顺序执行（文件冲突非技术依赖）。

### 路径速查

- spec: `specs/358-subagent-runtime-observability.md`
- trace 写侧 SSOT: `src/harness/trace/`（types / jsonl / noop / observability-bridge / index 五件同形态）
- 埋点点: `src/harness/subagent/manager.ts`（spawn / 状态变更 / 终止三处）
- timeout 消费: `src/harness/subagent/manager.ts`（SIGTERM timer）+ `worker.ts`（D8 spread 删除点）
- settings 模板参照: maxTurns 六处改动（`src/config/env.ts` 既有模式）
- Session API: `src/session-api/hub.ts`（manager 透传点已存在，只加路由）
- Web: `web/src/lib/flowTree.ts`（站映射五件套）+ `web/src/api/types.ts`（wire 镜像）

### 验证（plan done 三项）

1. `grep -E "^### T[0-9]+\." plans/358-subagent-runtime-observability.md` → 9 条 tracer bullet 编号齐全
2. 实施后 `git log --oneline` → 9 commits（每个 T 对应一次 commit，1 commit = 1 logical task）
3. `git diff --stat` 每 commit 改动 scope 与 bullet 的 Affects 行匹配（`envelope.ts` / `src/tui/` 全程零 diff）

---

## Tracker commands（票创建留待 operator 放行）

```bash
gh issue create --label 'ready-for-agent' --title "[#358] T1 settings 双字段通道（per-call + per-task）" --body-file <ticket-t1.md>
gh issue create --label 'ready-for-agent' --title "[#358] T2 D8 修复 + per-task 消费链" --body-file <ticket-t2.md>
gh issue create --label 'ready-for-agent' --title "[#358] T3 timeout 优雅收尾（SIGTERM → epilogue → timeout 信封）" --body-file <ticket-t3.md>
gh issue create --label 'ready-for-agent' --title "[#358] T4 trace 三类事件写侧" --body-file <ticket-t4.md>
gh issue create --label 'ready-for-agent' --title "[#358] T5 traceserver 读侧（白名单 + 过滤 + 列定义）" --body-file <ticket-t5.md>
gh issue create --label 'ready-for-agent' --title "[#358] T6 Web trace 面板 subagent 站" --body-file <ticket-t6.md>
gh issue create --label 'ready-for-agent' --title "[#358] T7 Session API 只读端点（#371 并入）" --body-file <ticket-t7.md>
gh issue create --label 'ready-for-agent' --title "[#358] T8 Web 子代理状态栏（轮询起步）" --body-file <ticket-t8.md>
gh issue create --label 'ready-for-agent' --title "[#358] T9 契约冻结收口（SC9+SC10 显式断言）" --body-file <ticket-t9.md>
# blocking 边：T2←T1, T3←T2, T5←T4, T6←T5, T8←T7, T9←T1..T8（addBlockedBy GraphQL mutation，
# mechanics 见 writing-plans references/tracker.md）
```

票 body = 对应 bullet 全文 + spec link + per-ticket loop 行。
