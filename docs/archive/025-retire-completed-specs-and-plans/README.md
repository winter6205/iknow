# 025 — Archive: 已落地 / superseded 的 specs + plans

> **Status: ARCHIVED.** 归档于 2026-08-14。本目录下的 spec / plan 均已落地或
> superseded。保留为 git 跟踪的历史参考；当前 runtime 不读取其中任何文件。

## Why

这些 spec / plan 对应的功能已实现并进入产品（或以 ADR / 新 spec 取代）。落地与否的
版本真值以根目录 `CHANGELOG.md` 为准；决策真值以 `docs/adr/` 为准。文档保留在原位
会让主代理先读到旧 spec，再被引导去探索新 spec（或反向），产生不必要的探索成本。
因此按「归档非删除」原则集中移入本目录，入口文件只指向活跃索引 `specs/README.md`。

配套的活跃索引：

- `specs/README.md` — 活跃 module spec 活索引（SSOT；「已归档」段含 supersede 指针）
- `CHANGELOG.md` — 版本变更真值（根目录）
- `docs/adr/` — 架构决策记录（决策 SSOT，保留全部）

## specs/

原 `specs/` 下已落地 / superseded 的 spec（理由与 `specs/README.md`「已归档」段一致）：

- `119-compression-landing.md` — 落地完成（PR #239）
- `126-hook-system.md` — superseded by `#406` roundtrip mask
- `128-verify-classifier.md` — superseded by `specs/verify-goal-gate.md`（2026-08-20）
- `128-auto-correction-loop.md` — 落地完成（`012bc7c1`）
- `228-memory-injection-landing.md` — 落地完成（PR #233，决策沉淀于 ADR-0009 / ADR-0010）
- `449-verify-evidence-first-loop.md` — 判官门禁 superseded by `specs/verify-goal-gate.md`（2026-08-20）
- `458-goal-lifecycle-taskfocus.md` — 判定公式 superseded by `specs/verify-goal-gate.md`（2026-08-20）
- `252-loop-stop-semantics.md` — 决策已进 ADR-0011 / ADR-0012 / ADR-0013
- `321-tui-opentui-migration.md` — 渲染后端迁移完成（PR #360；旧 ink 归档 `archive/tui-ink/`）
- `356-subagent-v1.md` — superseded by V1.5（`#361` foreground spawn 反转）
- `trace-lifecycle-panel-v2.md` / `iknow-trace-standalone-service.md` / `traceserver-inspection-panel.md` — trace 三迭代 spec；独立 `iknow trace` 进程（`#183`）+ web trace.html 面板已取代
- `653-horizon-pkg1-perception.md` — 落地完成（PR #666）
- `653-horizon-pkg2-kernel.md` — 落地完成（PR #671）；前台/后台 bash 沙箱纪律对齐 + `isConcurrencySafe` 并行调度
- `251-lsp-tool.md` — superseded by `specs/symbol-primary-aci.md`（坐标模型面合同；客户端实现仍用）
- `session-folder-consolidation.md` — 落地完成（PR #966；ADR-0071 L3；五锚点 → 会话文件夹 + blob 唯一 + 读侧两级树）

## plans/

原 `plans/` 下已落地 / superseded 的 plan：

- `119-compression-landing.md` — 落地完成（PR #239）
- `120-session-persistence.md` — 落地完成；活跃 spec `120-session-persistence.md` 保留
- `126-hook-system.md` — superseded by `#406` roundtrip mask
- `128-verify-classifier.md` — superseded by `specs/verify-goal-gate.md`（2026-08-20）
- `128-auto-correction-loop.md` — 落地完成（`012bc7c1`）
- `146-tui.md` — TUI 交互骨架落地；活跃 spec `146-tui.md` 保留
- `449-verify-evidence-first-loop.md` — superseded by `specs/verify-goal-gate.md`（2026-08-20）
- `458-goal-lifecycle-taskfocus.md` — superseded by `specs/verify-goal-gate.md`（2026-08-20）
- `196-identity-assembly.md` — 身份认知装配落地；活跃 spec `196-identity-assembly.md` 保留
- `228-memory-injection-landing.md` — 落地完成（PR #233）
- `252-loop-stop-semantics.md` — 决策已进 ADR-0011 / ADR-0012 / ADR-0013
- `321-tui-opentui-migration.md` — 渲染后端迁移完成（PR #360）
- `353-settings-loop-config.md` — settings loop 配置落地，收敛进 settings.json（ADR-0015）
- `356-subagent-v1.md` — superseded by V1.5（`#361` foreground spawn 反转）
- `365-tui-subagent-wiring.md` — TUI subagent 接线落地（PR #364，ADR-0014）
- `378-mcp-failed-recovery.md` — MCP failed 恢复落地（issue #378 三根因 + 共性）
- `383-b2-interrupt-transcript.md` — 打断作 transcript 事件落地（schema v4）
- `auto-mode.md` — auto 权限模式落地（TUI mode 切换）
- `653-horizon-pkg1-perception.md` — 落地完成（PR #666）
- `653-horizon-pkg2-kernel.md` — 落地完成（PR #671）
- `trace-lifecycle-panel-v2.md` — 独立 `iknow trace` 进程（`#183`）+ web 面板取代
- `trace-service.md` — trace 观测落地（JSONL + 查询 API，A-scope）
- `session-folder-consolidation.md` — 落地完成（PR #966；ADR-0071 L3）

## docs-plans/

- `196-identity-bootstrap-align.md` — identity bootstrap 对齐 openharness 落地
  （rev 2026-08-11 全部落地，文件头 `✅ DONE`）

## 指向

- 活跃 spec 索引：`specs/README.md`（「已归档」段含每条的 supersede 指针）
- 版本变更真值：`CHANGELOG.md`
- 决策真值：`docs/adr/`
