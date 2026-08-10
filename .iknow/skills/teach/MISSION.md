# Mission: AI 应用开发工程师面试准备（iknow 项目 = 面试项目）

## Why

用户（陈乙昊，26 届软件工程本科，广州商学院）以 **AI 应用开发工程师 / Prompt 工程师** 为求职目标。**iknow 仓库是他的面试项目**，fork 自 `garrytan/gbrain`（v0.42.59.0）做了二次开发：4-tool Agent 架构 + G2 信封 + Session HTTP API + Vite React SPA。仓库代码 95% 以上是 AI 助手在历次会话中写的，**他自己只消化了 RAG 原理层（0001-0007 课）**，对 TypeScript、Next.js、Vercel AI SDK、Shadcn 等技术栈基本零基础，导致「越来越不知道在干什么」「不知道技术细节」。

**底层真实目标**：通过 AI 应用开发工程师初级岗位面试（校招）。
**达成手段**：把 iknow 这个已有项目从「AI 替我写的代码」变成「我能向面试官讲清楚架构/取舍/权衡的项目」。

## Success looks like

- **能向面试官 30 秒讲清 iknow**：4 tool / G2 信封 / max_hops=5 / 鉴权注入 host 不进 tool —— 这四条「为什么这么设计」每条都能讲出取舍。
- **能区分自己学的 RAG 和 iknow 的 RAG**：知道 iknow 的 `kb_retrieve` 双臂合并 = 你学的「混合检索」、`kb_verify_citation` 三态 = 你学的「引用溯源」、`kb_governance` snapshot_id = 你学的「freshness/conflict」、`kb_compile` = 你学的「证据固化」。
- **能读懂 iknow 的核心代码**：能从 `src/kb-retrieve/`、`src/agent-loop/`、`src/interaction/`、`src/session-api/` 任何一段里抽出一段向面试官讲「这块在做什么、为什么这么写」。
- **能讲清 gbrain 上游与 iknow 的差异**：fork 自哪里、改了什么、为什么改、哪些是 spec 里有但代码没做的、哪些是代码有但 spec 没写的。
- **能解释 web 前端栈（Next.js / Vercel AI SDK / Shadcn / Zustand / TanStack Query）的存在意义**：不是要会写，是要能说出每个工具解决什么问题、为什么选它、可以换成什么。
- **每次会话结束**：teacher 给一段 readiness 复盘：当前距「能讲清 iknow 项目」还差什么、面试被追问哪个方向最可能答不上来、下一步补什么。

## Constraints

- **教学语言**：中文；技术名词（RRF / HNSW / chunk / G2 / SSE / SSRF / RAG）保留英文。
- **知识源优先级**：
  1. iknow 仓库源码 + spec（首要：讲清「自己的项目」）
  2. `_upstream_gbrain/` + `docs/deep_research/`（讲清「fork 自哪里、改了什么」）
  3. `reference/` PDF 知识卡（讲 RAG/LLM 概念时引用 [原文 Pxx]）
  4. 外部高信源（LangChain / Vercel AI SDK / Next.js 官方文档，仅补缺）
- **teacher 不得凭参数记忆编造知识点**。代码层面的事实必须可追溯到 `src/` 具体文件行号；概念层面须标 [原文 Pxx] 或 [source: file:line]。
- **用户时间紧**（在校 + 求职期），课需短（5-15 分钟内能消化）、有 1 个具体 tiny win、可立刻复习。
- **教学纪律**：每课必须产出 (a) `learning-records/NNNN-*.md` 一条评估 (b) `lessons/NNNN-*.html` 一节 HTML 课（用 `assets/base.css` 统一外观）。
- **RAG 基础已合格**：0001-0007 课的 chunking/embedding/检索/rerank 全链路已通过；后续课不再重讲这些底层，重心是「接回 iknow 项目」。

## 课型排序（用户明确）

1. **面试导向课**（最高优先）—— 从高频面试问反推概念链，让用户能讲清自己项目。
2. **代码导读课** —— 带用户读 iknow 真实代码（不是玩具 Python），每课一段关键 seam。
3. **技术栈课** —— Next.js / Vercel AI SDK / Shadcn / Zustand / TanStack Query 一项一项打通（最小可运行例子 + 面试能说的点）。

## Out of scope（暂定）

- 非 AI 求职方向 / 非 RAG/Agent 类岗位（如纯算法岗、后端通用开发）。
- 分布式 / 高并发 / 大模型训练 / 量化微调 —— 校招 AI 应用岗一般不问。
- gbrain 之外的同类项目深度对比（Dify / Coze / LangChain 等仅作概念对照，不开专题课）。

---

**Maintenance cadence**：每次会话结束更新 readiness 复盘；用户明确改变求职目标时整段重写。
