# 0118. 用量条与 auto-compact 闸共用 occupancy 分子

Date: 2026-09-21
Status: accepted

分母已是策略预算窗口（ADR-0100）。分子却分叉：条用 API / `countTokens`，proactive 闸用 `estimateMessagesTokens`（thinking=0、image ≈1）。hoolycheck 会话 `8582d3fc` 条 955.6k/256k、34 次调用零 compaction。闸改吃 **context occupancy**：本拍有限且 >0 的 `countTokens`，否则上一拍 occupancy，否则才 chars 估算。pre_call cache 缺席时 occupancy = `inputTokens`，不得把总量再加 cache。显示仍禁止用估算顶替 usage（ADR-0008 D6 显示半边）。压缩器与手动 `/compact` 不过 token 闸的语义不变。

Amends ADR-0008 D6（估算不再是压缩主判据）与 ADR-0100（分子与分母都同一占用账，不只分母）。
