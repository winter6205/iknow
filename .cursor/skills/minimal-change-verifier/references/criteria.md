# S6 最小变更 + 依赖真实 - 详细规范

## 二元判据 (任一违反 = FAIL)

- [ ] commit-msg hook 拦截 refactor: 含 feat/fix/perf ( commit = 1 逻辑任务)
- [ ] 新依赖含 PR 描述 YAGNI 理由
- [ ] diff scope = 任务 scope (无无关改动)
- [ ] pre-commit 测试必须 exit 0
- [ ] 依赖变更必含 lockfile 更新

## 出处

《The Pragmatic Programmer》Tip 11 DRY + Tip 12 Orthogonality | arXiv 2603.28592 AI 代码腐烂实证 (89.3% code smells)

## AI 易违反痛点

LLM 复制粘贴相近代码段而非抽象; 为快速完成功能硬编码相似常量; 批量"重写"代替小步重构, 丢失中间可回滚状态。
