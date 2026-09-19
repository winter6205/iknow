# G4 独立事件、单独模块、lite model 槽

- Map: [会话列表显示的会话概要（决策）](../session-list-label-map.md)
- Type: `wayfinder:grilling` (HITL)
- Status: closed（2026-09-19）
- Blocked by: —

## Question

标题要不要做成 transcript 独立事件、生成要不要独立模块、settings 要不要单独一个 **lite model** 槽（与主会话 `settings.llm.model` 分开）？lite 只服务标题，还是所有「便宜后台补全」共用？缺席 / 失败怎么走？

## Resolution

1. **独立事件：要。** append-only JSONL 增标题事件（type 名本仓自定，不与 message 混写）。权威是 lite 生成的那条事件；`SessionFileV1.title` 只做列表缓存。`extractTitle` 只在还没有 title 事件时写占位。不给人改名。
2. **单独模块：要。** 单次文本补全、无工具、不进 Loop Engine。host 在首轮 completed 后 fire-and-forget。
3. **lite model 槽：要，且收窄。** 用户 settings `settings.llm.liteModel` = 与主模型同形的 `provider/model` 路由，走同一 `providers[]`，不新开注册表、不第二套 apiKey（除非该 provider 自己的 `apiKeyEnv`）。**本图只把标题生成接到这个槽。** compact / memory extract / dream 不自动改用 lite。缺席或调用失败 → 静默留 `extractTitle` 占位，**不** fail-fast 整个产品（主模型缺失仍按 ADR-0015 fail-fast）。
