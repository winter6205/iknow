# iknow — 架构决策记录 v0.1

> 状态：雏形打磨阶段（协议层），未锁实现细节、未读源码、未定开发环境
> 配套文档：../reference/ref-enterprise-kb.md（原功能设计初稿，待后续重构为 Agent 形态）
> 参考输入：../reference/ref-agent-harness-production-guide.md（Agent harness 生产指南，governance 走 B 定位、不依赖模型私有思考字段等决策的来源依据）

---

## 1. 形态判定

**结论：Agent（非纯 RAG pipeline）。**

理由（A/B/C/D 全成立）：
- A. 多跳问答：用户问题需跨多个文档/事实拼接，Agent 动态决定先查什么再查什么
- B. 动态工具编排：检索策略、编译、溯源非固定顺序，Agent 按 query 类型选路径
- C. 不确定性任务：用户意图模糊时需先澄清或拆解再检索
- D. 记忆/个性化：多轮对话需记住上下文（追问、修正）

### 1.1 Agent vs Workflow 对比与回退条件

**对比维度**：

| 维度 | Agent（本项目采用） | Workflow（预定义链路） | 本项目判定 |
|------|---------------------|------------------------|-----------|
| 路径确定性 | 动态决定检索顺序 | 路径固定、可枚举 | A/B/C 成立 → 动态 |
| 多跳需求 | 跨文档/事实拼接，步数不固定 | 单链路，难扩展 | A 成立 → Agent |
| 工具顺序 | 按 query 类型选路径 | 固定编排 | B 成立 → Agent |
| 意图模糊处理 | 先澄清/拆解再检索 | 无澄清能力 | C 成立 → Agent |
| 多轮记忆 | 记住上下文追问修正 | 无状态 | D 成立 → Agent |
| 固定流程（如每日报告） | 过度设计 | 可靠可审计 | 若此类场景为主 → Workflow |
| 实时性 < 500ms | 难满足（LLM 延迟） | 预编译模板可满足 | 若硬实时 → Workflow |

**回退条件（何时放弃 Agent 退回 Workflow / 简化形态）**：

- **R1**：线上 query 分布统计显示 90%+ 为单轮、意图明确、路径固定 → 降为 prompt chaining，agent loop 过度设计
- **R2**：实时性硬约束 < 500ms 且无法接受 LLM 延迟 → 退化为纯检索 + 固定 prompt 模板
- **R3**：tool 数预期 > 8 或单任务 step > 10 → 按 lifecycle 阈值重新评估，拆子 agent 或退回 workflow

**结论**：当前 A/B/C/D 全成立，Agent 形态站得住；上述 R1/R2/R3 为监控触发线，触发后重新评估，不预设回退。

**模型假设（不锁具体模型）：**
- 支持标准 `tool_calls` + `messages` 历史传递上下文（不依赖任何模型私有思考字段，跨模型通用）
- 上下文窗口 ≥128K（主流 256K，留余量防长多跳 + 全文历史触顶）
- 注：MiniMax-M3 function-call 文档仅作参考，非绑定

---

## 2. Tool 集合（4 个，符合 ≤8 约束）

### 2.1 kb_retrieve（检索）
- 入参：`query` + 可选 `prior_chunks[{chunk_id, summary}]`（二次检索轻量上下文，不传原文）+ `index: chunk|fact|both`（默认 both）+ `filter{doc_type?, time_range?, freshness_level?}`
- 双索引（chunk + fact）并行 RRF 融合，**fact 只回 chunk_id 供排序，不暴露 fact 文本给 Agent**
- **A filter 在线实时治理检查**（读同步视图，不依赖后台 C 最终一致），过期/无权限文档降权或剔除
- 出参：`chunks[{chunk_id, doc_id, doc_type, summary, source_ref, chunk_version, fact_status}]`
  - `fact_status: compiled|outdated|missing` 驱动 Agent 补编决策（堵"无 fact 判定从哪来"链路缺口）
  - 全文承载于 messages 历史，防 context rot

### 2.2 kb_verify_citation（引用验证）
- 入参：`claim`（单句）+ `source_span{chunk_id, quote|offset}`（必须指向 chunk 原文，不允许指向 fact）
- 出参：`verdict: supported|partially_supported|unsupported` + `evidence_span`（unsupported 也回写"最接近但不支撑"片段）+ `chunk_version`
- **纯三态，不扩 stale**（治理状态不进 verify，由 governance tool 独立查）
- 版本失效返 `version_stale`，Agent 换最新 version 重 retrieve

### 2.3 kb_compile（知识编译）
- 定位：**Agent 主动补编为主（二为主）+ 后台 pipeline 补编**
- 入参：`doc_id` + `content?` + `force?` + 强制 `content_hash`（防 Agent 重复编译）+ `document_version`
- 出参：`facts[{entity, attributes[], source_span, source_chunk_id, source_doc_id, chunk_version}]` + `compile_status: ok|partial|failed` + `hallucination_flag?`（供 eval/人工抽检，非运行时拦截）
- 每个 fact 自带 `source_chunk_id` + `chunk_version`，检索层直接读建索引（映射责任单一，版本天然绑定）

