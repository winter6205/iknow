# Plan: settings 机制扩字段 — `llm.model` + `llm.fallback` 入 settings（最终架构）

Tracer bullet，承接 #353（settings 机制）的第二阶段 + **settings-model-extension 收敛收尾（Phase 2）**：把 LLM 配置（model + apiKey）从「env + 硬编码 / key 变量名间接寻址」收敛到 `settings.json` **单承载**。

**最终架构（ADR-0015 `docs/adr/0015-llm-config-settings-single-source.md`，现态真值）：**

- `settings.llm.model`（字面值，唯一 model 来源，trim 后非空串）：缺失 → `loadIknowEnv` fail-fast 抛「no LLM model configured in settings.llm.model」，**无任何代码默认 / 无 env 覆盖**（`IKNOW_LLM_MODEL` 已退役，不再读取）。
- `settings.llm.apiKey`（字面 / `${VAR}` / `$VAR`）：唯一 key 承载。字面 → 原样；占位符 → 经 `expandPlaceholders(value, fileMap)` 从 `process.env[VAR]` > `.env.local` > `.env` 解析（process.env 优先，fileMap 兜底）。解析不到 → undefined（消费点守卫抛「no API key configured」）。**`IKNOW_LLM_API_KEY_ENV` 已退役，`LlmEnv.apiKeyEnv` 字段已删**（不再有「key 变量名」概念）。
- `settings.llm.fallback?: string[]`：用户自配 fallback 路由 ID 列表（代码不预置）。
- `.env.local` 退化为**占位符真值源**（持有 `${VAR}` 指向的变量值本身），不再是 model / key 变量名的配置口。
- provider = 9router、baseUrl 代码默认 `http://localhost:20128/v1`（`IKNOW_LLM_BASE_URL` 仍读）—— 项目级栈决策保留。

ADR: supersede ADR-0001 的「m3-combo 焊死 + key 变量名间接寻址」条款 → 模型配置改为可配置 + fail-fast + apiKey 单承载（ADR-0015），**移除 hardcoded `m3-combo` 兜底 + `apiKeyEnv` / `IKNOW_LLM_MODEL` / `IKNOW_LLM_API_KEY_ENV` 机制**。

---

## Architecture Change Reviewer verdict

- bounded-context-guardian: yes — 改动仍在 `src/config/` 既有 bounded context（#353 已确立）。`settings.ts` 是配置模块，`env.ts` 是 env loader，无跨模块泄露。tests 走既有 `tests/config/`。
- defensive-contract-validator: yes — 边界测试覆盖：settings.llm.model 缺失/空串/非 string 类型/合法 string；settings.llm.fallback 缺失/空数组/非数组/含空串项/含非法项/合法数组；user vs project 覆盖；project 非法不覆盖 user 合法；env > settings 优先级链 + env 与 settings 都没 model → fail-fast 抛错；深 frozen 保持。
- error-handling-enforcer: yes — 双层纪律分离：settings 层「drop-not-throw」（非法字段值丢弃不抛错，文件不存在/坏 JSON 返回空对象）；env 层对「model 完全无来源」fail-fast 抛 typed error（不再静默走任何默认），错误信息给出修复指引。`src/harness/sandbox/env-isolation.ts` 的模块顶层 `loadIknowEnv()` 用 `safeLlmApiKeyEnv()`（try/catch 退化）防御，安全层任何环境可加载。
- complexity-anti-drift: yes — 最小改动：settings.ts 加 2 个 validator + parseLlm/mergeLlm 各加数行 + 空输出判断加 fallback；env.ts model 计算提到 `return` 前（envOptional ?? settings + fail-fast 抛错）+ fallback 行。函数体 < 40 行，分支数 +1。
- minimal-change-verifier: yes — 1 逻辑任务（让 settings.llm.model/fallback 成为模型配置寻址位 + 移除 hardcoded 兜底 + fail-fast）；1 commit；ADR supersede 决议与代码同 commit（按 docs/CONTEXT.md 闭路契约，ADR 是该决策的 rationale，不是独立 commit）；CHANGELOG/CONTEXT 同步更新视为同一任务附属，无独立 refactor。

