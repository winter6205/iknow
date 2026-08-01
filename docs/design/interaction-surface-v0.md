# iknow 交互方案设计 v0（对齐原协议）

> 状态：**I1–I3 + HTTP/web host**（`iknow chat` + `iknow serve` + Session API + Vite React SPA `web/`）  
> 范围：交互与会话表面，**不改** 4 tool 协议拓扑  
> 依据：`HANDOFF` → ADR-v0.1 → tool-schema → architecture → analysis-c-auth-async  
> HTTP 契约：`docs/design/session-http-api-v0.md`  
> FE 栈：`docs/design/frontend-stack-upgrade-v1.md`（I3.5 Web = SPA，非零依赖静态壳）

---

## 0. Skill Check（本轮）

| 用途         | 选用                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| 过程边界     | `agent-development-lifecycle`（交互属产品表面，不重开协议）                          |
| 提示六要素   | `system-prompt-six-elements`（Identity/Goals/Tools/Policies/Uncertainty/Completion） |
| 评测对齐     | `agent-evaluation-system`（每轮仍产 trajectory 可评分信封）                          |
| 审查纪律     | `review-report-repair`（若后有实现审查，不在此设计轮）                               |
| **本轮不做** | 编码、REPL 落地、真机冒烟执行                                                        |

**结论：** 本轮只产出可评审的交互设计；实现另开任务。

---

## 1. 问题陈述（纠正口径）

| 已有                                    | 缺口                        |
| --------------------------------------- | --------------------------- |
| 4 tool + G2 信封 + 单次 `answer(query)` | **多轮人机交互**            |
| CLI 单次问句 → JSON                     | REPL / 会话态 / 人读展示    |
| 轮内 multi-hop（含 `prior_chunks`）     | **轮间** 指代、续问、上下文 |

「主路径齐」若包含「用户能连续对话地用企业 KB Agent」，则**尚未齐**。本设计定义如何在**不偏离协议**的前提下补齐交互。

---

## 2. 协议硬约束（不可谈判）

摘自设计真值（实现不得「UX 优化」掉）：

1. **仍是 Agent 形态**：多跳、动态 tool 序、可澄清；非固定 RAG 流水线。
2. **恰好 4 tool**：`kb_retrieve` / `kb_verify_citation` / `kb_compile` / `kb_governance`。
3. **双索引只排序**；verify **只看 chunk 原文**。
4. **溯源三层**：claim → `source_span` → `snapshot_id`（G2 不可省）。
5. **`max_hops=5`**：仅 **retrieve + verify** 计跳；治理注入 / compile 后 re-retrieve 不计。
6. **verify 纯三态**（禁止连续置信度驱动门禁）。
7. **鉴权 / 角色**：session 注入，不新增 tool。
8. **主问答同步**；长 compile 不挡交互主路径（异步仅后台作业语义）。

---

## 3. 设计原则（产品层）

| 原则                        | 含义                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| **信封优先**                | 每一轮用户话轮 → 恰好一次 `IknowAnswer`（G2）；展示层只做投影                 |
| **协议外会话**              | 会话态、历史、REPL 在 **host 层**，不进 tool schema                           |
| **轮间桥 = `prior_chunks`** | 唯一协议已提供的检索续接钩子；不传全文                                        |
| **双视图**                  | Human 可读 vs Machine JSON（`--json` / 审计）；禁止「漂亮但无 snapshot」      |
| **模式分层**                | ~~CI/eval 保持 deterministic 单次~~ — 已退役：仅保留 LLM + host 护栏（见 §6） |

---

## 4. 目标交互形态

### 4.1 主入口：`iknow chat`（REPL）

> （以下 role / embeddings 交互面已随旧 loop 残留清理移除 — harness 为通用 agent，授权由 ACI 装饰层逐次工具调用承接）

```text
$ iknow chat ~~[--mode deterministic|llm]~~ ~~[--embeddings]~~ ~~[--role employee|manager|admin]~~ [--json]

iknow> 公司的退款政策是什么？
（人读：答案 + 引用 + 治理状态）
iknow> 那和旧版差在哪？
（续问：注入 prior_chunks / 短历史）
iknow> /quit
```