### 2.4 kb_governance（治理查询）
- 定位：**B 定位独立 tool**，Agent 多跳/冲突/用户问"最新吗"时主动调
- 入参：`action: check_freshness|detect_conflict|snapshot_status` + `doc_id?` + `chunk_id?`
- 出参：`status: ok|stale|conflict` + `snapshot_id` + `checked_at` + `chunk_version?`
- `snapshot_id = hash({doc_id, document_version, check_type, result, ts})`（判定时生成，含 document_version 满足版本一致性；C job 退预计算缓存，非权威源）

---

## 3. 已决硬原则

1. **双索引只影响排序**，verify 永远看原文（企业零容忍）
2. **溯源三层闭环**：claim → source_span（原文级）→ governance(snapshot_id)（审计级）
3. **治理实时检查**：检索前在线判断新鲜度/冲突，后台 C 只做预计算缓存
4. **G2 标签必填**：答案发出前必须有 governance 标签（不依赖 Agent 自觉）
5. **多跳护栏**：协议层 `max_hops: 5` 粗略上限（具体数字 eval 阶段回填），超界强制返回"无法确认" + 已检索来源
6. **chunk/fact 索引同 document_version 原子切换**（不覆盖旧版本，防空窗）

---

## 4. 对抗性检查（已收敛）

对 7 个探索性漏洞的处置结论：**0 个需要修改 tool 协议**，仅 ADR 文字补全 + Phase 3 标注。

| 原漏洞 | 处置 | 理由 |
|--------|------|------|
| 版本切换瞬间脏数据 | 实现层双缓冲/读锁，不进协议 | 原子切换 + 读锁足够，协议不加状态 |
| G2 guard vs max_hops 死锁 | ADR 写清 hops 口径：只计 Agent 主动 retrieve/verify 探索步；guard 注入的 governance、补编后自动重检索属基础设施动作，不计入 | 口径问题非机制问题 |
| 补编消耗 hops 预算 | 同上口径；后台 pipeline 已覆盖常规文档，Agent 补编仅少数情况，天然有界 | 不需独立 max_compile 预算 |
| C 故障降级路径缺失 | ADR 标注"在线检查需定义超时降级路径，Phase 3 展开" | 运维阶段内容 |
| G2 粒度错位 | 写清：governance 查文档级（doc_id + snapshot_id），claim 级溯源由 verify 的 source_span 承载，二者不冲突 | 表述补全非修复 |
| 审计不可绕过 | ADR 写"G2 为必填字段，缺失不返回用户"（雏形写原则，机制 Phase 3） | 不设计序列化机制 |
| 版本切换后审计语义断链 | ADR 已知限制标注 | 说明项 |

---

## 5. 已知缺口（留 Phase 2+）

- eval 门禁具体数字（检索层/编译层/生成层/成本层 accept 阈值）、trajectory eval 设计
- 成本/latency 模型选型（等真实 payload）
- `prior_chunks.summary` 生成方（verify 出参 or retrieve 内部摘要）
- verify 一次验证一个还是多个 claim（调用粒度）
- gbrain 源码适配：哪些用原生能力、哪些自研 tool
- 开发环境（Python/TS、向量库、SDK 接入方式）
- **鉴权**：企业硬要求，当前 4 tool 协议未含调用者角色；tool 预留 role 上下文入口，模型 Phase 3 定义
- **异步交互**：当前 Agent Loop 为同步请求响应；企业可能需异步任务/通知，Phase 3 评估，不在当前 loop 模型内

### 5.1 原文档遗留标注（mapping-ref-to-adr.md 同步记录）

以下三项为原文档 `../reference/ref-enterprise-kb.md` 与 ADR 决策的偏差，已确认不修改本协议，仅留痕供 Phase 2/3 处理：

- **§4.2 confidence 连续值（已推翻）**：原文档 NLI 用 `entailment > 0.7 → supported` 并附 `confidence: 0.95/0.92` 连续值。ADR §2.2 已改为纯三态（`supported|partially_supported|unsupported`），不输出 confidence 数字——agent 读不懂 0.95，三段式直接驱动决策。原文档该节标注"错误待修"。
- **§8.1 成本计算错误（已修正数值）**：原文档 `10.5M × ($10+$30)/2 = $210/月` 有误，输入输出应分开计：输入 `10.5M × $10/1M = $105` + 输出 `10.5M × $30/1M = $315` = **$420/月**。成本选型 Phase 2 定，本协议不锁。原文档该节标注"错误待修"。
- **§7 安全衔接零留痕（Phase 3 待决）**：原文档 §7.2 `requireApprovalFor` 与 ADR 治理 B 定位（`kb_governance` 独立 tool）如何衔接未记录，Phase 3 需补决策。

---

## 6. 逻辑闭环确认

query 进 loop → retrieve（双索引 + 在线过滤）→ verify（三态 + 溯源锚点）→ governance（按需 + 审计快照）→ 答案三层溯源闭环。护栏（hops 口径 / G2 必填）已写清无死锁。雏形阶段自洽，无未决硬冲突。
