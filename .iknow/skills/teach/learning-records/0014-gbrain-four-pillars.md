---
id: 0014
type: lesson-recap
date: 2026-07-25
---

# 0014 · gbrain 四支柱深度侦察 + iknow 改进候选清单

## 用户状态

- 用户发起 /teach："我还想继续了解这个代码库，比如说它是怎么查的，就是涉及到我们需要改进的功能，全都需要帮我了解一下。还有说他的消息队列，鉴权，还有他的公司模式（Company Brain），GitHub 介绍页最好是你先读一下。还有它的 no agent 模式又是什么，这些我都完全不清楚。Send Explorers first if you need。"
- 这是 0010 课的**深度展开**：用户从"读懂陌生代码库"过渡到"理解上游能力全景 + 找改进点"。
- 基线：0010 课已建立上游地图（102 工具 / 三招方法）；这节课建立**能力-改进矩阵**。

## 决策

- **3 个并行侦察兵**（不重叠）：A 读 GitHub 介绍页 + Company Brain + no-agent 模式 / B 查询/检索主路径 / C Minions + 鉴权。
- **每支柱侦察完做 peer 校验**——不是冗余，是侦察的必需阶段（结果证明纠出 4 处事实错误）。
- 产出 1 张参考卡（4 支柱矩阵 + 3 件套推荐 + 不要升级清单 + iknow 真实优势 + 4 节深入课方向）。

## 关键事实（peer 校正后）

### 支柱 1 · 介绍页 / 定位

- `VERSION = 0.42.57.0`（CLAUDE.md 写 v0.42.59.0 是文档滞后）
- Garry YC 总裁自用：146,646 页 / 24,585 人 / 5,339 公司 / 66 cron
- 两种集成模式：(1) 全自主 agent 平台 / (2) Claude Code/Codex 的 MCP 检索层 → **iknow = (2) 的窄缝**
- README 营销 P@5 49.1% / R@5 97.9% 无 baseline 文件（`docs/eval/results/` 在 git 里是空的）——第三个"营销 vs 代码"脱节

### 支柱 2 · Company Brain / no-agent

- 3 拓扑：Personal / Team mount / CEO-class（多 brain + mounts）；跨 brain 是 agent fan-out 不是 SQL 联邦
- **Postgres RLS 是"防 anon key 暴露"层，不是 per-user 切片层**——真值隔离在 application-level `sourceScopeOpts`
- 5 阶段升级路径：数据底座 → 应用层隔离 → OAuth 字段 → 拓扑 + mounts → Postgres RLS（4-5 sprint，每阶段可 ship）

### 支柱 3 · 查询/检索（最复杂，4 次 peer 校正后）

- 主入口：`hybridSearch(engine, query, opts)` `src/core/search/hybrid.ts:808-812`，**13 阶段流水线**（`:808-1545`）
- **3 路召回**（不是 4 路）：keyword FTS + vector HNSW + relational 图谱；fact **不进 RRF**（独立 `recall` op）
- 关键词 = **PostgreSQL FTS `ts_rank(... websearch_to_tsquery('english'))`**（不是 BM25），CJK 走 ILIKE/bigram
- 3 search modes = **9 旋钮包**（`mode.ts:284-437`）：tokenBudget / expansion / limit / relational / autocut / reranker / intent / cache / graph
- Cache = **3 层防护**：① TTL 3600s ② knobs_hash v11（mode/token/expansion/limit/embedding provider+column）③ corpus freshness gate `page_generation_clock` + per-page generations（`query-cache-gate.ts:1-49`）
- AI 网关 `chat_fallback_chain` 是**配置存根**（`types.ts:362-366` + `gateway.ts:391-421`），**无 chatWithFallback 实现**——README 营销的"自动多模型 fallback"在代码里不存在
- query handler **不挂 citation 对象**，只 stamp evidence

### 支柱 4 · Minions + 鉴权

