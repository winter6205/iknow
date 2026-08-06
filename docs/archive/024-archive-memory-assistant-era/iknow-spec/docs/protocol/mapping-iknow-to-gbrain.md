# iknow ↔ gbrain 适配映射（Phase 3 输入素材）

> 阶段：Phase 1 协议层已决 + gbrain v0.42.26.0 源码已读。本文是 **Phase 3 实现层的输入素材**，不是已决产出。
> 映射基于真实源码符号（已通过 codebase-memory 检索坐实），不修改 ADR §2/§3 任何已决项。
> 源端契约：ADR-v0.1-iknow.md + tool-schema.md v0.1。目标端：gbrain-src（v0.42.26.0）。

---

## 1. 总表：4 tool → gbrain 能力归属

| iknow 工具           | gbrain 原生能力                                                                              | 适配方式                                                   | 阶段归属                 |
| -------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| `kb_retrieve`        | `operations.ts` → `hybridSearch` + `rrfFusion`；`vector-index.ts` → `chunkEmbeddingIndexSql` | tool wrapper，双索引直接映射；A filter 在线治理需额外 hook | Phase 3 自研 wrapper     |
| `kb_verify_citation` | `eval-contradictions/judge.ts` → `judgeContradiction(JudgeInput)`                            | 输入/输出适配，三态 verdict 已对齐                         | Phase 3 适配层           |
| `kb_compile`         | `facts/backstop.ts` → `runFactsBackstop` + `engine.insertFact` / `upsertFactRow`             | 后台 pipeline 无需 wrapper；agent-requested 编译需工具封装 | Phase 3 封装             |
| `kb_governance`      | `schema-pack/detect.ts` → `runDetect` + `PageVersion` + `citation.validate`                  | **独立 tool 封装，需自研 snapshot 哈希层**                 | Phase 3 自研（最大 gap） |

---

## 2. 逐 tool 映射

### 2.1 kb_retrieve ↔ hybridSearch + rrfFusion

**gbrain 真相**（已读符号）：

- `hybridSearch` 在 `operations.ts`，并行跑 BM25 + 向量，产出 `SearchResult[]`。
- `rrfFusion` 做 reciprocal rank fusion，融合多路排序。
- `vector-index.ts` 的 `chunkEmbeddingIndexSql` / `applyChunkEmbeddingIndexPolicy` 表明**嵌入按 chunk 粒度建索引**，fact 是附加在 chunk 上的元数据（非独立 embedding 表）。
- 返回类型 `SearchResult` / `Chunk` 含 `chunk_id` / `doc_id` / `source_ref` / `version` 字段，可直接复用为 iknow `Chunk`。

**映射**：

- iknow `index: chunk|fact|both` → gbrain 双路检索后 RRF 融合；fact 只回 `chunk_id` 由 `citation.validate` / `upsertFactRow` 返回形状约束（fact 文本不暴露给 Agent，符合原则 1）。
- iknow `filter.freshness_level` → **A filter 在线实时治理**：gbrain 无现成"在线新鲜度过滤"原语，需在 wrapper 内读同步视图（pages 表的 `version` / `deleted_at`）做实时降权/剔除，不依赖后台 C 预计算（原则 3）。
- iknow `fact_status: compiled|outdated|missing` → 由 chunk 关联的 fact fence 状态推导，wrapper 内计算后填入出参。

**未决**：fact 索引是独立 `fact_embeddings` 表还是共享 chunk 表加 type 过滤——从 `applyChunkEmbeddingIndexPolicy` 看更可能是**嵌入按 chunk 粒度、fact 仅元数据附加**。Phase 3 实现时需确认 `hybridSearch` 内部 fact 路的具体表结构。

### 2.2 kb_verify_citation ↔ judgeContradiction

**gbrain 真相**（已读符号，`judge.ts`）：

```typescript
export interface JudgeInput {
  query: string;
  a: {
    slug: string;
    text: string;
    source_tier?: string;
    holder?: string | null;
    effective_date?: string | null;
  };
  b: {
    slug: string;
    text: string;
    source_tier?: string;
    holder?: string | null;
    effective_date?: string | null;
  };
  model: string;
  maxPairChars?: number;
  chatFn?: typeof chat;
  abortSignal?: AbortSignal;
}
export async function judgeContradiction(
  input: JudgeInput
): Promise<JudgeOutput>;
```

- 输入是**双陈述 a/b + effective_date（Lane A1）**，输出 `JudgeOutput`（三态 verdict + 置信度归一化 + 错误收集）。
- `effective_date` 语义对应 iknow `source_span` 中的版本锚点——gbrain 已原生支持版本感知矛盾检测。

**映射**：

- iknow `claim` + `source_span{chunk_id, quote|offset}` → gbrain `a.text`（claim）+ `a.slug`（chunk_id 映射）。
- iknow 三态 `supported|partially_supported|unsupported` ↔ gbrain `JudgeOutput` 三态枚举，需对齐取值名称（gbrain 内部用 `supported`/`contradicted`/`unknown` 类命名，适配层做枚举翻译，不引入 confidence 连续值——严守 ADR §2.2 纯三态）。
- **版本失效**：gbrain `JudgeOutput` 无 `version_stale` 标志。iknow 的 `version_stale` 信号需由 wrapper 在调用前比对 `chunk_version`，或交由 `kb_governance` 后置检查（见 §3 gap 1）。

**注意**：gbrain `judgeContradiction` 是**双陈述矛盾检测**原语，对应 iknow `kb_verify_citation` 的"引用是否支撑单 claim"需做语义收窄——verify 是 claim vs source_span 的支撑判定，judge 是 a vs b 的矛盾判定。适配层需把 verify 建模为"claim 陈述 vs 原文陈述"的一对 judge 调用，而非直接透传。

