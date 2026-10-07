# Security Boundaries

## 优先只读命令

分析阶段优先使用：

```bash
ls
find
grep
rg
cat
sed -n
git status
git diff
git log
git show
```

## 修改前说明计划

涉及多文件修改、架构调整、高风险模块、依赖升级时，必须先输出：

```text
Plan:
1. ...
2. ...
3. ...

Files expected to change:
- ...

Validation:
- ...
```

## 不允许的操作

不得读取或输出敏感文件内容：

```text
.env
.env.*
*.pem
*.key
*.p12
*.crt
id_rsa
id_ed25519
secrets.*
credentials.*
```

不得把密钥 / token / cookie / 生产凭据复制到聊天、提交信息、日志或测试快照中。

## 高风险区域 — 修改前必先确认

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

## 安全与隐私

任何涉及用户数据 / 认证 / 权限 / 支付 / 日志 / 遥测的变更，都必须考虑：

1. 最小权限
2. 输入校验
3. 错误信息不泄露敏感细节
4. 日志脱敏
5. 审计可追踪
6. 回滚方案
7. 测试覆盖

不得在测试、示例、文档中使用真实密钥或真实用户数据。
