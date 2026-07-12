# Handoff — 2026-07-13 session closeout

> 会话收尾：进度 + 问题 + 下步。不含任何 API key 明文。

## 1. 本会话交付（进度）

| 切片 | 状态 | Tip / 证据 |
|------|------|------------|
| Session HTTP API + 静态 host | 已合入 | `c5d0266` 等 session-api 线 |
| 产品 SPA（Vite React TS） | 已合入 | `198759b` |
| serve → `web/dist` + SPA fallback | 已合入 | `5626110` |
| 前端审查修复 live-review.198759b | 已合入 | `2eb0ea4` |
| I4 三模式 + HTTP 冒烟 | 已合入 | `b5abe8e` + `docs/handoff/i4-smoke/` |
| LLM SSE trailer 解析 | 已合入 | `0068405` |

**当前 tip（收尾前）**: `b5abe8e`（收尾 commit 若追加见 git log）

### 产品面一览

- **CLI**: `chat` / `ask` / `serve`
- **API**: `/api/v1/health|sessions|messages|commands|reset`；events **501**
- **UI**: `web/` SPA，G2 侧栏；`npm run web:build` → `web/dist`
- **协议**: 4 tool 未改；G2 仍硬约束

## 2. 问题与开放项（整理）

### P1 — 9router 与 `NINE_ROUTER_API_KEY`（沟通已澄清）

| 事实 | 说明 |
|------|------|
| 变量名 | 正确且唯一：`NINE_ROUTER_API_KEY`（不换名） |
| 操作者立场 | 用 9router 发的 key 设进该变量，本机认为可用 |
| Agent 实测 | 同 key：`GET /models` **200**；`chat` / `embeddings` 曾 **401** |
| 结论 | 不是「换环境变量名」；是 **同名下的值对某 endpoint 是否被接受**，或 **agent 进程 env ≠ 操作者终端 env** |
| 探针 | `npx tsx scripts/i4-probe-nine-endpoints.ts`（只打 status，不打印 key） |

### P2 — 已修（勿当未修）

- 9router 非流式响应后带 `data: [DONE]` → `parseLlmResponseJson` + `stream: false`
- SPA 异步竞态 / mode-role 确认 / composer 清稿 / sourcemap 默认关

### P3 — 未做（下会话）

| 项 | 说明 |
|----|------|
| I5 多轮 trajectory eval | 可选 |
| message_id / 会话持久化 | Session API v1 |
| 真实 KB 语料 | seed 仍合成 |
| SSE 流式 | 预留 501 |
| 鉴权 / P4 上线 | 开放项 |

## 3. 验证（verification-before-completion）

```text
npm run typecheck     → exit 0（收尾前已跑过）
npm test              → 163 pass（含 llm-client-parse + session-api）
npm run web:build     → exit 0（SPA 升级时）
I4 artifacts          → docs/handoff/i4-smoke/* PASS 矩阵
```

复跑命令见 `docs/handoff/i4-smoke/README.md`。

## 4. Task-end ritual 索引

| Q | 产物 |
|---|------|
| Q1 学到什么 | `docs/CONTEXT.md`（Session API / SPA / parseLlmResponseJson / NINE_ROUTER 歧义） |
| Q2 状态变了 | `Claude.md` Runtime map 更新 |
| Q3 业务变更 | `CHANGELOG.md` + 本 handoff + `docs/handoff/i4-smoke/` |

## 5. 建议下会话第一刀

1. 操作者终端跑 `scripts/i4-probe-nine-endpoints.ts` 确认 chat 是否 200  
2. 若 200：日常 `chat --mode llm` / Web 联调即可  
3. 产品下一功能：message_id + 会话列表，或真实语料导入（二选一开 plan）

## 6. 未纳入 git 的本机噪音

- `.claude/*` 本地规则改动（若有）  
- `ocr-reports/`、`code-reports/`  
- 勿提交密钥 / `.env.local`

---

**成功 =** 进度表 + 问题表可交接；Q1–Q3 已落盘；无密钥进仓。