### 2.3 kb_compile ↔ runFactsBackstop + insertFact

**gbrain 真相**（已读符号，`facts/backstop.ts`）：

- `runFactsBackstop(parsedPage, ctx)` 是实时热内存管道：extract → resolve(entity slug) → dedup(cosine @ 0.95) → write fence → `engine.insertFact`。
- 双执行模式：`queue`（fire-and-forget，sync/put_page 用）/`inline`（await 真实计数，extract_facts MCP op 用）。
- `FactKind` / `FactVisibility`（`facts-fence.ts`）枚举映射到 iknow `fact_status`。
- `upsertFactRow`（`facts-fence.ts:356`）是 fence 行的原子 upsert，对应 iknow fact 的 `source_chunk_id` + `chunk_version` 绑定写入。

**映射**：

- iknow 后台 pipeline 补编 → 直接复用 `runFactsBackstop` 的 `queue` 模式，无需 wrapper。
- iknow Agent 主动补编（二为主）→ 封装为 tool，调用 `runFactsBackstop` 的 `inline` 模式或显式 `extract_facts` MCP op，返回 `{inserted, duplicate, superseded, fact_ids}` 作为 `compile_status` 依据。
- iknow `content_hash` 防重复编译 → gbrain dedup 已用 cosine 0.95，但 content_hash 是确定性去重，需在 wrapper 层额外维护（gbrain 无 content_hash 概念）。
- iknow `document_version` 绑定 → gbrain fact 通过 fence + `chunk_version` 原子切换（原则 6 已满足）。

### 2.4 kb_governance ↔ runDetect + PageVersion + 自研 snapshot 层

**gbrain 真相**（已读符号）：

- `schema-pack/detect.ts` → `runDetect(engine, opts)`：基于 `pages` 表的 type/null 分布做 schema 推断，返回 `total_pages` / `typed_pages` / `untyped_pages` / `prefixes[]` / `candidate`。这是**页面级版本与类型真相**来源之一。
- `PageVersion` 类型：chunk/page 的版本锚点，对应 iknow `chunk_version` / `document_version`。
- `citation.validate`：引用校验原语，可复用为 governance 的引用完整性检查。
- **gbrain 无独立 `snapshot_id` 概念**——这是最大 gap。

**映射**：

- iknow `action: check_freshness` → wrapper 读 `PageVersion` + `pages.version` 实时比对，输出 `status: ok|stale`。
- iknow `action: detect_conflict` → 复用 `judgeContradiction` 做跨 chunk 矛盾扫描 + `citation.validate` 引用校验。
- iknow `action: snapshot_status` → **自研**：`snapshot_id = hash({doc_id, document_version, check_type, result, ts})`，gbrain 无现成实现，Phase 3 需写封装层生成并存储。
- G2 标签必填（原则 4）→ wrapper 在答案发出前强制注入 governance 标签，gbrain 无此机制，需在 Agent loop 层实现。

---

## 3. 三个 gap 锚点结论

### gap 1：verify 判定原语

`judgeContradiction` 的 `JudgeInput` 已含 `effective_date`（Lane A1），满足 iknow 版本感知需求。但输出无 `version_stale` 标志。
**结论**：verify 时由 wrapper 主动比对 `chunk_version` 生成 `version_stale`；或交由 `kb_governance.check_freshness` 后置。建议 wrapper 前置比对（实时性更强，符合原则 3）。

### gap 2：fact 索引真相

`facts/backstop.ts` 的 `runFactsBackstop` 是**写入路径**；检索侧用 `hybridSearch` + fact 索引。从 `applyChunkEmbeddingIndexPolicy` / `chunkEmbeddingIndexSql` 看，**嵌入按 chunk 粒度，fact 是元数据附加**（非独立 fact_embedding 表）。
**结论**：iknow `index: fact` 实际映射为 chunk 表上的 fact 类型过滤 + fact fence 元数据，fact 文本不独立建向量。Phase 3 实现时需确认 `hybridSearch` 内部 fact 路的具体 SQL。

### gap 3：governance 零件

gbrain 无独立 governance tool，但有三类可拼装零件：

1. `schema-pack/detect.runDetect` — schema 自检
2. `citation.validate` — 引用校验
3. `PageVersion` + `pages.version` — 版本真相

**结论**：三者拼装成 iknow `kb_governance`，但需写一层封装（尤其 `snapshot_id` 哈希生成 + G2 标签注入）。这是 Phase 3 自研工作量最大的部分。

---

## 4. Phase 3 待决标注（与 ADR §5 对齐，不新增决策）

| 待决项                           | 本文结论                                                                   | ADR 归属            |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------- |
| verify 调用粒度（单 claim / 批） | judge 是双陈述原语，单 claim verify 需建模为 claim vs 原文一对调用         | ADR §5 TODO Phase 2 |
| prior_chunks.summary 生成方      | gbrain `SearchResult.summary` 可直接复用为 prior summary                   | ADR §5 TODO Phase 2 |
| gbrain 源码适配范围              | 本文已映射：retrieve/verify/compile 有原生能力，governance 需自研          | ADR §5 标注         |
| 鉴权模型                         | tool 加 role 入参，gbrain 无现成调用者角色概念                             | ADR §5 Phase 3      |
| 异步交互                         | 当前 loop 同步，gbrain `runFactsBackstop` queue 模式已支持 fire-and-forget | ADR §5 Phase 3      |

**本文不修改 ADR 任何已决项**（4 tool 协议、6 原则、纯三态、枚举取值均原样映射）。本文是 Phase 3 实现层的输入素材，待 Phase 3 消费后迭代。
