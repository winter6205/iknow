# 前端技术栈 · 交互实现 · 多轮改造与数据层路线

> 类型：技术分析报告（会话外交付）  
> 日期：2026-07-12  
> 对齐代码：`web/` + `src/session-api/` + `src/interaction/` + `src/knowledge-store/` + `src/kb-retrieve/embedding/`  
> 协议硬约束：4 tool 不变；每轮 G2（`snapshot_id` / `source_spans` / `governance_status` / `tool_calls`）

---

## 1. 结论摘要

| 维度 | 现状 | 判定 |
|------|------|------|
| 前端栈 | 零框架静态页（HTML + CSS 变量 + ES modules） | v0 合理；多轮产品化后建议组件化 SPA |
| 交互模型 | host 会话袋 + HTTP Session API；每消息一轮 `answer` | 协议对齐正确；缺流式 / 持久会话 / 消息级 ID |
| 多轮记忆 | `prior_chunks`（检索桥）+ `history_finals`（LLM 短窗） | 够演示；不够长会话与可恢复 |
| 消息 | 服务端 `turns[]` 进程内；前端再镜像一份 | 无 message_id / 无分页 / 无导出 |
| 缓存 | 无应用层缓存；向量索引进程内 | 缺会话缓存、检索结果缓存、embedding 持久 |
| 向量 | 可选 API embedding → 内存 `VectorIndex` | 需迁 pgvector / 等价向量库 |
| 正常数据 | 内存 `InMemoryKnowledgeStore` + seed | 需文档/chunk/fact 版本化关系库 |

**一句话：** 当前是「可跑的 host 交互壳 + 内存 KB」；多轮 Agent 产品化的主轴是 **消息与会话持久化、分层缓存、向量与文档同版本存储**，而不是重开 tool 协议。

---

## 2. 前端技术栈（如实）

### 2.1 选型

| 层 | 技术 | 版本/说明 |
|----|------|-----------|
| 运行时 | 浏览器原生 | 无 React / Vue / Svelte |
| 模块 | ES modules | `web/app.js` → `import * as api from "./api.js"` |
| 样式 | 单文件 CSS 设计令牌 | `web/styles.css`：`--color-*` / `--space-*` / `--radius` |
| 构建 | **无** bundler | 由 `iknow serve` 同进程静态托管 |
| 类型 | JSDoc 注释 | 无 `tsc` 对 `web/` 的编译管线 |
| 依赖 | **零** npm 前端包 | 与根 `package.json` 解耦，避免双包管理器 |

**为何当时这样选（S6 / 最小变更）：**

- 仓库主栈是 Node + TypeScript Agent，无既有 FE monorepo。  
- 交互真值在 host（`ConversationState` + G2），UI 只做投影。  
- 同源服务消除 CORS；契约已固定在 `session-http-api-v0`。  
- 可后续替换为 SPA 而不改后端路径形状。

### 2.2 文件职责

| 文件 | 职责 |
|------|------|
| `web/index.html` | 语义结构：header / log 区 / composer / G2 侧栏；`aria-live` |
| `web/styles.css` | 设计令牌 + 布局；禁止组件内散落魔法色（约定） |
| `web/api.js` | Session HTTP 客户端；`RESERVED.sessionEvents` 预留 SSE |
| `web/app.js` | 容器状态机 + 渲染；不直接碰 tool schema |

### 2.3 状态与交互实现

**UI 相位（显式四态 + 发送中）：**

```text
idle → loading → ready ⇄ sending
                 ↘ error（可重试 bootstrap / 单轮失败）
```

**本地 state 形状（浏览器内存）：**

```js
{
  phase,           // UiPhase
  session,         // SessionSummary 镜像
  turns: [],       // { query, answer, human_text? }[]
  lastAnswer,      // 最近一轮 IknowAnswer（侧栏 G2）
  error
}
```

**主流程：**

1. `bootstrap`：`GET /health` → `POST /sessions` → 空 turns 空态文案  
2. `submit`：`POST …/messages` → push turn → 渲染答案 + sources + meta  
3. `reset` / `new session`：清空或重建 conversation  
4. mode / role：`POST …/commands`（slash 语义 HTTP 化）  

