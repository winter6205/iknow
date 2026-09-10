# Project Instructions for Claude Code

## 读取规范

每次开始任务时按需读取：只读取与当前任务相关的文件。

---

## 代码规范

@.claude/rules/code-quality.md

## 测试规范

@.claude/rules/test.md

## 安全边界

@.claude/rules/security-boundaries.md

## Completion

汇报使用中文。实测矩阵见已引用的测试规范；模型可见文案或装配先读 `docs/guides/prompt-development.md`。

完成后简要报告：

- 改了什么；
- 实际运行的验证及结果（命令或 TUI 操作 + 证据）；
- 未验证内容及原因；
- 存在时报告风险、阻塞项以及 commit、push、release 等 Git/发布操作。

---

## 规范变更流程

修改本文件前必须：

1. 说明修改原因。
2. 说明影响范围。
3. 检查是否与 README / docs 冲突。
4. 单独提交规范变更，不与业务代码混合。

---

## 本机已配

- **本机 key 已配**。`npm run test:real-llm` 可跑。
- `mcp__aiterm__pty_*` 已配：TUI/REPL 真实交互用它。

## 网络工具

- `mcp__exa__*`。

## 产品主路径

```bash
npm test          # vitest：unit + harness + integration
```

## Git 操作

- 自动commit。
- 无用户明确 `push` 授权则不执行 `git push`。

## 按需查阅（SSOT 指针）

碰到对应任务再读；架构 / 配置 / 现状以 docs 为准，本文件不复述。

- 模块职责：`docs/architecture.md`（Capability modules）
- 领域词：`docs/CONTEXT.md`
- 功能现状：`docs/STATUS.md`
- 活跃 spec：`specs/README.md`（新增/归档只改那里）
- LLM / settings：`docs/llm-config-quickstart.md`、ADR-0015
- workspace root：ADR-0019
- 最近交接：`docs/handoff/` 最新一篇
- 版本记录：根目录 `CHANGELOG.md`
