# 0093. LLM provider registry (user layer); `/model` switching; single Anthropic-format client

Date: 2026-09-13
Status: accepted

The model routing ID `provider/model` (same shape as the currently live `minimax-cn/MiniMax-M3`) resolves through the `settings.llm.providers` registry: hit → `baseUrl = provider.baseUrl` + `apiKey = process.env[provider.apiKeyEnv]`; miss → legacy path `IKNOW_LLM_BASE_URL` + `settings.llm.apiKey` (back-compat). Selecting in `/model` → persist + `reloadFromEnv` (effective next round, same round-trip as thinking). Anthropic format only (keeps `@anthropic-ai/sdk`, one client factory); `provider.headers?` is passed through to `defaultHeaders`.

**Why not repo-bundled provider connection info:** vendor names + URLs written into a public repo are pollution; a user's own key and endpoint must never be overwritten by `git pull`. The registry lives in the user layer `~/.iknow/settings.json` (project files are not adopted, per ADR-0084).

**Why not multiple formats:** V1 demand is anthropic-compatible only; a Plugin / Adapter abstraction framework under a single format is over-engineering. OpenAI-compatible / Gemini native is left to later rounds (if demand appears).

**Why not per-model temperature / max_tokens:** the current `IKNOW_LLM_*` env carries single host-level values; per-model parameters would add branching to LLM client assembly and are orthogonal to loop-engine — deferred.

**Why not mid-turn provider switching:** the loop-engine adapter is assembled once from env resolution; replacing it mid-turn needs thread safety plus a streaming-abort policy — the same boundary problem as thinking's round-trip switching. Left to later rounds.

Amends ADR-0084 (the provider registry is a user-layer key). **Reopens ADR-0015 §2 ("single `settings.llm.apiKey` field, replacing `apiKeyEnv` indirection")**: a single `settings.llm.apiKey` field cannot carry N keys for N providers, so `provider.apiKeyEnv` is reintroduced **inside the user-layer registry** as a per-provider variable name (reads `process.env` only, no fallback to fileMap); the global `IKNOW_LLM_API_KEY_ENV` and the `LlmEnv.apiKeyEnv` field remain retired, and the provider-miss path still goes through the `settings.llm.apiKey` placeholder chain. ADR-0015 §1 is unchanged — the model literal stays the single source and missing-value fail-fast still applies; that literal can now be read as a `provider/model` routing ID.