**展示纪律（与设计对齐）：**

- 答案区：`human_text` 优先，否则 `answer.text`  
- 侧栏：始终投影 `snapshot_id` / `governance_status` / `hops_used` / `source_spans` / `tool_calls`  
- **禁止**「只美化文本、丢掉 G2」  

**a11y 基线（已做 / 未做）：**

| 已做 | 未做 |
|------|------|
| `<button>` / `<label for>` / `role=log` / `role=alert` | axe 自动化门禁 |
| Enter 发送 / Shift+Enter 换行 | 焦点陷阱（无 modal） |
| `aria-live` 通告连接与结果 | 完整键盘命令面板 |

### 2.4 与后端的边界

```text
[ web UI ]  --JSON-->  [ session-api HTTP ]  --host-->  [ interaction ConversationState ]
                              |                              |
                              |                              +--> Agent.answer(query, { prior_chunks, history })
                              v
                         静态 /web/*
```

- UI **不**调用 4 tool。  
- UI **不**持有 prior 算法；prior 在 `recordTurn` 服务端派生。  
- 流式：`GET …/events` 已预留，**当前 501**。

### 2.5 前端局限（改造触发条件）

| 局限 | 影响 |
|------|------|
| 无虚拟列表 | 长会话 DOM 膨胀 |
| 无 message_id | 无法局部重试 / 引用单条 |
| 状态双写 | 刷新丢前端镜像；服务端会话也进程内丢失 |
| 无构建链 | 难做代码分割、严格 TS、组件库 |
| 无鉴权头 | 仅本机演示 |

**建议升级路径（渐进，非一次重写）：**

1. **仍静态**：补 message_id 渲染、会话导出 JSON、简单 localStorage 草稿。  
2. **轻量 SPA**（Vite + 预渲染或同域）：TypeScript 共享 `contract` 类型；组件拆分 MessageList / Composer / G2Panel。  
3. **状态**：服务端为源；前端 React Query / 自研 cache 按 `conversation_id` + cursor。  
4. **流式**：SSE 消费 reserved path；UI 增量写 assistant bubble，落盘仍以完整 G2 为准。

框架可选顺序：**Vite + 原生 TS** 或 **Vite + Preact/React**；不引入第二套协议。

---

## 3. 当前多轮对话实现（Agent 视角）

### 3.1 一轮 = 一次完整 Agent run

```text
User text
  → Host 组装 AnswerRequest
      prior_chunks ← ConversationState.last_priors（cap=5，summary 消毒）
      history      ← history_finals（LLM 短窗；deterministic 也可忽略）
  → Agent.answer  (max_hops=5 仅计 retrieve+verify)
  → IknowAnswer (G2)
  → recordTurn → 更新 turns / last_priors / history_finals
  → 投影 human | json
```

**跳数按本轮 run 计，非会话终身累计**（与 ADR 一致）。

### 3.2 两类「记忆」分工

| 机制 | 位置 | 作用 | 上限 |
|------|------|------|------|
| `prior_chunks` | 协议桥进 `kb_retrieve` | 续问检索偏好，**非全文** | K=5；summary 截断 |
| `history_finals` | host → LLM only | 指代 / 省略句 | 字符预算 + 近 N 条 cap |
| `turns[]` 全量 G2 | host 审计 | 回放 / 评测 / UI | 内存无界（风险） |

**刻意不做：** 把 tool 原文全文灌进会话；第 5 个 `kb_memory` tool。

### 3.3 与「消息」概念的差距

现状 turn ≈ 一轮问答，**不是**聊天产品里的 Message 实体：

| 字段 | 现状 | 多轮产品需要 |
|------|------|----------------|
| id | 无（仅 conversation_id） | `message_id` / `turn_id` |
| role | 隐式 user+assistant 一对 | 可拆澄清轮 / system 提示条 |
| status | 同步完成或失败 | pending / streaming / failed / cancelled |
| parent / branch | 无 | 可选分支编辑（后置） |
| token / cost | 无 | 观测与配额 |
| 持久化 | 无 | 跨进程恢复 |

