# Spec: 358 — 子进程运行时观察（trace 三类事件 + loop 配置 settings 通道 + timeout 优雅收尾 + Web 实时状态）

> 来源：#358 [SPEC] 子代理能力 V1 · SPEC-3 子进程运行时观察。父图 #331（已 cleared 2026-08-10）；源决议 #333（T3 生命周期与 trace）+ #335（T5 loop 配置）+ PR #355（settings 通道）。
> 假设闸门：operator 于 2026-08-18 grilling 逐条定案 D6–D10 + A/B/C/D 假设清单（spec-driven-development Step 1 confirmed）。
> **范围扩展（operator 指令）**：本 spec 从「运行时观察」扩为「运行时观察 + Web 实时子代理状态最小面」；TUI 构建全部搁置，主攻 Web（A2/A3）。#371（暴露子代理只读端点）并入本 spec。
> **ACR 实证修正**：`subagentManager` 已在 hub.ts 透传（`hub.ts:371/478/1305`，serve 入口经 buildHarnessEngine 注入 + 懒取）——#371 真正缺的是**只读 GET 端点**，不是透传。本 spec 不动 hub 装配链，只加路由。

## Glossary（exact copy from docs/CONTEXT.md）

- **turnCount**: Foundation 运行时回合计数，每完成一个 assistant 回合（包括纯文本完成）加一；`maxTurns` 是在调用模型前检查的运行时上限。
  _Avoid_: steps、retries。
- **StopReason**: Loop Engine 的七类停止判别联合——016 五类（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse）末尾追加 017 两类 `cancelled`（signal abort）与 `timeout`（超时强制）；追加不重排。
  _Avoid_: 把 cancelled 与 timeout 混为一条；把总耗时当作独立 stop 触发器。
- **LoopTrace**: `run()` 的第二返回面 `{ result, trace }`——A 层结构元数据 trace，严格不含 payload；与 append-only messages 唯一权威解耦。
  _Avoid_: 在 trace 里塞 input/output/token/cost（B 层字段）——该禁令仅对 LoopTrace 本体，不外延到 TraceService（`LlmCallRecord` 承载 token usage 是 ADR-0008 裁决的合规落点）。
- **前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）= handler 同步等 worker 到终态、envelope 直接作 tool_result 返回，当回合闭环；后景（`wait:false`，显式选项）= 立即返回 task_id，结果经 host 唤醒/drain 通道回传。worker 恒为独立进程，与前景/后景正交。
- **host drain**: host 侧把 completed 子代理 envelope 浓缩成一条消息、注入下一轮 run() priorMessages 的机制（#356 V1）；只 drain completed，不修改 buffer 状态。#361 裁决后仅在异步臂生效。
- **in-flight closeout**: abort/timeout 发生时的收尾语义——模型在途则整回合不进历史；工具在途则 assistant 回合已原子追加（不可回滚），在途 tool call 填 `execution_failed`，所有 tool_result 编码为一条 user message 原子追加后 stop。signal 优先于 timeout。
  _Avoid_: 回滚已追加的 assistant 回合；悬空未回填的 tool call。
- **project stack defaults (SSOT boundary) — settings 单承载收敛 (ADR-0015)**: LLM 配置收敛到 `~/.iknow/settings.json`（user）+ `<cwd>/.iknow/settings.json`（project 覆盖 user）单承载；非 LLM 字段的 `process.env > .env.local > .env` 优先级链不变。

**本 spec 新术语**：

- **per-call timeout**：单次 LLM 调用竞速上限（`LlmEnv.timeoutMs`，默认 60s，`loop-engine.ts:958` raceModel 消费）。
- **per-task wallclock**：子代理整任务寿命上限（`settings.subagent.taskTimeoutMs`，缺省 7200s，父 manager SIGTERM 计时消费）。两者语义、命名、消费点全程分离（C9）。

## Architectural Constraints（ADR 引用）

