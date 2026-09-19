# 0108. 模型在途打断：留下 freeze 前缀，丢掉正在长的块

Date: 2026-09-19
Status: accepted

## Context

**in-flight closeout** 旧读法：模型在途则整条 assistant 不进历史。实现上 cancelled 只保留 user + `Interrupted by user.`，流式 overlay settle 后卸掉。操作员指出这与既定截断单位不一致：实时过程里**已经成形的消息要留**，只截**还在生成的半截**；粒度已选 **streaming block freeze**（钉住除最后一个顶层块外的前缀）。工具在途路径本来就会留下已 append 的 assistant，不在本 ADR 重开。

## Decision

Esc **前台打断**（cancelled）且模型仍在途时：

1. 对已累积的流式 markdown 跑与墙上同一刀：`splitStreamingMarkdown` 的 `prefixRaw` 作为本轮 assistant 写入 **append-only messages** 并 commit；`tailRaw` 丢弃。
2. 无 prefix（全文都在最后一个还在长的块里）→ 不落 assistant，只留 user + **interrupt system message**。
3. 已闭合的 `tool_use` 块算成形，留下；尚未执行的 call 走既有工具在途 closeout（`execution_failed` / `"cancelled"`）。
4. 打断当下 TUI、重开/load、普通下一句 prior **同一形状**。禁止只在墙上冻草稿、盘上没有。
5. timeout / 进程死亡 resume 仍不加 `Interrupted by user.`；timeout 的 keep 刀与 cancelled 相同（前缀留下），文案规则不改。
6. **切刀模块**须是 harness 已能 import 的层（现有 `src/shared` 缝）。TUI Markdown 改为调用方。**禁止** `src/harness` import `src/tui`。

## Why not

- **整步不落 assistant（旧 closeout）：** 把已钉住的完整块当成半截扔掉，墙上像整轮蒸发。已否。
- **流过的 token 全留：** 半截粒度不是 freeze；操作员选了钉住块。
- **只改 TUI、不改权威历史：** 打断当下和重开分叉；下一句模型看不见人刚看见的完整块。拒。
- **harness 直接 import `src/tui`：** 反向依赖显示层。拒。

## Consequences

- freeze 切法是 closeout keep 与墙的同一 SSOT，不是 TUI 私有 lexer。
- 单块还在长、前面没有钉住块时，打断后可以没有 assistant 正文——这是粒度推论，不是退回「整步丢弃」。
- 既有「cancelled 不 append assistant」测试与 CONTEXT 旧句一并作废，由后续 spec/计划改锁。
