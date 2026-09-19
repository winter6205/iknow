# Plan: agent-status-instruction-echo

**Goal:** 状态栏新增 `instruction:` 逐字回显段与一次性 pivot reconcile 标记，修「复诵内容失真」事故；注入纪律（每跳 append-only、不进 system）零变化。
**Approach:** 先把 `agent-status.ts` 纯函数对与真实用户消息甄别谓词钉死（双向兼容 + 名册完备性锁），再把 instruction 回显打通到栏与流事件、叠上 reconcile 的 run 作用域一次性结算；TUI 显示面只做投影纪律回归；最后黄金集四件与 pty 实测收口。不新增子系统、不动注入频率。
**Spec link:** `specs/agent-status-instruction-echo.md`
**ACR:** all-yes（与 spec 块相同）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)
**Tracker:** 本地 markdown fallback——本仓惯例无 GitHub issue 边（范本同），bullet 状态以本文件勾选为准。
**待写入:** 无（`docs/CONTEXT.md`「状态栏」词条已随 ADR-0103 更新到位，本 plan 不引入 / 变更领域词；ADR 冲突检查：无——spec 与 ADR-0028 的张力已由 ADR-0103 Amended clause 落盘）。

## ACR

```text
bounded-context-guardian: yes — 改动全留 harness 栏缝（spec Surface 行、T2 不反向 import TUI、T4 显示面不动、Out-of-scope 排除 TUI chrome/taskFocus）
defensive-contract-validator: yes — F1-F7 + Input-contract 表覆盖空/畸形/溢出（100 码点 CJK+emoji 截断 T2）/异常；并发由 run 作用域装箱天然隔离（T3 两处调用点同形接线，loop-engine.ts:2276/:2328 实测存在）
error-handling-enforcer: yes — F7 todos 读失败=既有 EXIT 静默收敛（agent-status.ts:147 实证）；F3/F4/F6 畸形→null 不 throw；提取面「零抛错」（invariant 7、T1）
complexity-anti-drift: yes — 复用 lastToolRef 装箱形态（loop-engine.ts:2185-2192 实证）与 pendingInjected 纪律（invariant 6），扩纯函数对不造子系统（T1/T3）
minimal-change-verifier: yes — 与 ADR-0103 决策 1-4 一一对应；T5/T6 系仓规强制面非 creep；名册锚点全部实测命中
```

## Tasks (ordered by dependency)

1. **栏字段对双向兼容扩展** — tag: `[implementation]`
   - **Inherits:** spec invariant 5「所有标量字段行排在 `todos:` 头之前，todo 行永远占据栏末段」+ invariant 7「空槽不广告」+ F3/F4/F5（旧栏解析得 `instruction: null, reconcile: false`；新栏被旧解析器得正确子集；含 `</agent_status>` 子串不破坏行级校验）。
   - **Surface:** `src/harness/agent-status.ts`（`buildAgentStatusText` / `parseAgentStatusText` 纯函数对，文件名已由 spec 冻结；reconcile 常量导出）
   - **Acceptance:** 单测覆盖——新构新解 round-trip；旧格式栏解析为合法缺省；`todos:` 头之前的未知标量行不吞进 todo 列表；畸形 → `null` 不 throw（既有契约）；reconcile 常量为导出件（供测试与名册锁引用）。`npm test` 相关路径绿。复杂度门槛走 complexity-anti-drift thresholds，不在本 bullet 复制数字。
   - Status: [x]

2. **真实用户消息甄别谓词 + 名册完备性锁** — tag: `[implementation]`
   - **Inherits:** spec invariant 2「instruction 来源 = messages 尾部最新一条真实用户消息：排除栏注入本身 + 全部宿主注入 + 剥 memory prefetch overlay」+ T2 注入名册全集 + skill-load remainder 规则 + F2（首行空前扫）+ F6（取最后一个 marker 之后段）+ SC2「无任何 LLM 参与」+ SC5。
   - **Surface:** `src/harness`（提取谓词落 agent-status 同域单文件，具体命名留实现者）
   - **Acceptance:** 单测——尾栏在场跳过取真消息；drain / graph / MCP 重连 / skill delta / verify / LOOP_DETECTED / compact 提示各注入形态在场均被跳过；prefetch overlay 剥净取原文、marker 出现在原文内部取末段；skill-load 信封取 remainder 首行、空 remainder 前扫；CJK + emoji 混合 100 码点截断不劈半字符且不加省略号；SEAM 测试枚举 loop-engine 全部 `encodeUserText` 注入产出、assert 每条命中名册（新缝不挂名册即红）；grep 断言本模块零 adapter import。
   - [parallel]（与 T1 无产物相交）
   - Status: [x]

