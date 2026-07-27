---
title: 确定演示语料与证据契约
label: wayfinder:grilling
status: closed
parent: ../maps/company-brain-assistant.md
assignee: user-and-kiro
blocks:
  - 005-evaluation-and-verification-gate
---

## Question

在没有真实企业资料时，v0 应使用怎样的可控演示语料，才能同时验证：可回答性、跨文档关系、来源可追溯、知识缺口与未来 source/权限扩展？每一类答案应满足什么证据契约？

## Resolution

v0 采取 **real-data-first**：主语料使用 [Docugami KG-RAG SEC 10-Q](https://github.com/docugami/KG-RAG-datasets/tree/main/sec-10-q) 中冻结版本的真实公开企业季度报告及其人工复核问答，不虚构企业正文。问题集采用 [Know Your RAG](https://arxiv.org/html/2411.19710) 的 `fact_single`、`summary`、`reasoning`、`unanswerable` 分类与 statement-first 构题方法补齐，但所有生成题均须人工核对答案和证据。

知识缺口与未来隔离通过**受控 corpus view**验证：为同一批真实文档赋予稳定 `document_id`、`source_id`、版本和定位符，再按测试主体配置允许访问的 source 或有意缺少某些期间；不伪造秘密资料，也不把静态 allowlist 测试表述为生产级认证/授权证明。

### 候选方案取舍

| 方案 | 事实问答 | 跨文档综合 | 关系/多跳 | 引用与缺口 | source / 权限预留 | 定位 |
| --- | --- | --- | --- | --- | --- | --- |
| Apollo/Wikipedia 摘要 | 强 | 弱到中 | 实体重叠直观 | 可引用，但缺口较难控制 | 与企业 source 不自然 | 教学 smoke test，不作为 v0 主语料 |
| Docugami SEC 10-Q | 强；已有人工复核 QA | 强；覆盖单文档多片段和多文档 | 擅长跨期间、跨公司关系；人物/组织链较弱 | 真实 PDF 可定位；可用受控视图制造可判定缺口 | 可按公司/文档集合映射 source | **v0 主语料** |
| MultiHop-RAG | 中 | 强 | 强；每题证据分布于 2–4 篇真实新闻 | 有支持证据，但不天然覆盖企业权限 | 可映射 source，但资料形态不像内部知识 | 仅当主语料无法暴露关系检索瓶颈时加入压力包 |

[FinanceBench](https://github.com/patronus-ai/financebench) 的开放样本具有人工答案、证据文本、来源文档和页码，可用于校准引用判定，但 v0 不同时维护第二套财务主语料。任何下载或再分发实施都必须在后续 ticket 中固定上游版本并再次核对许可证与归属要求；MultiHop-RAG 仓库标注为 ODC-BY。

### 最小语料切片

从 Docugami 已发布的 20 份 AAPL、AMZN、INTC、MSFT、NVDA 季度报告中，先选取一个保持时间连续性的最小切片：

- 3 家公司；
- 每家公司 4 个连续报告期；
- 共 12 份真实 PDF；
- 保留该切片内已有的人工复核 QA；
- 若上游实际清单不能形成 `3 × 4` 连续矩阵，则以 manifest 中可形成的最大连续矩阵为准，不补写虚构文档。

每份文档进入 corpus manifest 时至少记录：`document_id`、`source_id`、公司、报告期、文档类型、上游 URL、上游版本/获取日期、内容校验值、页码或稳定片段定位符。原始快照与解析文本必须能相互追溯。

### 问题集结构

问题分类使用多个正交维度，而不是只给一个标签：

1. **答案类型**：`fact_single` / `summary` / `reasoning` / `unanswerable`；
2. **证据范围**：`single_chunk` / `multi_chunk` / `multi_document`；
3. **时间范围**：单期 / 跨期；
4. **source 视图**：全部允许 / 部分允许 / 目标 source 不允许；
5. **结果类型**：可回答 / 证据冲突或不足 / 范围限定缺口 / 中性拒答。

首轮最小题集为 40 题，每种答案类型至少 10 题；其中至少 12 题需要多文档证据，至少 8 题使用跨期比较，至少 8 题成对运行于不同 source allowlist，且 `unanswerable` 必须同时覆盖“语料本来没有”“缺少必要期间”和“当前主体不可访问”三种原因。可以从上游 195 道人工复核题中选取和重标；缺失类别再按 statement-first 方法生成候选并人工审核。

每个 case 至少记录：

```text
case_id, question, answer_type, evidence_scope, temporal_scope,
principal, allowed_source_ids, expected_outcome,
required_claims, required_evidence, forbidden_evidence, gold_answer, review_status
```

### 回答证据契约

- **直接事实**：每个可核查 claim 至少有一个真正蕴含该 claim 的 `[document_id, version, page/locator]`；不得以相关但不支持结论的页面充当引用。
- **总结/跨文档综合**：完整答案中的每个必要组成事实均有引用；必须覆盖题目要求的所有期间或公司，并明确区分原文事实与助手概括。
- **推理/多跳**：列出得到结论所需的事实或关系链，每一步均可回到证据；不得把实体共现当作关系，也不得隐藏计算或比较依据。
- **冲突或时间变化**：同时呈现相关时期和冲突证据；若证据不能裁决，结果必须是不确定，而不是静默选择检索分更高的文档。
- **知识缺口**：只能说“在当前允许访问且已索引的 source/期间中未找到足够证据”，并指出缺少的期间或证据类型；不得把局部未找到扩大成“公司不存在该事实”。
- **source 边界**：检索、生成和引用只能使用 `allowed_source_ids`；不可访问资料不能通过标题、计数、片段、引用或“资料存在但无权限”等措辞侧漏。无权限与当前语料不存在对用户保持中性。

以下任一情况均为硬失败：关键结论无证据、引用不蕴含结论、漏掉必要文档却给出确定答案、使用禁止 source、通过回答泄露禁止 source、或在证据不足时利用模型既有知识补答。

### 边界与后续触发

本决策证明的是基于真实公开企业文档的检索、综合、引用、缺口和 source 过滤契约，不证明私有企业导入、身份认证、生产授权或多租户隔离。若 12 文档主切片中的关系题主要退化为数值/跨期聚合，不能有效区分普通混合检索与关系检索，则由 `006-graph-role-and-adoption-trigger` 决定是否加入固定版本的 MultiHop-RAG 小型压力包；不得仅因技术偏好直接引入知识图谱。