---

## 4. 未来改造方向：适配 Agent 多轮对话

原则：**协议 4 tool + G2 不动**；改造集中在 host、存储、缓存、UI 投影。

### 4.1 目标能力图

```text
┌──────────── UI / API Clients ────────────┐
│  消息时间线 · 流式 · 会话列表 · 导出      │
└───────────────┬──────────────────────────┘
                │ Session API v1
┌───────────────▼──────────────────────────┐
│  Conversation Service（持久会话 + 消息）   │
│  Cache：会话热数据 / 检索短路 / embedding  │
└───────┬─────────────────────┬────────────┘
        │                     │
        ▼                     ▼
┌───────────────┐     ┌──────────────────┐
│ Agent Runtime │     │ Knowledge Plane  │
│ answer+G2     │     │ Docs/Chunks/Facts│
│ priors/history│     │ + Vector Index   │
└───────────────┘     └──────────────────┘
```

### 4.2 消息模型（建议 v1）

```ts
type MessageRecord = {
  message_id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  // user
  text?: string;
  // assistant
  answer?: IknowAnswer;       // 完整 G2 仍一等公民
  human_text?: string;
  status: "pending" | "streaming" | "final" | "failed" | "cancelled";
  parent_message_id?: string;
  created_at: string;
  error?: { code: string; message: string };
};
```

**API 增量（向后兼容 v0）：**

| 能力 | 建议 |
|------|------|
| 列表消息 | `GET /sessions/:id/messages?cursor=&limit=` |
| 发消息 | 现 `POST …/messages` 增加返回 `message_id` |
| 取消 | `POST …/messages/:mid/cancel` |
| 流式 | `GET …/events` SSE：`token` / `tool` / `final_g2` |
| 会话列表 | `GET /sessions?limit=`（多会话管理） |

**澄清轮：** `status=final` 但 `tool_calls=[]`、notes 标明 clarify；UI 不伪造 citation。

### 4.3 多轮上下文策略（分层）

| 层 | 内容 | 策略 |
|----|------|------|
| L0 本轮 | user text | 必送 Agent |
| L1 检索桥 | last_priors | 继续 cap=5；可按 span 分数加权 |
| L2 对话窗 | history_finals | token 预算从 contextWindow 扣 system/tools |
| L3 摘要 | rolling summary | **可选** host 字段，不进 tool；超长会话压缩 |
| L4 审计 | 全 turns G2 | 只存库，不默认进 prompt |

**改造优先级：** L2 预算严格化 → 消息持久化 → L3 滚动摘要 → 多轮 trajectory eval。

### 4.4 前端多轮 UX 清单

1. 消息列表虚拟滚动；失败气泡可 **Retry**（同 text 新 message_id）。  
2. 流式占位 + 最终用 G2 **替换**草稿（避免无 snapshot 的「半成品成功」）。  
3. 会话侧栏：turn 选择查看历史 G2，而非仅 lastAnswer。  
4. 可选：会话标题、导出 JSON、从导出恢复（P4 前本地文件即可）。  
5. 指代质量：LLM 模式默认 + priors 可见性调试开关（仅 dev）。

---

## 5. 缓存梳理

### 5.1 现状

| 位置 | 有无缓存 | 说明 |
|------|----------|------|
| 浏览器 | 无 | 无 localStorage / Service Worker |
| SessionHub | 无 | Map 会话 = 热状态，非 cache |
| Knowledge store | 无 | 全量内存 |
| VectorIndex | 进程内 | 重启全丢；配置里曾有磁盘 cache 路径意向，未产品化 |
| Embedding API | 无 | 重复 chunk 可能重复计费 |
| HTTP | Cache-Control: no-store/no-cache | 正确（会话动态） |

### 5.2 建议分层缓存

