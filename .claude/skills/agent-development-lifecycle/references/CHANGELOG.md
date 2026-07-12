# Changelog

## v0.2.0 - 2026-07-04

### 规范化修复（基于三角色审查）

**审查来源：**
- 新手开发者视角：50 个问题（术语未解释、缺代码示例、阈值无理由）
- 资深架构师视角：45 个问题（缺权衡分析、反模式、真实案例）
- 技能作者视角：40 个问题（章节名不规范、description 缺触发语境、冗余）

**本次修复（高优先级）：**
- 添加 `## Overview` 章节（所有技能）
- `## Procedure` → `## Instructions`（所有技能）
- `## Pitfalls` → `## Common Pitfalls`（所有技能）
- `## Verification` → `## Verification Checklist`（所有技能）
- description 添加 "Use when..." 触发语境（所有技能）
- 填充 `related_skills` 关联关系（所有技能）
- 版本号统一升级到 0.2.0

**待修复（中/低优先级，下轮迭代）：**
- 术语表（Glossary）添加到总纲
- 关键概念解释（MCP、RAG、Gray release 等）
- 阈值理由说明
- 代码示例补充
- 权衡分析补充
- 动名词命名（如 `developing-agent-lifecycle`）

### v0.1.0 - 2026-07-04
- Initial skill creation
- 7-phase lifecycle (Requirements → Maintenance)
- Architecture Decision Matrix
- Tool Design Principles (5 principles)
- Production Baselines (quantitative)
- Common Pitfalls section
- Verification Checklist section

### Sources
- Anthropic "Building effective agents" (2024-12)
- Anthropic "Writing effective tools for agents" (2025-09)
- HumanLayer 12-Factor Agents (GitHub 24k stars)
- OpenAI Agents SDK (GitHub 22k stars)
- ISO/IEC/IEEE 12207:2026