| 命令/输入       | 行为                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 普通文本        | 一轮 `answer`                                                                                                               |
| `/json on\|off` | 切换机器输出                                                                                                                |
| `/role <r>`     | ~~改 session.caller_role（不改 tool）~~ — **已退役**：caller_role 随旧 loop 移除；授权由 harness ACI 装饰层逐次工具调用承接 |
| `/mode <m>`     | 改 agent 实现                                                                                                               |
| `/reset`        | 清空会话袋，保留 store                                                                                                      |
| `/quit`         | 退出                                                                                                                        |

**单次** `iknow ask "…"` 保留给脚本/CI，语义不变。

### 4.2 一轮生命周期（协议内）

```text
User utterance
    │
    ▼
[可选] 澄清轮：0 tool，不产虚假 G2；或轻量 G2「请补充」
    │  (仅当无法形成可检索意图；不用于逃避治理)
    ▼
Host 组装 AnswerRequest:
  query + prior_chunks? + history? (LLM)
    │
    ▼
Agent.answer  ──max_hops(retrieve/verify)──►  IknowAnswer (G2)
    │
    ▼
Host 更新 ConversationState
    │
    ▼
Renderer: human | json
```

**跳数：** 按 **本轮 answer run** 计，非会话终身累计（与 ADR 探索预算一致）。

---

## 5. 会话模型（host，非 tool）

```ts
// 设计概念 — 非当前代码真值
type ConversationState = {
  session: SessionContext; // ~~caller_role (+ eval flags only)~~ — 已退役：当前为空 harness 注入标记
  conversation_id: string;
  turns: Array<{
    query: string;
    answer: IknowAnswer; // 完整 G2 信封，供审计/eval
  }>;
  /** 供下一轮 retrieve 的协议桥 */
  last_priors: PriorChunk[]; // { chunk_id, summary }[]
  /** LLM 专用：仅终局 user/assistant 短历史，不灌满 tool 原文 */
  history_finals?: Array<{ role: "user" | "assistant"; content: string }>;
};
```

### 从 `IknowAnswer` 派生 `last_priors`（推荐算法）

1. 取本轮 `source_spans` 的 `chunk_id`（去重，保序，最多 K=5）。
2. `summary`：优先 store 内 chunk.summary；否则 quote 截断（≤200 字）。
3. 不把 chunk 全文塞进 `prior_chunks`（协议禁控上下文腐烂）。

### 不进 `SessionContext` 的字段

聊天历史、priors、UI 偏好 → **ConversationState**，避免污染治理/鉴权上下文。

---

## 6. Agent 入口扩展（最小，不改 tool）

保持 4 tool 不变；仅扩展 **host→agent** 调用：

```ts
// 设计目标 API
answer(
  query: string,
  opts?: {
    prior_chunks?: PriorChunk[];
    history?: { role: "user" | "assistant"; content: string }[]; // LLM only
  },
): Promise<IknowAnswer>;
```

| 模式              | 行为                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------- |
| ~~deterministic~~ | ~~首次 `kb_retrieve` 带上 `opts.prior_chunks`（若有）；模板答案可略偏报告体~~ — 已退役      |
| **llm**           | system + `history` 终局短窗 + user；**护栏**：事实续问应再 retrieve；G2 仍 force governance |

### 交互默认模式（产品建议）

| 场景                    | 模式                                                     |
| ----------------------- | -------------------------------------------------------- |
| ~~CI / `npm run eval`~~ | ~~deterministic，单次，无会话~~ — 已退役                 |
| 本地演示 / 真交互       | **llm + host priors**（有 key）；无 key fail-closed      |
| ~~离线/无网关~~         | ~~deterministic REPL + 明确「无对话记忆」提示~~ — 已退役 |

---

## 7. 展示层（IknowAnswer 投影）

不修改 `IknowAnswer` 必填字段。

### Human（默认）

```text
{text}

—— 依据 ——
[1] {chunk_id}  {quote?}
…

治理: {governance_status}  ·  snapshot: {snapshot_id 短显}
 hops: {hops_used}  ·  tools: {tool_trace 简写}
{notes 若有}
```

