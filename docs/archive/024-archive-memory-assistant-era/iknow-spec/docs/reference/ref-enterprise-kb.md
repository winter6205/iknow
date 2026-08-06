# 企业知识库 Agent 设计基线 v1.0

> 基于 gbrain 做检索与治理增强，形态为企业知识库 **Agent**（非纯 RAG pipeline）。
> 本文件为后续开发的**唯一设计基线**，与 `../protocol/ADR-v0.1-iknow.md` 对齐。
> 凡 ADR 已决事项，本文直接采用；未决事项标注「待 Phase 2/3」，不编造数字。

---

## 一、项目定位

基于开源知识库框架（gbrain）改造企业知识问答 Agent，通过 **4 个工具**实现可溯源的企业问答：

- `kb_retrieve`：双索引（chunk + fact）并行检索，fact 只影响排序，不暴露给 Agent
- `kb_verify_citation`：claim 级引用验证（纯三态），永远看原文不引 fact
- `kb_compile`：知识编译（Agent 补编为主 + 后台 pipeline）
- `kb_governance`：治理查询（B 定位独立 tool，实时判定新鲜度/冲突）

重点解决四个工程问题：

1. **分块策略评测**：不同分块策略的召回率差异
2. **知识编译**：原始文档 → 结构化事实，提升召回质量
3. **混合检索 + 引用溯源**：BM25 + 向量 + Reranker + claim-level grounding
4. **知识治理**：过期检测、冲突检测、增量索引

**形态决策**：采用 Agent 架构（agent loop + tool calling），理由 A/B/C/D 全成立（多跳问答、动态工具编排、不确定性任务、多轮记忆）。详见 ADR §1。

---

## 二、分块策略对比评测

### 2.1 问题

不同分块策略对召回率影响巨大：

- 固定长度分块：可能切断语义完整的段落
- 按段落分块：段落长度不一致，影响检索质量
- 混合策略：需要评测验证

### 2.2 三种分块策略

**策略 1：固定长度分块**

- 每 512 token 切一刀
- 优点：实现简单
- 缺点：可能切断语义完整的段落

**策略 2：按段落分块**

- 按 `\n\n` 或标题切分
- 优点：保持段落语义完整
- 缺点：段落长度不一致

**策略 3：混合策略（推荐）**

- 优先按段落切分
- 超长段落（> 1000 token）按句子边界二次切分
- 表格/代码块保持完整
- 短段落（< 200 token）向前合并

### 2.3 评测方案

**测试集构建**：

- 200 条 QA 对
- **来源**：人工标注（不是 LLM 生成）
- **标注方式**：
  - 问题：来自真实用户查询
  - 答案：人工撰写
  - relevant_chunks：人工标注答案所在的 chunk id
- **多跳问题**：标注所有相关 chunk（不是只标一个）
- **按文档类型分层评测**：表格、代码、制度文档、FAQ

**评测指标**：

**检索层指标**：

- Hit@K（K=1,3,5,10）：Top-K 结果中包含正确答案的比例
- MRR（Mean Reciprocal Rank）：第一个正确答案的排名倒数的平均值
- nDCG@K：归一化折损累积增益

**生成层指标**：

- Answer Correctness：答案是否正确（人工评测）
- Faithfulness：答案是否忠实于检索到的文档（人工评测）
- Citation Coverage：答案中有多少比例的句子有引用

**评测流程**：

```
1. 加载测试集（200 条 QA）
2. 对每种分块策略：
   a. 对文档进行分块
   b. 对每个问题，检索 Top-10 chunks
   c. 计算 Hit@K、MRR、nDCG
3. 对比三种策略的指标
4. 选择最优策略
```

### 2.4 评测数据集示例

```json
{
  "id": "qa-001",
  "question": "公司的退款政策是什么？",
  "answer": "公司退款政策为 30 天内可全额退款。",
  "relevant_chunks": ["chunk-123", "chunk-456"],
  "doc_type": "policy",
  "difficulty": "easy"
}
```

### 2.5 评测结果

**状态：待 Phase 2 真实 eval 回填。**

原初稿曾给出「混合策略 Hit@5=0.78」等假设值，已被 ADR 判定为不可作为门禁——评测数字须由真实标注集运行后得出，不在基线阶段锁定。

---

## 三、知识编译（辅助索引）

### 3.1 问题

原始 RAG 检索到的 chunk 噪音多：

