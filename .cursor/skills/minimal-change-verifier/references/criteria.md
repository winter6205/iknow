# S6 最小变更 + 依赖真实 - 详细规范

## 二元判据 (任一违反 = FAIL)

- [ ] diff scope = 任务 scope (无无关改动、无第二件独立功能)
- [ ] 新依赖含 PR 描述 YAGNI 理由
- [ ] pre-commit 测试必须 exit 0
- [ ] 依赖变更必含 lockfile 更新
- [ ] 证明本次任务的测试与改动在同一份 landing 里

提交条数 / squash 不在本表。口径只在操作者全局「提交」段。

## 出处

《The Pragmatic Programmer》Tip 11 DRY + Tip 12 Orthogonality | arXiv 2603.28592 AI 代码腐烂实证 (89.3% code smells)

## AI 易违反痛点

LLM 复制粘贴相近代码段而非抽象; 为快速完成功能硬编码相似常量; 批量"重写"夹带无关文件。
