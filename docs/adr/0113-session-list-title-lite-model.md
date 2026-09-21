# 0113. 会话列表标题：独立事件 + lite model

Date: 2026-09-19
Status: proposed

## Context

列表行现在靠 `extractTitle`（首条 user trim + 80）写入 `SessionFileV1.title`。TUI 已渲染该字段，但寒暄、操作剧本半截、compact preamble 都会变成列表名；且每次 save / compact 会重算，生成结果没有闸。主会话只有 `settings.llm.model`（ADR-0015）；标题生成若走主模型会进 Loop Engine 贵路径。需要和 compact 的 LLM 摘要拆开（`title` 不是压缩摘要）。

## Decision

1. **标题权威是 transcript 独立事件**（与 `message` 并列的 JSONL type，本仓自定名字）。header `title` 只是 `GET /sessions` / TUI / Web 的缓存：等于最新一条标题事件正文；没有事件时才是 `extractTitle` 占位。
2. **生成走单独模块**：一次无工具文本补全，不进 Loop Engine，不挡主回合。host 在第一次 `StopReason=completed` 且已有实质 user 文本后 fire-and-forget；失败静默，占位保留。
3. **`settings.llm.liteModel`**：用户层、与 `llm.model` 同形的 `provider/model` 路由，走同一 `providers[]`。缺席或调用失败不 fail-fast。本 ADR 只授权**会话标题生成**消费该槽；compact / memory extract / dream 不改路由。
4. 已有标题事件后，`extractTitle` 与 compact 不得回写 header `title`。不提供给人改会话名的命令或 UI。
5. 三条列表面主文案对齐缓存 `title`。`lastFinalText` 只给搜索，不进行。

## Why not

- **继续只截首条 user：** TUI 已证明接线不等于可扫。
- **把 compact 摘要当列表名：** 两个语义已拆开。
- **第二套 provider / 全局 apiKey：** 重复 ADR-0015 注册表。
- **lite 缺席 fail-fast：** 标题是增强，不是主会话前提。
- **给人改会话名：** 列表标题是机器生成的扫读标签，不是用户资产名。拒。

## Consequences

- JSONL 解析联合必须认识标题事件，未知 type 纪律与现有 unknown-field 策略对齐，不得把标题事件投影进 `messages`。
- ADR-0015 的「`settings.llm.model` 是主会话路由唯一来源」仍成立；lite 是**另一字段**，不是替换 model。
- 项目 settings 仍不采纳 `llm`（ADR-0084）。
