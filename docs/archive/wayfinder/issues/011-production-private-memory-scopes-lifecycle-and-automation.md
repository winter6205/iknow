---
title: 确定生产私有记忆的作用域、生命周期与自动化边界
label: wayfinder:grilling
status: closed
parent: ../maps/production-company-brain.md
assignee: user-and-kiro
---

## Origin

本 ticket 从原 `004-agent-memory-boundaries` 中迁出，完整保留此前已经作出的 task/project/durable 作用域、结构化存储、事件历史、生命周期和自动记忆决策。v0 的最小 session/durable 子集仍由 004 管理；本票只拥有生产扩展，不阻塞 v0。

## Question

生产级用户私有记忆需要哪些作用域、记录、确认、召回、生命周期和自动化模式，才能跨会话提供个性化，同时保持可解释、可撤销并且不污染企业正式知识？

## Resolution

### 1. 真相地位与所有权

私有记忆是绑定 `tenant_id + owner_user_id` 的用户资产，不是模型拥有的记忆，也不是企业知识、授权来源或团队共享规则。owner 和授权边界继承 `010-production-identity-authorization-and-profile-boundaries`；任何跨 tenant/owner 的读取、写入或召回均为硬失败。

私有记忆只保存个人偏好、个人工作上下文、职责、承诺，以及对正式知识的受控引用。企业事实、团队规则、凭据、秘密和无权限 source 内容不得复制为私人真相；潜在企业知识必须交给 `007-enterprise-knowledge-promotion-and-approval`，不能通过私有记忆绕过治理。

### 2. 作用域与优先级

每条记忆必须有显式作用域：

- `session`：仅当前 `conversation_id` 生效；
- `task`：仅当前任务生效；
- `project`：仅指定、由可信应用上下文提供的 `project_id` 生效；
- `durable`：跨会话长期生效。

作用域优先级为 `session > task > project > durable > system default`。更具体的偏好临时覆盖更一般的偏好，但不删除被覆盖记录。用户说“这次/当前/今天”时归入 session；说“这个项目/这项任务”且存在可信 scope ID 时归入 project/task；说“以后/默认/每次”时可以归入 durable。表达不明确时默认只在当前会话生效，并询问是否扩大范围，不得静默永久化。

团队共享的项目规则不是私有 project 偏好；它必须成为正式 source 或走 007 的治理流程。

### 3. 存储形式与记录契约

结构化数据库是唯一真相源；Markdown 仅作为用户可读、可导出的投影视图，Agent 不直接任意改写文件。存储必须位于稳定接口之后，使单进程 SQLite 实现可以在多进程、多租户阶段迁移到 PostgreSQL 等事务型外部存储而不改变业务契约。

每条私有记忆至少记录：`memory_id`、`tenant_id`、`owner_user_id`、`kind`、`key/value` 或原子陈述、`scope_type`、`scope_id`、`status`、来源定位、提出主体、确认主体与时间、`valid_from`、`expires_at`、`supersedes_memory_id`、创建与更新时间。

另以 append-only 事件记录提出、确认、拒绝、修改、替换、撤销、过期和删除动作。当前状态可以物化，但不得因此丢失可审计历史。

### 4. 写入与确认

- 用户明确说“记住”“以后默认”或在记忆界面直接编辑允许类别的个人偏好时，可以形成 `active` 记忆；系统立即返回写入回执，显示内容、作用域、来源及撤销/修改入口。
- Agent 从语气、重复行为或上下文推断出的偏好只能成为 `proposed` 候选，必须经用户明确确认后才能 `active`。
- 表述不明确或无法确定作用域时，只作为 session 工作偏好执行，并询问作用域。
- 敏感个人信息不得从推断中自动持久化；凭据、密钥和禁止保存的数据永不进入记忆库。
- 从账户或管理端 seed 的画像必须标记外部来源、写入主体和时间，并允许用户查看、纠正；画像仍不能改变授权字段。

### 5. 来源、召回与解释

对话来源记录 `conversation_id`、`turn/event_id`、必要原始引用或内容哈希、提出者、确认者和确认时间。账户或管理端 seed 记录外部来源与操作者。

每轮不把全部记忆塞入模型。系统只加载严格受限的稳定画像，再按当前 session/task/project 和问题相关性加载 active 记忆，并记录召回、使用、冲突与用户纠正事件。初期优先使用结构化 SQL 和精确作用域过滤；只有评测证明数量或语义匹配需要时才引入向量检索。

用户必须能在“系统记住了什么”页面查看内容、来源、范围、状态和历史。记忆实质影响回答或与当前要求冲突时，Agent 应说明使用了哪项偏好；当前明确指令始终覆盖既有记忆。

### 6. 过期、替换与撤销

不为所有记忆设置统一 TTL：session 在会话外不生效；task 在任务完成后失效；project 在项目关闭、用户离开项目或主动撤销后失效；durable 默认持续到用户修改或撤销；有明确日期的提醒和承诺按日期过期。

修改使用 `superseded` 链，撤销使用 `revoked`，到期使用 `expired`，均停止正常召回并保留审计历史，而不是静默覆盖。物理删除、匿名化、档案保留与 legal hold 由 `012-enterprise-data-retention-deletion-and-legal-hold` 单独决定。

### 7. 自动记忆模式

系统保留 `off / shadow / suggest / auto` 四种模式：

- `off`：不生成候选；
- `shadow`：评测候选但不向用户展示、不落正式记忆；
- `suggest`：向用户提出候选，确认后才 active；
- `auto`：仅对明确允许的低风险类别无逐条确认写入。

生产默认使用 `suggest`；评测可以使用 `shadow`。只有验证门证明候选精度、作用域正确率、撤销率和安全硬门槛达标后，才可对明确允许的低风险类别启用 `auto`。越权写入、跨用户泄漏和企业事实误入私有记忆必须始终为零，并能立即关闭 auto。

## Decoupled concerns

- 身份、tenant、owner 和授权字段：010；
- 企业知识候选、审批与发布：007；
- 物理删除、保留、加密和 legal hold：012；
- 多 worker 并发和会话恢复：009；
- v0 最小记忆验证：004 和 005。

本 ticket 不阻塞 `005-evaluation-and-verification-gate`；它保存的是生产地图下已经做出的扩展决策。
