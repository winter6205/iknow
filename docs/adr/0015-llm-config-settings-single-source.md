# 0015. LLM 配置收敛到 settings.json 单承载 — model 字面 + apiKey 字段 + ${VAR} 占位符

Date: 2026-08-12
Status: accepted

> **Amendment 2026-09-19**（ADR-0113）：§1 仍是**主会话** `settings.llm.model` 缺失 fail-fast。可选 `settings.llm.liteModel` 不改变本条。
>
> **Amendment 2026-09-12**（ADR-0084 / `specs/agent-control-surface.md` Slice B）：§1 与 §2 引用的守卫文案中指向 `<cwd>/.iknow/settings.json` 的尾句 **superseded**——`llm` 是用户层键，项目文件只采纳 `hooks` / `verify` / `secrets` / `permissions`，文案只指向 `~/.iknow/settings.json`（`src/config/messages.ts`）。§1 model 字面唯一来源、§2 apiKey 单字段与占位符语义、§5 不动范围均不变。
>
> **Amendment 2026-09-13**（ADR-0093 / #1010）：§2「取代 `apiKeyEnv` 间接寻址」**重开**——`settings.llm.providers[i].apiKeyEnv` 在**用户层注册表内**重新引入 per-provider 变量名（只直读 `process.env[apiKeyEnv]`，不回落 `.env.local` / `.env` fileMap；env 缺席 → typed 抛错，不回退字面 `apiKey`）。§2 其余条款不变：全局 `IKNOW_LLM_API_KEY_ENV`、`LlmEnv.apiKeyEnv` 字段、未命中 provider 路径的 `settings.llm.apiKey` 占位符链路均仍如原文。§1 model 字面唯一来源与缺失 fail-fast 不变，该字面现可读作 `provider/model` 路由 ID。

## Context

iknow 历史上 LLM 配置存在多个并存入口（ADR-0001 substack 的体现）：

- **`env.ts` 硬编码 `m3-combo`**（m3-combo 9router 路由 ID 焊死作代码默认）
- **`env.ts` 间接寻址 `apiKeyEnv` 字段**（读 `process.env[IKNOW_LLM_API_KEY_ENV]`，默认 `ANTHROPIC_AUTH_TOKEN`），任何 secret 都是变量名查找
- **`process.env[IKNOW_LLM_MODEL]`**（env 直读覆盖 model）
- **`.env.local`** 兜底

四个口 + 两条 precedence，开发者心智分裂；用户视角"模型到底在哪改"无唯一答案（issue #353 第二阶段已立项）。硬编码兜底 + 间接寻址也使 iknow 业务接口对外暴露外部企业的变量名（`ANTHROPIC_AUTH_TOKEN`），与「让 iknow 业务接口不出现外部企业变量名」的项目目标冲突。

`#353 settings 机制`（第一阶段）已建好 `settings.json` 的承载能力（user + project 合并、drop-not-throw、深 frozen），但模型 / API key 两个字段未接入。

## Decision

**`settings.json` 是 LLM 配置唯一承载点。** 三项具体收敛：

### 1. `settings.llm.model` 字面值唯一来源

- **SSOT** = `settings.llm.model`（trim 后非空字符串）——**主会话**路由。后台无工具补全另见可选 `settings.llm.liteModel`（ADR-0113）；lite 缺席不改变本条 fail-fast。
- **缺失 → fail-fast**：`loadIknowEnv` 抛「iknow: no LLM model configured in settings.llm.model. Set it in ~/.iknow/settings.json (or <cwd>/.iknow/settings.json).」
- **退役**：`process.env[IKNOW_LLM_MODEL]` 不再被任何代码读取（含 env.ts / scripts / i135 smoke / 4 个 serve-path 测试 fixture）
- **不写占位符**：model 字段不展开 `${VAR}`，model 路由 ID 是声明的、字面的、可读代码评审的

### 2. `settings.llm.apiKey` 单字段（取代 `apiKeyEnv` 间接寻址）

- **SSOT** = `settings.llm.apiKey`（接受两种形态二选一）：
  - **字面值**：`"apiKey": "sk-abc123..."` — 直接落 key
  - **占位符**：`"apiKey": "${ANTHROPIC_AUTH_TOKEN}"` — 解析时从 `process.env` → `.env.local` 兜底展开
