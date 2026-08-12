# archive/tests-real-llm — historical snapshot (removed from vitest collection)

settings-model-extension phase 2（ADR-0015）把 LLM 配置收敛到
`settings.json` 单承载：`settings.llm.model` 字面唯一来源 + `settings.llm.apiKey`
（字面 / `${VAR}` 占位符）单承载，`IKNOW_LLM_MODEL` / `apiKeyEnv` /
`IKNOW_LLM_API_KEY_ENV` 退役。

本目录的两个历史 real-LLM e2e（`bootstrap-real-llm.test.ts` /
`tui-subagent-wiring-acceptance.test.ts`）仍引用退役变量
`process.env.IKNOW_LLM_MODEL ?? "m3-combo"` 与 `apiKeyEnv: "ANTHROPIC_AUTH_TOKEN"`，
与 settings 单承载语义不符（review fix M5），已从 `vitest.real-llm.config.ts`
的 include 列表移除。本目录作为历史快照保留，不再被 `npm run test:real-llm`
拉起。

当前 real-LLM 验证入口：

- `scripts/i135-settings-model-extension-smoke.ts`（`npm run probe:settings-model`，
  A/B/C/D 四组真实模型验证 settings 占位符 / fail-fast / 缺 key 守卫 / 字面 key）
- `scripts/i9-real-anthropic-adapter-smoke.ts` / `scripts/i10-cli-harness-smoke.ts`
  / `scripts/i11-session-api-harness-smoke.ts`（来源标记 `key_source` 指向
  `settings.llm.apiKey`）
