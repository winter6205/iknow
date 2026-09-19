# G2 不一致时改哪一层

- Map: [打断后本轮去哪了](../interrupt-round-visibility-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: resolved (2026-09-19)
- Blocked by: G1

## Resolution

**两层对齐，刀只一把。** closeout / `commitMessages` 必须在 settle 前把 `prefixRaw` 写成 assistant；TUI 仍可卸 overlay，改画已含前缀的快照。`splitStreamingMarkdown` 升为墙与史共用，禁止只冻 TUI 草稿。不存在「现状即目标」。

## Question

若 G1 目标态与 R1/R2 现状不一致，改哪一层？

- 只改 TUI（live 缓冲 / 墙仍画已丢或未落盘的本轮）
- 只改 **in-flight closeout** / 权威历史 keep
- 两层都改（墙与盘对齐）

本票不写 spec 正文，只定责任层。G1 若裁定「现状即目标」，本票关为「不改层」。