3. **instruction 回显打通栏与流事件** — tag: `[implementation]`
   - **Inherits:** spec invariant 1「栏只承载代码算出的现势，逐字回显非摘要」+ invariant 6「append-only 不动，`pendingInjected` record 纪律照常覆盖新注入形态」+ SC1 / SC6「`agent_status` 流事件与栏文本同源（同一 snapshot 派生）」。
   - **Surface:** `src/harness/loop-engine.ts`（`appendAgentStatusBar` 消费 T2 提取器）+ `src/harness/stream.ts`（事件字段随快照加性扩）
   - **Acceptance:** harness 集成测试按仓规双轨 assert（trace event sequence + NoopTrace-vs-no-trace deepEqual 基线）——prior 含真实指令时该指令首行在每条栏的 `instruction:` 行、同回合多跳每跳在场且不进 `deps.system`；无真实用户消息时段整段缺席（F1）；todo 读取路径零变化；流事件与栏文本同一 snapshot 派生断言。
   - [blocks: T1, T2]
   - Status: [x]

4. **reconcile run 作用域一次性结算** — tag: `[implementation]`
   - **Inherits:** spec invariant 3「reconcile 在场条件只有一个：新用户消息进场后的下一条栏；禁止用 todo_write 调用史 / todo 段在场 / 栏变化当条件」+ invariant 4「标记文本字节稳定」+ T3 装箱纪律（复用 `lastToolRef` 形态，消息对象同一性即相关号；不落盘、不进 deps 装配面）+ 冷启动 `stamped = undefined` 合法性 + F7。
   - **Surface:** `src/harness/loop-engine.ts`（正常 step 与 compact 重试两处调用点同形接线）
   - **Acceptance:** trace 双轨 assert——新消息进场首跳栏含 reconcile 行、次跳起消失；第二波消息（新 run）再标记一次；todo 段为空时标记独立在场；两处调用点（含 reactive-compact 重试）结算行为同形；常量行跨回合字节一致。
   - [blocks: T3]
   - Status: [x]

5. **TUI 投影纪律回归** — tag: `[implementation]`
   - **Inherits:** spec T4「显示面不动：`agentStatusLines` 继续只投影未勾 todo 行、`clipOneLineVisual` 规则不变；`agentStatusFromEvent` 容忍并透传新字段；replace-on-event 语义不变」+ SC4 + Out-of-scope「TUI chrome 不加 instruction 行」。
   - **Surface:** `src/tui/agent-status-line.tsx`（事件映射扩）+ `src/tui/session-state.ts` / `src/session-api/turn-projection.ts`（隐藏谓词验证性回归）
   - **Acceptance:** TUI 单测——带 instruction/reconcile 段的事件渲染输出与旧事件逐字节相同；隐藏气泡过滤与 `isAgentStatusText` 前缀判定回归绿；旧 transcript 冷启动 hydrate（`agentStatusFromMessages`）返回合法快照。
   - [blocks: T3] [parallel]（与 T4 各自独立于 T3 之上）
   - Status: [x]

6. **黄金集四件（STATIC + SEAM + 轨迹夹具 + 名册回填）** — tag: `[implementation]`
   - **Inherits:** spec T5 / SC7「`<agent_status>` 面 = 缺口 → 按 prompt-development 指南补集：STATIC 栏格式关键行锁、SEAM 结算锁、轨迹夹具与既有轨迹集共处不另开总柜、实现 PR 回填名册表」。
   - **Surface:** `tests/harness` agent-status 区（夹具落点参照 `graph-mode-notification.fixtures.ts` 共处纪律）+ `docs/guides/prompt-development.md` 名册 `<agent_status>` 行
   - **Acceptance:** STATIC 测试锁 `last_tool:` / `instruction:` / reconcile 前缀与 `todos:` 头次序及常量句；SEAM 由 T3/T4 集成断言承担可指认；轨迹夹具固定输入 = 非空账本 + pivot 指令进场，可判定行为 = 模型下一跳首工具为 `todo_write`，真模型半边过 `npm run test:real-llm`（缺 key → 如实 Not run，不以离线绿冒充）；名册行回填为集路径。
   - [blocks: T4, T5]
   - Status: [ ] pending

7. **TUI pty 实测证据留档** — tag: `[implementation]`
   - **Inherits:** spec T6 步骤①–④ + SC8 + 仓规「凡进会话的改动必须上屏，chat REPL / TUI 单测不能代替」。
   - **Surface:** `mcp__aiterm__pty_*` 真实 TUI 会话（预期零代码改动；实测暴露缺陷回写对应 bullet 重跑）
   - **Acceptance:** 实测走读——多步任务 `todo_write` 入账后中途 pivot；读 trace 证据：pivot 后首跳栏含 `instruction:`（= pivot 首行逐字）+ reconcile 行，次跳 reconcile 消失、instruction 仍在；屏上无注入气泡回潮、todo footer 投影不劣化；transcript 片段 + trace 行号写进验收报告。
   - [blocks: T4, T5, T6]
   - Status: [ ] pending

---

收尾：全部 bullet 落完后跑一轮 end-of-round code review（环境选定 code-review skill），随 operator 全局 commit 段落地。