- 同一个事实在多篇文档中重复出现
- 文档中有大量铺垫、过渡、修辞
- 检索到的 chunk 信息密度低，LLM 需要从中提取关键信息

### 3.2 知识编译方案

**核心思路**：在文档入库时，做一次知识编译，提取结构化事实。

**编译流程**：

```
原始文档
  ↓
LLM 提取核心事实（entity, attribute, value）
  ↓
结构化存储（JSON/表格）
  ↓
回链原文 span（保证可追溯）
```

**编译示例**：

**原文**：

```
公司的退款政策为 30 天内可全额退款。如果超过 30 天，只能退 50%。
```

**编译后**：

```json
{
  "entity": "退款政策",
  "attributes": [
    { "key": "全额退款期限", "value": "30 天" },
    { "key": "超期退款比例", "value": "50%" }
  ],
  "source_span": "原文第 1 行",
  "source_doc_id": "doc-001"
}
```

### 3.3 双索引架构

**关键设计**：知识编译作为**辅助索引**，不是替代原文。

```
query
  ↓
┌─────────────────────────────────────┐
│ 检索层（双索引并行，封装于 kb_retrieve）│
│                                     │
│ Index A: 原文 chunk index            │
│   → 保证可追溯、可审计              │
│                                     │
│ Index B: compiled facts index        │
│   → 提升结构化事实召回              │
│   → 每条 fact 回链原文 span         │
│   → 仅用于排序，fact 文本不暴露 Agent │
└─────────────────────────────────────┘
  ↓
RRF 融合 → Rerank → 注入 LLM
  ↓
生成答案（回链原文 span，不引用编译事实）
```

**为什么用双索引**：

- 编译事实可能引入幻觉（LLM 提取错误）
- 最终答案必须回链原文 span，保证可追溯
- 编译事实只用于提升召回排序，不作为最终证据

> **与 ADR 对齐**：fact 索引只回 `chunk_id` 供排序，绝不将 fact 文本注入 Agent 上下文或 verify 输出层。verify 永远看原文 chunk。

### 3.4 评测方案

**对比实验**：

- 基线：纯 chunk 检索
- 实验：双索引检索（chunk + compiled facts）

**评测指标**：

- Hit@K、MRR、nDCG（检索层）
- Answer Correctness、Faithfulness（生成层）
- **编译幻觉率**：编译事实与原文不一致的比例

**预期结果**：

- 双索引检索的 Hit@5 提升幅度待 Phase 2 真实 eval 回填
- 编译幻觉率目标 < 5%（通过人工抽检验证）

---

## 四、混合检索 + Reranker + claim-level 引用溯源

### 4.1 混合检索方案

**检索流程**（封装于 `kb_retrieve` 内部，Agent 不感知细节）：

```
query
  ↓
BM25 检索（Top-50）
  ↓
向量检索（Top-50）
  ↓
RRF 融合（k=60）
  ↓
Cross-Encoder Reranker（Top-20 → Top-5）
  ↓
注入 LLM
```

**RRF 融合公式**：

```
RRF_score(d) = Σ 1 / (k + rank_i(d))
```

其中 k=60 是平滑参数，rank_i(d) 是文档 d 在第 i 个检索器中的排名。

### 4.2 claim-level 引用溯源

**问题**：传统引用溯源只是格式检查（检查是否有 `[1]`），不检查内容是否真的被来源支持。

**claim-level grounding 方案**（对应 `kb_verify_citation` 工具）：

```
答案
  ↓
拆分成 claims（每个 claim 是一个独立的事实陈述）
  ↓
对每个 claim，找到支持的 source span（Agent 指定，非 NLI 自行猜测）
  ↓
用 NLI 模型判断 claim 是否被 source span 支持
  ↓
生成 grounded answer（每个 claim 标注来源）
```

**工具契约（纯三态，无连续 confidence 值）**：

入参：

- `claim`：Agent 从草稿拆出的**单句**陈述
- `source_span`：Agent **指定**的原文片段（chunk_id + quote 或 offset）

出参：

- `verdict`：三选一
  - `supported`：指定 span 明确支撑
  - `partially_supported`：部分支撑有缺口
  - `unsupported`：指定 span 不支撑（同时回写 `evidence_span` 指出最接近但不支撑的片段）
- `chunk_version`：验证所基于的 chunk 版本

**示例**：

**答案**：

```
公司的退款政策为 30 天内可全额退款 [1]。如果超过 30 天，只能退 50% [1]。
```

**claim-level grounding 结果**：

