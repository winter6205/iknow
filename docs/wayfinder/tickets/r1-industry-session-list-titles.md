# R1 业界会话列表标题怎么生成

- Map: [会话列表显示的会话概要（决策）](../session-list-label-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved
- Blocked by: —

## Question

聊天产品的会话列表，「概要 / 标题」常见有哪几套生成与展示方案？触发时机、输入材料、失败回退、与手改的关系分别是什么？只陈述公开实现与讨论，不评本仓该选哪套。

## Resolution

公开实现里，列表可读名几乎都叫 **conversation / session title**，不是压缩摘要。常见分层：

1. **占位（同步、零 LLM）**  
   空标题、`New Chat`、UUID、或**首条用户消息截断**（OpenHands 第一轮就是前 15 字；AuditBuffet 把「前 50 字」写成可验收的 fallback）。列表立刻有字，避免整排 Untitled。

2. **一次 LLM 标题（异步、廉价）**  
   业界默认形态。输入多为「首条 user」或「首轮 user+assistant」。ChatOllama：等**第一次有意义的助手回复后再生成**，材料是首问 + 首答摘要，避免对「你好」烧一次调用。LibreChat Agents：改为与流式回复**并行**，用首条 user，约 1–2s 出题，修的是「等整段回复才请求 gen_title → 客户端 15s 轮询超时 → 整场卡在 New Chat」。Hermes Agent：`maybe_auto_title` 在后台线程、不挡首答，用最便宜/压缩任务那档模型，只在前 1–2 条 user 上触发。

3. **只生成一次 + 手改优先**  
   Hermes / Multica：已有标题或 `/title` 手改则跳过；写盘用 CAS（`UPDATE … WHERE title = expected`），自动标题不得盖手改。失败、超时、无 key、输出不像标题 → **静默**留占位，不弹错。

4. **不随对话演进改名**  
   Hermes WebUI 明确：中途话题变了标题不变。ChatOllama 把「动态更新 / 聚类」列为后续，不是现行默认。

5. **标题 ≠ 摘要**  
   LocalLLaMA 讨论与 Open WebUI 实践：title 是 3–8 词主题，不是 summarization。ChatGPT Next Web 曾把标题生成钉在廉价模型上，主模型换了 key 不支持该档时整表变成 New Conversation。

对照源：ChatOllama 2025-09 文；Hermes #624 / WebUI #869；LibreChat PR #13395；Vercel AI SDK 讨论 #8443；Multica PR #5141；OpenHands PR #7390。
