# iknow 功能现状与展望

> 维护说明：描述产品/工程事实，不替代协议真值（`docs/iknow-spec/`）。  
> 最后对齐代码线：session HTTP API + Vite React SPA（`src/session-api/` + `web/` → `web/dist`）。  
> 协议真值链仍为：`HANDOFF` → `ADR-v0.1` → `tool-schema` → `mapping` → eval。

---

## 1. 已实现功能

### 1.1 协议与设计资产（P0–P2 文档侧）

| 能力                     | 说明                                 | 位置                                           |
| ------------------------ | ------------------------------------ | ---------------------------------------------- |
| 产品定义                 | 企业 KB **Agent**（非纯 RAG 流水线） | `docs/iknow-spec/`                             |
| ADR / 架构 / 4 tool 契约 | 已闭环                               | `docs/protocol/*`                              |
| 评测集草案               | 32 条构造用例（easy/hard/edge）      | `docs/eval/eval-set.draft.json`                |
| 门禁与 trajectory 规格   | 硬门禁 + 打分公式                    | `eval-gate` / `trajectory-eval-spec`           |
| gbrain 映射与只读基线    | 改造参考，禁止 runtime 链接          | `mapping-*` / `_upstream_gbrain/`（gitignore） |
| 交互方案设计             | 多轮 host 层设计 v0                  | `docs/design/interaction-surface-v0.md`        |
| 审查修复技能             | 报告驱动根因修复流程                 | `.claude/skills/review-report-repair/`         |

### 1.2 运行时核心（独立 `iknow`，无 gbrain 依赖）

| 能力                  | 说明                                                                                        | 位置                                    |
| --------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| ~~4 tools~~           | ~~`kb_retrieve` / `kb_verify_citation` / `kb_compile` / `kb_governance`~~ **已归档 023**    | `docs/archive/023-retire-kb-tools/`     |
| Agent 执行层          | harness foundation（loop-engine + anthropic-adapter + executor + registry）+ ACI 装饰层原型 | `src/harness/`（含 `src/harness/aci/`） |
| 内存知识库            | 合成 seed 语料（企业政策/HR/财务等场景）                                                    | `src/knowledge-store` / `fixtures`      |
| ~~确定性 Agent~~      | ~~规则 loop，G2、`max_hops=5`~~ **已归档 022**                                              | `docs/archive/022-retire-agent-loop/`   |
| ~~LLM Agent~~         | ~~OpenAI-compatible tool_calls~~ **已归档 022**，现由 harness anthropic-adapter 承接        | `src/harness/model-adapter/`            |
| G2 信封               | 每轮答案含 `text` / `source_spans` / `snapshot_id` / `governance_status` / `tool_calls`     | `IknowAnswer`                           |
| 授权（per-tool-call） | harness ACI 装饰层逐次工具调用授权；`caller_role` 角色枚举已移除                            | `src/harness/aci/`                      |
| 配置加载              | `.env` / `.env.local` + `process.env`；密钥只读 env 名                                      | `src/config/env.ts`                     |

### 1.3 检索增强（M1，已归档 023）

> 双臂排序 / Embedding 客户端 / 内存向量索引随 `kb_retrieve` 一并归档于
> `docs/archive/023-retire-kb-tools/`。CLI 产品路径不再构建向量索引；
> `--embeddings` CLI flag 与 `IKNOW_EMBEDDING_MODE` 等 env、孤儿字段
> `simulate_governance_timeout` / `--governance-timeout` 已随旧 loop residue 一并移除。

| 能力                 | 说明                                                             |
| -------------------- | ---------------------------------------------------------------- |
| ~~双臂排序~~         | ~~关键词 +（向量 **或** overlap 回退）→ RRF(k=60)~~ **已归档**   |
| ~~Embedding 客户端~~ | ~~OpenAI-compatible `/embeddings`~~ **已归档**                   |
| ~~内存向量索引~~     | ~~`VectorIndex`；可选 `--embeddings`~~ **已归档**（flag 已移除） |
| ~~失败回退~~         | ~~网络失败时回退 overlap 臂~~ **已归档**                         |

### 1.4 交互表面（I1–I3，相对设计稿）