```json
[
  {
    "claim": "公司的退款政策为 30 天内可全额退款",
    "source_span": "doc-001 第 1 行",
    "verdict": "supported",
    "chunk_version": "v3"
  },
  {
    "claim": "如果超过 30 天，只能退 50%",
    "source_span": "doc-001 第 1 行",
    "verdict": "supported",
    "chunk_version": "v3"
  }
]
```

> **与 ADR 对齐**：原初稿使用 `entailment > 0.7 → supported` 并附 `confidence: 0.95/0.92` 连续值，已被 ADR §2.2 推翻。Agent 读不懂 0.95 这类连续值，纯三态直接驱动决策（重试/换策略/承认不知道）。NLI 模型选型：`cross-encoder/nli-deberta-v3-base`，阈值判定为 entailment 即 supported。

### 4.3 评测方案

**评测指标**：

- **Citation Coverage**：答案中有多少比例的句子有引用
- **Citation Accuracy**：引用的内容是否真的支持 claim
- **Faithfulness**：答案是否忠实于检索到的文档

**评测流程**：

```
1. 加载测试集（200 条 QA）
2. 对每个问题：
   a. 检索 Top-5 chunks
   b. 生成答案
   c. 拆分成 claims
   d. 对每个 claim，找到 source span
   e. 用 NLI 模型判断是否支持
   f. 计算 Citation Coverage 和 Citation Accuracy
3. 人工抽检 20 条，验证 NLI 模型的准确性
```

**预期结果**：

- Citation Coverage / Citation Accuracy / 人工抽检准确率的具体阈值**待 Phase 2 真实 eval 回填**，不在基线阶段锁定。

---

## 五、知识治理

### 5.1 过期检测

**问题**：企业知识库中的文档会过时（如政策更新、价格变化）。

**方案**（对应 `kb_governance` 的 `check_freshness` 动作 + `kb_retrieve` 的 A filter 在线实时检查）：

按知识类型配置 freshness policy：

```typescript
interface FreshnessPolicy {
  docType: "policy" | "api-doc" | "price" | "announcement" | "general";
  ttlDays: number;
  decayFactor: number; // 过期后相似度乘数
}

const policies: FreshnessPolicy[] = [
  { docType: "policy", ttlDays: 90, decayFactor: 0.5 },
  { docType: "api-doc", ttlDays: 180, decayFactor: 0.7 },
  { docType: "price", ttlDays: 30, decayFactor: 0.3 },
  { docType: "announcement", ttlDays: 60, decayFactor: 0.6 },
  { docType: "general", ttlDays: 365, decayFactor: 0.8 },
];
```

**过期处理**：

- 未过期：正常检索
- 刚过期（< 2 × ttlDays）：相似度 × decayFactor（由 `kb_retrieve` 的 A filter 在线实时判定，读同步视图，不依赖后台 job）
- 严重过期（> 2 × ttlDays）：从索引中移除，但保留原文（可恢复）

> **与 ADR 对齐**：原初稿将过期检测设计为「后台定时任务」，ADR 升级为「检索前实时检查」（消除延迟窗），后台 job 退化为预计算缓存，非权威源。Agent 也可主动调 `kb_governance(check_freshness)` 判定文档最新性。

### 5.2 冲突检测

**问题**：企业知识库中可能存在冲突信息（如不同文档对同一政策的描述不一致）。

**方案**（对应 `kb_governance` 的 `detect_conflict` 动作，B 定位独立 tool）：

**Hard conflict（阻断发布）**：

- 价格、版本号、政策期限等强结构字段冲突
- 例：文档 A 说"退款 30 天"，文档 B 说"退款 60 天"

**Soft conflict（进入审核）**：

- 语义可能冲突（需要人工判断）
- 例：文档 A 说"建议用 TypeScript"，文档 B 说"推荐用 JavaScript"

**冲突检测流程**：

```
新文档入库
  ↓
提取结构化字段（价格、日期、版本号等）
  ↓
与已有文档比对
  ↓
发现 hard conflict → 阻断发布，通知用户
发现 soft conflict → 标记冲突，进入审核队列
无冲突 → 正常入库
```

> **与 ADR 对齐**：原初稿冲突检测为「入库时拦截」，ADR 改为 Agent 查询时通过 `kb_governance(detect_conflict)` 实时判定，更灵活。Agent 发现冲突时不自行裁决，暴露冲突 + snapshot_id 交用户/人工。

### 5.3 增量索引

**问题**：文档更新后，全量重建索引成本高。