```text
L1 进程内（热）
  - conversation 热会话（TTL + 最大会话数 LRU）
  - 当前 turn 进行中状态

L2 应用缓存（Redis 或等价）
  - session meta / 最近 N 条 message 摘要
  - retrieve 结果：key = hash(query, role, snapshot/version, priors)
  - rate limit / 幂等 message_id

L3 持久（DB）
  - messages / conversations 权威
  - chunk embeddings（见 §6）
  - content_hash → compile 结果

L4 CDN/静态
  - web 资产（hash 文件名后可 long-cache）
```

**失效规则（必须写清）：**

| 事件 | 失效 |
|------|------|
| KB 版本原子切换 | 该 version 的 retrieve 缓存 + 相关 embedding 视图 |
| fact/chunk 更新 | content_hash 维 compile 缓存 |
| 角色变更 | 带 role 的 retrieve 缓存 |
| 会话 reset | 该 conversation 热缓存 |

**禁止：** 用缓存的 verify 结果替代看原文（协议：verify 永远看 chunk 原文）。

---

## 6. 向量数据库与「正常数据」存放

### 6.1 现状数据平面

| 实体 | 存放 | 备注 |
|------|------|------|
| Document / Chunk / Fact | `InMemoryKnowledgeStore` | seed 合成；无多租户 |
| Embedding 向量 | 可选 `VectorIndex` 内存 | OpenAI-compatible API 生成 |
| Conversation / Turn | `SessionHub` Map | 与 KB 同进程 |
| Eval 结果 | 本地 JSON（gitignore） | 非产品库 |

检索：关键词/overlap 臂 +（可选）向量臂 → **RRF(k=60)**；双索引只排序，不替代 verify。

### 6.2 目标：知识平面 vs 会话平面 分离

```text
Knowledge Plane（版本化、可治理）     Session Plane（多轮、可审计）
─────────────────────────────       ──────────────────────────
documents                            conversations
chunks (+ text 权威)                 messages (+ G2 JSON)
facts (content_hash)                 session_meta (role, mode)
chunk_embeddings (vector)            optional: rolling_summary
governance_snapshots                 optional: feedback labels
```

**版本不变量（已有 ADR）：** chunk 与 fact **同 version 原子切换**；`snapshot_id` 继续进 G2。

### 6.3 正常数据存放建议

| 数据 | 推荐存储 | 理由 |
|------|----------|------|
| 文档元数据、chunk 正文、fact | PostgreSQL（或兼容） | 事务、版本、ACL、审计 SQL |
| 大附件原文 | 对象存储（S3 兼容） | chunk 只存指针 + 正文摘录 |
| 会话与消息 | PostgreSQL（JSONB 存 G2） | 查询 timeline、合规导出 |
| 作业队列（compile 后台） | Redis / queue | 异步不堵交互主路径 |
| 密钥 | 环境 / KMS | 永不入库明文 |

**表草图（逻辑，非最终 DDL）：**

- `documents(doc_id, version, status, acl, …)`  
- `chunks(chunk_id, doc_id, version, text, summary, …)`  
- `facts(fact_id, content_hash, source_chunk_id, version, …)`  
- `conversations(id, tenant_id, role, mode, created_at, …)`  
- `messages(id, conversation_id, role, status, payload_jsonb, created_at, …)`  

`payload_jsonb` 对 assistant **必须能还原完整 IknowAnswer**。

### 6.4 向量数据库建议

| 选项 | 适用 | 备注 |
|------|------|------|
| **pgvector**（同 PG） | 中小规模、运维简单 | 与文档同事务版本切换友好 |
| Qdrant / Milvus / 云向量 | 大规模、独立扩缩 | 需 **version 标签** 与 PG 对齐，避免索引漂 |
| 继续内存 VectorIndex | 仅 CI / 单测 / 演示 | 非生产 |

**索引键建议：** `(tenant_id?, chunk_id, embedding_model, dim, kb_version)`  
**检索：** 向量 TopK → 回表取 **原文 chunk** → 再 RRF 与关键词臂融合 → verify 仍读 PG 中原文。

**Embedding 缓存：**  
`content_hash` 或 `chunk_id+version+model` → 向量；文档未变不重复调用 API。

### 6.5 与 Agent 多轮的交汇点

