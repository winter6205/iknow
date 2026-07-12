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
- 术语解释（State machine、Sandbox、Handoff）
- Docker sandbox 配置示例
- 多 agent 通信协议
- 架构选型决策树

### v0.1.0 - 2026-07-04
- Initial skill creation
- Multi-agent patterns (Router-Specialist, Hierarchical, Peer-to-Peer, Orchestrator-Workers)
- Handoff protocol design
- State machine lifecycle (7 states)
- Sandbox execution patterns

### Sources
- OpenAI Agents SDK (GitHub 22k stars)
- Anthropic multi-agent best practices
