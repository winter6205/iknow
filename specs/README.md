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
- `120-session-persistence.md` — 会话持久化（schema v1→v2 + `~/.iknow` 跨进程池）
- `checkpoint-rewind.md` — 检查点回退（T1 数据层已落地）

### TUI

- `146-tui.md` — TUI 交互骨架

### 工具与扩展源

- `224-tool-extension-path.md` — 工具扩展路径（lazy / discover / visibleSchemas + tool_search）
- `251-lsp-tool.md` — LSP 工具（自建客户端 + TS 首期）
- `302-lsp-multilang.md` — LSP 多语言泛化
- `337-skill-mcp-extension.md` — skill + MCP 扩展源
- `406-secret-roundtrip-mask.md` — Secret roundtrip mask（supersedes `#126` hook-system）

### 身份与记忆

- `196-identity-assembly.md` — 身份认知装配（identity / soul / 首启 BOOTSTRAP）

---

## 已归档（指针）

批量归档：`docs/archive/025-retire-completed-specs-and-plans/specs/`

- `126-hook-system.md` — superseded by `#406` roundtrip mask
- `128-auto-correction-loop.md` — 落地完成（`012bc7c1`）
- `119-compression-landing.md` — 落地完成（PR #239）
- `228-memory-injection-landing.md` — 落地完成（PR #233，决策沉淀于 ADR-0009 / ADR-0010）
- `252-loop-stop-semantics.md` — 决策已进 ADR-0011 / ADR-0012 / ADR-0013
- `321-tui-opentui-migration.md` — 渲染后端迁移完成（PR #360；旧 ink 归档 `archive/tui-ink/`）
- `356-subagent-v1.md` — superseded by V1.5（`#361` foreground spawn 反转）
- `trace-lifecycle-panel-v2.md` / `iknow-trace-standalone-service.md` / `traceserver-inspection-panel.md` — trace 三迭代 spec；独立 `iknow trace` 进程（`#183`）+ web trace.html 面板已取代

---

## 配套目录

- `../docs/adr/` — 架构决策记录（决策 SSOT，保留全部）
- `../docs/archive/025-retire-completed-specs-and-plans/` — 已落地 / superseded spec + plan 批量归档（含 README 索引）
- `../plans/` — 实施计划（落地后归档至 `docs/archive/025-.../plans/`）
- `../docs/design/` — 设计定案（UI / 前端栈等）
- `../docs/CONTEXT.md` — 领域术语（仅 `domain-modeling` 可写）
- `../docs/STATUS.md` — 功能现状与展望 + §6 文档索引（指向本文件）
- `../CHANGELOG.md` — 版本变更真值（根目录）
