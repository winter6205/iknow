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
- 术语解释（Gray release、Feature flags、Exponential backoff）
- Langfuse/Grafana 配置示例
- 告警阈值计算方法
- 灾难恢复方案

### v0.1.0 - 2026-07-04
- Initial skill creation
- Standardized error dictionary (6 types)
- Three-layer observability (Trace/Metrics/Drift)
- Human-in-the-loop patterns
- Deployment strategies (gray release, feature flags)

### Sources
- Anthropic "Building effective agents" (2024-12)
- OpenAI Agents SDK production practices
- ISO/IEC/IEEE 12207:2026
