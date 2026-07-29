---
title: 确定会话信息进入企业知识库的提议、审批与发布流程
label: wayfinder:grilling
status: open
parent: ../maps/production-company-brain.md
assignee: null
blocked_by:
  - 005-evaluation-and-verification-gate
---

## Scope boundary

本 ticket 属于只读 v0 通过价值与安全验证后的 **阶段 B**，不阻塞 `005-evaluation-and-verification-gate`。v0 只允许 Agent 指出知识缺口、冲突、过期或错误嫌疑并收集普通反馈；不实现知识变更提议、审批、发布或回滚。只有只读 v0 的评测证据证明该能力值得继续，并且出现真实的知识维护需求后，才推进本 ticket。

## Question

会话中出现的潜在企业知识，如何从未经确认的用户陈述转化为可审计的知识变更提议；谁可以提交、补充证据、审批和发布；如何处理权限、来源、冲突、版本、撤销、索引更新与失败回滚，才能确保 Agent 永不直接改写正式企业知识？

## Constraints carried forward

- 会话记录只能作为候选来源，不能因 Agent 抽取或用户陈述而自动成为企业正式知识。
- Agent 只能创建或更新知识变更提议；正式发布必须经过有权主体的明确审批。
- 提议、审批、发布和撤销必须保留操作者、时间、来源定位符、版本及理由，且不得突破 `allowed_source_ids` 或泄露不可访问 source。
- 审批后的内容必须先形成版本化正式 source，再进入解析、编译和检索索引；不能绕过正式知识边界直接写入检索事实。
- 本 ticket 负责提议到发布的治理流程；私有 Agent 记忆边界仍由 `004-agent-memory-boundaries` 决定，工具表面由 `003-v0-agent-interface-and-tool-contract` 决定。
