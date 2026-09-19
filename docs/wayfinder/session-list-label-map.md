# wayfinder:map — 会话列表显示的会话概要（决策）

> Tracker: 本地 markdown（沿用本仓既有 wayfinder 惯例，不开 GitHub issue）
> Charted: 2026-09-19
> 图名（人读引用时用全名）：**会话列表显示的会话概要（决策）**
> 触发：操作员原话「会话列表显示的会话概要方案有没有，去网上搜一下，结合我们的项目，看看」

## Destination

走完一次决策：TUI `/sessions`、Web 侧栏、HTTP `GET /sessions` 这三条列表面上，**一行会话该显示什么、从哪来、何时写进 `title`**。到达标志是 G1–G4 都有 Resolution。不把会话文件夹改名、话题聚类、会话搜索排序当到达。

## Notes

**domain**：会话列表展示面。磁盘字段已是 `title`（#467 从误导名 `summary` 改来）+ 列表派生 `lastFinalText`。文件夹名仍是 `conversationId`（CONTEXT：禁止用 session `title` / `goal` 当 slug）。

**每个 session 开工前必读**：

- `arthurpower:logicsync` —— grilling 默认
- `src/session-api/store/schema.ts` `extractTitle` —— 首条 user text trim + 80
- `src/tui/list-view.tsx` —— TUI 行主文案
- `web/src/components/SessionSidebar/grouped-view.tsx` —— Web 行主文案
- `arthurpower:domain-modeling` —— **lite model** / **session-title event** / ADR-0113 已落本树

**落盘纪律**：调研结论写在票的 Resolution。业界对照不写入 Decisions so far 的「该怎么做」；R1 只记事实。

**本回合**：操作员把「是否模型 / 读哪里 / 何时」捆成一问，G1–G3 同回合 coupled grilling（打破默认一票一 session）。

**本图必须尊重的既有决策**（票内点名挑战者除外）：

- #467：`summary` 改名 `title`，语义是 UI 标题摘录，**不是** full compact 的 LLM 结构化摘要。
- compact 成功后 `title` 仍从 compact **前**的 messages 抽首条 user，避免被 preamble 污染。
- 会话文件夹叶子 = `conversationId` 原文。

## Decisions so far

- [R1 业界会话列表标题怎么生成](tickets/r1-industry-session-list-titles.md) — 主流是「首条截断立刻占位 + 首轮后廉价 LLM 只生成一次」；失败静默回退；手改 CAS 不覆盖；几乎不随对话中途改名。
- [R2 本仓三条列表面现在显示什么](tickets/r2-iknow-list-surfaces.md) — 盘上 `title` = 首条 user 80 字；TUI 用 `title`；Web 侧栏用 `lastFinalText` 32 字（空则短 id），**不用 `title`**；无 rename API。
- [G2 列表行主文案用 title 还是 lastFinalText](tickets/g2-primary-list-label.md) — 三条面主文案对齐 `title`；`lastFinalText` 只给搜索，不进行。
- [G1 title 继续截断还是 LLM 生成](tickets/g1-title-generation-scheme.md) — lite 生成一次短主题；占位 `extractTitle`；不把 compact 摘要当列表名。
- [G3 何时写、失败怎么兜、能不能覆盖](tickets/g3-when-and-overwrite.md) — 占位立刻；第一次 completed 后异步一次；有标题事件后禁止 `extractTitle` 回盖。
- [G4 独立事件、单独模块、lite model 槽](tickets/g4-lite-model-and-title-events.md) — JSONL 独立标题事件；无工具模块；`settings.llm.liteModel` 只接标题，缺席静默。

## Not yet specified

- 标题形态（短主题句 vs 关键词串；实施时模块内自定，不另开产品入口）。
- lite 槽以后要不要被 compact / memory 复用（本图明确不接线）。

## Out of scope

- 用 `title` / `goal` 当会话文件夹名或 worktree slug。
- 会话聚类 / 自动分组（ChatOllama 路线图级能力）。
- 改 full compact 的 LLM 摘要格式，并把它当列表标题（那是压缩域，#467 已拆开）。
- 记忆条 `memory_catalog` 的 title（另一套索引）。
- 给人改会话名、中途持续改题、列表双行、话题聚类。

## Tickets

票体在 `docs/wayfinder/tickets/`。阻塞用正文 `Blocked by:`。

| 票                                                                                | 类型     | 在过程中的位置 | 阻塞       |
| --------------------------------------------------------------------------------- | -------- | -------------- | ---------- |
| [R1 业界会话列表标题怎么生成](tickets/r1-industry-session-list-titles.md)         | research | 事实           | —          |
| [R2 本仓三条列表面现在显示什么](tickets/r2-iknow-list-surfaces.md)                | research | 事实           | —          |
| [G2 列表行主文案用 title 还是 lastFinalText](tickets/g2-primary-list-label.md)    | grilling | 取舍（显示）   | R2         |
| [G1 title 继续截断还是 LLM 生成](tickets/g1-title-generation-scheme.md)           | grilling | 取舍（生成）   | R1, R2, G2 |
| [G3 何时写、失败怎么兜、能不能覆盖](tickets/g3-when-and-overwrite.md)             | grilling | 取舍（写策略） | G1         |
| [G4 独立事件、单独模块、lite model 槽](tickets/g4-lite-model-and-title-events.md) | grilling | 取舍（承载）   | —          |

Frontier：空。handoff：本树 `specs/session-list-title.md` + `plans/session-list-title.md`（分支 `feat/session-list-title`）。
