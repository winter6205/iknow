# Changelog

## v0.2.0 - 2026-07-04

### 规范化修复（基于三角色审查）

**本次修复：**
- 添加 `## Overview` 章节
- `## Procedure` → `## Instructions`
- `## Pitfalls` → `## Common Pitfalls`
- `## Verification` → `## Verification Checklist`
- description 添加 "Use when..." 触发语境
- 填充 `related_skills: [agent-development-lifecycle]`
- 版本号升级到 0.2.0

**待修复（下轮迭代）：**
- 术语解释（Trajectory eval、Mock tool responses）
- 完整 eval case 示例
- 阈值理由说明（Easy 60% / Hard 25% / Edge 15%）
- Batch evaluation 代码示例

### v0.1.0 - 2026-07-04
- Initial skill creation
- Eval-first methodology
- Trajectory evaluation
- Iteration priority (5 levels)
- Quality gates (Sprint 1 / Production)

### Sources
- Anthropic "Demystifying Evals for AI Agents" (2026-01)
- HumanLayer 12-Factor Agents (GitHub 24k stars)