| 场景 | 数据读路径 |
|------|------------|
| 新会话首问 | messages 空；retrieve 全库（受 ACL） |
| 续问 | 读 last priors + history；retrieve 可带 prior_chunks |
| 刷新页面 | 从 DB 拉 conversation + messages 重建 UI |
| KB 发布 | 新 version 上线；旧会话仍可审计旧 snapshot_id |
| 敏感角色 | session.role 注入；过滤在 retrieve/governance，不进 tool 入参 |

---

## 7. 分阶段路线图（可执行）

### Phase A — 巩固 host（1 个迭代内）

- [ ] `message_id` + `POST /messages` 响应扩展（兼容字段）  
- [ ] 会话 turns 上限 / LRU；防内存涨死  
- [ ] Web：按 turn 浏览历史 G2；失败 Retry  
- [ ] 文档化缓存「故意不做」清单  

### Phase B — 持久会话与消息

- [ ] PG：conversations + messages  
- [ ] SessionHub 改为 repository 后端；进程重启可恢复  
- [ ] `GET …/messages?cursor=` 分页  
- [ ] 导出 / 导入会话 JSON  

### Phase C — 知识平面持久化

- [ ] PG：documents / chunks / facts + 版本切换事务  
- [ ] pgvector（或外置向量库）+ embedding 按 content_hash 缓存  
- [ ] 导入流水线替换 seed 主路径（seed 保留测试）  

### Phase D — 多轮体验与评测

- [ ] SSE 流式（final 仍强制 G2）  
- [ ] rolling summary（host）  
- [ ] 多轮 trajectory eval 样本  
- [ ] 可选 SPA 升级（共享 contract 类型）  

### Phase E — P4 工程化

- [ ] 鉴权 / 多租户 / 限流 / 观测 trace_id  
- [ ] compile 异步队列 UX  
- [ ] 密钥托管与发布流水线  

---

## 8. 非目标（防偏离）

- 新增 `kb_chat` / `kb_memory` tool 替代 host 会话  
- 用连续置信度替代 verify 三态  
- 展示层省略 `snapshot_id` 换简洁 UI  
- Runtime 链接 gbrain  
- 未批准前静默定稿鉴权 / requireApprovalFor 产品规则  

---

## 9. 风险与决策点

| 决策 | 选项 | 建议默认 |
|------|------|----------|
| 向量与文档是否同库 | PG+pgvector vs 分离 | **先同库**，规模不够再拆 |
| 消息是否双写搜索引擎 | 仅 PG vs + ES | 仅 PG 直到审计检索需要 |
| 前端是否立刻上 React | 现在 vs Phase D | **Phase D**；A/B 先补消息模型 |
| 会话 TTL | 永不过期 vs 7/30 天 | 产品策略；工程默认 30 天热 + 冷归档 |
| 多轮摘要谁写 | LLM host vs 规则 | 先规则截断；质量不够再 LLM 摘要 |

---

## 10. 参考路径索引

| 资产 | 路径 |
|------|------|
| Web UI | `web/` |
| Session API | `src/session-api/` |
| 会话袋 | `src/interaction/` |
| HTTP 契约 | `docs/design/session-http-api-v0.md` |
| 交互设计 | `docs/design/interaction-surface-v0.md` |
| 现状地图 | `docs/STATUS.md` |
| 内存 KB | `src/knowledge-store/` |
| 向量 | `src/kb-retrieve/embedding/` |
| 实现计划（已交付 v0） | `plans/web-interaction-session-api.md` |

---

## 11. 成功判据（改造后）

- 刷新浏览器可恢复同一 `conversation_id` 的消息时间线。  
- 每条 assistant 消息可还原完整 G2，评测与审计不丢字段。  
- KB 版本切换后，新会话检索新版；旧消息 snapshot 仍可解释。  
- 向量检索失败可降级关键词臂；verify 始终读权威 chunk 原文。  
- 前端可换实现，**Session API 形状保持兼容或版本化**。

---

*本报告为分析与路线，不替代 ADR；落地前对鉴权/审批等开放项仍需书面确认。*
