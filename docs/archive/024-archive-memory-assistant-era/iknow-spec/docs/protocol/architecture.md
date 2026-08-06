# iknow 架构图与数据流（协议层 v0.1）

> 阶段：Phase 1 协议层。本文只描述 **tool 编排关系与数据流**，不画 gbrain 内部类结构（Phase 3 实现层）。
> 对齐：ADR-v0.1-iknow.md §2（4 tool 协议）、§3（6 原则）。

---

## 一、系统架构图

```mermaid
flowchart TD
    U[用户 Query] --> L["Agent Loop<br/>(max_hops=5, 护栏)"]
    L -->|"① kb_retrieve(query, prior_chunks?, filter?)"| R["kb_retrieve"]
    R -->|"双索引并行 RRF 融合<br/>chunk + fact(仅回 chunk_id)"| RRF["RRF 融合 (k=60)"]
    RRF -->|"Top-K chunks<br/>含 fact_status"| L
    L -->|"② kb_verify_citation(claim, source_span)"| V["kb_verify_citation"]
    V -->|"纯三态 verdict<br/>supported/partially/unsupported"| L
    L -->|"③ kb_compile(doc_id, content_hash)"| C["kb_compile"]
    C -->|"facts[] 回链 chunk_version"| L
    L -->|"④ kb_governance(action, doc_id?)"| G["kb_governance"]
    G -->|"snapshot_id 含 document_version"| L
    L -->|"答案 + source_span + snapshot_id<br/>(G2 标签必填)"| U

    subgraph 治理实时检查
        R -. "A filter 在线实时<br/>过期/权限降权或剔除" .-> R
        G -. "B 定位独立 tool<br/>Agent 主动查" .-> G
    end
```

**读图要点**：

- Agent Loop 是中枢，4 tool 都是它调用的叶子节点，无 tool 间直接调用（除 `kb_compile` 产出供 `kb_retrieve` 索引使用，属后台数据流，非 loop 内调用）。
- 治理有两路：检索前 `kb_retrieve` 的 A filter 在线实时检查（不占 tool 名额）+ Agent 主动调 `kb_governance`（B 定位）。
- 溯源三层在 loop 出口闭合：claim → source_span（verify）→ snapshot_id（governance）。

---

## 二、单次问答数据流（时序）

```mermaid
sequenceDiagram
    participant U as 用户
    participant A as Agent Loop
    participant R as kb_retrieve
    participant V as kb_verify_citation
    participant G as kb_governance

    U->>A: query
    A->>R: ① retrieve(query, filter)
    R-->>A: chunks[chunk_id, doc_id, fact_status, chunk_version]
    Note over A: 拆 claim（单句）
    A->>V: ② verify(claim, source_span)
    V-->>A: verdict=supported / partially / unsupported
    alt verdict = unsupported
        A->>R: ① retrieve(换策略, prior_chunks)
        R-->>A: 新 chunks
        A->>V: ② verify(新 claim, 新 span)
    end
    A->>G: ③ governance(snapshot_status, doc_id)
    G-->>A: snapshot_id, status=ok/stale/conflict
    A-->>U: 答案 + [source_span] + snapshot_id
    Note over U,A: G2 必填：无 snapshot_id 不返回用户
```

---

## 三、双索引检索内部流（kb_retrieve 封装）

```mermaid
flowchart LR
    Q[query] --> BM25[BM25 Top-50]
    Q --> VEC[向量检索 Top-50]
    BM25 --> RRF[RRF 融合 k=60]
    VEC --> RRF
    RRF --> RER[Cross-Encoder Rerank<br/>Top-20 → Top-5]
    RRF -. "fact 索引仅贡献排序分<br/>不暴露 fact 文本" .-> RRF
    RER --> OUT[chunks: chunk_id + summary<br/>+ source_ref + chunk_version + fact_status]
```

**原则落地**：fact 索引只回 `chunk_id` 供排序，绝不将 fact 文本注入 Agent 上下文或 verify 输出层（ADR 原则 1）。

---

## 四、溯源三层闭环（审计视角）

```mermaid
flowchart TD
    CLAIM[claim 单句事实陈述] --> SP["① source_span<br/>(原文级: chunk_id + quote/offset)"]
    SP --> VER["kb_verify_citation 判定 supported"]
    VER --> SNAP["② governance snapshot_id<br/>(审计级: 含 document_version)"]
    SNAP --> ANS["答案发出<br/>G2 标签必填"]
    SP -. "verify 失败" .-> LOOP["抛回 Agent<br/>重试/换策略/承认不知道"]
```

---

## 五、多跳场景（hops 护栏示意）

```mermaid
flowchart TD
    Q[跨文档问题] --> H1["hop1: retrieve(维度A)"]
    H1 --> D1[chunks_A]
    D1 --> H2["hop2: retrieve(维度B, prior_chunks=[A摘要])"]
    H2 --> D2[chunks_B]
    D2 --> MERGE["Agent 合并两维度<br/>各自溯源"]
    MERGE --> OUT[答案 + [span_A][span_B] + [snap_A][snap_B]]
    H2 -. "hops>5" .-> STOP["强制返回<br/>'无法确认' + 已检索来源"]
```

**护栏口径**（ADR §4）：hops 只计 Agent 主动 retrieve/verify 探索步；governance 注入、补编后自动重检索属基础设施动作，不计入。超 `max_hops=5` 强制"无法确认"。

---

## 六、图与 ADR 的对应关系

| 图               | 对应 ADR                       |
| ---------------- | ------------------------------ |
| 一、系统架构图   | §2 四 tool + §3 原则 2/3       |
| 二、单次问答时序 | §2.1–2.4 调用顺序 + 原则 4(G2) |
| 三、双索引内部流 | §2.1 双索引 RRF + 原则 1       |
| 四、溯源三层     | §3 原则 2                      |
| 五、多跳护栏     | §3 原则 5                      |

> 本文为协议层心智模型，gbrain 内部实现（类结构、索引存储、SDK 接入）属 Phase 3，不在本图范围。