- **缺失 → undefined**（不 fail-fast；不读默认变量名；不硬编码任何名字）。消费点守卫抛「LLM mode needs API key. Set settings.llm.apiKey (literal or ${VAR} placeholder) in ~/.iknow/settings.json or <cwd>/.iknow/settings.json.」
- **`LlmEnv` 接口删除 `apiKeyEnv` 字段**：间接寻址机制退役；`LlmEnv` 接口只剩 `apiKey: string | undefined`
- **退役**：`IKNOW_LLM_API_KEY_ENV` env 变量（连同其「选择 key 变量名」开关）完全退役；`ANTHROPIC_AUTH_TOKEN` 不再作为代码默认变量名

### 3. `.env.local` 退化为纯 env var 装载器

- 唯一作用：`KEY=VALUE` 注入 `process.env`
- 仅作 `${VAR}` 占位符的真值源之一
- **不再直接当 model 配置口**（之前 `IKNOW_LLM_MODEL` 还能从 `.env.local` 读的字面，已退役）

### 4. sandbox 遮蔽层

`src/harness/sandbox/env-isolation.ts` 的 `placeholderVarNames()` / `configuredSecretNames()` / `currentSecretValues()` 改为解析 `settings.llm.apiKey` 原始形态：

- **占位符串**（`${VAR}` / `$VAR` 任意合法组合，含多段 `${A}${B}` 与字面 + 占位符混合如 `${A}literal`）→ 变量名去重数组进 `configuredSecretNames()`（`extractPlaceholders` 共用 settings.ts 的占位符正则源）。SC20 遮蔽作用到多段 / 混合形态（M1 修复多段遮蔽漏洗）。
- **字面值**（trim 后非空、不含 `$IDENT` / `${VAR}` 形态）→ 变量名不进 env 扫描；其 trimmed 值进 `currentSecretValues()` 的内存遮蔽集（M3 修复字面密钥回显 SC20 遮蔽失效）。drift 风险（字面值变化时遮蔽集不自动更新）见 ADR Concrete Quiddity。

**完全 settings 驱动**，业务层（含 `LlmEnv` 接口）不再含任何外部企业变量名。

### 5. 其它 env 字段（不动范围）

`maxTurns` / `compress` / `stream` / `thinking` / `maxOutputTokens` / `timeoutMs` / `temperature` / `thinkingEffort` / web.* / mcp.* 等 env 字段保持现状 `process.env > .env.local > .env > defaults`。本 ADR 只收敛 LLM `model` + `apiKey` 两个字段。

## Consequences

### Positive

- **配置唯一地址**：用户回答「model 在哪改」只需说 `settings.json` 一个地方（fail-fast 文案也指向同一地址）
- **业务接口清洁**：`LlmEnv` 接口不出现 `ANTHROPIC_AUTH_TOKEN` / `m3-combo` 等外部企业标识字面量
- **占位符语义友好**：`shell export` 临时切模型也走 `${VAR}` 解析（`.env.local` 兜底），与进程外团队习惯一致
- **可读性**：settings 文件直接审阅，无需在代码与外部环境间穿梭验证
- **测试隔离**：`tests/_helpers/install-test-settings-source.ts` 利用 `HOME` 重定向 + fork-local tmp dir，每个 vitest fork 独立 settings，不共享可变状态

### Negative / Trade-offs

- **失去「.env.local 直接覆盖 model」**：原来 `.env.local` 写 `IKNOW_LLM_MODEL=xxx` 即可修改，**现在需要改 `settings.json`**。如果用户在 `.env.local` 残留 `IKNOW_LLM_MODEL` 行，会形成视觉噪声但不影响行为（不再被读取）
- **失去「env 变量名可覆盖」**：原来 `IKNOW_LLM_API_KEY_ENV=OTHER_KEY` 可改变 iknow 找 key 的变量名，**现在 API 引用名仅由 settings 占位符决定**。如果团队习惯用 `LLM_API_KEY` 之类的非默认名，需在 settings.json 写 `"apiKey": "${LLM_API_KEY}"` 显式绑定
- **占位符语法局限**：仅 `${VAR}` / `$VAR` 形式，无 `$$` 转义、无默认值表达式（如 `${VAR:-default}`，**显式拒绝**——避免引入隐性兜底）
- **mental-model 迁移**：原 `.env.local` 是配置载体的认知根深，新机制要求**所有模型 / 密钥配置落到 settings 文件**，`.env.local` 仅作占位符真值源

### Concrete Quiddity

字面 apiKey（settings.llm.apiKey 形如 `"sk-..."`）的 SC20 遮蔽依赖 `currentSecretValues()` 在每次调用时**实时**读 settings 拿 trimmed 值（`env-isolation.literalApiKey()`，每次 call 现取 `loadIknowSettings()`，模块顶层 SECRET_ENV_NAMES 不缓存字面值）。drift 风险：