- **ADR-0003**（Trace Service domain interface）：#4 conversation_id 必填；#5 ID 由 TraceService 语义生成；#8 JSONL snake_case / TS camelCase（`camelToSnake` 单文件）；#9 **Postel's Law**（只落当前可填字段，不预声明）；#11 实时写盘（step end，`fs.appendFileSync`）；#13 **`recordXxx` MUST NOT throw**，埋点全走 `safeTrace`。
- **ADR-0011**（MaxTurnsExceeded + 模型收尾摘要）：timeout 优雅收尾复用其 epilogue 摘要轮机制（固定 1 次、不计预算、失败跳过不阻塞）。
- **ADR-0012**（maxTurns 默认无限）：worker 的 maxTurns 继承「undefined = 无限」语义；per-task wallclock 是独立防线，两者不混。
- **ADR-0014**（foreground spawn default）：前景 `wait:true` 契约不动；trace 事件时序兼容前景/异步两臂。
- **ADR-0015**（settings 单承载）：新 settings 字段镜像 maxTurns 六处改动模式（interface / validate / parse / merge / env 回退 / 消费点）。

## Objective

让子代理「跑得怎么样」可观察、可配置、可交代，共四块：

1. **trace 三类事件**：`subagent_spawn` / `subagent_stop` / `subagent_state_change` 落 JSONL trace（写侧 SSOT 全触碰点），子代理生命周期从「完全不可见」变为可 grep、可面板查询。
2. **loop 配置 settings 通道**：`settings.llm.timeoutMs`（per-call，镜像现有 env 语义）+ `settings.subagent.taskTimeoutMs`（per-task wallclock，新顶层段，缺省 **7200s**——operator 真实使用数据：子代理任务常态超过 1 小时，对齐 deer-flow 1800s 实测再留余量）；修复 D8 混用 bug（envelope timeoutMs 不再塞进 `deps.timeoutMs`）。
3. **timeout 优雅收尾**：SIGTERM → abort → in-flight closeout → ADR-0011 摘要轮 → 写出带 summary 的 `{status:"failed", reason:"timeout"}` 信封 → 干净退出；SIGKILL 降级为兜底。被杀任务留下「做到哪了」的浓缩交代，不再无声蒸发。
4. **Web 实时子代理状态最小面**（operator 方向指令：主攻 Web，对标市面智能体工具）：#371 = 新增 Session API 只读端点（manager 已在 hub.ts 透传，本轮不动装配链）+ Web chat 页面子代理状态栏（轮询起步）。trace 面板同步加 subagent 站（历史面）。TUI 搁置。

用户：主代理操作者（看见子代理在不在跑、结果是什么）+ 调试者（trace 定位生命周期）。成功 = 四块 Success Criteria 全绿。

## Tech Stack

不变：TypeScript + Node（ESM，tsc strict）+ Web 侧 React/Vite（既有栈）。无新依赖。轮询起步（2–3s），不建 SSE/websocket 推送通道（iknow 现无 web push 基础设施，从最简起步）。

## Commands

```bash
npm run typecheck                 # tsc -p tsconfig.json --noEmit
npm test                          # vitest：unit + harness + integration
npx vitest run tests/subagent     # subagent 定向
npx vitest run tests/traceserver  # traceserver 定向
npx vitest run tests/config       # settings/env 定向
npm run lint
cd web && npm run build           # SPA 构建验证
```

## Project Structure

