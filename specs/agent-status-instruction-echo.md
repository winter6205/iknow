# Spec: 状态栏复诵升级 —— instruction 回显字段与 pivot reconcile 标记

**Status:** draft (rev 2 —— end-of-round review 裁定落盘：T3 相关号补「re-freeze 同内容克隆判同」第二条款及成立前提，防实现按 rev 1 纯对象同一性算法回退；OQ1/OQ2 关闭登记见 `docs/STATUS.md`)
**Basis:** ADR-0103（修订 ADR-0028 Consequences 两处半句；注入纪律逐字不变）；`docs/CONTEXT.md`「状态栏」词条 + _Avoid_ 清单
**Surface:** `src/harness/agent-status.ts`（字段集 + 甄别谓词）、`src/harness/loop-engine.ts`（`appendAgentStatusBar` 注入点 + run 作用域 reconcile 装箱）、`src/harness/stream.ts`（`agent_status` 事件字段）、`src/tui/agent-status-line.tsx`（事件映射，渲染面不动）、`src/tui/session-state.ts`（隐藏谓词不动，验证性回归）

## Goal

修「复诵内容失真」：用户 pivot 指令进场后，状态栏仍每跳全量重发冻结的旧 todo 清单，指令本身被栏列推出末段注意力窗口（实测事故 conversation `ee13c787`，2026-09-18，模型做旧任务约 8 分钟）。两条新信息进栏：

1. `instruction:` 段——最新**真实**用户指令首行的逐字回显（纯代码计算，不摘要、不改写）；
2. pivot reconcile 标记——新用户消息进场后的**下一条**栏附一次性标记，提示模型先 `todo_write` 对齐账本再继续，后续跳不重复。

注入纪律不动：每跳追加、append-only、不替换旧栏、不进 `deps.system`（ADR-0028）。

## Boundaries

- **Does:**
  - `AgentStatusSnapshot` 字段集扩展：`instruction`（`string | null`）+ `reconcile`（`boolean`）；`buildAgentStatusText` / `parseAgentStatusText` 双向支持，**旧栏（无新段）必须照常解析**（冷启动 hydrate 路径 `agentStatusFromMessages`）。
  - 「真实用户消息」甄别谓词（harness 层 SSOT，见 T2）：排除全部宿主注入 user 消息 + 剥 memory prefetch overlay。
  - loop-engine 注入点接线：`appendAgentStatusBar` 从 `state.messages` 提取 instruction，经 run 作用域装箱做 reconcile 一次性结算。
  - `agent_status` 流事件字段随快照扩（同一份 snapshot 对象，单一真源纪律不破）。
  - 黄金集处置（`<agent_status>` 面名册登记为**缺口**）：STATIC + SEAM 锁补齐 + 事故轨迹集补集（见 T5）。
- **Out of this spec:**
  - 注入频率 / 边界注入 / dedup（ADR-0103 §Why not 已裁定拒绝，不得借「降噪」重提）。
  - `isTuiHiddenUserMessage` 谓词本身（栏仍是 `<agent_status>` 前缀命中，隐藏行为零变化）。
  - TUI chrome 新增 instruction 行（见「TUI 投影纪律」：显示面不动）。
  - todo 账本写入侧、`todo_write` 语义（ADR-0085 三件事不动）。
  - 把 taskFocus / 任务卡 / 环境现势引入栏（CONTEXT 禁令）。

## Settled invariants