- settings.llm.apiKey 字面值在两次遮蔽调用之间被改 → 旧字面值仍进遮蔽集直到缓存失效（M3 实施选择：**不缓存字面值**，每次 call 现取，避免此 drift）。
- 字面值在 trace 文件、stdout、stderr 中如已被原样打印 → 历史数据无法事后回溯遮蔽（这是输出写侧的纪律，非 SC20 能修复）。settings 写入 / 改写期间必须配合 `currentSecretValues()` 的实时语义。

### Reversibility

**Hard to reverse**（满足 ADR 三条件）：改动跨 src/ + tests/ + scripts/ + docs/ 4 个域 30+ 文件，触及 `LlmEnv` 接口字段（删除）、fail-fast 路径、sandbox 遮蔽层。撤回需还原所有调用点 + 重新引入间接寻址机制，代价大。

### 实现要点

- `src/config/settings.ts` + `isApiKeyOrPlaceholder` validator；`IknowSettingsLlm.apiKey?: string` 字段
- `src/config/env.ts` `expandPlaceholders()` helper（处理 `${VAR}` / `$VAR`，从 `process.env` → `.env.local` 兜底，找不到 → `undefined`）
- `src/harness/build-engine.ts` / `src/tui/deps.ts` / `src/session-api/thinking-override.ts` 守卫文案统一
- `src/cli.ts` ask 错误 JSON envelope 字段 `apiKeyEnv` → `apiKey`
- `src/harness/sandbox/env-isolation.ts` 解析 settings 形态驱动清洗列表
- 测试 fixture (`LlmEnv` 字段) 清理 9+ 文件；4 个 serve-path 测试从 `process.env.IKNOW_LLM_MODEL = "test-model"` 改为 `installTestSettingsSource()` helper
- `scripts/i135-settings-model-extension-smoke.ts` 重写为 A/B/C/D 四组（settings 生效 / model 缺失 fail-fast / apiKey 缺失守卫 / 字面 apiKey）
- `scripts/i153-probe-9router-thinking.ts:459` 等 probe 脚本清理 `process.env.IKNOW_LLM_MODEL` 直读

## Supersedes

- **ADR-0001**（`docs/adr/0001-9router-stack-as-code-defaults.md`）的 2026-08-12 Update 段（移除了 `m3-combo` 兜底）—— 本 ADR 进一步：① `apiKeyEnv` 间接寻址机制一并退役；② `IKNOW_LLM_MODEL` / `IKNOW_LLM_API_KEY_ENV` 整个 env 变量名机制退役；③ model 来源改为 settings 字面唯一，不经 env 中转
- ADR-0001 的「项目栈默认（key 变量名 `ANTHROPIC_AUTH_TOKEN`、provider/baseUrl `http://localhost:20128/v1`）焊进 env.ts 代码默认」机制**保留**（provider/baseUrl 与 key 变量名默认是两个问题，本 ADR 不动 provider/baseUrl 的代码默认）；但 `ANTHROPIC_AUTH_TOKEN` 不再作为**默认 key 变量名**——若需在 settings 引用，**用户必须显式写 `${ANTHROPIC_AUTH_TOKEN}` 占位符**

## Evidence

- Phase 1 tracer bullet (`scripts/i164-tracer-bullet-model.ts`) 四组实测：
  - A 组：settings `{model: "ocg/deepseek-v4-flash", apiKey: "${ANTHROPIC_AUTH_TOKEN}"}` → 真实调用成功，wire `model` 字段 `ocg/deepseek-v4-flash` → 9router 改写响应 `deepseek-v4-flash`（content "OK" 非空）
  - B 组：settings `{}` → fail-fast 抛「no LLM model configured in settings.llm.model」, exit 1
  - C 组：settings `{model: "..."}` + `ANTHROPIC_AUTH_TOKEN=""` → 守卫抛「no API key configured」, exit 1
  - D 组：settings 字面 `"apiKey": "sk-..."` → 不依赖 env 跑通
- `npx tsc --noEmit` 退出 0
- `npm test` 2416/2417 通过（仅 SC8 预存 flaky；与本改动无关）
- 全程 key 仅通过 `ANTHROPIC_AUTH_TOKEN` env 注入；settings 文件、fixtures、scripts、日志均无明文 key 落盘

## 关联

- `plans/settings-model-extension.md`（tracer bullet / validation 详述）
- `#353 settings 机制`（settings 读取能力基建）
- `docs/CONTEXT.md §83`（LLM 配置 SSOT 边界，需同步更新）
- PR #391（实现 PR）