**方案**：基于内容 hash 的增量索引。

```typescript
interface Document {
  id: string;
  content: string;
  contentHash: string; // SHA-256
  updatedAt: Date;
}

async function indexDocument(doc: Document) {
  const existing = await getDocument(doc.id);
  if (existing && existing.contentHash === doc.contentHash) {
    return; // 内容未变，跳过
  }
  await deleteChunks(existing.id);
  await insertChunks(doc);
  await updateDocument(doc);
}
```

**增量索引的优势**：

- 只重新索引变化的文档
- 节省 90%+ 的索引时间
- 保持索引一致性

> **与 ADR 对齐**：`kb_compile` 入参强制 `content_hash` 防 Agent 重复编译，增量逻辑在后台 pipeline，Agent 补编复用 hash 去重。

### 5.4 评测方案

**评测指标**：

- **过期检测准确率**：正确识别过期文档的比例
- **冲突检测召回率**：正确识别冲突文档的比例
- **增量索引性能**：索引时间对比（全量 vs 增量）

**预期结果**：

- 过期检测准确率、冲突检测召回率、增量索引时间占比的具体阈值**待 Phase 2 真实 eval 回填**。

---

## 六、可观测性（tracing 层）

### 6.1 RAG Trace 记录

**记录内容**：

- query
- query rewrite 结果
- BM25 topK
- vector topK
- RRF fused topK
- rerank score
- 最终注入上下文
- 每个 answer claim 对应 source span
- citation coverage
- latency
- token cost
- 无答案率

### 6.2 Trace 存储方案

**存储选型**：

- **本地开发**：SQLite
- **生产环境**：ClickHouse

**采样策略**：

- 默认全量记录
- 可配置为 10% 采样（降低成本）

**保留策略**：

- 7 天热存储（快速查询）
- 30 天冷存储（归档查询）
- 之后归档到对象存储（S3/OSS）

**敏感信息脱敏**：

- 用户查询中的敏感信息自动替换为 `[REDACTED]`
- 文档内容默认不记录到 trace
- 可选：记录完整日志（需显式开启，用于调试）

### 6.3 评测方案

**评测目标**：验证可观测性是否能有效支撑问题诊断，同时不显著影响性能。

**评测维度**：

1. **问题诊断效率**：诊断时间缩短比例（有 trace vs 无 trace）
2. **Trace 完整性**：关键事件覆盖率
3. **性能开销**：trace 记录增加的延迟与存储

> **状态**：可观测性属生产运维，Phase 3 细化。ADR 溯源三层（source_span / snapshot_id）已为 trace 留锚点。

---

## 七、安全设计

### 7.1 问题

企业知识库可能包含敏感信息：

- 内部政策、价格、客户数据
- API key、密码
- 用户查询中的个人信息

### 7.2 安全策略

**访问控制**：

```typescript
interface AccessPolicy {
  allowedRoles: string[];
  allowedDocTypes: string[];
  requireApprovalFor: string[];
}

const defaultPolicy: AccessPolicy = {
  allowedRoles: ["employee", "manager"],
  allowedDocTypes: ["policy", "api-doc", "general"],
  requireApprovalFor: ["price", "customer-data"],
};
```

**日志脱敏**：

- 用户查询中的敏感信息自动替换为 `[REDACTED]`
- 文档内容默认不记录到 trace
- 可选：记录完整日志（需显式开启，用于调试）

**审计日志**：

- 所有查询记录到 `~/.kb/audit-log.json`
- 记录内容：query、timestamp、user_id、retrieved_docs

### 7.3 安全与治理的衔接（待 Phase 3 决策）

原初稿 `requireApprovalFor`（price / customer-data 需审批）与 ADR 治理 B 定位（`kb_governance` 独立 tool）的衔接方式尚未确定，Phase 3 需补决策：

- 审批判定落在 `kb_retrieve` 的 `filter` 层（A filter 在线检查），还是
- `kb_governance` 的 `requireApprovalFor` 动作

**鉴权模型**（待 Phase 3）：当前 4 tool 协议未含调用者角色，Phase 3 在 tool 封装层统一注入 `caller_role`，不改变协议拓扑。

### 7.4 安全审计

**定期审计**：

- 每月检查一次访问日志
- 检查是否有异常查询（如大量查询敏感文档）
- 检查是否有未授权访问

---

## 八、成本分析

### 8.1 Token 消耗估算

**假设**：

