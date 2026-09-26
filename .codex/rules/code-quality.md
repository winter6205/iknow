# Code Quality Rules

## Coding Principles

Use as default bias, not strict checklist.

- Principle of Least Astonishment：代码行为可预测，少意外副作用。
- Follow Existing Conventions：沿用项目既有风格、目录、命名、接口。
- Keep It Simple：优先最短清楚实现，不提前抽象。
- Explicit over Implicit：意图、类型、边界、错误路径显式。
- Single Responsibility Principle：一个函数 / 类 / 模块一个明确职责。
- Single Source of Truth：业务概念、规则、状态、配置单一权威来源。
- Comments Explain Why：注释只解释原因、约束、边界，不解释显而易见的代码。

## 高风险区域

以下区域必须先给出计划，经用户确认后再修改：

- 身份认证
- 授权权限
- 支付计费
- 加密、签名、token、session
- 数据库迁移
- 数据删除脚本
- CI/CD
- 生产配置
- 基础设施配置
- 安全策略
- 多租户隔离
- 审计日志
- 合规相关逻辑

## 测试规范

新增或修改业务逻辑时，必须优先补充测试。测试应覆盖：

1. 正常路径
2. 失败路径
3. 边界条件
4. 权限不足
5. 空输入或非法输入
6. 并发或重复提交场景（若适用）

不得删除测试来让构建通过。不得降低断言强度。不得把失败测试改成跳过，除非用户明确授权且提交正文说明原因。

如果测试无法运行，必须记录：

```text
Validation:
- Not run: <reason>
- Expected command: <command>
- Blocking issue: <issue>
```