---

## Problem statement

现状（src/config/env.ts，改动前）：

```ts
model:
  envOptional({ file, key: "IKNOW_LLM_MODEL" }) ??
  mergedSettings.llm?.model ??
  "m3-combo",
```

`process.env > .env.local > .env > settings > hardcoded "m3-combo"`，末位是硬编码兜底。

用户诉求（裁定）：模型配置 SSOT 应在 `~/.iknow/settings.json`（全局）+ `<cwd>/.iknow/settings.json`（项目）里；env 仍可 override；**不硬编码 m3-combo 兜底**——未配 model 时 fail-fast 抛错（typed error，不静默走任何默认）；fallback 由用户经 `settings.llm.fallback?: string[]` 自配，代码不预置。`.env.local` 不再承载模型值（消除第二源 drift，ADR-0001 §CONTEXT.md 早有限定）。

---

## Tracer bullets

1. `src/config/settings.ts`：给 `IknowSettingsLlm` 加 `model?: string` 与 `fallback?: string[]` 字段；新增 `isNonEmptyString` / `isNonEmptyStringArray` validator（数组 + 全非空串字符串 + 至少 1 项）；`parseLlm` / `mergeLlm` 接入 model / fallback 字段（同字段 project > user 替换；project 非法不覆盖 user 合法；drop-not-throw）；空输出判断加 `fallback === undefined`。
2. `src/config/env.ts`：model 来源改为 `envOptional(IKNOW_LLM_MODEL) ?? settings.llm.model`，**无任何代码默认**；两者均缺席 → fail-fast 抛「iknow: no LLM model configured…」（typed error）。`LlmEnv` 加 `fallback: string[]` = `settings.llm.fallback ?? []`。保持 process.env > .env.local > .env 三层不变。
3. `tests/config/settings.test.ts`：新增 model/fallback 解析/合并用例 — 缺失/空串/非 string/合法 string（array）/含空串项/非数组/含非法项；user/project 覆盖；非法 project 不覆盖 user；深 frozen；与既有 maxTurns/compress 用例同构。
4. `tests/config/env.test.ts`（如有）：新增 env + settings 优先级链 + fail-fast 用例 — settings.llm.model 在无 env 时生效；env 仍最高；env 与 settings 都没 model → **抛错**（不是回退 m3-combo）；settings.llm.fallback 透传 / 未配 → []。
5. ADR / CONTEXT 同步：`docs/adr/0001-9router-stack-as-code-defaults.md` 增补「supersede by settings-model-extension：模型配置改为可配置 + fail-fast，**移除 hardcoded m3-combo**」；`docs/CONTEXT.md` §83 SSOT 表述补「未配置 settings.llm.model 且未设 IKNOW_LLM_MODEL → 启动 fail-fast；fallback 由用户自配」。
6. CHANGELOG.md：增条目（settings.llm.model / settings.llm.fallback 新增；移除 hardcoded m3-combo；未配 model 启动抛错）。
7. 真实模型 e2e：smoke 脚本 `i135-settings-model-extension-smoke.ts` —「settings 改 model 后模型名实际生效」用例（用 ANTHROPIC_AUTH_TOKEN 环境变量 key）；B 组断言**无 settings → loadIknowEnv 抛「no LLM model configured」**（fail-fast，不再有兜底真值 case）。

---

## Files changed (Phase 1 + Phase 2)

**Phase 1（model 可配置 + fail-fast）**:

- `src/config/settings.ts`（`IknowSettingsLlm` + `model?` + `fallback?` + validators）
- `src/config/env.ts`（model 链 `envOptional(IKNOW_LLM_MODEL) ?? settings.llm.model` + fail-fast）
- `src/harness/build-engine.ts` / `src/tui/deps.ts` / `src/session-api/thinking-override.ts`（守卫文案对齐）
- `src/harness/sandbox/env-isolation.ts`（`safeLlmApiKeyEnv` 防御模块顶层 loadIknowEnv 抛错）
- `tests/config/settings.test.ts` / `tests/config/env.test.ts`（model/fallback 用例）
- 测试 fixture `apiKeyEnv` 清理 9+ 文件 + `tests/_helpers/install-test-settings-source.ts`
- `docs/adr/0015-llm-config-settings-single-source.md`

