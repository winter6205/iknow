# 测试规范

## 强制

- 任何行为变更必考虑 + 包含相应测试
- 新增功能必有对应测试
- Bug fix 必带回归测试

## 路径

- 单元测试 → `tests/unit/` (或 `__tests__/unit/`)
- 集成测试 → `tests/integration/`
- E2E 测试 → `tests/e2e/`
- 文件名禁 phase / version / date 标签

## 跨引

- TDD 原则 (先写测试再写实现) → `~/.claude/rules/s4-spec-as-test.md`
- 测试覆盖验收点 + "测试失败报告功能缺失而非拼写错误" 立约 → `~/.claude/rules/s4-spec-as-test.md`
- Code review Spec 轴 → `~/.claude/rules/code-review-protocol.md` §3