- Minions：35 文件 `src/core/minions/`，9 态状态机（waiting/active/completed/failed/delayed/dead/cancelled/waiting-children/paused），锁续约 30s + 15s 心跳
- `submit_job` 有 PROTECTED 名字门（shell/subagent/synthesize 等）远端拒；`submit_agent` 是 OAuth-bound（`bound_tools/bound_source_id/bound_slug_prefixes/bound_max_concurrent/budget_usd_per_day`）
- progress.ts：stderr 铁律 + 1s heartbeat + snake_case phase + CI 守门
- db-pacer 4 mode（off/gentle/balanced/aggressive）；OAuth 2.1（client_credentials + authorization_code + refresh_token）；**不用 JWT，用 opaque token + SHA-256 哈希**
- scopes 6 个：`read/write/admin/sources_admin/users_admin/agent`；`agent` 是 v0.38 sibling **不被 admin 隐含**
- `OperationContext.remote: boolean` type-level REQUIRED（fail-closed）；CLI 钉 `remote:false`，stdio/HTTP MCP 钉 `remote:true`

## 推荐的 3 件套（iknow 应该升级的）

| #   | 部件                                                                                      | 行数 | 工作流 | 面试含金 |
| --- | ----------------------------------------------------------------------------------------- | ---- | ------ | -------- |
| 1   | `progress.ts` 铁律（stderr/heartbeat/phase/CI 守门）                                      | ≤200 | 半天   | 中       |
| 2   | `transport: 'cli'\|'mcp-http'\|'mcp-stdio'` 3 态 trust boundary + 收紧 `isPrivilegedRole` | ≤100 | 1 天   | **高**   |
| 3   | `protectedTools: ReadonlySet<string>`（CLI 跳过，远端拒）                                 | ≤80  | 半天   | 中       |

## 不要升级的（overkill）

❌ MinionQueue / worker.ts / 锁续约（无长跑后台场景）
❌ OAuth 2.1（无 network surface）
❌ db-pacer / pace-mode（无 PgBouncer）
❌ subagent / brain-allowlist（agent loop 在 CLI 进程内）
❌ cycle / cron / autopilot / dream cycle（无 60 cron 场景）

## iknow 真实优势（被侦察反证的事实，不是安慰）

1. **fact arm 设计更紧**——kb_retrieve fact 进排序不进 G2 信封；gbrain `recall` op 独立不进 RRF，iknow 在这点反而领先
2. **citation 元数据主动挂**——kb_retrieve 输出主动构造 7 字段（chunk_id/doc_id/doc_type/summary/source_ref/chunk_version/fact_status）；gbrain query 不挂 citation
3. **ACL + freshness + fact_status 三件套内置**——retrieve.ts:102-173 一开始就在做
4. **deterministic + llm 双 agent mode**——产品级稳定设计

## 4 节深入课方向（按面试含金量排）

1. **hybridSearch 13 阶段导读 + 模式旋钮**（支柱 3 核心）
2. **cache 3 层防护深度课**——TTL + knobs_hash + page_generation_clock
3. **transport 信任边界 + protectedTools 实战课**（支柱 4 核心，面试常考点）
4. **Company Brain 5 阶段升级路径规划课**——分阶段工程节奏

## 侦察纪律教训（self-evolving）

- **peer 校验不是冗余**——本卡经 4 次 peer Claude 交叉校验，纠出至少 4 处事实错误（BM25 vs FTS / 4 路 vs 3 路 / cache 单层 vs 3 层 / chatWithFallback 不存在 / iknow fact arm 设计方向反了）
- 教训：连侦察协调者都要反复遵守"代码是 ground truth"；peer 校验是侦察的必需阶段，不是事后修补
- 文档 vs 代码冲突永远信代码（本卡记录 3 个冲突案例）

## 产出

- `reference/18-gbrain-capability-map.html`：4 支柱 × iknow 改进方向矩阵（含侦察纪律说明 + 3 件套推荐 + 不要升级清单 + iknow 真实优势 + 4 节深入课方向）

## ZPD 影响

- 用户从"上游地图（4 招）"推进到"上游能力全景 + 改进候选清单 + iknow 真实优势"。
- **下一步最该补**（按用户优先级）：
  1. **transport 信任边界 + protectedTools 实战课**——iknow 立刻能加 3 态字段 + 收紧 isPrivilegedRole，是面试能讲的 fail-closed 实战（最推荐先讲）
  2. **hybridSearch 13 阶段导读**——讲清 gbrain 单个检索函数的内部复杂度
  3. **cache 3 层防护深度课**——理解"为什么单一 hash 不够"
  4. **Company Brain 5 阶段升级路径规划**——长期方向

## 关联

- 0010（陌生代码库方法 + 102 工具地图）、0013（深度侦察评估）
- reference/17（工具地图）/ reference/18（本卡，能力矩阵）
- MISSION.md / NOTES.md（不变）
