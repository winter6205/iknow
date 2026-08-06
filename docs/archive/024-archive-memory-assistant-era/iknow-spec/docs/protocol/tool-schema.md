# iknow Tool Schema 草案 v0.1

> 阶段：Phase 1 协议层。本文是 ADR-v0.1-iknow.md §2 的**机器可消费契约**。
> 锁 ADR 已决部分；ADR §5 待定项标 `// TODO Phase 2`，不锁死。
> 对齐：ADR §2（4 tool）、§3（6 原则）。

---

## 通用约定

- 所有 tool 调用遵循标准 `tool_calls` 协议（不依赖模型私有思考字段）。
- `chunk_version` / `document_version`：溯源与审计的版本锚点，verify 失败若 `version_stale` 须重 retrieve。
- 枚举类型用 `|` 分隔，取值严格限定。
- `// TODO Phase 2` 标记项：当前协议不锁，待真实 eval 后回填。

---

## 1. kb_retrieve（检索）

```typescript
interface KbRetrieveInput {
  query: string;
  prior_chunks?: PriorChunk[]; // 二次检索轻量上下文，不传原文
  index?: "chunk" | "fact" | "both"; // 默认 'both'
  filter?: {
    doc_type?: string;
    time_range?: [string, string]; // ISO8601
    freshness_level?: "fresh" | "stale" | "any"; // A filter 在线实时治理检查
  };
}

interface PriorChunk {
  chunk_id: string;
  summary: string; // 来自上一轮 retrieve 返回的 summary，非 raw chunk
}

interface KbRetrieveOutput {
  chunks: Chunk[];
}

interface Chunk {
  chunk_id: string;
  doc_id: string;
  doc_type: string;
  summary: string; // 供 Agent 决策，全文承载于 messages 历史
  source_ref: string; // 原文定位（行号/offset）
  chunk_version: string;
  fact_status: "compiled" | "outdated" | "missing"; // 驱动 Agent 补编决策
}
```

**原则落地**：双索引（chunk + fact）并行 RRF 融合，**fact 只回 `chunk_id` 供排序，不暴露 fact 文本**（原则 1）。`filter.freshness_level` 由 A filter 在线实时判定（原则 3）。

---

## 2. kb_verify_citation（引用验证）

```typescript
interface KbVerifyCitationInput {
  claim: string; // Agent 从草稿拆出的单句陈述
  source_span: {
    chunk_id: string;
    quote?: string; // 原文片段
    offset?: [number, number]; // 或 offset 定位
  };
}

type Verdict = "supported" | "partially_supported" | "unsupported";

interface KbVerifyCitationOutput {
  verdict: Verdict; // 纯三态，无 confidence 连续值
  evidence_span?: string; // unsupported 时回写"最接近但不支撑"的片段
  chunk_version: string;
  // version_stale: 若 chunk_version 失效，返回此信号，Agent 换最新 version 重 retrieve
}
```

**原则落地**：纯三态驱动决策（重试/换策略/承认不知道），不扩 stale（治理状态由 `kb_governance` 独立查）。verify 永远看原文 chunk，不引 fact（原则 1/2）。

`// TODO Phase 2`：verify 一次验证一个 claim 还是一批（`verify 调用粒度`，ADR §5）。

---

## 3. kb_compile（知识编译）

```typescript
interface KbCompileInput {
  doc_id: string;
  content?: string; // Agent 补编时提供；后台 pipeline 可不传
  force?: boolean; // 强制重编译
  content_hash: string; // 强制：防 Agent 重复编译
  document_version: string; // 版本绑定
}

interface CompiledFact {
  entity: string;
  attributes: { key: string; value: string }[];
  source_span: string;
  source_chunk_id: string;
  source_doc_id: string;
  chunk_version: string; // 每个 fact 自带，检索层直接读建索引
}

type CompileStatus = "ok" | "partial" | "failed";

interface KbCompileOutput {
  facts: CompiledFact[];
  compile_status: CompileStatus;
  hallucination_flag?: boolean; // 供 eval/人工抽检，非运行时拦截
}
```

**原则落地**：Agent 主动补编为主 + 后台 pipeline 补编。fact 自带 `source_chunk_id` + `chunk_version`，版本天然绑定（原则 6）。

---

## 4. kb_governance（治理查询，B 定位独立 tool）

```typescript
type GovernanceAction =
  "check_freshness" | "detect_conflict" | "snapshot_status";
type GovernanceStatus = "ok" | "stale" | "conflict";

interface KbGovernanceInput {
  action: GovernanceAction;
  doc_id?: string;
  chunk_id?: string;
}

interface KbGovernanceOutput {
  status: GovernanceStatus;
  snapshot_id: string; // = hash({doc_id, document_version, check_type, result, ts})
  checked_at: string; // ISO8601
  chunk_version?: string;
}
```

**原则落地**：B 定位独立 tool，Agent 多跳/冲突/用户问"最新吗"时主动调。snapshot_id 含 `document_version` 满足版本一致性（原则 2/6）。G2 标签必填：答案发出前必须有 governance 标签（原则 4）。

---

## 5. 枚举与结构汇总（锁定量）

| 项               | 取值                                                        | 来源     |
| ---------------- | ----------------------------------------------------------- | -------- |
| Verdict          | `supported` \| `partially_supported` \| `unsupported`       | ADR §2.2 |
| fact_status      | `compiled` \| `outdated` \| `missing`                       | ADR §2.1 |
| GovernanceAction | `check_freshness` \| `detect_conflict` \| `snapshot_status` | ADR §2.4 |
| GovernanceStatus | `ok` \| `stale` \| `conflict`                               | ADR §2.4 |
| index            | `chunk` \| `fact` \| `both`（默认 both）                    | ADR §2.1 |
| prior_chunks     | `{chunk_id, summary}[]`                                     | ADR §2.1 |
| snapshot_id      | `hash({doc_id, document_version, check_type, result, ts})`  | ADR §2.4 |

**未锁定量（TODO Phase 2）**：

- `prior_chunks.summary` 生成方（verify 出参 or retrieve 内部摘要）
- verify 调用粒度（单 claim 逐条 or 多 claim 一批）
- 各 tool 的 error code 规范（Phase 3 定义）

---

## 6. 与 ADR 的对应

| Schema 节             | ADR 对应          |
| --------------------- | ----------------- |
| §1 通用约定           | §3 原则 1/2/3/4/6 |
| §2 kb_retrieve        | §2.1 + 原则 1/3   |
| §3 kb_verify_citation | §2.2 + 原则 1/2   |
| §4 kb_compile         | §2.3 + 原则 6     |
| §5 kb_governance      | §2.4 + 原则 2/4/6 |

> 本文为草案 v0.1，锁 ADR 已决部分。Phase 2 eval 后回填 TODO 项，Phase 3 补 error code 与实现层细节。
