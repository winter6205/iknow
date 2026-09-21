# Spec: context occupancy 闸条同分子

用量条与 proactive auto-compact 看同一占用数字。分母仍是策略预算窗口。

## Does

- 条的百分比分子 = **context occupancy**（TUI 与 Web 同一公式）。
- proactive 闸在每次 `step` 前用 occupancy 与 `floor(0.95 × contextWindow)`（或显式 threshold）比较。
- occupancy 优先级：本拍有限且 >0 的 `countTokens` → 上一拍 occupancy(usage) → `estimateMessagesTokens`。
- pre_call cache 缺席：occupancy = `inputTokens`。post_call：三类相加。
- 手动 `/compact` 仍不过 token 闸。

## Does not

- 改策略预算窗口缺省或 95% 公式。
- 用供应商 1M 当分母。
- 改 window / full_summary 压缩器。
- 用 chars/N 填 trace 或 `lastUsage`。
- 把 countTokens 总量再加 cache 字段。

## Contract

- EXIT：缺 `countTokens` / throw / 非有限或 ≤0 → 本拍无实测，不得收成 `below_token_threshold`；继续上一拍 occupancy，再估算。
- empty：无实测且估算低于阈值 → noop。
- overflow：occupancy 高于阈值（即使估算低于）→ 不得 noop。
- concurrent：本拍测量与上一拍不一致时用本拍。
- 无 `onStream` 可不打显示用 countTokens；闸仍走上一拍 → 估算。
- 闸探针口径：本拍 `countTokens` 只测闸所见 messages（不含 system/tools）；显示 pre_call 拍测 system+tools+messages。同拍两数之差由上一拍 API usage 进链补合（一拍滞后，非永久分叉），此为登记口径。

依据：ADR-0118；ADR-0100；ADR-0008 D6 显示半边。
