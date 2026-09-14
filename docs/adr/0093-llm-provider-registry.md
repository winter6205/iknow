# 0093. LLM provider 注册表(用户层);`/model` 切换;Anthropic 格式单 client

Date: 2026-09-13
Status: accepted

模型路由 ID `provider/model`(沿用今日 `minimax-cn/MiniMax-M3` 形状)由 `settings.llm.providers` 注册表解析:命中 → `baseUrl = provider.baseUrl` + `apiKey = process.env[provider.apiKeyEnv]`;未命中 → 旧路径 `IKNOW_LLM_BASE_URL` + `settings.llm.apiKey`(back-compat)。`/model` 选 → 持久化 + `reloadFromEnv`(下一轮生效,与 thinking 同款 round-trip)。仅 anthropic 格式(沿 `@anthropic-ai/sdk`,client 工厂单一),`provider.headers?` 透传到 `defaultHeaders`。规格:`specs/tui-model-command.md`。

**Why not 仓库内置 provider 连接信息:** 供应商名 + URL 写进公开仓库是污染;用户自家 key 与 endpoint 不应被 `git pull` 覆盖。注册表走用户层 `~/.iknow/settings.json`(项目文件不采纳,沿 ADR-0084)。

**Why not 多格式:** V1 需求只有 anthropic-compatible;抽象 Plugin / Adapter 框架在单格式下是过度工程。OpenAI-compatible / Gemini native 留后续轮(如有需求)。

**Why not per-model temperature / max_tokens:** 现行 `IKNOW_LLM_*` env 是单一 host 级值;per-model 参数会增加 LLM client 装配的分支,与 loop-engine 正交,推迟。

**Why not mid-turn 切 provider:** loop-engine adapter 由 env 解析一次性装配,中途替换需要线程安全 + 流式响应中断策略,与 thinking 切换的 round-trip 边界同款问题,留后续轮。

Amends ADR-0084(provider 注册表为用户层键)。**重开 ADR-0015 §2「`settings.llm.apiKey` 单字段(取代 `apiKeyEnv` 间接寻址)」**:单字段 `settings.llm.apiKey` 承载不了 N 个 provider 的 N 把 key,`provider.apiKeyEnv` 于是在**用户层注册表内**重新引入 per-provider 变量名(只直读 `process.env`,不回落 fileMap);全局 `IKNOW_LLM_API_KEY_ENV` 与 `LlmEnv.apiKeyEnv` 字段仍退役,未命中 provider 的路径仍走 `settings.llm.apiKey` 占位符链路。ADR-0015 §1 不变 —— model 字面唯一来源与缺失 fail-fast 照旧,该字面现可读作 `provider/model` 路由 ID。
