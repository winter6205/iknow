# 0094. 运行时 EnvLoader 单源;wire model = models[].id;API 错只进 viewport

Date: 2026-09-14
Status: accepted

Amends ADR-0093. `settings.llm.model` 仍是路由 ID `provider/model`，只用来查注册表（baseUrl / apiKeyEnv / headers）和 picker。SDK 请求的 `model` 是 `models[].id`（路由里第一个 `/` 之后的原文）；provider `id` 不上 wire。网关若要前缀，前缀写在模型名里，不由装配层拼接。运行时 LLM env 只由一份 EnvLoader 持有（TUI 与 serve 同挂）；hub 禁止构造期 `overrideEnv` 快照，thinking 覆盖走同一 `createAdapterFromEnv`，不得第二套 client 工厂。供应商/API 失败对人画在对话流（薄外壳 `API error (status):` + 原文），不追加进 session transcript；`StopReason` / `protocolError` 不当 UX 文案。harness 控制流 envelope（如 LOOP_DETECTED）仍进权威 messages 喂模型。
