# 0122. Sub-agent model route is user settings, not a spawn argument

Date: 2026-09-22
Status: accepted

> **Amendment 2026-09-26** (MOT spec; supersedes only the “Per-route thinking or max tokens” clause below): each subagent request uses `models[].maxTokens` from its effective `settings.subagent.model` route, falling back to 32,000 when absent, independently of the main-session route. Per-route thinking remains host-level; other host-level sampling settings are unchanged. The legacy output-budget environment-variable migration is recorded in ADR-0093.

The worker's model route is user-layer `settings.subagent.model` (`provider/model`, same `providers[]` as `settings.llm.model`). Absent, empty, wrong type, or a transport that cannot be built (`LlmProviderConfigError` only) and the worker uses the main-session route; the parent spawn is not failed. Anything else thrown while resolving still propagates. `spawn_subagent` does not take a model, and `WorkerEnvelope.model` is removed. Live contract: `specs/subagent-model.md`. Amends ADR-0015 only by adding this worker slot; §1 for the main session stays.

## Why not

- **Let the parent model pass a model:** `spawn_subagent` is resident in the parent prompt. A free argument or an enum of every configured route is reread every parent turn, and the parent starts choosing models.
- **Keep the unread envelope field:** `WORKER_SCHEMA` sets `additionalProperties: false`, so a property that remains is still writable and still ignored. The request is stdin from a same-version parent, not a document read back across versions.
- **Fail the spawn when the route is bad:** a broken worker default would stop every sub-agent until the file is fixed. The main route is already required.
- **Per-route thinking or max tokens:** ADR-0093 left those as host-level values.
