# 0035. subagent 生命周期 trace 无条件落盘（修正 ADR-0003 D10 范围）

Date: 2026-08-28
Status: accepted

背景：PR #783（worker 启动秒崩）复盘发现，chat REPL 入口 subagent trace 缺省 Noop（`build-engine.ts:374-380` / `cli.ts:277-286`），秒崩后磁盘零证据，事故取证完全依赖 serve/TUI 入口。决定：`subagent_spawn`/`subagent_state_change`/`subagent_stop` 三类生命周期事件 + crash stderr 指针文件（`<traceDir>/stderr/<taskId>.log`，mask 后、1MiB cap）在所有产品入口无条件落盘；ADR-0003 D10「chat REPL 不做 trace」的排除范围**收窄为 content trace**（llm_call/turn/tool_call 等 payload 面），生命周期元数据行极小（实测 ~400-600B/行）不构成该决策当初规避的交互边界问题（ctrl-c/会话切换写盘边界属 content 面语义）。

**正面 / Applied:** 任何入口复现 #783 类秒崩都有磁盘证据链（error 结构化字段 + stderr 全量指针 + 尾部 summary）；调试者不再依赖入口开关记忆。

**负面 / Trade-offs:** chat REPL 多一个 `subagent.jsonl` 聚合文件的持续 append（量级 KB/任务）；与 ADR-0003 D10 原文表面冲突，靠本 ADR 的范围收窄消解——未来读者看到 chat REPL 有 trace 行时以本 ADR 为准。

Evidence pointers: `specs/trace-agent-readability.md`（Success Criteria 1/3/4）；PR #783（d1e5a9e7）与 buglog `c1a15695`（分支 docs/subagent-worker-startup-crash-buglog）；2026-08-28 trace 设计评估（4 路 Explore + skeptic 二审）。