```
# 写侧（trace 三类事件）
src/harness/trace/types.ts              # + SubagentSpawnRecord / SubagentStopRecord / SubagentStateChangeRecord
                                        # + SubagentState 联合（"starting"|"running"|"completed"|"failed"，与 manager TaskState 同构）
                                        # + TraceService 接口 +3 方法（recordSubagentSpawn/Stop/StateChange）
src/harness/trace/jsonl.ts              # +3 record 实现（record_type 字面值 + toSnakeCaseRecord + warnOnce 同形态）
src/harness/trace/noop.ts               # +3 空实现
src/harness/trace/observability-bridge.ts  # _record 联合追加 3 类型（B-scope 穷举检查）
src/harness/trace/index.ts              # barrel export
src/harness/subagent/manager.ts         # 埋点：spawn / 状态变更 / 终止三处发事件（safeTrace 包裹）；
                                        # SIGTERM 前给 worker 优雅收尾宽限期；PER_TASK_TIMEOUT_MS 300_000 → 7200_000
src/harness/subagent/worker.ts          # SIGTERM handler：abort → closeout → epilogue 摘要 → timeout 信封 → 干净退出；
                                        # 删除 envelope.timeoutMs → deps.timeoutMs 的 spread（D8 fix）

# settings 通道
src/config/settings.ts                  # + IknowSettingsLlm.timeoutMs（per-call）+ IknowSettingsSubagent 新段（taskTimeoutMs）
src/config/env.ts                       # + 两字段 env > settings 回退（镜像 maxTurns 模式）；
                                        # IknowEnv + subagent 段

# 读侧（traceserver + trace 面板）
src/traceserver/types.ts                # TraceRecordType 联合 + TRACE_RECORD_TYPES 白名单 +3；TraceQuery + taskId?/parentTurnId?
src/traceserver/http.ts                 # parseTraceQuery 加两字段解析
src/traceserver/reader.ts               # applyFilter 加 task_id/parent_turn_id 精确匹配
src/traceserver/fields.ts               # TRACE_FIELD_DEFS 加 subagent 列（subagentId/taskId/parentTurnId/fromState/toState/origin/reason/...）
web/src/api/types.ts                    # TraceRecordType / TraceFieldDef 镜像同步
web/src/lib/flowTree.ts                 # StationId + "subagent" 站 + stationOf/statusOf/labelOf/STRUCTURAL_KEYS/recordsToEvents 映射
web/src/components/TraceFilterBar.tsx   # 联动 union 扩展（白名单派生，无硬编码）

# Web 实时状态最小面
src/session-api/hub.ts                  # + GET /sessions/:id/subagents 只读端点（manager 已透传 hub.ts:371/478/1305，
                                        #   本轮不动装配链，只加路由消费 listActive/queryBuffer）
web/src/components/（新增状态栏组件）    # 子代理状态栏：轮询端点，running/完成/失败徽标 + summary 展示
web/src/（chat 页面接线）               # 状态栏挂载 + 2–3s 轮询
tests/                                  # subagent/traceserver/config/session-api/web 对应测试
```

不改：`envelope.ts` wire schema（status 枚举 / reason 枚举 / `minimum: 1` 全部维持——C7/D7）；`loop-engine.ts`（StopReason 冻结）；TUI 任何文件（A2 搁置）。

## Code Style

沿用既有风格（显式类型、纯函数优先、Postel、注释只解释 why）。

```ts
// trace/types.ts — 三类 record（对齐 VerificationRecord 形态；Postel：可选字段仅存在时落盘）
export type SubagentState = "starting" | "running" | "completed" | "failed";
export interface SubagentSpawnRecord {
  readonly id: string;                 // → subagent_id（= manager taskId）
  readonly taskId: string;
  readonly parentTurnId: string;       // spawn 发生的 turn（对齐 SandboxCmdRecord.parentTurnId 模式）
  readonly origin: "parent" | "child"; // v1 恒 "parent"（禁嵌套），schema 留位
  readonly startedAt: string;          // ISO（禁 Date.now() 数值，reader sortByTimeDesc 依赖 ISO 字典序）
  readonly status: TraceStatus;
  readonly ts: string;                 // ISO
  // Postel 可选：model? / taskPreview? / maxTurns? / timeoutMs? / error?
}
// SubagentStopRecord：+ endedAt / durationMs / finalState / exitCode? / signal? /
//   reason?（"crashed"|"timeout"|"maxTurnsExceeded"|"protocolError"|"cancelled"，对齐 envelope + cancelled）/ summary?
// SubagentStateChangeRecord：+ fromState / toState（必有枚举）/ reason?（仅 failed 时）

// jsonl.ts — 埋点全走 safeTrace（ADR-0003 #13），worker/manager 侧同
await safeTrace(() => trace?.recordSubagentSpawn({ ... }));

// worker.ts — SIGTERM 优雅收尾（复用 ADR-0011 epilogue）
process.once("SIGTERM", () => abortController.abort("subagent-timeout"));
// abort → loop-engine cancelled 路径 → in-flight closeout → catch 侧跑 epilogueSummary 一轮
// → toFailedEnvelope("timeout") 携带 summary → stdout 写出 → process.exit(0)

// settings.ts — 新段（镜像 maxTurns 六处改动）
export interface IknowSettingsSubagent { readonly taskTimeoutMs?: number; }
// env.ts — env.subagent.taskTimeoutMs = envOptionalInt("IKNOW_SUBAGENT_TASK_TIMEOUT_MS") ?? mergedSettings.subagent?.taskTimeoutMs
// manager/handler 消费：def.timeoutMs ?? env.subagent.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS(7200_000)

// session-api — 只读端点（manager 已在 hub.ts 透传，本轮只加路由）
// GET /sessions/:id/subagents → [{ taskId, state, taskPreview, startedAt, endedAt?, summary?, reason? }]
```