1. **栏只承载代码算出的现势**：instruction 是逐字回显（用户原话首行、截断），不是 LLM 摘要；reconcile 标记是固定常量文本。政策散文仍不进栏。
2. **instruction 来源 = messages 尾部最新一条真实用户消息**：必须排除 agent_status 注入本身（`isAgentStatusText`），且排除全部宿主注入（甄别名册见 T2）；memory prefetch 骑在用户 turn 上（`MEMORY_PREFETCH_END` 之前的部分是模型侧 overlay），提取前先剥 overlay 取原文段。
3. **reconcile 在场条件只有一个**：「新用户消息进场后的下一条栏」。禁止用「本跳是否调用过 todo_write」「todo 段是否在场」「栏是否变化」当条件（CONTEXT _Avoid_ 明列）。标记只在该跳出现一次。
4. **reconcile 文本字节稳定**：跨回合、跨会话同一常量（它是栏内行不是 system，不破前缀稳定性）。
5. **字段次序纪律（双向兼容的根）**：所有标量字段行（`last_tool:`、`instruction:`、reconcile 行）排在 `todos:` 头**之前**，todo 行永远占据栏末段。效果：旧解析器吃新栏（find `last_tool:` + `todos:` 头后全收）仍得正确子集；新解析器吃旧栏得 `instruction: null, reconcile: false`。
6. **append-only 不动**：本 spec 不新增任何消息替换 / splice 路径；`pendingInjected` record 纪律（#888 save-fork）照常覆盖新注入形态。
7. **空槽不广告**：无真实用户消息（理论上仅合成装配）→ `instruction:` 段整段缺席；无未勾项 → todo 段整段缺席（既有纪律）。

## 任务拆分

### T1 — 栏字段集扩展（`agent-status.ts` 纯函数对）

`buildAgentStatusText` 输出形态（todo 段在场时的完整形状）：

```
<agent_status>
last_tool: <name>
instruction: <首行逐字、≤100 码点>
reconcile: <固定标记句，仅该跳出现>
todos:
- [ ] [tN] <subject>
</agent_status>
```

- `instruction` 为 `null` → 整行缺席；`reconcile` 为 `false` → 整行缺席（两者都是「空槽不广告」）。
- reconcile 行的固定文本（常量，导出供测试与名册锁）语义为：「检测到新的用户指令；若与当前 todo 账本不一致，先用 todo_write 对齐账本再继续。」英文单行（与栏其余部分同语言面），字节恒定。
- `parseAgentStatusText`：`instruction:` 行取值（缺失 → `null`）；`reconcile:` 行在场 → `true`；`todos:` 头之前的未知标量行不吞进 todo 列表（头后才是 todo 段）。畸形 → `null` 不 throw（既有契约）。

**验收**：单测覆盖——新构新解 round-trip；旧格式栏（仅 last_tool + todos）解析得 `instruction: null, reconcile: false`；新格式栏被旧字段消费方（TUI `agentStatusFromEvent`）不因多字段崩溃；`agentStatusFromMessages` 对旧 transcript（冷启动 hydrate 只有旧栏）返回合法快照；`instruction` 值含 `</agent_status>` 子串时不破坏结构解析（同行文本、行级校验，见 Failure paths F3）。

### T2 — 真实用户消息甄别（SSOT 谓词）

新谓词（落点 `agent-status.ts` 或同域单文件，命名如 `extractLatestRealUserText(messages)`）从 `messages` 尾向前扫第一条**真实**用户消息：

- role === user、text 块拼接（同 `joinedUserText` 形态，但不 import TUI 侧件——harness 不反向依赖）；
- 命中**注入名册**任一条 → 跳过。名册（现行全集，逐条挂谓词）：`isAgentStatusText`（`<agent_status>`）、`isGraphModeText`（`<graph_mode>`，含 change 长通知与 presence 短句）、`isSubagentDrainText`（`## Sub-agent `，即 task 类系统注入）、`isVerifyInjectedText`、`isSkillIndexDeltaText`（`<available_skills>` 增量）、MCP 重连通知（`MCP_RECONNECT_NOTIFICATION_TEMPLATE` 固定前缀 `MCP server '`）、`LOOP_DETECTED_TEXT`、compact 产物提示（`buildCompactPrompt` / `SUMMARY_PROMPT` 文本，若已持久化进 prior）。skill-load 信封（`[skill-load name="…" ]`）**计入真实用户消息**但提取其 `\n\n` 后的 remainder 首行；remainder 空 → 该条视为无指令源，继续向前扫（理由：首行是装配信封不是用户原话，逐字回显它没有复诵价值）。
- 命中 memory prefetch overlay（`MEMORY_PREFETCH_END` 在文本中）→ 取末段（marker 之后）为原文再提取；无 marker → 全文即原文。
- **名册完备性锁**：SEAM 测试枚举 loop-engine 全部 `encodeUserText` 注入缝的产出文本，assert 每条命中甄别名册（新注入缝不挂名册即红）。这是本 spec 给未来的护栏，防「新注入被当成用户指令」。

