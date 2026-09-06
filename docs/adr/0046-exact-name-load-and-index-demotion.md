# 0046. 有描述则按名加载；无描述才 search；索引降档不删名

Date: 2026-09-06
Status: accepted

## Context

MCP 短描述曾由 #631 T2 进 system，被 ADR-0043 B4 收成裸名；`skill_search` 与「未加载必须 tool_search」把检索和加载焊死。本票修订 ADR-0043 §2/§5/§7 中「必经 tool_search」读法，不推翻 schema 不 upfront、开局等待、前缀冻结。

## Decision

1. **加载 vs 检索**：前缀已有描述 → 按精确名灌贵载荷（`skill({name})`；未 discover 的工具/MCP 直呼 `discover`，参数齐则执行）。前缀没有描述 → 才用 `tool_search` 补描述+schema。删除 `skill_search`。
2. **超限梯子**：内建 schema 超窗口 10% → 退场件索引为名+描述，不剥描述。MCP/skill 索引超 10% → 只剥这两类条目的描述，名字保留。退场内建不参与剥描述。永不从目录删名。
3. **目录外 skill**：不经检索件；对话指路径后 `read_file`。

## Why not

- **工具超限也剥成仅名字**：会让本有描述的退场件去走 search，与「search 只补缺失描述」冲突。
- **保留 skill_search**：对已常驻或仅差正文的清单做子串检索，弱于模型注意力且多一跳。
- **未加载一律报错指路 tool_search**：与有描述即可直呼矛盾。

## Consequences

- **正面 / Applied:** #631 短描述与 ADR-0043 前缀冻结可并存；`tool_search` 岗位收窄为无描述。
- **负面 / Trade-offs:** 仅剩名字的 MCP 仍可能关键词 miss；本票不升级检索算法。
