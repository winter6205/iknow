# G1 三面可见性契约

- Map: [打断后本轮去哪了](../interrupt-round-visibility-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-19)
- Blocked by: R1, R2

## Resolution

操作员选粒度 **1（钉住块）**；其余由本会话代决。

三面同一形状（权威历史）：

1. **打断当下 TUI**、**重开/load**、**普通下一句 prior**：user 在；`prefixRaw` 作为本轮 assistant 在（若有）；`tailRaw` 不在；cancelled 另有 `Interrupted by user.`。`/continue` 仍只从本次 prior 去掉末尾 interrupt，前缀留下。
2. **半截** = `splitStreamingMarkdown` 的最后一个还在长的顶层块（含未闭合 `tool_use` / 未闭合 thinking 尾）。已钉住块、已闭合 `tool_use` 算完整消息。无 prefix 时可以没有 assistant 正文——这是粒度推论，不是整步丢弃。
3. 工具在途：维持已 append assistant + cancelled tool_result。
4. 改写 **in-flight closeout**（ADR-0108）；禁止默默分叉旧「模型在途整条 assistant 不进史」。

## Question

Esc **前台打断** 之后，下面三面各自必须看见什么（用户句 / 已流出的 assistant / 已跑或在途的工具 / `Interrupted by user.`）？

1. 打断当下的 TUI
2. 重开或再 load 同一会话
3. 普通下一句人话进模型的 prior（不是 `/continue` 的 skip-append）

R1/R2 给出的是现状；本票裁定目标态。与既有 **in-flight closeout** / **interrupt system message** 冲突则显式改写或显式继承，禁止默默分叉。