**提取规则**：剥净后取**首行**（`\n` 前），`trim` 行尾空白；截断 = 100 **码点**（`Array.from` 计数，非 UTF-16 单元），超限截断不加省略号（逐字纪律：加省略号即改写）；首行为空串 → 该消息无有效指令行，继续向前扫。

**验收**：单测——pivot 消息进尾 → 提取其首行；尾栏在场 → 跳过栏取真消息；drain / graph / mcp 重连 / skill delta 各自在场 → 跳过；prefetch 前缀在场 → 取原文段；skill-load 信封带 remainder → 取 remainder 首行，无 remainder → 前扫；CJK + emoji 混合 100 码点截断不劈半字符；名册完备性 SEAM 测试绿。

### T3 — loop-engine 接线与 reconcile 一次性结算

- **instruction 来源**：`appendAgentStatusBar` 增加 `state.messages` 消费（T2 提取器），传入 `computeAgentStatusSnapshot`（opts 扩 `instruction: string | null`）。todo 读取路径零变化。
- **reconcile 状态落点 = run 作用域装箱**（照抄 `lastToolRef` 形态，`run()` 创建、跨 step 共享；`public step()` 单步语义各自新建）。**不**做快照持久字段、**不**落 JSONL、**不**进 deps 装配面：
  - 装箱内容：`reconcileRef: { stamped: AnthropicNativeMessage | undefined }`——最近一次已随栏结算的「真实用户消息」对象引用（消息 frozen + immutable append，无需 id；判同条款见下）。
  - **相关号 = 判同，双条款（rev 2）**：① 对象同一性（`L === stamped`）；② 同 role + 逐块同内容 → 判为同一条（re-freeze 克隆）。②成立的**前提**：单 run 内真实用户消息仅 `run()` 入口追加的一条，其后 user 消息全是 T2 名册滤除的宿主注入——故内容判同在结算面等价于同一性，不存在内容相同的第二条真实消息可混淆。**实证动机（为何 ① 不够）**：compact 的 `applyCompactAttachment` 经 `freezeMessage` 逐条克隆 kept 消息，reactive-compact 重试后同一条消息引用变而内容不变；纯 ① 会把克隆误判成新消息进场、对同一指令重复标记，违反 invariant 3「标记只在该跳出现一次」。落点：`loop-engine.ts` `isSameRealUserMessage`。
  - 结算算法（每次 `appendAgentStatusBar` 调用内）：取 T2 命中的真实用户消息 `L`（对象引用）；`L !== undefined && !判同(L, reconcileRef.stamped)` → 本栏 `reconcile: true` 并置 `stamped = L`；否则 `reconcile: false`。**标记只出现一跳**由此算法天然保证。
  - compaction / reactive-compact 重试路径共用同一装箱与算法（两处 `appendAgentStatusBar` 调用点同形接线）。
  - 冷启动 / resume：装箱以 `stamped = undefined` 起步 → 本 run 第一条栏带标记一次（合法：进程重启后模型恰需一次对齐提示；不算违背「一次性」，一次性 = 每次进场结算一次）。
- **`agent_status` 流事件**字段随 snapshot 扩（`instruction` / `reconcile` 两字段），仍从同一计算点的同一份 snapshot 发出（单一真源，TUI 与栏不可能分叉）。

