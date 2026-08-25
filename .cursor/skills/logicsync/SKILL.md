---
name: logicsync
description: "This skill should be used when a long interview, 长访谈, 盘问, 质询, 深度盘问, or LogicSync interview is needed to resolve drifting terms or hard-to-reverse decisions."
bucket: engineering
type: technique
version: 4.0.0
related_skills: [domain-modeling]
---

# LogicSync

## When to use

- 需求或问题域还糊，需要先问清
- 术语过载、漂移，或和 `docs/CONTEXT.md` 已定义词冲突
- one-way door 需要 Recommend 和 live option，不能直接动手

## When not to use

- 已经问清，可以直接做
- 用户明确说别问了

## Procedure

### 1. 读已有定义

读 `docs/CONTEXT.md`（没有则读 `docs/CONTEXT-MAP.md`），扫相关 `docs/adr/`。文件缺失就继续，不新建。

**Done when:** 读过或确认不存在。

### 2. coupled

对本轮每个 coupled 组：

1. 对照 CONTEXT.md：用词是否冲突、是否缺词。决策是否 Hard to reverse / Surprising w/o ctx / Real trade-off 全真——全真才列入待写入 ADR。
2. coupled 写进同一条回复；没有 A 就问不出 B 才拆到下一回合。不是 coupled 的不要捆在一起。
3. Recommend 写在最前，附 1–2 句理由（代码 / CONTEXT.md / trade-off）。
4. 若有真分叉，再列 live option，每条带自己的 trade-off。没有真分叉就 Confirm Recommend。用户用自己的话改，按他的话走。词冲突先判沿用 CONTEXT.md 还是改 CONTEXT.md。
5. 发完等用户下一条：回编号、回名称、或用自己的话改都可以。
6. 选定的词和 ADR 记入本轮待写入清单（写在回复或摘要草稿里）。本步不写 `CONTEXT.md` / ADR，不 invoke `domain-modeling`。

**Done when:** 每个 coupled 组都有 Recommend；列出的都是 live option；无分叉走了 Confirm；待写入清单已更新。

### 3. persist

待写入清单空则跳过。否则立刻 invoke `domain-modeling`，只写清单上的项。

**Done when:** 清单已刷完或确认跳过。

### 4. 结束

对齐摘要写在回复里。下一步已经清楚就只写那个名称；否则只列此时用得上的名称（需要时才出现 writing-plans / spec-driven-development；总有 stop-here）。发完等用户下一条，再结束本轮。只报用户点的名称。不 invoke writing-plans / spec-driven-development。

```text
对齐摘要：
- 触及术语：<新增/更新词条>
- 触及决策：<新增 ADR 编号>
- 候选下一步：<名称>
```

**Done when:** 摘要已出，用户下一条已到，本轮结束。
