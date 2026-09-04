# 0042. memory_layer catalog 会话级快照 — 开局取一次、会话内冻结

Date: 2026-09-04
Status: accepted

## Context

wayfinder 图「模型面前缀分层与缓存兑现」G1 票（前缀稳定边界）盘问中段裁决。G1 采用从严资格线：一段内容要有资格留在前缀区（`tools` + `system`），其输入来源必须**构造上**不可能在会话内变——「实测没变」不算数。按线盘点，`memory_layer` 中不合格的只有 catalog 段（[ADR-0034](0034-auto-memory-catalog-prefetch-channels.md) D1 允许进 system 的 live titles/hooks + 纪律句）：它经 `memory/refresh.ts` 的 mtime 门控读取，auto-memory 落盘（ADR-0031，completed 闸后异步、成簇写入）当下一次装配就变——R4 实测每会话抖 1~3 次，每次废掉 system 之后**整条 messages history** 的被动缓存。ADR-0034 D2 已把重载荷（bodies / prefetch）放在 user 消息侧、不碰前缀，本票只处理 catalog。

## Decision

1. **catalog 快照化**：`memory_layer` 中的 catalog 段（+ promote 段同层）在会话**首次装配时取一次快照，此后会话内冻结**——实现语义从「mtime 比对缓存（变了会刷新）」改为「快照（永不再算）」。新落盘的记忆对**当前会话**的 catalog 不可见，下个会话才入索引；这是已接受代价，且对 catalog 影响极小（模型刚写完的记忆不需要从索引里再看见）。
2. **bodies / prefetch 通道不变**：维持 ADR-0034 D2（prefetch 挂 user 消息、标 advisory），本票不动它们。
3. **既有 channel / 信任语义不变**：ADR-0034 D1 的「catalog in system、bodies not」、un-promoted body 不进 system、英文纪律句均原样保留；变的只有 catalog 内容的**新鲜度时机**（每落盘刷新 → 会话级冻结）。
4. 冻结后，`memory_layer` 成为会话级常量段，通过 G1 从严资格线；「auto-memory 写入时机与缓存边界对齐」这一悬置问题随之消解（写入时机不再影响缓存）。

## Why not

- **catalog 也搬出 system（并进 user 消息侧与 prefetch 同槽）**：要动 ADR-0034 D1 的「catalog in system」通道设计，改动面大；而快照化以一处时机改动即达目的。
- **维持现状（mtime 门控、落盘即刷新）**：每会话 1~3 次全量 messages 缓存作废；「写入要不要节流」会变成新的无休止权衡（需要节流才保缓存，节流又伤记忆时效）。
- **放宽资格线容忍抖动**：与 G1 从严线（构造上不可能变才合格）及 destination「不靠个人判断」冲突；「容忍几次」无机械答案。

## Consequences

- **正面 / Applied:** R4 抖动表中「system 任一段变（记忆落盘）→ 全部 messages 作废，每会话 1~3 次」整行消除；system 侧剩余不合格段仅 `<mcp_tools_overview>`（另裁）。
- **负面 / Trade-offs:** 长会话中途落盘的记忆在当前会话的 catalog / promote 段不可见（`memory_recall` 仍可实时召回， bodies 走 prefetch 亦不受影响）——损失仅限「模型对自采记忆的目录级可见性」，被判定可接受。

## Evidence pointers

- R4 实测（wayfinder 图「模型面前缀分层与缓存兑现」）：`memory/refresh.ts` mtime 门控 + 记忆化机制；记忆落盘成簇（08-28 16:49 / 17:02、09-02 22:46 等）。
- ADR-0009 D3 / D6；ADR-0031（异步抽取与写入成簇）；ADR-0034 D1 / D2。
- D1（本图）：git 块「开局快照、会话期间不刷新」同款先例，代价结构相同。