**Phase 2（apiKey 单承载 + env 机制退役 + docs 同步）**:

- `src/config/env.ts` 新增 `expandPlaceholders(value, fileMap)`（process.env 优先 + fileMap 兜底 + `yes` 占位符过滤 + 非法 `${...}` 形态 → undefined）
- `src/config/env.ts` 移除 `IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` 读取，移除 `LlmEnv.apiKeyEnv` 字段
- `src/harness/sandbox/env-isolation.ts` 的 `configuredSecretNames` 从 settings 占位符解析 secret 变量名
- `scripts/i135-settings-model-extension-smoke.ts` 整脚本重写为 A/B/C/D 四组真实模型验证（settings 占位符 / 无 settings fail-fast / 缺 key 守卫 / 字面 key 不依赖 env）
- `scripts/i153-probe-9router-thinking.ts` model 解析改 `loadIknowEnv().llm.model`
- `scripts/i9/i10/i11/i132/i4/i12/t4` 7 个 probe/smoke 清理 `apiKeyEnv` / `IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` 字面值
- `tests/config/env-expansion.test.ts`（新增 25 个边界用例）
- `tests/config/settings.test.ts` / `tests/config/env.test.ts` / `tests/harness/sandbox/env-isolation.test.ts`（新增 30 个用例）
- `docs/CONTEXT.md` §83 / `docs/adr/0001-…md`（supersede by 0015 段）/ `CHANGELOG.md` / `README.md` / `CLAUDE.md` / `docs/architecture.md` / `docs/STATUS.md` / `docs/integration-materials.env.example` 同步

---

## Validation（Phase 2 实测）

- `npx tsc --noEmit` → exit 0
- `npm test` → 全绿（除 SC8 预存 flaky：`tests/cli/register-shutdown.test.ts` 真实 SIGINT 计时断言偶发）
- `npx vitest run tests/config/env-expansion.test.ts tests/config/settings.test.ts tests/config/env.test.ts tests/harness/sandbox/env-isolation.test.ts` → 152 用例全过
- `npm run probe:settings-model`（`scripts/i135-settings-model-extension-smoke.ts`）A/B/C/D 四组 12 断言全过：settings `${VAR}` 占位符真实 chat（响应 model 被 9router 改写为 `deepseek-v4-flash`）/ 无 settings fail-fast / 缺 key 守卫 / 字面 key 不依赖 env。key 只打 `len` + `sha256_12` 指纹，绝不打印全文 / 落盘 / 进 git。

---

## Risks / Open items

- **行为破坏（有意）**：未配 `settings.llm.model` → env loader **fail-fast 抛错**（改动前静默回退 `m3-combo`）；未配 `settings.llm.apiKey` → 消费点守卫抛「no API key configured」。所有需要 LLM 的入口（CLI chat/ask/serve/hub/subagent）都会在装配期暴露——这是用户裁定要求，属于有意破坏，配 settings 即恢复。
- **导入期连带**：`src/harness/sandbox/env-isolation.ts` 模块顶层调用 `loadIknowEnv()`（SECRET_ENV_NAMES 常量），fail-fast 会让其在 model 未配时导入即崩 → 已用 `safeLlmApiKeyEnv()`（try/catch 退化）防御，安全层任何环境可加载。
- **`expandPlaceholders` 非法形态语义**：含 `${` 但含非法/未闭合 `${...}` 形态（`${}` / `${1VAR}` / `${VAR`）→ undefined（settings.ts `isApiKeyOrPlaceholder` 丢弃语义对齐）；含 `${` 但全串由合法 `${VAR}` 拼成 → 正常解析；`$VAR` 裸形态与 `${VAR}` 同样由 expandPlaceholders 解析（无字面短路；无 `$$` 转义；含 `$IDENT` 形态被当作占位符）。
- ADR-0001 不全文废弃，仅 supersede model/key 条款；provider、baseUrl 代码默认保留。