| 能力                     | 说明                                                                                                                                                                                                                                                              | 位置                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **产品 CLI 多轮**        | TTY REPL + 管道串行；默认 TTY 无参进 chat                                                                                                                                                                                                                         | `src/cli/*` + `src/cli.ts`                                                               |
| 人读输出                 | 答案 + 依据 + 治理/snapshot/hops                                                                                                                                                                                                                                  | `interaction/format.ts`                                                                  |
| 机器输出                 | `/json on` 或 one-shot JSON                                                                                                                                                                                                                                       | 同上                                                                                     |
| 会话袋                   | `ConversationState`：turns、`last_priors`、history_finals                                                                                                                                                                                                         | `interaction/conversation.ts`                                                            |
| 轮间桥                   | `answer(q, { prior_chunks, history })`；priors 统一消毒 cap=5                                                                                                                                                                                                     | `priors.ts` + agents                                                                     |
| Slash                    | `/help` `/quit` `/json` `/mode` `/reset`                                                                                                                                                                                                                          | `interaction/slash.ts`                                                                   |
| 单次脚本                 | `ask "…"` / 裸 query → JSON（CI 兼容）                                                                                                                                                                                                                            | `cli.ts`                                                                                 |
| **Session HTTP API**     | 进程内多会话：create / message / command / reset；G2 每轮                                                                                                                                                                                                         | `src/session-api/`                                                                       |
| **Web 产品 UI**          | Vite + React + TS SPA（`web/`）；build → `web/dist`；`iknow serve` 优先托管 dist（无 dist 时回退 `web/`）；空/载入/错/数据四态 + 侧栏 G2 投影；SSE 路径仍 **501**                                                                                                 | `web/` + `iknow serve`                                                                   |
| FE 栈决策                | React 选型、组件树、forest cockpit 令牌、非目标                                                                                                                                                                                                                   | `docs/design/frontend-stack-upgrade-v1.md`                                               |
| API 契约                 | v0 路由与预留路径                                                                                                                                                                                                                                                 | `docs/design/session-http-api-v0.md`                                                     |
| **Web MVP 原型（独立）** | Next.js 15 + React 19 + Tailwind/shadcn + Zustand/TanStack；亮色非 AI 化；**已接真实 Session HTTP API**（mock 已移除）；G2 机器面板（治理/snapshot/工具轨迹/引用）；角色·模式 → `/commands`；6 条 E2E 对真实 `iknow serve` 全绿；UI 栈 A/B 决策（提案 A，待批准） | `iknow-prototype/` + `docs/design/prototype-cli-integration-and-ui-stack-decision-v0.md` |

### 1.5 评测与质量门禁

| 能力             | 说明                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| 单元/契约测试    | `npm test`（含 interaction / chat-repl / llm mock / env 等）          |
| Trajectory suite | 已退役：归档于 `docs/archive/021-retire-legacy-loop-and-eval/`（#48） |
| 结构化 tool 日志 | `tool_calls[{tool,args,ordinal}]`                                     |
| 审查修复闭环     | 多轮 live-review 根因修复已合入主干                                   |

### 1.6 工程与协作

| 能力         | 说明                                                   |
| ------------ | ------------------------------------------------------ |
| 独立仓库     | 私有 GitHub `winter6205/iknow`，`master` 跟踪 `origin` |
| 上游参考隔离 | `_upstream_gbrain/` 只读 + gitignore                   |
| 接入材料模板 | 网络 API + Key 画像                                    | `docs/integration-materials.env.example` |

---

## 2. 未实现 / 仅部分实现

### 2.1 产品与数据

| 缺口                     | 说明                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| **真实企业语料**         | 仍为 seed 合成库；无生产导入/版本切换流水线                                                   |
| **真 query 评测集**      | `eval-set.draft.json` 仍为 DRAFT 构造数据；`relevant_chunks` 等未用真实日志回填               |
| **软门禁校准**           | Hit@5 / Faithfulness 等数字未用真实数据标定                                                   |
| **持久化存储**           | 仅内存 store；无 DB / 对象存储 / 多租户                                                       |
| **向量持久化**           | 内存向量索引已随 023 归档；harness 为通用 agent，无向量检索，故无向量持久化需求               |
| **后台 compile 队列**    | 设计允许异步作业；产品级 job/notify 未做                                                      |
| **鉴权生产化**           | 授权由 harness ACI 装饰层逐次工具调用承接（session 角色枚举已移除）；完整 ACL/审批流待 ADR    |
| **Web 生产化**           | SPA 构建链已定（Vite React → `web/dist` + 同进程 API）；无鉴权 / 无多租户 / 无 CDN 发布流水线 |
| **流式输出**             | SSE 路径预留 `…/events` → **501**；无 token streaming                                         |
| **多轮 trajectory eval** | 评测仍是单次 input；无 N 轮会话样本与评分器                                                   |

### 2.2 交互与 Agent 体验

| 缺口                    | 说明                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| **I4 真机 LLM 冒烟**    | **已做**（2026-07-12）：`docs/handoff/i4-smoke/`；LLM/HTTP 证据已归档；shell key 与 9router chat 对齐仍为运维项 |
| **指代/省略续问鲁棒性** | LLM 依赖模型与 host priors，未系统评测                                                                          |
| **澄清轮（0 tool）**    | 设计允许「意图不清先问」；未作为一等状态机落地                                                                  |
| **会话持久化**          | REPL 进程内；无跨进程会话恢复                                                                                   |
| **anthropic_tools**     | 仅 openai_tools；选 anthropic 会 fail-closed                                                                    |
| **全量 context 打包**   | history 有字符预算；未从窗口严格扣 system/tools/检索正文                                                        |

### 2.3 协议开放项（设计未决，禁止静默定稿）

见 `HANDOFF` §5 / `ADR-v0.1-assumptions-p3.md`：