**验收**：harness 集成测试按仓规走 stub-model + `createJsonlTraceService` 双轨 assert（trace event sequence + NoopTrace-vs-no-trace deepEqual 基线）：同回合多跳 → reconcile 标记仅首跳、instruction 每跳在场；第二波用户消息进场（新 run）→ 首跳再标记一次、第二跳起消失；todo 段空时标记独立在场（在场条件与 todo 无关，invariant 3）。

### T4 — TUI 投影纪律

- **显示面不动**：`agentStatusLines` 继续只投影未勾 todo 行（`□ a · b · c` 单行、`clipOneLineVisual` 截断规则不变）。instruction 回显**不**加 chrome 行——进场时用户消息本来就渲染为 ❯ 气泡，复诵给人看是重复；reconcile 标记是给模型的提醒，人读面无价值。
- `agentStatusFromEvent` 需容忍并透传新字段（事件映射扩，`AgentStatusLine` 消费面零变化）；replace-on-event 语义不变。
- `isTuiHiddenUserText` / `isAgentStatusText` 前缀判定不变（新段在包装内，不影响隐藏）；`session-api/turn-projection.ts` 的 `isAgentStatusText` 过滤同理回归验证。

**验收**：TUI 单测——带 instruction/reconcile 段的事件渲染输出与旧事件逐字节相同（人读面无回退）；隐藏气泡过滤回归绿。

### T5 — 黄金集 / 名册处置（模型可见文案变更的强制面）

`docs/guides/prompt-development.md` 名册：`<agent_status>` 面锁 = STATIC + SEAM，集路径 = **缺口**。本改动属于「缺口面被改动」，按指南两条路二选一——本 spec 裁定**补集**（依据：指南「事故再出现，把那次输入收进集，禁止回归」，ADR-0103 的 evidence 正是 `ee13c787` 事故）：

1. **STATIC**：栏格式关键行（`last_tool:` / `instruction:` / `reconcile:` 前缀、`todos:` 头次序、reconcile 常量句）进既有 agent-status 静态锁测试；
2. **SEAM**：T3 集成测试（一次性结算、不进 system、跨跳字节稳定）；
3. **轨迹集**：新增黄金夹具（落点与既有轨迹集同放、不另开总柜——参照 `tests/harness/graph/graph-mode-notification.fixtures.ts` 的共处纪律，建议 `tests/harness/agent-status-instruction.fixtures.ts`）：固定输入 = 非空 todo 账本 + pivot 指令进场，可判定行为 = 模型下一跳首工具为 `todo_write`（对齐账本）而非继续旧任务工具；真模型半边必须过 `npm run test:real-llm`（缺 key → 如实 Not run，不得以离线绿冒充）；
4. **回填**：实现 PR 把集路径回填名册表 `<agent_status>` 行（缺口 → 路径）。

### T6 — TUI pty 实测（仓规：进会话的改动必须上屏）

`mcp__aiterm__pty_*` 起 TUI 新会话：①下达多步任务并让模型 `todo_write` 入账；②中途 pivot 指令；③读会话 JSONL / trace 证据：pivot 后首跳栏含 `instruction:`（= pivot 首行逐字）+ `reconcile:` 行，下一跳栏 reconcile 行消失、instruction 行仍在；④屏上无注入气泡回潮、todo footer 投影不劣化。证据（transcript 片段 + trace 行号）写进验收报告。

## Failure paths

