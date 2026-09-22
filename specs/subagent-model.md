# Spec: Sub-agent model from settings

Operators choose the model a sub-agent runs on in user settings. The parent model does not choose it, and the dead per-spawn `model` field is removed. Issue: [#1121](https://github.com/winter6205/iknow/issues/1121).

## Objective

A sub-agent worker builds its adapter from `settings.subagent.model` when that route can be turned into a transport, and otherwise from `settings.llm.model`. `spawn_subagent` stays resident in the parent prompt and does not gain a model argument or a route list.

## Boundaries

- **Does:** add user-layer `settings.subagent.model`; `loadIknowEnv` resolves that route inside `src/config` and puts a successful result on the exported `IknowEnv` (same transport fields as the exported `LiteModelEnv`: route, `baseUrl`, apiKey, `headers?`). The worker reads `IknowEnv` only and does not call a private resolver. Delete `model` from the parent-facing `spawn_subagent` input, `SubAgentDefinition`, `WorkerEnvelope`, and `WORKER_SCHEMA`. Stop writing `model` on new `subagent_spawn` trace records.
- **Confirms with human:** `(none)` — settled in the #1121 decision thread.
- **Out of this spec:** a parent-model override or an enum of routes on `spawn_subagent`; a `model` field on `SubagentInfo`, the subagent panel, the parent-visible handoff, or new trace records; per-route `thinking`, `temperature`, `maxOutputTokens`, or per-call timeouts; keying the strategy budget window off the model; `/model` writing `subagent.model`; a new env var for the sub-agent route; reading `models[]` to accept or reject the settings string.

## Success Criteria

- Assembled `spawn_subagent` input schema has no `model` property.
- `WORKER_SCHEMA.properties` has no `model`. A parent→worker payload that still contains `model` fails envelope parse (`additionalProperties: false`).
- `subagent.model` set to a `provider/model` whose provider is registered and whose api-key env is non-empty: the worker adapter's wire model is `wireModelFromRoute` of that route, and the client uses that provider's `baseUrl` / apiKey / headers.
- `subagent.model` absent, empty after trim, or not a string: the resolved field is absent and the adapter uses `settings.llm.model` and the main-session transport.
- `subagent.model` set, but resolution throws `LlmProviderConfigError` (`provider_model_not_registered` or `provider_api_key_missing`, recognized only by `isLlmProviderConfigError`): the resolved field is absent (not `null`), the parent spawn is not failed, and the worker still starts on `settings.llm.model`. The catch rethrows anything that is not that typed error. The fallback carries an `// EXIT:` naming that condition.
- When the route differs from `settings.llm.model`, adapter `thinking` and `maxOutputTokens` are still the main `llm` values.

Public entry for the route string is user settings consumed by `loadIknowEnv`. Input classes:

- empty: absent / blank → field absent, main route. Applicable.
- invalid: wrong JSON type → field dropped, main route. Numeric "negative" does not apply to a route string.
- overflow: no length cap. A string that is not a registered provider is the exception class below, not a size class. N/A.
- concurrent: each worker process loads env once; this spec adds no shared mutable settings object. N/A.
- exception: the two `LlmProviderConfigError` kinds → field absent and main route; any other throw from resolution propagates.
- A `subagent_spawn` record written after this change has no `model` field. A previously stored line that already has `model` still parses.
- A `subagent` section in a project settings file does not override the user-layer `subagent.model`.

## Open Questions

`(none)`

## Architecture review

```
bounded-context-guardian: yes — loadIknowEnv keeps resolveLlmTransport private and the worker reads only the exported IknowEnv.
input-contract-tests: yes — empty and exception are allocated; numeric negative, overflow, and concurrent are N/A with reasons.
error-handling-enforcer: yes — isLlmProviderConfigError sets the field absent rather than null, other throws are rethrown, and the fallback has an EXIT comment.
complexity-anti-drift: yes — resolution stays one config step reusing the lite transport helper, with no second provider table.
minimal-change-verifier: yes — one task; panel, parent override, and per-route sampling stay out of scope.
```

## Inherits / Changes

Inherits, quoted:

- **主会话** model: "`settings.llm.model`（字面值，唯一来源，trim 后非空串）: **主会话**模型路由 ID 的全局可寻址位" (`docs/CONTEXT.md`). Missing main model stays fail-fast. This spec does not add a second source for that slot.
- **lite model** shape, not its failure policy: "与 `llm.model` 同形的 `provider/model` 路由，走同一 `providers[]`". `subagent.model` reuses that registry. It does not add a second provider table. Unlike lite, an unusable sub-agent route still runs the worker, on the main route.
- **wire model**: "Anthropic SDK 请求体里的 `model` 字段 = 注册表 `models[].id` 原文（路由 `provider/model` 第一个 `/` 之后）".
- **项目 settings 允许名单**: "共享项目 `<仓>/.iknow/settings.json` 只采纳 `verify` / `secrets` / `permissions`". _Avoid_: "项目文件盖 isolation / llm / memory / subagent". ADR-0084.
- **Retired model env**: "`IKNOW_LLM_MODEL`（env 覆盖 model）已不再读取". No `IKNOW_SUBAGENT_MODEL`.
- ADR-0093: per-model temperature / max_tokens stay deferred. ADR-0015 §1: the main-session literal stays the sole source and still fail-fasts when missing.
- ADR-0100: `env.compress.contextWindow` stays the strategy budget window, not a per-model ceiling.
- The worker injected-adapter test seam (`createWorkerDeps` `opts.model` as an adapter instance) is not the route field and stays.

Changes: user-layer `subagent.model` becomes the worker route, resolved by `loadIknowEnv` onto `IknowEnv`. The worker does not import a private transport resolver. The per-spawn `model` contract is deleted, not left unread.

### 待写入

Flushed: **sub-agent model route** in `docs/CONTEXT.md`; ADR-0122; ADR-0015 amendment 2026-09-22.
