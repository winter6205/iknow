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
- 术语解释（RAG、Context Rot、Dumb Zone）
- Token 计数方法说明
- Checkpoint/Resume 代码示例
- 三层记忆实现代码

### v0.1.0 - 2026-07-04
- Initial skill creation
- Three-layer memory architecture (L1/L2/L3)
- Context rot defense mechanisms
- Tool result compression strategies
- Pre-fetching patterns

### Sources
- HumanLayer 12-Factor Agents (GitHub 24k stars)
- Anthropic context engineering best practices
