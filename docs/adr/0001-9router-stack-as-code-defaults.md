# 0001. Bake 9router stack (key var + model) into env.ts code defaults

Date: 2026-07-29
Status: deprecated

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

**为何修正（不是推翻整条 ADR）：** ADR-0001 的核心主张 -- "key 变量名 + 主模型作为代码默认焊进 env.ts，`.env.local` 只持值" -- 依然成立并保留。被修正的只是"具体变量名选哪个"这一可逆细节：`NINE_ROUTER_KEY` 是 9router 专属命名，对不接触 9router 历史的人/项目是噪声（探针变量名漂移即其一）；`ANTHROPIC_AUTH_TOKEN` 是通用生态名，新 clone 配一个变量即跑。

**未变部分：**

- `m3-combo` 作为主模型默认 -- 保留。
- `.env.local` 只持值、`IKNOW_LLM_API_KEY_ENV` 可覆盖变量名 -- 保留（机制不变，只是默认值变了，原 `.env.local` 里冗余的 `IKNOW_LLM_API_KEY_ENV=ANTHROPIC_AUTH_TOKEN` 行可删）。
- `process.env > .env.local > .env` 优先级 -- 保留。

**关联：** 历史叙事中的 `NINE_ROUTER_KEY` / `NINE_ROUTER_API_KEY` 字面值在 CHANGELOG / handoff / plans 等历史记录中保留不擦（git 可追溯性）。

---

## Update (2026-08-06): Status → deprecated

本 ADR 状态标记为 `deprecated`（非 `superseded by NNNN`——它未被单一新 ADR 取代）。原因：原始决策的 **embedding 臂已随 023 归档**（harness 为通用 agent，无向量检索），**key 变量名默认已由 2026-08-05 Update 段修正为 `ANTHROPIC_AUTH_TOKEN`**。核心机制（「项目栈默认焊进 `env.ts`，`.env.local` 只持值」）仍有效，故保留文件、不删不归档；`docs/archive/024-archive-memory-assistant-era/` 记录了同批归档。读取本 ADR 时以 2026-08-05 Update 段的现态为准。

---

## Update (2026-08-12): 模型默认条款 supersede — settings.llm.model 可配置，移除 hardcoded m3-combo

本 ADR 原决策「`m3-combo` 作为主模型焊进 `src/config/env.ts` 代码默认」的**现态部分**已由 settings 机制（第二阶段）supersede：模型默认从「焊死」改为「可配置 + fail-fast」——`src/config/settings.ts` 的 `IknowSettingsLlm` 新增 `model?: string` 与 `fallback?: string[]` 字段，`src/config/env.ts` 的 model 链改为 `env > settings`，**无任何代码默认**。

**supersede 边界（其余条款保留）：**

- **移除 hardcoded `m3-combo`**：`env.ts` 不再回退 `"m3-combo"`。
- **未配置 model → fail-fast（typed error）**：`IKNOW_LLM_MODEL` 与 `settings.llm.model` 均缺席时，env loader 抛「iknow: no LLM model configured…」，不再静默走任何默认。
- **fallback 由用户自配**：新增 `settings.llm.fallback?: string[]`（用户声明模型 fallback 路由 ID 列表），代码不预置任何 fallback；`env.llm.fallback` 未配时 = `[]`。
- **env 仍最高**：`IKNOW_LLM_MODEL`（env）优先于 `settings.llm.model`；fallback 仅来自 settings。
- **未变部分**：key 变量名默认 `ANTHROPIC_AUTH_TOKEN`、provider/baseUrl `http://localhost:20128/v1` 仍焊进 env.ts 代码默认；`.env.local` 只持值、`IKNOW_LLM_API_KEY_ENV` 可覆盖变量名 —— 保留。

**关联：** settings 机制第一阶段。

---

## Update (2026-08-12): 后续条款 supersede — ADR-0015 settings 单承载收敛

本 ADR 剩余「项目栈默认焊进 `env.ts`」条款中，**key 变量名间接寻址 + model 的 env 覆盖机制**已被 `docs/adr/0015-llm-config-settings-single-source.md`（settings-model-extension Phase 1+2）supersede：LLM 配置收敛到 `settings.json` 单承载。

**supersede 边界（本次新增，覆盖上文 2026-08-12 段的部分内容）：**

- **`apiKeyEnv` 间接寻址退役**：`LlmEnv.apiKeyEnv` 字段已删。key 唯一来源 = `settings.llm.apiKey`（字面值或 `${VAR}` / `$VAR` 占位符），经 `expandPlaceholders` 从 `process.env[VAR]` > `.env.local` > `.env` 解析；不再有「key 变量名」概念。
- **`IKNOW_LLM_API_KEY_ENV` 机制退役**：不再有覆盖 key 变量名的 env 支（ADR-0001 2026-08-05 Update 段的该条款随之失效）。
- **`IKNOW_LLM_MODEL` 退役**：上文 2026-08-12 段「env 仍最高：`IKNOW_LLM_MODEL`（env）优先于 `settings.llm.model`」条款失效——`env.ts` 不再读 `IKNOW_LLM_MODEL`，model 唯一来源 = `settings.llm.model` 字面值（缺失 fail-fast）。
- **`.env.local` 职责收窄**：退化为占位符真值源（`settings.llm.apiKey` 的 `${VAR}` 变量在 `.env.local` 里的值），不再直接当 model / key 变量名的配置口。

**保留条款（未被 0015 supersede）：**

- provider = 9router、baseUrl 代码默认 `http://localhost:20128/v1` 仍焊进 `env.ts`（`IKNOW_LLM_BASE_URL` fallback）。
- `.env.local` 只持值（占位符真值）；`process.env > .env.local > .env` 优先级对非 LLM 配置字段仍保留。
- 无默认变量名、无硬编码兜底 model（0015 延续 2026-08-12 段的 fail-fast 纪律）。

**关联：** `docs/adr/0015-llm-config-settings-single-source.md`、`docs/CONTEXT.md` §83。