**为什么 worker 删掉 timeoutMs spread（D8）**：`deps.timeoutMs` 语义 = per-call 竞速；envelope 捎带的是 per-task 寿命，塞进去会让一次正常 LLM 调用按任务寿命竞速（per-call 保护失效），或让显式小值误杀正常调用。任务寿命只归父 manager SIGTERM 管，worker 内无消费者。

**为什么 stop 事件单侧（parent 侧）emit**：v1 子代理生命周期状态机完全在父 manager 内（worker 只写 stdout 信封），parent 侧已覆盖全部状态迁移点；child 侧 origin 字段留位（schema 不变即可升级）。

## Testing Strategy

vitest，按模块落 `tests/subagent/` / `tests/traceserver/` / `tests/config/` / `tests/session-api/`。覆盖测试规范六类：

| 层          | 内容                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常        | spawn→state_change→stop 三类事件落盘（stub harness 集成，double-track：trace assert + no-trace deepEqual 基线）；settings 双字段 parse/merge/env 回退；端点返回在场子代理列表 |
| 失败        | trace 写盘失败不 crash（safeTrace 契约）；SIGTERM 后 epilogue 失败不阻塞退出（摘要跳过、信封仍写出）；端点查无会话 → 404/空列表 typed                                         |
| 边界        | 同一 turn 多 spawn 全部有配对 stop（sibling 必齐）；`timeoutMs` 缺省 → 7200s 链；maxTurns undefined = 无限（ADR-0012 对齐）；worker 重启场景 state_change 序列                |
| 权限        | 端点只读、无写路径；trace 事件不含密钥内容（taskPreview 截断 + 不落 task 全文）                                                                                               |
| 空/非法输入 | TraceQuery 无新字段 → 行为不变（向后兼容）；settings.taskTimeoutMs 非正整数 → drop-not-throw                                                                                  |
| 并发        | 前景（wait:true）与异步（wait:false）两臂事件时序不乱（reader sortByTimeDesc 还原）；多 worker 并发 state_change 交错落盘可解析                                               |

D8 专项：断言 worker `deps.timeoutMs` 恒为 `env.llm.timeoutMs`，不随 spawn `timeoutMs` 变化。
优雅收尾专项：timeout 触发 → worker 退出码 0 + envelope `{status:"failed", reason:"timeout", summary 非空}`。

## Boundaries

- **Always do**：埋点全走 `safeTrace`（ADR-0003 #13）；时间戳 ISO 字符串；单 conversationId 单 JSONL 文件（worker 不开独立 trace 文件，reader sortByTimeDesc 还原时序）；两个 timeout 命名/语义/消费点全程分离（C9）；新 record 字段遵守 Postel（有可填来源才加）。
- **Ask first**：record 字段增删（Postel 裁决）；端点 URL / 返回形状变更；轮询间隔调整（默认 2–3s）。
- **Never do**：扩 envelope `status` 枚举（Q4 顶层契约）；改 `timeoutMs` schema `minimum: 1`（D7：模型不可关寿命上限）；TUI 任何改动（A2 搁置）；建 SSE/websocket 推送通道（本轮轮询起步）；为 subagent 另开 trace 文件；把 per-task 值再塞进 per-call 语义（D8 回归）；本轮做限流/429 backoff（D10 ADR 候选）。

