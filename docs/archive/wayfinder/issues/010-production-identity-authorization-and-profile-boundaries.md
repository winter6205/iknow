---
title: 确定生产身份、授权与用户画像边界
label: wayfinder:grilling
status: closed
parent: ../maps/production-company-brain.md
assignee: user-and-kiro
---

## Origin

本 ticket 从原 `003-v0-agent-interface-and-tool-contract` 与 `004-agent-memory-boundaries` 中迁出，保留此前已经作出的生产边界决策。迁移只改变决策所有权，不撤销决策，也不让本票反向阻塞只读 v0。

## Question

生产级多用户 Company Brain 中，认证身份、授权范围、用户可编辑画像与 Agent 私有记忆所有权怎样分离，才能让所有用户复用同一业务接口而不允许聊天内容提升权限？

## Resolution

认证主体的 `tenant_id`、`user_id`、正式角色、部门/项目成员资格、数据安全分级和 `allowed_source_ids` 由独立身份/授权系统或有权管理主体维护。Agent、用户问题、记忆内容和工具参数都不能创建、修改、推断替代或提升这些字段。

普通员工、部门人员与管理层复用同一个公司知识检索业务接口，不为职位创建不同工具。host/runtime 从已认证会话注入 `principal`、tenant/company、角色与部门关系、`allowed_source_ids`、安全分级和资源上限；Agent 只能用业务过滤进一步收窄请求。实际访问范围始终是授权范围与 Agent 请求范围的交集。

权限过滤必须发生在检索和生成之前。不可访问内容不得通过标题、计数、摘要、片段、引用、检索分数或“存在但无权访问”等措辞侧漏。生产入口不得提供可由用户自行选择或提升 `employee / manager / admin` 的控件；类似控件只能存在于隔离的测试 fixture。

用户可以编辑显示名称、称呼、语言、时区、回答风格、关注领域和工作习惯等体验画像。这些字段只能影响呈现和个性化，不能改变角色、成员资格、source allowlist 或任何授权判断。从账户资料预填的画像必须记录来源和写入主体，并允许用户查看与纠正。

“Agent 私有”记忆绑定 `tenant_id + owner_user_id`，不是模型自身拥有的记忆。它不能成为团队共享的影子知识库，也不能复制无权限 source、凭据、秘密或企业事实作为私人真相。跨 tenant 或跨 owner 的读取、写入和召回必须作为安全硬失败。

个人拥有的文档若作为知识 source 导入，其原始内容仍由所有者或正式 source 管理流程控制；切块、向量和事实抽取等派生索引属于可重建基础设施，不赋予 Agent 修改知识来源的权限。

## Deferred implementation choices

以下内容尚未决定，只有生产地图 entry gate 通过并出现真实需求后才拆票：

- 身份供应商、SSO、SCIM、OAuth client 与账户生命周期；
- RBAC、ABAC 或关系授权的具体组合与策略语言；
- tenant 建立、合并、迁移与管理员委派；
- 项目成员资格、临时访问、紧急访问和审批流程；
- 授权缓存、策略版本发布、撤销传播和生产审计字段。

## Relationships

- `003-v0-agent-interface-and-tool-contract` 只保留固定测试主体与受控 allowlist，不证明本票的生产能力。
- `011-production-private-memory-scopes-lifecycle-and-automation` 复用这里定义的 owner 与画像/授权分离原则。
- `007-enterprise-knowledge-promotion-and-approval` 的提交、审批和发布主体必须由这里定义的授权系统提供。
- 本 ticket 不阻塞 `005-evaluation-and-verification-gate`。
