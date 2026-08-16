# Plan: 440 — toolset B-direction（todo_write 模型自治账本 + MCP resources 协议补全）

**Goal:** 落地 #440 决策——todo_write（D1-D9）+ MCP resources（M1-M7）。两张实施票 #477 + #478 各自垂直切片化；本 plan 不重议决策，只分解为可执行 tracer bullets。

**Architecture:** 见 `docs/handoff/2026-08-17-wayfinder-440-decisions.md`（grilling 决策全文）。两 Stream 独立：B 方向走 todo_write 自治账本（model-side governance）；M 方向走 MCP resources 通道补全（host-side seam）。两个 Stream 互不依赖、可并行。

**Tech Stack:** TypeScript + Node (ESM, tsc strict)，无新依赖；复用项目既有 helper（typed-error catch / executor 截断 20000 + 契约 X / ajv 校验）；MCP SDK @modelcontextprotocol/client@2.0.0 已含 resources primitives（`Client.listResources()` / `readResource()` 直接用）。

**Spec link:** `docs/handoff/2026-08-17-wayfinder-440-decisions.md`（decision doc，含 D1-D9 + M1-M7 + 附带决议 + 实施前置约束）。本 plan 引用决策条目作为合同，不再二次讨论。

**前置依赖**: 无（两 Stream 各自独立，可并行）；下游：#477 / #478 实施票关闭。

**Tracker**: GitHub（#477 todo_write 实施；#478 MCP resources 实施；ready-for-agent 由 #440 派生）。

**来源说明（ACR skip path）**: 本 plan 跳过 architecture-change-reviewer 5 维评审——决策已通过 grilling 形成决议（见 `docs/handoff/2026-08-17-wayfinder-440-decisions.md`），每条决策对应明确的 code path 与边界；分解 bullets 时不重议决策本身。护栏通过 per-ticket loop（ADR-0012）的 `code-review` 与 `verification-before-completion` 在实施阶段落实。

---

## Tracer bullets

> Per-ticket loop（ADR-0012 §Decision）为强制：每个 `[implementation]` bullet 的 `Per-ticket loop` 行不可省略。
> 上限阈值、checkbox 形态、wire format 等具体值由 decision doc 承载——本 plan 不复制，避免实施时错位。

---

## Stream A — todo_write 实施（D1-D9）

### T1. `[implementation]` session 作用域存储 seam

- **Affects**: 新增 todoDir seam（host 注入）；registry SSOT append；gate 装配
- **Acceptance**: 主 loop 装配路径解析到 session 级 todos.md；worker 装配路径下 todoDir 为 undefined（所有权隔离）；新会话首次写入自动创建
- **Rationale**: D2 / D3 / D6 三条决策的 host 端前置
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` tool factory 与 mode 路由

- **Affects**: 新增 todo_write 工具文件（factory 形态）；input schema 含 mode 枚举；handler 路由
- **Acceptance**: list 返回 todos.md 全文 / add 追加 item / check 翻转首个精确匹配 item；非法 mode 与空 item 走 typed-error；输出短字符串无 envelope meta
- **Rationale**: D1 / D5 决策落地；checkbox 形态由 T2 在 TDD 中按决策 doc 收敛
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` 治理上限与原子写

- **Affects**: todo_write 工厂内：文件上限与单条上限的实现；写入选 atomic 机制；typed-error 包装
- **Acceptance**: 文件超限抛 typed-error；单条超限抛 typed-error；**不**拒绝负面措辞；并发 add 不丢更新；崩溃中途不污染既有 todos.md
- **Rationale**: D4 决策落地；具体阈值见 decision doc，T3 通过 TDD 收敛
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` 装配 SSOT append-only

- **Affects**: registry SSOT 数组 append-only 增量；四处同步（registry / build-engine / ensure-deps / deps-tools）；ask surface 排除
- **Acceptance**: ask 形态工具面不含该工具；chat/tui/serve 含；SSOT 字面四处一致（CI 锁或单测断言守住）；SSOT 长度变化符合 append-only
- **Rationale**: D3 决策落地
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` 默认 ask + worker 所有权隔离

- **Affects**: 工具 ACI 元数据（category + 默认 mode）；worker 装配路径下 todoDir 缺席
- **Acceptance**: 主 loop 调用走 ask 守门；list 模式不触发 ask；worker 装配时 todoDir 为 undefined（即使默认不 deny 该工具，也因 seam 缺席而不可用）；typed-error catch 渲染遵循 `code-quality.md` 契约
- **Rationale**: D6 / D7 决策落地
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T6. `[implementation]` 正面引导式 description

- **Affects**: tool description 字面；system prompt 隔离
- **Acceptance**: description 含精确正面触发条件；不含负面禁令词；system prompt 不含该工具的纪律文字；与 D9 决议字面对齐
- **Rationale**: D9 决策落地（grilling 结论：纪律在描述里、不在 system prompt；正面引导自限定触发条件）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T7. `[implementation]` 端到端：fresh conversation + typed-error 覆盖

- **Affects**: 新增端到端测试文件（接真实 SessionStore + fresh conversationId）
- **Acceptance**: 覆盖 happy path（add→list→check→list）、fresh conversation 合法态 vs 真实故障区分、文件与单条上限、并发 add 串行化、worker 装配断言、typed-error catch 渲染形态；CI 全绿
- **Rationale**: 项目测试规范要求 fresh conversation + typed-error catch 契约
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

[blocks: T1-T6]

---

## Stream B — MCP resources 通道补全（M1-M7）

### T8. `[implementation]` manager 协议方法与聚合层

