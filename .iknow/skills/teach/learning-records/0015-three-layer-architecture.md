---
id: 0015
type: lesson-recap
date: 2026-07-25
---

# 0015 · 三层架构：Harness · Agent 记忆 · 外置知识库

## 用户状态

- 用户发起 /teach：「我现在需要你的帮助，我对于 harness 的了解甚少，还有智能体的记忆系统，包括外置记忆库的功能，职责边界混淆不清晰，需要你现在来帮我梳理...Send explorers first if you need」
- 用户同时声称已有调研材料（`E:\训练集\agent-learn\agent-memory-harness-guide`），但自评"课程稍微对我的能力或者用画像方面等一些方面有误差，和讲的也不太够细"
- 基线：0014 课已建立 gbrain 四支柱能力地图；这节课回到**架构根问题**——三个最容易混淆的概念。

## 决策

- **4 个并行侦察兵**：A 读用户调研 / B gbrain 源码 / C iknow 记忆系统 / D Claude Code harness 官方文档。
- **每个侦察兵产出代码级实证**（文件:行号），不做抽象论断。
- **综合 4 份报告 + 评估用户调研深度** + 写课。
- **关键纠偏**：
  - 用户以为 gbrain 没接 LLM → 实际接入了 Anthropic Claude（gateway.ts）
  - 用户以为需要自己造 LLM → iknow 已经有 `OpenAiCompatibleLlmClient`
  - 用户以为公司脑是代码模式 → 实际是部署拓扑

## 关键事实

### Harness（Claude Code 官方定义）

来源：https://code.claude.com/docs/en/how-claude-code-works

- Claude Code = "agentic harness around Claude"
- Model 推理；Harness 提供工具、context 管理、执行环境
- 每轮循环：gather context → take action → verify → repeat
- 工具结果喂入下一轮决策
- **CLAUDE.md 是 conversation injection，不是 system prompt**（https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts）

### iknow 记忆系统（代码实证）

- **无持久化**：`InMemoryKnowledgeStore`（`src/knowledge-store/memory-store.ts:9-109`）纯内存，4 个 Map（documents/chunks/facts/compileHashes）
- **会话记忆**：`ConversationState`（`src/interaction/types.ts:15-22`）= turns[] + last_priors[] + history_finals[]
- **先验桥接**：`derivePriorsFromAnswer`（`src/interaction/conversation.ts:49-82`）从答案 source_spans → 下轮 boost +0.15
- **历史窗口**：`capHistory`（`src/agent-loop/llm-agent.ts:552-594`）capped at ~15% context / HISTORY_MAX_MESSAGES=6
- **已有 LLM 客户端**：`OpenAiCompatibleLlmClient`（`src/agent-loop/llm-client.ts:64-179`）默认 `http://localhost:20128/v1` + `deepseek-flash-combo`

### gbrain Company Brain（代码实证）

- **非代码模式，是部署拓扑**：`_upstream_gbrain/docs/tutorials/company-brain.md`（558 行）是唯一权威定义
- 代码里 `company-brain` 字符串只在文档里出现；`isCompanyBrain` 标志不存在
- **统一 AI Gateway**：`src/core/ai/gateway.ts` 支持 17+ embedding provider + Anthropic Claude 合成（Opus 4.7 默认）
- **3 拓扑**：Personal / Team mount / CEO-class（多 brain + mounts）
- **真实隔离层**：`sourceScopeOpts(ctx)`（`src/core/operations.ts`）= cross-source leak gate；Postgres RLS 只是 anon key 防护层
- **gbrain think 流水线**：INTENT → GATHER → SYNTHESIZE → COMMIT

### 用户调研材料评估

| 领域                | 评分     | 评价                                                 |
| ------------------- | -------- | ---------------------------------------------------- |
| Agent 记忆分层      | ⭐⭐⭐⭐ | 最强——四层模型、读写路径、compaction、多代理隔离系统 |
| gbrain 架构级分析   | ⭐⭐⭐   | 文档级好，无源码路径/schema                          |
| LLM 集成模式        | ⭐⭐     | 概念有，SDK/API 级细节缺                             |
| Claude Code Harness | ⭐       | 讲通用 harness 非 Claude Code                        |

**用户的"误差"自评准确**：标题写着 "Harness 底层原理"，实际深度是架构抽象，不是产品内部机制。

## 教学产物

- `lessons/0011-three-layer-architecture.html`：核心课（开篇 3 个诊断题 + 三层职责表 + 完整请求数据流 + iknow/gbrain/Claude Code 对比 + 4 个 Q&A + 面试问答示范）
- `reference/19-three-layer-architecture.html`：参考卡（核心定义 + 职责对照表 + 关键边界 + iknow 具体实现位置 + 缺陷清单 + 升级路径）

## 用户认知更新

| 之前                     | 现在                                                          |
| ------------------------ | ------------------------------------------------------------- |
| Agent 记忆来自 LLM 本身  | 记忆 = Harness 的上下文策展能力                               |
| gbrain 没接 LLM          | gbrain 通过 gateway 接 Anthropic Claude                       |
| 需要自己造 LLM           | iknow 已有 OpenAI 兼容客户端                                  |
| Company brain 是代码模式 | Company brain 是部署拓扑                                      |
| Harness = Agent Loop     | Harness 包含 Agent Loop，但更大（工具/权限/Hook/会话/子代理） |

## ZPD 影响

- 用户从"知道三层名字"推进到"知道每层职责 + 代码位置 + 协作机制"。
- **下一步最该补**（按用户优先级）：
  1. **ConversationState 代码导读**——下一课立刻可做，从 `interaction/conversation.ts` 逐行读 derivePriorsFromAnswer
  2. **kb_retrieve 13 阶段导读**（来自 0014 建议）——讲清检索函数的内部复杂度
  3. **把 iknow 升级到持久化 KB 的具体方案**——SQLite + sqlite-vec vs 接 gbrain MCP 的两条路径对比
  4. **transport 信任边界**（0014 建议）——给面试官讲 fail-closed 实战

## 关联

- 0010（陌生代码库）/ 0013（深度侦察）/ 0014（gbrain 四支柱）
- reference/17-18（工具地图 + 能力矩阵）
- MISSION.md / NOTES.md（不变）

## 教学纪律反思

- 用户的"自评误差"值得认真对待——不要轻信 learning-records 声称的"qualified"，要看到"听过词"≠"真懂"
- 4 个 explorer 同时派出是有用的：peer 校验纠出至少 3 处用户/自己都可能误判的事实（gbrain 没接 LLM / isCompanyBrain 存在 / Harness = Agent Loop）
- 后续课继续走"代码级实证 + 对比表 + 面试问答示范"三件套