| #   | 路径                                                              | 行为                                                                                                              |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| F1  | 栏后无任何真实用户消息（全新装配、prior 全注入）                  | `instruction` 段缺席、reconcile 不结算（无判定对象），栏退化为旧字段集形态                                        |
| F2  | 真实用户消息首行为空行                                            | 跳过该消息向前扫（提取规则 T2）；全链无有效行 → 同 F1                                                             |
| F3  | instruction 首行含 `</agent_status>` 或 `<agent_status>` 子串     | 逐字保留（同行文本不破坏行级校验：解析用 `lines[0] ===` / `lines.at(-1) ===` 全等，标量行前缀取值）；回归测试钉住 |
| F4  | 冷启动 hydrate 旧格式栏（无新段）                                 | `parseAgentStatusText` 返回 `instruction: null, reconcile: false`，不判畸形（invariant 5 的向后半边）             |
| F5  | 新格式栏被旧版本解析（回滚场景）                                  | 旧解析 find 到 `last_tool:`、`todos:` 头后全收 → 得到正确旧字段子集，不炸（次序纪律的前向半边）                   |
| F6  | `MEMORY_PREFETCH_END` marker 出现在用户原文内部（用户粘贴了该串） | 取**最后一个** marker 之后段为原文（宁欠勿过：宁可回显少一段前文，不把 overlay 当指令）；有测试钉住               |
| F7  | todos.md 读失败                                                   | 既有静默收敛（无 todo 段、不抛），新字段不受影响                                                                  |

## Input-contract classes

| Surface                | empty                           | invalid                                     | 备注                                    |
| ---------------------- | ------------------------------- | ------------------------------------------- | --------------------------------------- |
| instruction 提取       | prior 中无真实用户消息 → 段缺席 | 首行空 → 前扫                               | 纯读取，零抛错面                        |
| `parseAgentStatusText` | 旧栏（新段缺失）合法            | 缺 `last_tool:` / 包装行不等 → null（既有） | 新段缺失 ≠ 畸形                         |
| reconcile 装箱         | run 首跳 `stamped = undefined`  | N/A                                         | 相关号双条款判同（对象同一性 ∨ re-freeze 同内容克隆，前提见 T3 rev 2），frozen 消息无别名风险 |

## Success criteria

- **SC1**：栏字段集 = `last_tool` + `instruction`（条件在场）+ reconcile 行（一次性）+ todo 段（条件在场）；标量段全部先于 `todos:` 头（次序单测）。
- **SC2**：instruction 逐字 = 最新真实用户消息（剥 prefetch overlay 后）首行 ≤100 码点，无任何 LLM 参与（纯函数单测 + grep 断言本模块零 adapter import）。
- **SC3**：reconcile 标记「进场后首跳有、次跳起无」，trace 双轨 assert（T3）；在场条件独立于 todo 段与 `todo_write` 调用史。
- **SC4**：旧栏照常解析（hydrate 路径回归）；新栏被旧消费面（TUI footer / turn-projection）消费零异常。
- **SC5**：注入名册完备性 SEAM 测试绿（全部 loop-engine `encodeUserText` 注入产出均被甄别谓词判注入）。
- **SC6**：`agent_status` 流事件与栏文本同源单测（同一 snapshot 派生断言）。
- **SC7**：黄金集 T5 四件齐：STATIC 锁、SEAM 锁、轨迹夹具入集、名册表回填（回填发生在实现 PR；本 spec 合并即视为登记生效）。
- **SC8**：`npm test` 全绿 + TUI pty 实测（T6）证据留档；真实模型轨迹集过 `npm run test:real-llm`（缺 key → Not run 如实报）。

## Inherits / Changes

- **继承**：ADR-0028 注入纪律（每跳、append-only、不进 system）；#888 `pendingInjected` save-fork 纪律；`readOpenTodoLines` 静默收敛；todo 段投影 SSOT（`todo-ledger.ts`）；TUI replace-on-event 单源。
- **变更**：ADR-0028 Consequences 两处半句（已由 ADR-0103 Amended clause 落盘，本 spec 不改 ADR）；`AgentStatusSnapshot` / `buildAgentStatusText` / `parseAgentStatusText` / `computeAgentStatusSnapshot` / `agent_status` 事件形（扩字段、加性）；prompt-development 名册 `<agent_status>` 行（缺口 → 集路径，实现 PR 改）。
- **不动**：`isAgentStatusText`、`isTuiHiddenUserMessage`、`agentStatusLines` 渲染规则、todo 账本写侧。

## Open questions

