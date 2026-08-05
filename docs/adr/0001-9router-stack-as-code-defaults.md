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

---

## Update (2026-08-05): key 变量名默认 NINE_ROUTER_KEY -> ANTHROPIC_AUTH_TOKEN

本 ADR 原决策「`NINE_ROUTER_KEY` 焊进 env.ts 作 key 变量名默认」的**现态部分**已修正：`src/config/env.ts` 的 fallback 从 `NINE_ROUTER_KEY` 改为 `ANTHROPIC_AUTH_TOKEN`，对齐实际部署（部署环境只有 `ANTHROPIC_AUTH_TOKEN`，无 `NINE_ROUTER_KEY`）+ 通用生态命名。

**为何修正（不是推翻整条 ADR）：** ADR-0001 的核心主张 -- "key 变量名 + 主模型作为代码默认焊进 env.ts，`.env.local` 只持值" -- 依然成立并保留。被修正的只是"具体变量名选哪个"这一可逆细节：`NINE_ROUTER_KEY` 是 9router 专属命名，对不接触 9router 历史的人/项目是噪声（issue #173 暴露的探针变量名漂移即其一）；`ANTHROPIC_AUTH_TOKEN` 是通用生态名，新 clone 配一个变量即跑。

**未变部分：**

- `m3-combo` 作为主模型默认 -- 保留。
- `.env.local` 只持值、`IKNOW_LLM_API_KEY_ENV` 可覆盖变量名 -- 保留（机制不变，只是默认值变了，原 `.env.local` 里冗余的 `IKNOW_LLM_API_KEY_ENV=ANTHROPIC_AUTH_TOKEN` 行可删）。
- `process.env > .env.local > .env` 优先级 -- 保留。

**关联：** issue #173（探针变量名漂移）、PR #190。历史叙事中的 `NINE_ROUTER_KEY` / `NINE_ROUTER_API_KEY` 字面值在 CHANGELOG / handoff / plans 等历史记录中保留不擦（git 可追溯性）。