- **Affects**: MCP manager 模块；客户端句柄接口；共享类型定义
- **Acceptance**: stub 客户端上协议方法单测通过；多 server 聚合含 per-server 状态；capability 缺席 server 跳过不抛错；slot-based 调度与现有 callTool 路径一致
- **Rationale**: M1 / M3 / M4 决策的协议层前置
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T9. `[implementation]` list 工具（factory + 输入 + 描述）

- **Affects**: list 工具文件；handler 调 manager 聚合方法
- **Acceptance**: 输入解析路径正确（可选 server / cursor）；空结果返回中性占位；unknown server 走 typed-error；输出形态与参考实现一致；description 含正面触发条件
- **Rationale**: M1 / M2 决策的 list 部分落地；wire format 具体形态由 T9 在 TDD 中按 decision doc 与参考实现收敛
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T10. `[implementation]` read 工具（factory + 输入 + 描述）

- **Affects**: read 工具文件；handler 调 manager readResource
- **Acceptance**: server+uri 必填；text/blob 互斥形态正确返回；unknown server / 未连接 / capability 缺席 三种 typed-error 区分；isConcurrencySafe=false（M2 决议保守默认）
- **Rationale**: M1 / M2 决策的 read 部分落地
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T11. `[implementation]` 装配 SSOT append 与 read-only 元数据

- **Affects**: registry SSOT 数组 append-only 增量；四处同步；条件 = mcpManager 在场；ACI 元数据 category read-only 默认 ask 关闭
- **Acceptance**: mcpManager 缺席时工具面不含该对工具；SSOT 字面四处一致；read/list 调用不触发 ask 守门
- **Rationale**: M2 决策的装配面落地（PR #430 的 registerExternal 路径适配为 SSOT 条件化装配）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T12. `[implementation]` 零联动 guard test（worker 可见性 + verify 链路隔离断言）

- **Affects**: 新增 guard test 文件（worker 工具面装配断言 + evidence-checker / 判官输入契约不受 resource 读取影响的断言）；**不改**默认 deny 名单、evidence-checker、判官 deny 名单、trace 服务本体
- **Acceptance**: guard test 全绿——worker 工具面默认含该对工具（不进 deny 名单）；evidence-checker 对含 read_mcp_resource tool_use 的消息序列判定行为不变；判官 deny 名单字面不变；test-diff 本身即为该 bullet 的 commit 内容
- **Rationale**: M3 / M5 / D8「零联动」决议的可执行形态——零变更不等于零 commit，guard test 把「不联动」钉成回归防线，防止后续改动悄悄接线
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T13. `[implementation]` 端到端：暴露 resources 的 fixture stdio server

- **Affects**: 新增 fixture stdio MCP server（暴露至少一个 resources）；集成测试入口
- **Acceptance**: fixture server 在测试期启停；list 含至少一条 fixture 资源；read 该 URI 返回 fixture 内容；大内容触发 executor 截断行为；CI 全绿
- **Rationale**: codebase-memory 实测不暴露 resources（-32601）；端到端需独立 fixture（不能复用现状任何 stdio server）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

[blocks: T8-T12]

---

## Dependency graph

```
Stream A:  T1 → T2 → T3 ──┐
              T4 ───────┤
              T5 ───────┤
              T6 ───────┤
                         ↓
                         T7 [blocks: T1-T6]
                         （垂直切片验证）

Stream B:  T8 → T9 ──┐
          T10 ──────┤
          T11 ──────┤
          T12 ──────┤
                    ↓
                    T13 [blocks: T8-T12]
```

- Stream A 与 Stream B 互不依赖；可并行
- 每 bullet = 1 commit（项目规则 1 commit = 1 逻辑块）

## 决策-子弹映射

| 决策                                   | 落点                                                           |
| -------------------------------------- | -------------------------------------------------------------- |
| D1 单工具 + mode 枚举                  | T2                                                             |
| D2 session 作用域 + todoDir seam       | T1                                                             |
| D3 条件化装配 + ask 排除               | T1 / T4                                                        |
| D4 治理上限 + 原子写                   | T3                                                             |
| D5 短回执无计数无 envelope meta        | T2                                                             |
| D6 worker 不注入 todoDir（所有权隔离） | T1 / T5                                                        |
| D7 category write + 默认 ask           | T5                                                             |
| D8 零 verify 联动                      | T12（cross-stream 验证）                                       |
| D9 正面引导式 description              | T6                                                             |
| M1 两个显式工具 + list→read            | T9 / T10                                                       |
| M2 装配 + read-only 免 ask             | T11                                                            |
| M3 零新安全机制 + 现有纪律复用         | T8 / T9 / T10 / T12                                            |
| M4 stdio-only + slot-based             | T8                                                             |
| M5 零 verify 联动                      | T12                                                            |
| M6 零新成本机制                        | T13（fixture 端到端）                                          |
| M7 PR #430 摘取 + 适配                 | T8-T11（manager 通道 + 两工具 + 测试）+ T12（丢弃 todo-write） |

## 不在本计划范围

- PR #430 merge（D10 / M7 决议：不 merge；MCP 部分由 Stream B 摘取；todo_write 部分由 Stream A 重写）
- mcp_auth / plan mode（已关闭）
- 多 agent 共享账本 / MCP remote transport（未决，留后续方向）
- 现有 25 件 ACI 工具 description 审计（独立 task，不在 #440 范围）

## 验证（plan done 的四项）

1. `cat plans/440-wayfinder-toolset.md | grep -E "^### T[0-9]"` → 13 条 tracer bullet 编号齐全
2. 实施后 `git log --oneline` → 1 commit per bullet（13 bullets = 13 commits）
3. `git diff --stat HEAD~13..HEAD` → 每 commit 的 diff scope 匹配 bullet 的 affects 行
4. 最终报告含行: `成功 = plan has 13 tracer bullets, each with binary acceptance + [implementation] tag`
