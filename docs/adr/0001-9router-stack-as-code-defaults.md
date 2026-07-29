# 0001. Bake 9router stack (key var + model) into env.ts code defaults

Date: 2026-07-29
Status: accepted

iknow 钉死 9router 作为唯一 LLM/embedding 提供方 + m3-combo 作为主模型：把 `NINE_ROUTER_KEY`（LLM/embedding 共用 key 变量名）、`m3-combo`（9router 路由 ID）焊进 `src/config/env.ts` 作为代码默认。`.env.local` 只需持有密钥值本身，不再需要重复声明 `IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` / `IKNOW_EMBEDDING_API_KEY_ENV`。

**Why not B/C:**

- _Pure transport (env.ts 0 默认，所有 9router 配置全靠 .env.local + .env.example)_：贴合"env 只传 local"心智，但项目栈完全不进 git，新 clone 必须先建 `.env.local`，且 git 历史无法回答"iknow 主打哪个 model"——对一个固定打 9router 的产品而言代价过高。
- _每台机器都覆盖（不设默认，依赖 .env.local）_：等于 (1) 的退化版，重复 .env.example 的负担且无任何收益。

**Consequences / Trade-offs:**

- _Applied:_ drift 根因（同一变量在 env.ts 默认 + .env.local 双源）消失；新 clone 填 key 即跑；`loadIknowEnv` 默认链与 `.env.local` 真值对齐；活测试断言的 key 名同步成 `NINE_ROUTER_KEY`。
- _Trade-offs:_ 切换 model 需改代码（env.ts 默认），不再纯靠 `.env.local` 切换——可接受，因为 9router 路由切换属于项目级栈决策，git history 留痕比 .env.local 更稳。

**Evidence pointers:**

- env.ts 默认值 drift 导致 `NINE_ROUTER_API_KEY` (默认) vs `NINE_ROUTER_KEY` (.env.local) 的两源歧义，本次 commit `3d4da40` 统一。
- 全套 vitest (25 files / 233 tests) 通过；纯代码默认探针（空 cwd 无 .env.local）输出 `m3-combo` / `NINE_ROUTER_KEY` ✓。
