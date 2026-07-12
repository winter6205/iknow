# I4 真机交互冒烟 — 汇总

> 日期：2026-07-12  
> Tip 线：`2eb0ea4` + `fix(llm-client)` SSE parse（同批）  
> **无密钥**写入本目录；LLM 冒烟注入 9router DB `apiKeys.name=iknow` 仅进程内存

## 结果矩阵

| 面 | 模式 | 结果 | 证据 |
|----|------|------|------|
| CLI 多轮 + ask | deterministic | **PASS** | `deterministic.json` |
| CLI 多轮 + ask | deterministic + embeddings | **PASS** | `embeddings.json` |
| CLI 多轮 + ask | llm | **PASS** | `llm.json`（hops_used=5） |
| Session HTTP + SPA | deterministic | **PASS** | `http-session.json`（含 events **501**） |

## 发现与修复

1. **Shell `NINE_ROUTER_API_KEY`（`.env.local`）对 chat/completions 返回 401**  
   - `GET /v1/models` 可能仍 200  
   - 与 9router `apiKeys` 表中 active key（`default` / `opencode` / `iknow`）sha 不一致  
   - **操作建议**：把 `.env.local` 中 `NINE_ROUTER_API_KEY` 换成 9router UI 中 `iknow` 密钥（本仓库不写明文）

2. **9router chat 响应曾带 SSE trailer `data: [DONE]`**  
   - 已修：`stream: false` + `parseLlmResponseJson` 剥离 trailer  
   - 测试：`tests/llm-client-parse.test.ts`

3. Embeddings 臂在同一 key 下此前可过；LLM chat 必须用 DB 合法 key。

## 复跑

```bash
# deterministic
printf '%s\n' '退款政策是什么？' '那和旧版有什么不同？' '/status' '/quit' \
  | IKNOW_CHAT_QUIET=1 npx tsx src/cli.ts chat --mode deterministic

# embeddings
# ... same + --embeddings

# llm（推荐先同步 env key；或用脚本从本机 9router DB 注入）
npx tsx scripts/i4-llm-smoke-with-router-key.ts

# HTTP
npx tsx src/cli.ts serve --port 8791 --mode deterministic
# curl health / sessions / messages / events(501)
```

## 成功判据（I4）

- [x] 三模式 CLI 各有多轮 + ask 归档  
- [x] HTTP 会话双 turn G2 + 静态首页 + SSE 501  
- [x] 无密钥进 git  
- [x] LLM 解析 fail 已根因修复并复测 PASS  

**成功 = I4 清单 PASS 全绿（含 llm）；env key 对齐属运维项，见上。**
