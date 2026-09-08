# 0035. subagent 生命周期 trace 无条件落盘（修正 ADR-0003 D10 范围）

Date: 2026-08-28
Status: accepted

背景：PR #783（worker 启动秒崩）复盘发现，chat REPL 入口 subagent trace 缺省 Noop（`build-engine.ts:374-380` / `cli.ts:277-286`），秒崩后磁盘零证据，事故取证完全依赖 serve/TUI 入口。决定：`subagent_spawn`/`subagent_state_change`/`subagent_stop` 三类生命周期事件 + crash stderr 指针文件（`<traceDir>/stderr/<taskId>.log`，mask 后、1MiB cap）在所有产品入口无条件落盘；ADR-0003 D10「chat REPL 不做 trace」的排除范围**收窄为 content trace**（llm_call/turn/tool_call 等 payload 面），生命周期元数据行极小（实测 ~400-600B/行）不构成该决策当初规避的交互边界问题（ctrl-c/会话切换写盘边界属 content 面语义）。

**正面 / Applied:** 任何入口复现 #783 类秒崩都有磁盘证据链（error 结构化字段 + stderr 全量指针 + 尾部 summary）；调试者不再依赖入口开关记忆。

**负面 / Trade-offs:** chat REPL 多一个 `subagent.jsonl` 聚合文件的持续 append（量级 KB/任务）；与 ADR-0003 D10 原文表面冲突，靠本 ADR 的范围收窄消解——未来读者看到 chat REPL 有 trace 行时以本 ADR 为准。

## Amendment 2026-09-08（ADR-0071）

**位置变更**：`<traceDir>` 从 cwd 相对的 `./trace/`（`cli.ts:77`）移入**会话文件夹** `~/.iknow/projects/<项目 slug>/<conversationId>/`。本 ADR 要求的 crash stderr 指针随之落到 `<会话文件夹>/stderr/<taskId>.log`。同时 `subagent.jsonl` 那种「全机所有子代理聚合成一个文件」的形态（`createTrace("subagent")`，`hub.ts:2869` / `cli.ts:336`）退役，改为 **per-agent** 的 `<父会话文件夹>/subagents/agent-<id>.jsonl` + `.meta.json`——#783 类秒崩的证据链因此自带 lineage，不再需要靠 conversationId 字面量 `"subagent"` 反查。

**本 ADR 的无条件保证未被削弱**（这条是刻意写明的，防未来读者误判）：ADR-0071 Decision 5 给 trace 加了一个前置——`blobs/` 目录可写，不可写期间该次 `llm_call` 零行落盘。但那个前置**只作用于 content 面**（ADR-0003 D10 scope 的 `llm_call.messages` 正文，即需要走 `toBlobReferences` 的记录）。本 ADR 管的三类生命周期事件（`subagent_spawn` / `subagent_state_change` / `subagent_stop`）**不含 messages 正文**，`toBlobReferences` 对它们从不触发，因此 `blobs/` 不可写时生命周期行与 stderr 指针**仍照常落盘**。崩溃取证的无条件性原样成立。

**负面 / Trade-offs（本次新增）**：生命周期面与 content 面从此对 `blobs/` 健康度**敏感度不同**——同一次事故里可能生命周期行齐全而 `llm_call` 缺席。这是 ADR-0071 授权的取舍，取证时须知道「`llm_call` 缺席 ≠ 那次调用没发生」。

Evidence pointers: `specs/trace-agent-readability.md`（Success Criteria 1/3/4）；PR #783（d1e5a9e7）与 buglog `c1a15695`（分支 docs/subagent-worker-startup-crash-buglog）；2026-08-28 trace 设计评估（4 路 Explore + skeptic 二审）；ADR-0071（会话文件夹归并与 trace 正文内容寻址）；`specs/session-folder-consolidation.md` SC8 / SC11。