## Success Criteria（binary，每条映射可执行检查）

1. **三类事件落盘**：spawn 真实子代理后 JSONL 出现 `subagent_spawn` / `subagent_state_change` / `subagent_stop` 行，spawn 与 stop 按 task_id 配对。**Check**: 集成测试断言 + `grep -c "subagent_" <trace.jsonl>` ≥ 3。✅/❌
2. **traceserver 查询**：`TRACE_RECORD_TYPES` 含三类；`?taskId=` / `?parentTurnId=` 过滤命中。**Check**: `npx vitest run tests/traceserver` 绿。✅/❌
3. **Web trace 面板 subagent 站**：`StationId` 含 `"subagent"`，flowTree 映射三类 record，fields 列定义就位，SPA 构建通过。**Check**: `cd web && npm run build` exit 0 + flowTree 单测绿。✅/❌
4. **settings 双字段**：`settings.llm.timeoutMs`（per-call）+ `settings.subagent.taskTimeoutMs`（per-task）六处改动模式完整（interface/validate/parse/merge/env 回退/消费点）；per-task 缺省 7200s。**Check**: `npx vitest run tests/config` 绿 + `grep -n "7200" src/harness/subagent/manager.ts`。✅/❌
5. **D8 修复**：worker `deps.timeoutMs` 恒为 env 值，不随 spawn timeoutMs 变。**Check**: D8 专项测试绿。✅/❌
6. **优雅收尾**：timeout 触发 → worker 干净退出 + envelope `reason:"timeout"` + summary 非空。**Check**: 优雅收尾专项测试绿。✅/❌
7. **Session API 端点**：`GET /sessions/:id/subagents` 返回当前子代理状态列表（manager 已透传，端点为新增路由）。**Check**: `npx vitest run tests/session-api` 端点用例绿。✅/❌
8. **Web 状态栏**：chat 页面渲染子代理状态栏，轮询端点，状态变化可见。**Check**: 组件测试绿 + `web:dev` 手工冒烟记录。✅/❌
9. **契约不破**：`envelope.ts` wire schema 无 diff（status/reason 枚举 + minimum:1 维持）；TUI 目录零 diff。**Check**: `git diff --stat -- src/harness/subagent/envelope.ts src/tui/` 为空。✅/❌
10. **maxTurns 语义对齐**：worker maxTurns undefined = 无限（ADR-0012），显式值经 envelope 透传生效。**Check**: 既有 subagent maxTurns 测试全绿 + 新增 undefined 用例。✅/❌

## Open Questions

无阻塞项。记录两条非阻塞观察：(1) SPEC-3 原文「时间窗查询」（startedAt/before/after 过滤）本轮以 taskId/parentTurnId 下钻覆盖核心场景，纯时间范围过滤留后续；(2) staleness/心跳监测取代 wallclock（Hermes 方向）记为后续候选，本轮不做。

## Assumptions（operator confirmed 2026-08-18）

1. **D6 settings 双字段**（选项 1）：`settings.llm.timeoutMs` per-call + `settings.subagent.taskTimeoutMs` per-task 新顶层段；per-task 缺省 **7200s**（operator 真实使用数据：任务常态超 1 小时；deer-flow 1800s 为唯一正向实测，再留余量；300s 原值无实测依据）。CONFIRMED。
2. **D7 不允许 timeoutMs: 0**：schema `minimum: 1` 维持，模型不可关闭寿命上限（openclaw #37902 反例：模型自主把 timeout 越调越小；D6 底线承诺自洽）。CONFIRMED。
3. **D8 删 spread**：envelope.timeoutMs 不再进 `deps.timeoutMs`；任务寿命只归父 manager SIGTERM。CONFIRMED（operator：「确实不需要」）。
4. **timeout 杀法 = 优雅收尾**（选项 1）：SIGTERM → abort → closeout → epilogue → timeout 信封（带 summary）→ 干净退出；SIGKILL 兜底。参考 Claude Code drain-before-terminate。CONFIRMED。
5. **D9/D9b trace 完整版 + Web 实时状态最小面**（选项 1 + 选项 1）：trace 三类事件 + traceserver 过滤 + trace 面板 subagent 站；Session API 只读端点 + Web 状态栏（轮询）；#371 = 加只读 GET 端点（ACR 实证：manager 已透传，不动装配链）并入本 spec；TUI 搁置、主攻 Web（operator 方向指令）。CONFIRMED。
6. **D10 限流不做**：记 ADR 候选；风险窗口由优雅收尾兜底（429 截断留下可读交代）。CONFIRMED。
7. **C1–C9 硬约束**：ADR-0003 Postel/never-throw/safeTrace；单文件/ISO；ADR-0012/0014/0015 对齐；Q4 契约不扩；两 timeout 分离。CONFIRMED（调研锁定，非决策项）。

