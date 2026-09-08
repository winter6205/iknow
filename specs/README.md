# specs/ — 活跃 module spec 活索引（SSOT）

> **索引维护规则**（写在最前）：
>
> - **新增 spec** → 在对应主题组加一行（一句话职责 + supersede 指针若有）。
> - **spec superseded 或落地完成** → 从活跃表删除条目，移入 `docs/archive/025-retire-completed-specs-and-plans/`（批量归档），并在下方「已归档」段加一行 + supersede 指针。
> - **索引永远只列当前活跃 spec**，全量历史不在此重复 — 避免主代理"看到旧的→找新的"探索成本。
> - **入口文件**（CLAUDE.md / README.md / docs/STATUS.md / docs/architecture.md）只引用本文件，不再逐字枚举编号 spec。新增/归档只改本文件一处，入口永不变。

---

## 活跃 spec

### 运行时核心

- `security-guardrails.md` — 安全护栏（权限三层 · 沙箱 · 中断/超时）
- `trace-service.md` — trace 观测（JSONL + 查询 API · A-scope）
- `query-trace-tool-results.md` — `query_trace` 从 llm_call.messages 投影 tool_result（不写 tool_call.result）；plan: `plans/query-trace-tool-results.md`
- `trace-mcp-server.md` — stdio MCP server 暴露 trace 读侧三面（外部编码 agent 第三条读侧动线；#803）；v1.0 单工具 `query_trace`（plan: `plans/trace-mcp-server.md`）→ v1.1 按轴拆为 `list_sessions` / `query_trace` / `get_record`（plan: `plans/trace-mcp-read-side-split.md`）；承接 `query-trace-tool-results` 对 MCP 的 Out of scope
- `120-session-persistence.md` — 会话持久化（schema v1→v2 + `~/.iknow` 跨进程池）；Q1「不迁 JSONL」已被 `session-jsonl-resume.md` / ADR-0027 覆盖
- `checkpoint-rewind.md` — 检查点回退 UX（picker / 双 Esc）；截断落盘语义被 `session-jsonl-resume.md` 覆盖
- `session-jsonl-resume.md` — 会话 JSONL 账本（边写、process 补洞、rewind 留分支）
- `continue-pending.md` — 截断后续跑（`/continue` + CLI/TUI pending NL；Web 仅 slash+POST；同一 conversationId；非 ACI；#686 / map #270 / Resolution #277）
- `672-fault-recovery.md` — FaultClass + ModelAdapter 传输重试 + 本 run 工具环检测（`fused`）；map #672；ADR-0029
- `545-d-alpha-graph-mode.md` — D-α V1 graph mode overlay + `run_graph`（#545 CLOSED / ADR-0030；草稿 PR #698–#707 对照可摘，不合整链）
- `todo-ledger-replace.md` — 主会话 `todo_write` replace + 同目录快照（ADR-0046 / [#903](https://github.com/winter6205/iknow/issues/903)）；plan: `plans/todo-ledger-replace.md`；图上 DP/replan 见 [#904](https://github.com/winter6205/iknow/issues/904)

### TUI

- `146-tui.md` — TUI 交互骨架
- `tui-transcript-viewport.md` — ChatView 视口挂载（取代 PR #592 固定条数尾窗；滚动文档全量，树上只挂视口+overscan）
- `tui-markdown-stream-display.md` — markdown 围栏显示窗（32 行）+ 流式顶层块冻结；不改 session、不是消息条数尾窗
- `tui-run-graph-view.md` — `run_graph` 执行中 chrome 一行 + 语义分组视图（map #749；原型 #751）；plan: `plans/tui-run-graph-view.md`
- `tui-tool-settled-appearance.md` — 工具落定态（留 / 收 / 点名着色 + 失败横切 + `deriveSlot`）；**supersedes** `tui-display-consistency` D3；plan: `plans/tui-tool-settled-appearance.md`
- `tui-display-consistency.md` — 外壳统一 / thinkingMs / 结果预览窗（D4 ANSI·五行走·read 无内容预览）；**D3 折叠合同已让位** 给 `tui-tool-settled-appearance.md`

### 工具与扩展源

- `224-tool-extension-path.md` — 工具扩展路径（lazy / discover / visibleSchemas + tool_search）
- `251-lsp-tool.md` — LSP 工具（自建客户端 + TS 首期）
- `302-lsp-multilang.md` — LSP 多语言泛化
- `337-skill-mcp-extension.md` — skill + MCP 扩展源（SC6 写根 trailer **amended by** `skill-load-write-root.md`）
- `skill-load-write-root.md` — skill 正文装配收口 + 写根 trailer（slash / `skill()` / Web 共用装配口；与 worker prior 同一写根文案）；plan: `plans/skill-load-write-root.md`
- `disclosure-index-align.md` — 索引档对齐（#631 短描述收回、直呼加载、超限降档、删 `skill_search`）；amends ADR-0043 必经 `tool_search` 读法；plan: `plans/disclosure-index-align.md`
- `406-secret-roundtrip-mask.md` — Secret roundtrip mask（supersedes `#126` hook-system）
- `user-hook-router.md` — 用户钩子同进程 router（内置/用户钩子；V1 声明式 PreToolUse/PreWrite/PreCommit；plan: `plans/user-hook-router.md`）；不替代 #126 契约或 #406 roundtrip
- `task-worktree-lifecycle.md` — 隔离 ON 后进树/命名/list/remove 与身份根 grep·glob；plan: `plans/task-worktree-lifecycle.md`（amend ADR-0037 §3）；门禁分类与 unbound 文案 **amended by** `casual-ask-context-hygiene.md`

### 身份与记忆

- `196-identity-assembly.md` — 身份认知装配（identity / soul / 首启 BOOTSTRAP）
- `auto-memory.md` — 自动记忆抽取 + 机械清理（兑现 ADR-0009 D5，决策沉淀于 ADR-0031；默认 OFF；plan: `plans/auto-memory.md`）
- `memory-layer-follow-ups.md` — recall 过滤 disabled · type 封闭枚举 · 用户级 AGENTS 与 user.md 同根（叠项目 AGENTS）；plan: `plans/memory-layer-follow-ups.md`（#729–#732）
- `auto-memory-complete-upgrade.md` — CJK 近邻切分 · dream 离线合并 · §2.5 Medium（per-root 钩子 / 共用 notify）；plan: `plans/auto-memory-complete-upgrade.md`（文档轨，无 tracker issue）
- `auto-memory-low-trust-read.md` — 目录进 system · 预取进用户消息 · 低信任英文标注（第三次读路径改进；底 = 完整升级 + dream 双闸）；plan: `plans/auto-memory-low-trust-read.md`；指针/纪律句/recall 默认条数 **amended by** `casual-ask-context-hygiene.md`
- `casual-ask-context-hygiene.md` — 记忆读通道停下令 + worktree 门禁按「会不会写工作区」分类与错误文本（地图 G1–G4）；plan: `plans/casual-ask-context-hygiene.md`；promote 进 system **amended by** `promote-bodies-never-enter-system.md`
- `auto-memory-extract-discipline.md` — 抽取对照说明书丢弃 · 不记仓库可推（prompt）· 本轮 save 跳过 extract；plan: `plans/auto-memory-extract-discipline.md`
- `auto-memory-layering.md` — 抽取收窄 · 梦境 `replaces` 落盘 · `dream.json` · 软禁归档；promote 进 system **superseded by** `promote-bodies-never-enter-system.md`；plan: `plans/auto-memory-layering.md`
- `promote-bodies-never-enter-system.md` — 记忆正文不再进 system；promote 资格只给 GC；预取不按资格排除（ADR-0044）；plan: `plans/promote-bodies-never-enter-system.md`
- `serve-workspace.md` — serve/Web 工作空间制度（显式主根，禁止自动 cwd；ADR-0023, serve default = unbound, #531）

### Verify / 完成门禁

- `verify-goal-gate.md` — HITL vs `/goal` 自动模式两套判断逻辑；完成向 LLM 只挂自动模式（supersedes 归档 `128-verify-classifier` / `458` 判定公式 / `449-loop` 判官门禁）；HITL compact 保焦见 `recent-user-tasks.md`
- `recent-user-tasks.md` — compact 任务摘录（现抽现贴最近用户任务原话；删会话 `taskFocus`）；正交于 PR #601 压缩触发闸
- `468-subagent-judge-tool-surface.md` — 子代理声明工具面=实际工具面（判官只读契约）
- `449-evidence-checker.md` — 证据优先纯函数规则引擎（三态 verdict + 三防 + D2 探测）

### Verify 证据优先重构（#449/#458，实施顺序 A→B→C→D）

- `468-subagent-judge-tool-surface.md` — 子代理声明工具面=实际工具面（判官只读契约前置 bug fix，A）
- `458-goal-lifecycle-taskfocus.md` — goal/taskFocus 拆分 + model_proposed 删除 + /goal 三面 + validateGoalText（B）
- `449-evidence-checker.md` — 证据优先纯函数规则引擎（三态 verdict + 三防 + D2 探测，C）
- `449-verify-evidence-first-loop.md` — 验证循环重构主体：证据优先编排 + 补跑信封 + 证据感知判官 unverified 四态（D）

---

## 已归档（指针）

批量归档：`docs/archive/025-retire-completed-specs-and-plans/specs/`

- `126-hook-system.md` — superseded by `#406` roundtrip mask
- `128-verify-classifier.md` — superseded by `verify-goal-gate.md`（无 command 则每轮 completed 必跑判官 / `task` 可回退 query）
- `458-goal-lifecycle-taskfocus.md` — 数据模型已落地；判定公式 `goal ?? taskFocus ?? query` superseded by `verify-goal-gate.md`
- `449-verify-evidence-first-loop.md` — 三级流 shape 仍参考；「INSUFFICIENT 必请判官」+ 消费 458 公式 superseded by `verify-goal-gate.md`
- `128-auto-correction-loop.md` — 落地完成（`012bc7c1`）
- `119-compression-landing.md` — 落地完成（PR #239）
- `228-memory-injection-landing.md` — 落地完成（PR #233，决策沉淀于 ADR-0009 / ADR-0010）
- `252-loop-stop-semantics.md` — 决策已进 ADR-0011 / ADR-0012 / ADR-0013
- `321-tui-opentui-migration.md` — 渲染后端迁移完成（PR #360；旧 ink 归档 `archive/tui-ink/`）
- `356-subagent-v1.md` — superseded by V1.5（`#361` foreground spawn 反转）
- `trace-lifecycle-panel-v2.md` / `iknow-trace-standalone-service.md` / `traceserver-inspection-panel.md` — trace 三迭代 spec；独立 `iknow trace` 进程（`#183`）+ web trace.html 面板已取代；**superseded by ADR-0020（读侧融合回 `iknow serve` 同进程同端口；`iknow trace` 默认探测 + `--separate` escape hatch）**
- `653-horizon-pkg1-perception.md` — 落地完成（PR #666）；TUI Verify 终态 + 环境现势
- `653-horizon-pkg2-kernel.md` — 落地完成（PR #671）；前台/后台 bash 沙箱纪律对齐 + `isConcurrencySafe` 调度
- `tui-display-consistency.md` D3 折叠合同 — superseded by `tui-tool-settled-appearance.md`（spec 仍活跃，仅 D3 让位；plan T3 cancelled）

---

## 配套目录

- `../docs/adr/` — 架构决策记录（决策 SSOT，保留全部）
- `../docs/archive/025-retire-completed-specs-and-plans/` — 已落地 / superseded spec + plan 批量归档（含 README 索引）
- `../plans/` — 实施计划（落地后归档至 `docs/archive/025-.../plans/`）
- `../docs/design/` — 设计定案（UI / 前端栈等）
- `../docs/CONTEXT.md` — 领域术语（仅 `domain-modeling` 可写）
- `../docs/STATUS.md` — 功能现状与展望 + §6 文档索引（指向本文件）
- `../CHANGELOG.md` — 版本变更真值（根目录）
