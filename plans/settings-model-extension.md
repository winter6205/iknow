# Plan: settings 机制扩字段 — `llm.model` + `llm.fallback` 入 settings

Tracer bullet，承接 #353（settings 机制）的第二阶段：把模型配置从「env + 硬编码」二源改为「env > settings」两源链（**移除 hardcoded 兜底**），让全局 `~/.iknow/settings.json`（用户级）与 `<cwd>/.iknow/settings.json`（项目级）成为模型配置的单一可寻址位置，同时 `.env.local` 不再背负模型值（消除第二源 drift）。未配 model → fail-fast 抛错；fallback 由用户经 `settings.llm.fallback` 自配。

ADR: supersede ADR-0001 的「m3-combo 焊死」条款 → 模型配置改为可配置 + fail-fast（settings 覆盖 env 之下），**移除 hardcoded `m3-combo` 兜底**。

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

## Files expected to change

- `src/config/settings.ts`
- `src/config/env.ts`
- `tests/config/settings.test.ts`
- `tests/config/env.test.ts`（若存在则加，不存在跳过）
- `docs/adr/0001-9router-stack-as-code-defaults.md`
- `docs/CONTEXT.md`
- `CHANGELOG.md`
- `scripts/i135-settings-model-extension-smoke.ts`（真实模型 smoke，B 组改断言 fail-fast）
- `src/harness/sandbox/env-isolation.ts`（模块顶层 loadIknowEnv 的 fail-fast 防御）

---

## Validation

- `npm run typecheck`
- `npm test -- tests/config/` 全绿
- `npm test` 全绿
- `npm run probe:settings-model`（需 ANTHROPIC_AUTH_TOKEN 环境变量已设）—— A 组证明 settings.llm.model 实际影响模型调用；B 组断言无 settings 时 `loadIknowEnv` 抛「no LLM model configured」（fail-fast）。

---

## Risks / Open items

- **行为破坏（有意）**：未配 `settings.llm.model` 且未设 `IKNOW_LLM_MODEL` 时，改动前静默回退 `m3-combo`，改动后 env loader **fail-fast 抛错**。所有需要 LLM 的入口（CLI chat/ask/serve/hub/subagent）都会在装配期暴露「no LLM model configured」——这是用户裁定要求，属于有意破坏，配 model 即恢复。
- **导入期连带**：`src/harness/sandbox/env-isolation.ts` 模块顶层调用 `loadIknowEnv()`（SECRET_ENV_NAMES 常量），fail-fast 会让其在 model 未配时导入即崩 → 已用 `safeLlmApiKeyEnv()`（try/catch 退化）防御，安全层任何环境可加载。
- `.env.local` 已删（用户 8/12 操作），不再有第二源 drift 风险。
- ADR-0001 不全文废弃，仅 supersede 模型条款；其余（key 变量名、baseUrl 默认、provider）保留。