- §7 `requireApprovalFor` 与治理 B 定位的最终产品规则
- 鉴权模型与角色/ACL 细节的批准
- 异步交互产品形态（队列 UX）
- `prior_chunks.summary` 生产方 / verify 批大小等（实现有默认，待书面批准）

### 2.4 运维与上线（P4）

| 缺口       | 说明                                    |
| ---------- | --------------------------------------- |
| 可观测性   | 无统一 trace_id、指标、告警、成本看板   |
| 限流与配额 | 无租户级 RPM/TPM 产品封装               |
| 部署与发布 | 无标准镜像/编排/健康检查发布流水线      |
| 密钥托管   | 依赖本机/OS env；无集成密钥管理系统说明 |

---

## 3. 未来展望

### 3.1 近端（建议 1–2 个迭代）

1. **真实语料与 query**
   - 导入一版脱敏 KB；替换 draft eval 的一部分 hard/edge。
2. **env 密钥对齐**
   - 将 `.env.local` 的 `NINE_ROUTER_API_KEY` 与 9router UI `iknow` key 同步（chat 401 根因）。
3. **会话小增强**
   - 可选会话导出/导入 JSON；澄清轮最小状态。
4. **观测最小集**
   - 结构化日志：conversation_id、turn、hops、tool 耗时、是否 llm。
5. **Web MVP 原型接入 CLI**
   - `iknow-prototype` 前端从 mock 切到真实 Session HTTP API；G2 信封（`tool_calls`/`governance_status`/`snapshot_id`/`source_spans`）可视化；产品 UI 栈 A/B 决策落 `docs/design/`。详见 `docs/handoff/2026-07-21-web-mvp-prototype.md`。

### 3.2 中期

1. **持久化 KB + 版本原子切换**（对齐 ADR chunk/fact 同 version）。
2. **向量存储升级**（pgvector 等）与索引增量更新。
3. **LLM 护栏硬化**（强制首跳 retrieve、冲突必 governance 等 host 规则可配置）。
4. **多轮 eval**（注入 priors 的 N 步样本 + trajectory 扩展）。
5. **Session API 增强**（鉴权、SSE、会话持久化）— Web 已走 Vite React SPA，不重开协议。

### 3.3 远期

1. **P4 工程化**：多租户、审计合规、审批流与企业 IdP 对接。
2. **人机协同**：requireApprovalFor 完整产品流（待开放项批准）。
3. **持续评测**：生产抽样 + 漂移告警 + 成本门禁。
4. **与上游 Company Brain 能力对照升级**：仅移植思路，保持 runtime 独立。

### 3.4 非目标（刻意不做）

- Runtime 链接或 vendoring 可执行 gbrain 树
- 用连续置信度替代三态 verify
- 为聊天新增第 5 个 KB tool 取代 host 会话层
- 用「展示层省略 snapshot」换取简洁 UI

---

## 4. 能力地图（一句话）

| 层                       | 状态                                                           |
| ------------------------ | -------------------------------------------------------------- |
| 协议与评测资产           | **有**（构造数据）                                             |
| 可运行 4-tool 引擎       | **已归档 023**（harness ACI 装饰层原型承接，PR #95）           |
| 向量 + LLM 接线          | **已归档 023**（harness anthropic-adapter 承接）               |
| CLI 多轮交互             | **有**（进程内会话）                                           |
| HTTP 会话 + Web SPA      | **有**（v0 内存会话 + Vite React `web/`→`dist`；SSE/鉴权未做） |
| 生产数据 / 持久化 / 上线 | **无或极弱**                                                   |

---

## 5. 常用命令（现状）

```bash
npm test
npm run eval  # retired (#48)
npx tsx src/cli.ts chat
npx tsx src/cli.ts ask "单次问题"

# Session API + static host (prefers web/dist after SPA build)
npx tsx src/cli.ts serve --port 8787
# or: npm run serve

# Frontend SPA (package under web/)
npm install --prefix web
npm run dev --prefix web      # Vite :5173, proxy /api → :8787 (run serve in another terminal)
npm run build --prefix web    # → web/dist  (root alias if present: npm run web:build)
# root alias if present: npm run web:dev
```

配置：`.env.local` + 环境变量中的 API Key（见 `docs/integration-materials.env.example`）。

---

## 6. 文档索引

| 文档                                       | 用途                       |
| ------------------------------------------ | -------------------------- |
| `docs/iknow-spec/HANDOFF.md`               | 阶段与开放项               |
| `docs/design/interaction-surface-v0.md`    | 交互设计与 I 阶段          |
| `docs/design/frontend-stack-upgrade-v1.md` | FE 栈决策（Vite React TS） |
| `docs/architecture.md`                     | 运行时能力切分             |
| `docs/CONTEXT.md`                          | 领域术语                   |
| `docs/CHANGELOG.md`                        | 版本变更                   |
| `docs/handoff/*`                           | 会话交接                   |
| 本文 `docs/STATUS.md`                      | **已实现 / 未实现 / 展望** |

---

_更新本文时：改代码能力后同步 §1–§2；改路线图时同步 §3；并在 CHANGELOG 留一条引用。_