→ 无静默假设。

## ACR Verdict（architecture-change-reviewer）

**Round 1（2026-08-18）**: `5/5 yes` → **OVERALL: PASS → hand to writing-plans**。

```
bounded-context-guardian: yes — trace 域按 ADR-0003 文件头以字面联合自描述，不引入跨域 import；manager.ts 仅 safeTrace 包裹 + 同文件埋点（TaskState manager.ts:131 已与 SubagentState 同构）；settings/env 新段镜像 maxTurns 各自封闭（env.ts:526-530）；traceserver 新增白名单字段 + union 派生无外部依赖（fields.ts 自检 + http.ts parseTraceQuery 局部）；session-api/web 仅消费现有 manager；worker SIGTERM handler 局部。
defensive-contract-validator: yes — Testing Strategy 表六类齐全；并发（前景/异步两臂事件时序，reader sortByTimeDesc 还原）；异常（trace 写盘失败走 safeTrace、SIGTERM 后 epilogue 失败不阻塞——ADR-0011 D3「摘要失败即跳过」）；D8 专项断言 deps.timeoutMs === env.llm.timeoutMs；边界（timeoutMs 缺省 → 7200s 链、maxTurns undefined = 无限、sibling spawn 配对 stop）；空/非法（settings.taskTimeoutMs 非正整数 drop-not-throw、TraceQuery 缺新字段行为不变）；权限（端点只读 + taskPreview 截断）。
error-handling-enforcer: yes — 埋点全走 safeTrace（ADR-0003 D13）；epilogueSummary 在 MaxTurnsExceeded/异常停路径 best-effort 不抛不阻塞（loop-engine.ts:1406-1418, 1454-1462）；manager.ts:299-313 显式保留 timeout reason 不被 crashed 覆盖；envelope reason/status 枚举冻结；typed-error 链不变——无静默吞错。
complexity-anti-drift: yes — C9 两 timeout 命名/语义/消费点全程分离（per-call = raceModel @ loop-engine.ts:958，per-task = manager.ts:228 消费 env.subagent.taskTimeoutMs ?? 7200s）；3 record schema 镜像 VerificationRecord 形态，Postel 可选字段仅存在时落盘；SubagentState 与 manager TaskState 同构无新 union；stop 事件 parent-only emit 单点；settings 双字段严格镜像 maxTurns 六处改动模板；web 轮询 2-3s 起步有界。无 god-function/重复逻辑意图。
minimal-change-verifier: yes — 1 个逻辑任务簇（子代理「看得见 + 可配 + 死得交代」）；operator 在 D9/D9b 显式扩展至 Web 实时状态最小面并 TUI 搁置，非静默 scope creep；success criteria 10 条全部围绕同一主题，无 D10 限流等额外伸腿。
```

审查补充观察（非阻塞，writing-plans 消化）：

1. **#371 措辞已修正**：ACR 实证 subagentManager 已在 hub.ts 透传（hub.ts:371/478/1305），#371 真实缺口 = 只读 GET 端点——本 spec 已按此修正（范围扩展注 + Project Structure + Objective 第 4 条）。
2. **PER_TASK_TIMEOUT_MS 上调单独 commit**：300s → 7200s 常量变更与 trace 三类事件主 commit 解耦，review 颗粒更清。
3. **in-flight closeout 复用确认**：worker abortController 与 run() signal 串联走既有 `run(..., signal)` 接口（loop-engine.ts:1511），无需扩接口。
