---
name: domain-modeling
description: "This skill should be used when LogicSync, spec-driven-development, or writing-plans flushes a persist list, or the user needs to persist a term to docs/CONTEXT.md or an ADR for a one-way door."
bucket: engineering
type: technique
version: 3.0.0
related_skills: [logicsync]
---

# Domain Modeling

唯一写入 `docs/CONTEXT.md`、`docs/CONTEXT-MAP.md`、`docs/adr/` 的技能。别的技能只读或驱动。

## When to use

- 驱动者最后一步带着待写入清单
- 词已选定，要写入 CONTEXT.md
- Hard to reverse / Surprising w/o ctx / Real trade-off 全真，要写 ADR

## When not to use

- function / array / loop 这类通用编程词
- 一次性 debug → session memory
- 易逆的小决策 → commit message

## Procedure

1. 对照 `docs/CONTEXT.md` 已定义词。
2. 待写入清单或词已由 LogicSync / spec-driven-development / writing-plans 选定 → 立刻按 `CONTEXT-FORMAT.md` 写入，不再问。
   本技能单独跑 → Recommend 写在回复里；有真分叉再列 live option，带 trade-off；没有则 Confirm。发完等下一句，再写。
3. ADR：三条件全真才按 `ADR-FORMAT.md` 写 `docs/adr/NNNN-slug.md`（先扫最大号 + 1）。Status：`proposed` → `accepted` → `deprecated` / `superseded by NNNN`。被推翻时改 Status，不删文件。
4. 写 CONTEXT 词条：定义 ≤ 2 句；武断选词，`_Avoid_` 列同义词。

**Done when:** 该写的 CONTEXT 词条或 ADR 已落盘（或判定不写）。

## 护栏

Write/Edit 会走 `pre-context-write-guard.cjs`。格式不对会被拒，按 `CONTEXT-FORMAT.md` / `ADR-FORMAT.md` 改后再写。
