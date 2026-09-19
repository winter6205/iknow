# G1 title 继续截断还是 LLM 生成

- Map: [会话列表显示的会话概要（决策）](../session-list-label-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: closed（2026-09-19）
- Blocked by: R1, R2, G2

## Question

若 G2 决定列表要靠 `title`（单独或作主行），`title` 的**值**从哪来？

- 维持 `extractTitle`：首条 user trim + 80，零 LLM
- 业界默认：截断立刻占位，首轮后廉价 LLM 生成短主题（3–8 词 / 约 50 字内），只一次
- 用 full compact 已有的 LLM 摘要当列表文案（与 #467「title ≠ compact summary」对撞）
- 启发式抽关键词，不上模型

输入材料若走 LLM：只首条 user（可与首答并行，LibreChat），还是等首轮 user+assistant（ChatOllama / Hermes）？「你好」「帮我看看」这类开场是否跳过生成？

## Resolution（已撤回）

零 LLM + `extractTitle`。撤回原因：TUI **已经在渲染 `title`**，本池主项目会话里可见「你好」「你好，你叫什么」、半截命令、以及 compact preamble 当标题；接线 ≠ 可扫。

## Resolution

要模型生成一次短主题。走 **lite model** 后台补全，不进主会话。材料：跳过寒暄后的首条实质 user；过短可再等首轮助手。占位仍 `extractTitle`。权威落点见 G4 独立事件。不把 compact 摘要当列表名。操作员要 plan + worktree，本条收口。
