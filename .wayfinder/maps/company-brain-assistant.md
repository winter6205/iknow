---
title: 从 gbrain 到多用户 Company Brain 的路线图
label: wayfinder:map
status: open
tracker: local-markdown
---

## Destination

形成一条可执行、可验证的路线，将 `_upstream_gbrain` 演进为安全的多用户 Company Brain。第一阶段先验证一个通用企业知识助手：在共享知识 source 上给出可引用、可说明缺口的回答，并维护受控的私有 Agent 记忆。

## Notes

- 方法：Wayfinder；本地图只记录决策，不执行产品实现。每个会话最多解决一个 ticket。
- 代码证据：`_upstream_gbrain` 已有混合检索、source SQL 过滤、MCP 调度、事实/召回机制与 retrieval-quality eval。
- 外部证据：[Claude Knowledge Graph Construction guide](https://platform.claude.com/cookbook/capabilities-knowledge-graph-guide) 说明图谱适用于跨文档多跳问题，并要求抽取、实体消歧与精确率/召回率反馈闭环。
- 本地证据：`docs/kb-assistant-guide/10-vector-retrieval-deep-dive.html` 覆盖结构化解析、切块、contextual retrieval、混合检索、重排、引用、GraphRAG 与评测；其中有关 iknow 当前代码的段落仅作为待核实的参考，不能替代本 fork 的源码事实。
- 当前没有自有或私有企业语料；首个切片使用冻结的真实公开企业报告与受控 corpus view，并将其视为产品/检索/安全验证资产，而非真实企业部署证明。

## Decisions so far

- [确定 Company Brain 目的地](../issues/001-destination-company-brain.md) — 最终目标是多用户 Company Brain；首个验证切片是共享知识的通用问答与私有 Agent 记忆，默认不自动写入正式知识。
- [确定演示语料与证据契约](../issues/002-demo-corpus-and-evidence-contract.md) — v0 以 Docugami SEC 10-Q 的冻结真实公开报告为主语料，按 Know Your RAG 构造平衡题集，并以精确引用、范围限定缺口和受控 source view 作为证据边界；MultiHop-RAG 仅在关系题不足时作为压力包。

## Not yet specified

- 演示通过后，真实企业语料的来源、数据保留、隐私分级与导入审计如何设计。
- 从共享 source 扩展到多 source、每人 OAuth client、federated read 的上线顺序与运维要求。
- 何时值得启用 contextual retrieval、完整 BM25、reranker、关系召回或知识图谱；必须由评测样本而非技术偏好决定。
- 用户界面、外部系统集成、后台任务和正式生产部署均等待 v0 的价值与安全证据。

## Out of scope

- 在本地图阶段重写 `hybridSearch`、替换向量数据库、一次性构建 GraphRAG、接入 Slack/飞书/Notion，或直接部署生产多用户服务；这些都是后续决策可能产生的实施工作，而不是当前地图的目的地。