- OQ1（**rev 2 关闭**，end-of-round review 裁定，登记见 `docs/STATUS.md`）：`LOOP_DETECTED_TEXT` 与 compact 提示文本在当前 prior 形态下是否持久进跨 run 历史未实测确认——甄别谓词按「命中即注入」写，两缝即使不持久也先进名册（保守多滤，代价为零）；SEAM 完备性锁兜底新注入缝。裁决：保守多滤 + SEAM 锁即足够，OQ 关闭。
- OQ2（**rev 2 关闭**，end-of-round review 裁定，登记见 `docs/STATUS.md`）：skill-load remainder 为纯空格时按「无有效行前扫」处理已定，但 **`/compact` 等 slash 产物**是否以 user 消息形态留在 prior 需实现时以真实 transcript 复核；若存在未列名册注入形态，纳入 T2 名册（完备性 SEAM 测试会自动暴露）。裁决：T7 TUI pty + trace 实测无未列名册分歧，OQ 关闭。

## Evidence pointers

- 事故 transcript：`~/.iknow/projects/iknow-ddcb805367a0/ee13c787-5958-4524-95d3-0e89d520f12a/`（指令进场后同形栏 30+ 条 vs 指令 1 条）。
- 现行字段面：`src/harness/agent-status.ts:39-97`（snapshot + 纯函数对）、`:158-169`（`computeAgentStatusSnapshot`）。
- 注入点：`src/harness/loop-engine.ts:600-625`（`appendAgentStatusBar`，含流事件同源发射）、`:2185-2192`（`lastToolRef` run 作用域装箱形态——reconcile 装箱照此）、`:2276` / `:2328`（两处调用点：正常 step 与 compact 重试）。
- 注入形态全集：`encodeUserText` 调用点 grep（graph change/presence、mcp 重连 `:795`、skill delta、compact 提示、`LOOP_DETECTED_TEXT`、worker 侧 host 截断提示——worker 无栏缝不在本面）。
- 甄别名册现件：`isAgentStatusText`（agent-status.ts:62）、`isGraphModeText`（graph/notification.ts:37）、`isSubagentDrainText`（subagent/host-drain.ts:38）、`isVerifyInjectedText`（verify/inject.ts:17）、`isSkillIndexDeltaText`（skill/index-delta.ts:67）；prefetch marker：`memory/prefetch.ts:30`（`MEMORY_PREFETCH_END`，「Splits overlay (model-only) from the typed query」）。
- TUI 消费面：`src/tui/agent-status-line.tsx:27-57`、`src/tui/session-state.ts:302-312`、`src/tui/app.tsx:1506 / :2342`（hydrate `agentStatusFromMessages`）。
- 名册登记：`docs/guides/prompt-development.md` 表 `<agent_status>` 行（STATIC + SEAM，缺口）。

## ACR Verdict（architecture-change-reviewer · 5-verdict gate）

```text
bounded-context-guardian: yes — 改动全留 harness 栏缝（spec Surface 行、T2 不反向 import TUI、T4 显示面不动、Out-of-scope 排除 TUI chrome/taskFocus）
defensive-contract-validator: yes — F1-F7 + Input-contract 表覆盖空/畸形/溢出（100 码点 CJK+emoji 截断 T2）/异常；并发由 run 作用域装箱天然隔离（T3 两处调用点同形接线，loop-engine.ts:2276/:2328 实测存在）
error-handling-enforcer: yes — F7 todos 读失败=既有 EXIT 静默收敛（agent-status.ts:147 实证）；F3/F4/F6 畸形→null 不 throw；提取面「零抛错」（invariant 7、T1）
complexity-anti-drift: yes — 复用 lastToolRef 装箱形态（loop-engine.ts:2185-2192 实证）与 pendingInjected 纪律（invariant 6），扩纯函数对不造子系统（T1/T3）
minimal-change-verifier: yes — 与 ADR-0103 决策 1-4 一一对应；T5/T6 系仓规强制面非 creep；名册锚点全部实测命中
OVERALL: PASS — hand to writing-plans
```