- 每个查询平均检索 5 个 chunks
- 每个 chunk 平均 500 token
- 每天 100 个查询

**估算**：

- 单查询：5 × 500 = 2500 token（检索上下文）+ 1000 token（生成）= 3500 token
- 每天：100 × 3500 = 350,000 token
- 每月：30 × 350,000 = 10,500,000 token

**成本**（以 GPT-4 计价示例，实际模型选型待 Phase 2 定）：

- 输入：$10 / 1M token → 10.5M × $10/1M = **$105**
- 输出：$30 / 1M token → 10.5M × $30/1M = **$315**
- 每月成本：**$420**（输入与输出分开计算，原初稿 $210 为错误计算）

> **与 ADR 对齐**：原初稿 `10.5M × ($10+$30)/2 = $210` 有误，输入输出应分开计。成本选型 Phase 2 定，本节仅作示例。

### 8.2 成本优化策略

**模型路由**：

- 知识编译：用小模型，成本降低 10×
- 检索排序：用规则或小模型
- 答案生成：用大模型

**缓存策略**：

- 相似查询的检索结果缓存
- 热门文档的编译事实缓存

**批量处理**：

- 多个查询合并处理，减少 API 调用次数

> **状态**：模型路由与 ADR「不锁模型」假设需 Phase 3 协调。

---

## 九、失败案例集

### 9.1 案例 1：知识编译引入幻觉

**现象**：编译事实与原文不一致，导致答案错误。

**根因**：LLM 提取事实时出错（如把"30 天"提取成"3 天"）。

**修复**（与 ADR 机制对齐）：

- 编译事实必须回链原文 span
- 最终答案必须引用原文，不引用编译事实（`kb_verify_citation` 看原文 chunk，不引 fact）
- 定期人工抽检编译质量（幻觉率目标 < 5%）

### 9.2 案例 2：引用溯源只是格式检查

**现象**：答案中有 `[1]`，但引用的内容不支持 claim。

**根因**：传统引用溯源只检查格式，不检查内容。

**修复**（与 ADR 机制对齐）：

- 使用 claim-level grounding（`kb_verify_citation` 纯三态）
- 用 NLI 模型判断 Agent **指定**的 source span 是否支持 claim，而非格式检查
- Citation Accuracy 目标待 Phase 2 回填

### 9.3 案例 3：过期文档仍然被检索到

**现象**：用户查询到过期的政策文档，导致答案错误。

**根因**：没有过期检测机制。

**修复**（与 ADR 机制对齐）：

- 按知识类型配置 freshness policy
- `kb_retrieve` 的 A filter 在线实时检查（过期降权/剔除），比原初稿「定时检测」更彻底
- 严重过期文档从索引移除但保留原文

---

## 十、产出物

| 产出           | 内容                                                              | 用途           | 阶段            |
| -------------- | ----------------------------------------------------------------- | -------------- | --------------- |
| 架构决策记录   | ../protocol/ADR-v0.1-iknow.md（形态 + 4 tool 协议 + 6 原则）      | 协议层唯一权威 | Phase 1 ✅      |
| 工具契约       | ../protocol/tool-schema.md（4 tool 结构化入参/出参）              | 开发直接落地   | Phase 1（待补） |
| 原文档映射     | ../protocol/mapping-ref-to-adr.md（原稿 → ADR 对照）              | 溯源历史       | Phase 1 ✅      |
| 纸面推演       | ../protocol/walkthrough-b-test.md（6 构造 query 验证）            | 协议逻辑验证   | Phase 1 ✅      |
| 评测数据集     | 200 条人工标注 QA 对                                              | 证明评测可信   | Phase 2         |
| 评测报告       | Hit@K、MRR、nDCG、Answer Correctness、Citation Accuracy、门禁阈值 | 证明改进效果   | Phase 2         |
| 代码仓库       | 核心模块实现 + 单元测试                                           | 证明可运行     | Phase 3         |
| CI 配置        | 知识编译、检索、引用溯源自动运行                                  | 证明可持续集成 | Phase 3         |
| Trace 存储方案 | 存储、查询、采样、保留策略                                        | 证明可观测性   | Phase 3         |
| 安全策略文档   | 访问控制、日志脱敏、审计规则                                      | 证明生产安全   | Phase 3         |
| 成本分析报告   | 模型调用次数、token 消耗、真实成本                                | 证明经济可行   | Phase 2/3       |
| README         | 项目介绍、架构图、快速开始                                        | 项目文档       | Phase 3/4       |