### Machine（`--json` 或 `/json on`）

完整 `IknowAnswer`（含 `tool_calls`），供轨迹评测与排障。

**禁止：** 仅有美化文本、丢掉 `snapshot_id` / `source_spans` 的「展示模式」。

---

## 8. 与 system prompt 六要素的对齐（LLM 交互）

| 要素        | 交互设计落点                                            |
| ----------- | ------------------------------------------------------- |
| Identity    | 企业知识库 Agent，非闲聊助手                            |
| Goals       | 可溯源、可治理、 hops 内完成；不确定则「无法确认」      |
| Tool guide  | 4 tool 既有描述；事实续问优先 retrieve                  |
| Policies    | 敏感/竞对/G2/不编造；审批假设待批准时 UI 只展示拒绝文案 |
| Uncertainty | 映射三态与 notes，**不用** 0–1 连续置信                 |
| Completion  | 一轮以 G2 信封结束；REPL 再提示下一输入                 |

---

## 9. 分阶段落地（实现另开任务）

| 阶段                        | 交付                                                                | 验收                                                                                     |
| --------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **I0 设计冻结**             | 本文档评审通过                                                      | 无协议改写争议                                                                           |
| **I1 REPL 壳**              | `chat` 循环 + human 渲染 + 单进程复用 store                         | 多轮输入；每轮仍有 G2 JSON 可选                                                          |
| **I2 会话袋**               | `ConversationState` + priors 注入 `answer`                          | 续问可带 prior；单测可注入 priors                                                        |
| **I3 LLM 历史**             | `history_finals` 短窗 + 截断                                        | 指代类续问在有 key 时可用                                                                |
| **I3.5 Session HTTP + Web** | `serve` + `/api/v1/*` + **Vite React TS SPA** (`web/` → `web/dist`) | create+message 返回 G2；UI 展示 snapshot；SSE 仍 **501**（见 frontend-stack-upgrade-v1） |
| **I4 真机交互冒烟**         | 主线程/人工清单：三模式各 ≥3 轮                                     | 有命令与结果记录（无密钥）                                                               |
| **I5 多轮 eval（可选）**    | N 次单轮 + 注入 priors 的样本                                       | 不阻塞 I1–I4                                                                             |

---

## 10. 明确不做（防偏离）

- 不新增 `kb_memory` / `kb_chat` tool
- 不把 tool 原文全文累进会话 prompt
- 不把角色塞进 tool 入参
- 不把 hops 改成会话终身计数（除非另开 ADR）
- 不把「交互完成」定义为「API curl 通」

---

## 11. 开放项（交互设计也不得静默拍板）

仍属 HANDOFF / assumptions 未决：

- requireApprovalFor 与治理 B 的产品文案与拦截时机
- 角色枚举与 ACL 展示
- 治理超时降级的用户可见文案（须显式，禁静默）

实现 I1 时可用 **当前代码默认**（assumptions-p3），但须在 UI 文案标「实现默认」。

---

## 12. 成功标准（本设计轮）

- [x] Skill check 与协议硬约束写清
- [x] 与现状 gap（单次 CLI）对齐
- [x] 会话 / 一轮生命周期 / 双视图可评审
- [x] 最小扩展点不改 4 tool
- [x] 落地阶段 I0–I5 可拆实现任务
- [x] I1 REPL 壳：`npx tsx src/cli.ts chat` + human 默认 / `--json` / slash
- [x] I2 会话袋：`ConversationState` + `prior_chunks` 注入 `answer`
- [x] I3 LLM 历史：`history_finals` 短窗（LlmIknowAgent）
- [x] I3.5 Session HTTP + Web：**Vite React SPA** 栈（`web/`；build → `web/dist`；`serve` 托管）；SSE 未实现（501）
- [x] I4 真机交互冒烟：三模式 CLI + Session HTTP（见 `docs/handoff/i4-smoke/`）
- [ ] I5 多轮 eval（可选）
- [ ] 流式/鉴权/会话持久化仍未做（不阻塞 I4）

**成功 =** I1–I4 可本地跑通；I3.5 SPA 构建与 G2 投影可验收；I5 可选。
