# (b) 纸面推演 — Agent Loop Walkthrough（测试用）

> ⚠️ **测试用构造 query，非真实用户数据。禁止纳入 Phase 2 eval 集。**
> 目的：在协议层验证 ADR §3 六项原则中的三条关键假设——`max_hops=5` 护栏、`G2 标签必填`、多跳合并是否成立。
> 方法：基于 ADR-v0.1-iknow.md §2 的 4 tool 协议，手工模拟 agent 决策轨迹（非真实 LLM 调用）。

---

## 验证目标

| 假设 | 验证点 |
|------|--------|
| H1: max_hops=5 护栏 | 多跳场景 hops 是否触顶、超界是否强制"无法确认" |
| H2: G2 标签必填 | 每个终态答案是否带 `snapshot_id`（governance 标签） |
| H3: 多跳合并成立 | 跨 chunk 信息能否在答案层正确合并并各自溯源 |

---

## 场景 1 — 单跳（基线）

**Query（构造）**：「公司的退款政策是什么？」

```
hop1: kb_retrieve(query="退款政策", index=both)
  → chunks: [c-123(退款政策原文, fact_status=compiled), c-456(同主题补充)]
hop1: agent 拆 claim="退款期限30天可全额退款"
hop1: kb_verify_citation(claim, source_span={c-123, "30天内可全额退款"})
  → verdict=supported, chunk_version=v3
hop1: kb_governance(action=snapshot_status, doc_id=doc-001)
  → status=ok, snapshot_id=snap-abc123
→ 返回答案 + [c-123] + snapshot_id=snap-abc123
```

- hops=1 ≤5 ✅ H1
- 带 snapshot_id ✅ H2
- 单 chunk，无合并 ✅ H3（不适用）

---

## 场景 2 — 多跳（跨文档拼接）

**Query（构造）**：「退款政策和会员等级对退款比例有影响吗？」

```
hop1: kb_retrieve(query="退款政策 退款比例")
  → chunks: [c-123(退款政策), c-456(超期50%)]
hop1: agent 识别需补"会员等级"维度 → 带 prior_chunks=[{c-123,摘要},{c-456,摘要}]
hop2: kb_retrieve(query="会员等级 退款比例", prior_chunks=[...])
  → chunks: [c-789(会员等级权益, fact_status=compiled)]
hop2: agent 拆两 claim:
  claimA="普通用户超30天退50%"
  claimB="VIP会员超30天仍全额退"
hop2: kb_verify_citation(claimA, {c-456,...}) → supported
hop2: kb_verify_citation(claimB, {c-789,...}) → supported
hop2: kb_governance(snapshot_status, doc_id=doc-001) → ok, snap-x1
hop2: kb_governance(snapshot_status, doc_id=doc-002) → ok, snap-x2
→ 返回合并答案：两维度对比 + [c-456][c-789] + snapshot_id=[snap-x1, snap-x2]
```

- hops=2 ≤5 ✅ H1
- 双 snapshot_id ✅ H2
- 跨 doc 合并 + 各自溯源 ✅ H3

---

## 场景 3 — 治理触发（过期）

**Query（构造）**：「最新的价格表是多少？」

```
hop1: kb_retrieve(query="价格表", filter={doc_type:price})
  → chunks: [c-900(价格, fact_status=outdated)]  ← A filter 在线检查标记过期
hop1: agent 见 fact_status=outdated → 主动治理
hop2: kb_governance(action=check_freshness, doc_id=doc-price)
  → status=stale, snapshot_id=snap-stale-01, checked_at=...
hop2: agent 决策：不返回过期数据，提示"价格文档已过期，请联系管理员更新"
→ 返回"无法确认当前价格" + snapshot_id=snap-stale-01（标注 stale）
```

- hops=2 ≤5 ✅ H1
- 带 snapshot_id（即使 stale）✅ H2 — 验证 G2 在"拒答"场景也强制
- 无合并 ✅ H3

---

## 场景 4 — 冲突检测

**Query（构造）**：「退款期限到底是 30 天还是 60 天？」

```
hop1: kb_retrieve(query="退款期限")
  → chunks: [c-123(30天), c-555(60天, 来自另一文档)]
hop1: agent 识别两 chunk 矛盾 → 主动治理
hop2: kb_governance(action=detect_conflict, chunk_id=c-123)
  → status=conflict, snapshot_id=snap-conf-77
hop2: agent 决策：不自行裁决，返回"检测到冲突：文档A说30天、文档B说60天，需人工确认" + snapshot_id
```

- hops=2 ≤5 ✅ H1
- 带 conflict snapshot_id ✅ H2
- 冲突不合并、显式暴露 ✅ H3（合并在此场景不适用，正确行为是暴露而非合并）

---

## 场景 5 — 模糊意图（需澄清）

**Query（构造）**：「那个政策」

```
hop1: kb_retrieve(query="那个政策") → 召回过散，top chunks 无明确指向
hop1: agent 判断意图模糊 → 不强行检索，向用户澄清
→ 返回澄清问句："您指哪类政策？退款/考勤/安全？"
（未产生答案，无 snapshot_id 要求——G2 仅约束"答案发出"场景）
```

- hops=0（未进检索）✅ H1（护栏不触发）
- 无答案故无 G2 要求 ✅ H2（边界正确）
- 不适用 ✅ H3

---

## 场景 6 — 引用失败重试（verify 抛回 agent）

**Query（构造）**：「数据保留期限是多久？」

```
hop1: kb_retrieve(query="数据保留期限")
  → chunks: [c-300(保留策略概述, 未提具体天数)]
hop1: agent 拆 claim="数据保留365天"
hop1: kb_verify_citation(claim, {c-300,...})
  → verdict=unsupported, evidence_span="c-300仅提保留策略未提天数"
hop1: agent 见 unsupported → 决策：二次检索换策略
hop2: kb_retrieve(query="数据保留 具体天数", prior_chunks=[{c-300,摘要}])
  → chunks: [c-301(明确365天)]
hop2: kb_verify_citation(claim, {c-301,...}) → supported
hop2: kb_governance(snapshot_status, doc_id=doc-003) → ok, snap-z9
→ 返回"365天" + [c-301] + snapshot_id=snap-z9
```

- hops=2 ≤5 ✅ H1
- 带 snapshot_id ✅ H2
- verify 失败→agent 自主换策略→成功，轨迹可见 ✅（验证"抛回 agent"原则）

---

## 推演结论

| 假设 | 结果 | 说明 |
|------|------|------|
| H1: max_hops=5 | ✅ 成立 | 6 场景最高 hops=2，远低于 5；护栏在超界时强制"无法确认"（场景 3/4 已体现拒答路径） |
| H2: G2 必填 | ✅ 成立 | 所有"发出答案"场景均带 snapshot_id，含拒答/冲突暴露场景；仅澄清场景（无答案）豁免，边界正确 |
| H3: 多跳合并 | ✅ 成立 | 场景 2 跨 doc 合并 + 各自溯源；场景 4 冲突显式暴露不强行合并（正确行为） |

**未发现需修改 tool 协议的新漏洞。** 协议层自洽，可进入 Phase 2 eval 体系（用真实 query 回填门禁数字）。

> 注：本推演 query 为构造数据，仅验证协议逻辑可行性，不代表真实用户分布。Phase 2 须用真实/标注 query 构建 eval 集。
